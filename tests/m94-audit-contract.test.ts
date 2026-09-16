import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globMatches, globToRegExp, loadAuditRuleSet } from "../src/audit/rules";
import { deriveAuditBaseline } from "../src/audit/baseline";

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

describe("M94 audit contract — rules engine + baseline", () => {
  it("glob engine covers **, *, ?, {a,b} and literals", () => {
    expect(globMatches("drivers/**/*.{c,ko,py}", "drivers/foo.py")).toBe(true);
    expect(globMatches("drivers/**/*.{c,ko,py}", "drivers/nested/bar.ko")).toBe(true);
    expect(globMatches("drivers/**/*.{c,ko,py}", "src/foo.py")).toBe(false);
    expect(globMatches("docker-compose*.yml", "docker-compose.prod.yml")).toBe(true);
    expect(globMatches("docker-compose*.yml", "docker-compose.yml")).toBe(true);
    expect(globMatches("*.test.ts", "a.test.ts")).toBe(true);
    expect(globMatches("*.test.ts", "sub/a.test.ts")).toBe(false); // * stays in one segment
    expect(globMatches("a/**/b", "a/b")).toBe(true); // ** tolerates zero segments
    expect(globMatches("a/**/b", "a/x/y/b")).toBe(true);
    expect(globMatches("src/?ne.ts", "src/one.ts")).toBe(true);
    expect(globMatches("src/?ne.ts", "src/onne.ts")).toBe(false);
    // Special regex metacharacters in literals are escaped.
    expect(globMatches("a+b.c", "a+b.c")).toBe(true);
    expect(globMatches("a+b.c", "aab.c")).toBe(false);
    expect(globToRegExp("x").source.startsWith("^")).toBe(true);
  });

  it("loadAuditRuleSet fails open on missing/malformed files and validates shape", () => {
    const root = makeTempRoot("gf-rules-");
    expect(loadAuditRuleSet(root).rules).toEqual([]);
    writeFileSync(join(root, "graphflow.audit.json"), "{ not json", "utf8");
    expect(loadAuditRuleSet(root).rules).toEqual([]);
    writeFileSync(
      join(root, "graphflow.audit.json"),
      JSON.stringify({
        rules: [
          { name: "ok", filePattern: "drivers/**", mustBeReferencedBy: ["**/load*"] },
          { name: "bad-no-pattern", mustBeReferencedBy: [] },
        ],
      }),
      "utf8"
    );
    const loaded = loadAuditRuleSet(root);
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]?.name).toBe("ok");
    expect(loaded.source).toBe(join(root, "graphflow.audit.json"));
  });

  it("baseline prefers injected files, then working tree, then none", () => {
    const injected = deriveAuditBaseline("/anywhere", { changedFilesOverride: ["a\\b.ts", "c.ts"] });
    expect(injected.changedFiles).toEqual(["a/b.ts", "c.ts"]);

    const stub = (args: string) => {
      if (args.includes("rev-parse")) return "true\n";
      if (args.includes("diff --name-only HEAD")) return "pkg/a.ts\npkg/b.ts\n";
      if (args.includes("ls-files --others")) return "new/c.ts\npkg/a.ts\n"; // dedup across sources
      return "";
    };
    const wt = deriveAuditBaseline("/repo", {}, { git: stub });
    expect(wt.strategy).toBe("git-working-tree");
    expect(wt.changedFiles).toEqual(["pkg/a.ts", "pkg/b.ts", "new/c.ts"]);

    const since = deriveAuditBaseline("/repo", { since: "v1.0.0" }, { git: stub });
    expect(since.strategy).toBe("git-ref");
    expect(since.ref).toBe("v1.0.0");

    const noGit = deriveAuditBaseline("/plain", {}, { git: () => undefined });
    expect(noGit.strategy).toBe("none");
    expect(noGit.changedFiles).toEqual([]);
    expect(noGit.note).toContain("stateful");
  });
});
