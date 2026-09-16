/**
 * tests/m97-audit-runner-cli.test.ts — R9 收尾审计聚合器（runAudit）+ CLI 接线测试。
 *
 * 全部用注入的 stub checker / baseline / context（不依赖四个真实检查器文件
 * 是否就绪——runAudit 的默认 checkers 走惰性动态 import，注入时完全不触碰）。
 * 覆盖：findings 聚合与排序、checker reject 记 -1 不中断、strict 环境变量
 * （GRAPHFLOW_AUDIT_STRICT=1 临时设置后还原）、rootOverride 优先级、
 * warning 不影响非 strict ok、legacyText 格式、usage 文本 audit 行。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatAuditLegacyText, runAudit } from "../src/audit/audit";
import type { AuditBaseline } from "../src/audit/baseline";
import type { AuditChecker, AuditContext, AuditFinding } from "../src/audit/types";
import { buildCliUsage } from "../src/surfaces/cli/output";

const STRICT_ENV = "GRAPHFLOW_AUDIT_STRICT";

let originalStrictEnv: string | undefined;

beforeEach(() => {
  originalStrictEnv = process.env[STRICT_ENV];
  delete process.env[STRICT_ENV]; // 默认非 strict，个别用例内显式设置
});

afterEach(() => {
  if (originalStrictEnv === undefined) {
    delete process.env[STRICT_ENV];
  } else {
    process.env[STRICT_ENV] = originalStrictEnv;
  }
});

function makeFinding(
  id: string,
  kind: AuditFinding["kind"],
  severity: AuditFinding["severity"],
  message = id
): AuditFinding {
  return { id, kind, severity, message, evidence: {}, remediation: "fix " + id };
}

interface Recorder {
  roots: string[];
  filesList: string[][];
  contexts: AuditContext[];
}

function makeChecker(
  name: string,
  produce: () => AuditFinding[] | Promise<AuditFinding[]>,
  recorder?: Recorder
): AuditChecker {
  return {
    name,
    async run(changedFiles, root, context) {
      if (recorder) {
        recorder.roots.push(root);
        recorder.filesList.push(changedFiles);
        recorder.contexts.push(context);
      }
      return produce();
    },
  };
}

function makeBaseline(
  calls: Array<{ root: string; options: { since?: string; changedFilesOverride?: string[] } }>,
  result?: Partial<AuditBaseline>
): (root: string, options?: { since?: string; changedFilesOverride?: string[] }) => AuditBaseline {
  return (root, options = {}) => {
    calls.push({ root, options });
    return {
      strategy: "git-ref",
      ref: options.since ?? "HEAD~1",
      changedFiles: ["src/a.ts", "src/b.ts", "docs/c.md"],
      note: "injected baseline (test)",
      ...result,
    };
  };
}

const stubContext: AuditContext = {
  loadRules: () => ({
    rules: [{ name: "drivers-must-be-loaded", filePattern: "drivers/**", mustBeReferencedBy: ["container.json"] }],
  }),
  probeFile: async (relPath: string) => ({ nodeId: "file:" + relPath, inboundEdges: 3 }),
};

describe("runAudit（R9 收尾审计聚合器）", () => {
  it("聚合多个 checker 的 findings 并按 error→kind→id 排序，context 原样透传", async () => {
    const recorder: Recorder = { roots: [], filesList: [], contexts: [] };
    let probed: { nodeId?: string; inboundEdges: number } | undefined;
    const checkerA = makeChecker(
      "alpha",
      () => {
        void stubContext.loadRules();
        return [
          makeFinding("z", "dependency", "warning"),
          makeFinding("b", "orphan-file", "error"),
        ];
      },
      recorder
    );
    const checkerB = makeChecker("beta", async () => {
      probed = await stubContext.probeFile?.("src/a.ts");
      return [
        makeFinding("a", "dependency", "error"),
        makeFinding("m", "doc-consistency", "warning"),
      ];
    });

    const report = await runAudit(
      { changedFilesOverride: ["src/a.ts"] },
      "/tmp/param-root",
      undefined,
      {
        checkers: [checkerA, checkerB],
        baseline: makeBaseline([]),
        context: stubContext,
      }
    );

    expect(report.findings.map((f) => f.severity + ":" + f.kind + ":" + f.id)).toEqual([
      "error:dependency:a",
      "error:orphan-file:b",
      "warning:dependency:z",
      "warning:doc-consistency:m",
    ]);
    expect(report.summary).toEqual({
      total: 4,
      errors: 2,
      warnings: 2,
      checkers: [
        { name: "alpha", findings: 2 },
        { name: "beta", findings: 2 },
      ],
    });
    expect(report.ok).toBe(false); // errors>0
    expect(recorder.contexts[0]).toBe(stubContext); // 注入的 context 直接交给 checker
    expect(probed).toEqual({ nodeId: "file:src/a.ts", inboundEdges: 3 });
  });

  it("rejected 的 checker 记 findings:-1、不中断其它 checker、不污染 ok", async () => {
    const bad = makeChecker("bad", () => {
      throw new Error("checker exploded");
    });
    const good = makeChecker("good", () => [makeFinding("w1", "doc-consistency", "warning")]);

    const report = await runAudit({}, "/tmp/param-root", undefined, {
      checkers: [bad, good],
      baseline: makeBaseline([]),
      context: stubContext,
    });

    expect(report.summary.checkers).toContainEqual({ name: "bad", findings: -1 });
    expect(report.summary.checkers).toContainEqual({ name: "good", findings: 1 });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.id).toBe("w1");
    expect(report.summary.total).toBe(1);
    expect(report.ok).toBe(true); // 失败的 checker 记 0 findings，不给结果添 error
  });

  it("GRAPHFLOW_AUDIT_STRICT=1 使 warning 也阻塞 ok；显式 strict:false 仍优先于环境变量", async () => {
    const warnOnly = makeChecker("w", () => [makeFinding("w1", "doc-consistency", "warning")]);
    const deps = { checkers: [warnOnly], baseline: makeBaseline([]), context: stubContext };

    process.env[STRICT_ENV] = "1";
    try {
      const withEnv = await runAudit({}, "/tmp/param-root", undefined, deps);
      expect(withEnv.strict).toBe(true);
      expect(withEnv.ok).toBe(false); // strict 下 total>0 即不 ok

      const explicitOff = await runAudit({ strict: false }, "/tmp/param-root", undefined, deps);
      expect(explicitOff.strict).toBe(false); // options.strict ?? env —— 显式 false 胜出
      expect(explicitOff.ok).toBe(true);
    } finally {
      delete process.env[STRICT_ENV]; // 还原（afterEach 兜底）
    }

    const noEnv = await runAudit({}, "/tmp/param-root", undefined, deps);
    expect(noEnv.strict).toBe(false);
    expect(noEnv.ok).toBe(true);
  });

  it("root 优先级：rootOverride > config.graphPolicy.workspaceRoot > root 参数", async () => {
    const baselineCalls: Array<{ root: string; options: { since?: string; changedFilesOverride?: string[] } }> = [];
    const recorder: Recorder = { roots: [], filesList: [], contexts: [] };
    const deps = {
      checkers: [makeChecker("c", () => [], recorder)],
      baseline: makeBaseline(baselineCalls),
      context: stubContext,
    };

    await runAudit({ rootOverride: "/r/override" }, "/r/param", { graphPolicy: { workspaceRoot: "/r/config" } }, deps);
    expect(baselineCalls[0]!.root).toBe("/r/override");
    expect(recorder.roots[0]).toBe("/r/override");

    await runAudit({}, "/r/param", { graphPolicy: { workspaceRoot: "/r/config" } }, deps);
    expect(baselineCalls[1]!.root).toBe("/r/config");
    expect(recorder.roots[1]).toBe("/r/config");

    await runAudit({}, "/r/param", undefined, deps);
    expect(baselineCalls[2]!.root).toBe("/r/param");
    expect(recorder.roots[2]).toBe("/r/param");
  });

  it("warning 不影响非 strict ok；strict:true 下同一组 findings 不 ok", async () => {
    const warnOnly = makeChecker("w", () => [
      makeFinding("w1", "orphan-file", "warning"),
      makeFinding("w2", "dependency", "warning"),
    ]);
    const deps = { checkers: [warnOnly], baseline: makeBaseline([]), context: stubContext };

    const lax = await runAudit({}, "/tmp/param-root", undefined, deps);
    expect(lax.summary.warnings).toBe(2);
    expect(lax.summary.errors).toBe(0);
    expect(lax.ok).toBe(true);

    const strict = await runAudit({ strict: true }, "/tmp/param-root", undefined, deps);
    expect(strict.strict).toBe(true);
    expect(strict.ok).toBe(false);
  });

  it("注入 baseline 决定报告 baseline 并把 changedFiles 传给 checker；since 透传", async () => {
    const baselineCalls: Array<{ root: string; options: { since?: string; changedFilesOverride?: string[] } }> = [];
    const recorder: Recorder = { roots: [], filesList: [], contexts: [] };

    const report = await runAudit({ since: "v2.0" }, "/tmp/param-root", undefined, {
      checkers: [makeChecker("c", () => [], recorder)],
      baseline: makeBaseline(baselineCalls),
      context: stubContext,
    });

    expect(baselineCalls[0]!.options.since).toBe("v2.0");
    expect(report.baseline.strategy).toBe("git-ref");
    expect(report.baseline.ref).toBe("v2.0");
    expect(report.baseline.changedFiles).toEqual(["src/a.ts", "src/b.ts", "docs/c.md"]);
    expect(recorder.filesList[0]).toEqual(["src/a.ts", "src/b.ts", "docs/c.md"]);
  });
});

describe("audit CLI 接线", () => {
  it("formatAuditLegacyText 含 errors/warnings/ok/baseline 与逐条 [kind] message", async () => {
    const deps = {
      checkers: [
        makeChecker("c", () => [
          makeFinding("lock", "dependency", "error", "忘了锁版本吗？"),
          makeFinding("drift", "doc-consistency", "warning", "docs 漂移"),
        ]),
      ],
      baseline: makeBaseline([], { strategy: "git-ref", ref: "v1.9", changedFiles: ["src/a.ts", "src/b.ts"] }),
      context: stubContext,
    };
    const report = await runAudit({}, "/tmp/param-root", undefined, deps);
    const legacy = formatAuditLegacyText(report);

    expect(legacy).toContain("errors=1");
    expect(legacy).toContain("warnings=1");
    expect(legacy).toContain("ok=false");
    expect(legacy).toContain("baseline=git-ref(2 files)");
    expect(legacy).toContain("[dependency] 忘了锁版本吗？");
    expect(legacy).toContain("[doc-consistency] docs 漂移");

    const clean = formatAuditLegacyText(
      await runAudit({}, "/tmp/param-root", undefined, {
        checkers: [makeChecker("c", () => [])],
        baseline: makeBaseline([], { strategy: "none", changedFiles: [] }),
        context: stubContext,
      })
    );
    expect(clean).toContain("errors=0");
    expect(clean).toContain("warnings=0");
    expect(clean).toContain("ok=true");
    expect(clean).not.toContain("[");
  });

  it("buildCliUsage 在 challenge 行后包含 audit 命令行", () => {
    const usage = buildCliUsage();
    const auditLine =
      "  audit [--since <ref>] [--strict] [--json] [--config <path>]  # R9: closing audit — dangling deps/orphan files/container&loader refs/doc drift before calling it done";
    expect(usage).toContain(auditLine);
    expect(usage.indexOf("challenge --files")).toBeGreaterThanOrEqual(0);
    expect(usage.indexOf(auditLine)).toBeGreaterThan(usage.indexOf("challenge --files"));
  });
});
