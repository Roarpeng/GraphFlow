import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOrphanChecker } from "../src/audit/checkers/orphan-checker";
import { createRuleChecker } from "../src/audit/checkers/rule-checker";
import type { AuditContext, AuditRule } from "../src/audit/types";

const tempRoots: string[] = [];
function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

type ProbeResult = { nodeId?: string; inboundEdges: number } | undefined;

/** Stub AuditContext：loadRules 返回构造规则集；probeFile 按 relPath 映射（可选）。 */
function stubContext(options: { rules?: AuditRule[]; probe?: (rel: string) => ProbeResult }): AuditContext {
  const ctx: AuditContext = { loadRules: () => ({ rules: options.rules ?? [] }) };
  const probe = options.probe;
  if (probe) ctx.probeFile = async (rel) => probe(rel);
  return ctx;
}

describe("M96 orphan-file checker", () => {
  const checker = createOrphanChecker();

  it("reports a warning only for source files with zero inbound edges", async () => {
    const ctx = stubContext({
      probe: (rel) =>
        rel === "src/orphan.ts"
          ? { nodeId: "file:src/orphan.ts", inboundEdges: 0 }
          : { nodeId: `file:${rel}`, inboundEdges: 2 },
    });
    const findings = await checker.run(["src/orphan.ts", "src/wired.ts"], "/tmp/any", ctx);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.id).toBe("orphan-file:src/orphan.ts");
    expect(f.kind).toBe("orphan-file");
    expect(f.severity).toBe("warning");
    expect(f.message).toContain("src/orphan.ts");
    expect(f.message).toContain("接线");
    expect(f.evidence.files).toEqual(["src/orphan.ts"]);
    expect(f.remediation.length).toBeGreaterThan(0);
  });

  it("excludes test/spec files, configs, docs and scripts/** — but keeps ordinary source files", async () => {
    const findings = await checker.run(
      [
        "src/a.test.ts",
        "src/b.spec.ts",
        "src/__tests__/c.ts",
        "conf/config.json",
        "docs/readme.md",
        "deploy.yml",
        "scripts/build.ts",
        "src/real.go",
      ],
      "/tmp/any",
      stubContext({ probe: () => ({ inboundEdges: 0 }) })
    );
    expect(findings.map((f) => f.id)).toEqual(["orphan-file:src/real.go"]);
  });

  it("skips when probe returns undefined (graph unavailable — never guess)", async () => {
    const findings = await checker.run(["src/new.ts"], "/tmp/any", stubContext({ probe: () => undefined }));
    expect(findings).toEqual([]);
  });

  it("fails open when probeFile is absent, and when probe throws", async () => {
    expect(await checker.run(["src/new.ts"], "/tmp/any", stubContext({}))).toEqual([]);
    const throwing = stubContext({
      probe: () => {
        throw new Error("graph down");
      },
    });
    expect(await checker.run(["src/new.ts"], "/tmp/any", throwing)).toEqual([]);
  });
});

describe("M96 rule checker (rule engine executor)", () => {
  const checker = createRuleChecker();

  it("no finding when a target config on disk references the matched file", async () => {
    const root = makeTempRoot("gf-rule-hit-");
    writeFileSync(join(root, "load.py"), "registry = ['drivers/foo.py']", "utf8");
    const rules: AuditRule[] = [
      { name: "driver-loader", filePattern: "drivers/**", mustBeReferencedBy: ["**/load*"] },
    ];
    const findings = await checker.run(["drivers/foo.py"], root, stubContext({ rules }));
    expect(findings).toEqual([]);
  });

  it("finding when targets exist but never reference the file — kind/severity/message from the rule", async () => {
    const root = makeTempRoot("gf-rule-miss-");
    writeFileSync(join(root, "README.md"), "# images\n\nnothing relevant here", "utf8");
    const rules: AuditRule[] = [
      {
        name: "docker-context",
        kind: "container-ref",
        severity: "warning",
        description: "新增 Dockerfile 需在 README 镜像表中登记",
        filePattern: "Dockerfile*",
        mustBeReferencedBy: ["README*"],
        remediation: "在 README 镜像表中登记该 Dockerfile",
      },
    ];
    const findings = await checker.run(["Dockerfile.dev"], root, stubContext({ rules }));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.id).toBe("rule:docker-context:Dockerfile.dev");
    expect(f.kind).toBe("container-ref");
    expect(f.severity).toBe("warning");
    expect(f.message).toContain("规则 docker-context");
    expect(f.message).toContain("Dockerfile.dev");
    expect(f.message).toContain("（忘了吗？）");
    expect(f.remediation).toBe("在 README 镜像表中登记该 Dockerfile");
    expect(f.evidence.rule).toBe("docker-context");
  });

  it("defaults kind=rule / severity=error / generic remediation when the rule omits them", async () => {
    const root = makeTempRoot("gf-rule-defaults-");
    const rules: AuditRule[] = [
      { name: "loader-ref-basic", filePattern: "plugins/**", mustBeReferencedBy: ["config/registry.yaml"] },
    ];
    const findings = await checker.run(["plugins/p.ts"], root, stubContext({ rules }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("rule");
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.remediation).toBe("把文件引用加入对应配置");
  });

  it("finding when no disk file matches the mustBeReferencedBy globs", async () => {
    const root = makeTempRoot("gf-rule-notargets-");
    const rules: AuditRule[] = [
      { name: "driver-loader", filePattern: "drivers/**", mustBeReferencedBy: ["docs/**"] },
    ];
    const findings = await checker.run(["drivers/foo.py"], root, stubContext({ rules }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("rule:driver-loader:drivers/foo.py");
  });

  it("empty changedFiles (baseline none) skips every rule", async () => {
    const root = makeTempRoot("gf-rule-empty-");
    writeFileSync(join(root, "README.md"), "no drivers listed", "utf8");
    const rules: AuditRule[] = [
      { name: "driver-loader", filePattern: "**", mustBeReferencedBy: ["README*"] },
    ];
    expect(await checker.run([], root, stubContext({ rules }))).toEqual([]);
  });

  it("rule with no matched files is skipped entirely", async () => {
    const root = makeTempRoot("gf-rule-nomatch-");
    const rules: AuditRule[] = [
      { name: "driver-loader", filePattern: "drivers/**", mustBeReferencedBy: ["README*"] },
    ];
    expect(await checker.run(["src/unrelated.ts"], root, stubContext({ rules }))).toEqual([]);
  });

  it("walker skips node_modules/.git/dist and anything deeper than 3 levels", async () => {
    const root = makeTempRoot("gf-rule-walk-");
    const reference = "drivers/foo.py";
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "a/b/c/d"), { recursive: true });
    writeFileSync(join(root, "node_modules/pkg/load.py"), `see ${reference}`, "utf8");
    writeFileSync(join(root, "dist/load.py"), `see ${reference}`, "utf8");
    writeFileSync(join(root, ".git/load.py"), `see ${reference}`, "utf8");
    writeFileSync(join(root, "a/b/c/d/load.py"), `see ${reference}`, "utf8"); // depth 4 — not walked
    const rules: AuditRule[] = [
      { name: "driver-loader", filePattern: "drivers/**", mustBeReferencedBy: ["**/load*"] },
    ];
    const ctx = stubContext({ rules });
    expect(await checker.run(["drivers/foo.py"], root, ctx)).toHaveLength(1);
    // 深度 ≤3 的可达目标出现引用后即消除 finding（新 run 重新走盘）。
    mkdirSync(join(root, "ok"), { recursive: true });
    writeFileSync(join(root, "ok/load.py"), `import ${reference}`, "utf8");
    expect(await checker.run(["drivers/foo.py"], root, stubContext({ rules }))).toEqual([]);
  });

  it("binary target files are skipped, not treated as references", async () => {
    const root = makeTempRoot("gf-rule-binary-");
    writeFileSync(
      join(root, "registry.bin"),
      Buffer.concat([Buffer.from("drivers/foo.py"), Buffer.from([0]), Buffer.from("tail")])
    );
    const rules: AuditRule[] = [
      { name: "driver-loader", filePattern: "drivers/**", mustBeReferencedBy: ["*.bin"] },
    ];
    const findings = await checker.run(["drivers/foo.py"], root, stubContext({ rules }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("rule:driver-loader:drivers/foo.py");
  });
});
