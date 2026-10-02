import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEfficiencyPipeline, type PipelineInput, type PipelineResult } from "../src/agent/pipeline.js";
import type { PipelineSecurity } from "../src/agent/security-adapter.js";
import { createDefaultSecurity } from "../src/agent/security-default.js";
import { DEFAULT_FLAGS, type EffFlags } from "../src/flags.js";
import { takeWorkspaceSnapshot } from "../src/host/workspace-snapshot.js";
import {
  auditWorkspaceSnapshots,
  auditWorkspaceWrites,
  checkWriteScope,
  DEFAULT_SECURITY_POLICY,
  isInsideRoot,
  toRootRelative,
  type WorkspaceSnapshot,
} from "../src/security/index.js";
import { fixtureDeps, scratchWorkspace } from "./helpers/pipeline-fixtures.js";

const ACTING: EffFlags = { ...DEFAULT_FLAGS, EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false };
const SPAWN_TIMEOUT = 120_000;
const P = DEFAULT_SECURITY_POLICY;
const quote = (p: string): string => `"${p}"`;

type OnFinished = (fn: () => void) => void;

const agentThen = (code: string): string =>
  [
    "const fs = require('fs');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => (input += c));",
    "process.stdin.on('end', () => {",
    code,
    "});",
  ].join("\n");

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
}

/** A real temp git repo: scratch agent/validation scripts + `files`, all committed. */
function repo(onFinished: OnFinished, agentBody: string, files: Record<string, string> = {}) {
  const ws = scratchWorkspace(agentBody);
  onFinished(ws.dispose);
  git(ws.dir, ["init", "-q"]);
  git(ws.dir, ["config", "user.email", "test@example.com"]);
  git(ws.dir, ["config", "user.name", "eff-agent-test"]);
  git(ws.dir, ["config", "core.excludesFile", path.join(ws.dir, ".no-global-excludes")]);
  git(ws.dir, ["config", "core.autocrlf", "false"]);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws.dir, rel)), { recursive: true });
    writeFileSync(path.join(ws.dir, rel), body);
  }
  git(ws.dir, ["add", "-A"]);
  git(ws.dir, ["commit", "-q", "-m", "init"]);
  return ws;
}

/** Wraps the default gate and also records legacy porcelain-only snapshots (the pre-fix audit input). */
function recordingSecurity(): { security: PipelineSecurity; legacy: string[][] } {
  const real = createDefaultSecurity();
  const legacy: string[][] = [];
  return {
    legacy,
    security: {
      ...real,
      snapshot: (root, before) => {
        legacy.push(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).split(/\r?\n/).filter(Boolean));
        return real.snapshot(root, before);
      },
    },
  };
}

function legacyAudit(legacy: string[][], root: string, readOnly: boolean) {
  expect(legacy).toHaveLength(2);
  return auditWorkspaceWrites({
    before: legacy[0]!,
    after: legacy[1]!,
    workspaceRoot: root,
    readOnly,
    policy: P,
    ignorePaths: ["graphflow-out/**", ".graphflow-cache/**"],
  });
}

function run(
  ws: { dir: string; agentScript: string },
  security: PipelineSecurity,
  overrides: Partial<PipelineInput>
): Promise<PipelineResult> {
  return runEfficiencyPipeline(
    {
      task: "fix the parser",
      root: ws.dir,
      mode: "broker",
      policy: "conservative",
      category: "bugfix",
      validation: [`${quote(process.execPath)} ${quote(path.join(ws.dir, "pass.cjs"))}`],
      executor: { command: process.execPath, args: [ws.agentScript], promptVia: "stdin", timeoutMs: 30_000 },
      flags: ACTING,
      ...overrides,
    },
    fixtureDeps(ws.dir, { security })
  );
}

// ───────────── pure helpers ─────────────

describe("write audit helpers: root containment and declared scope", () => {
  const root = path.join(os.tmpdir(), "eff-wa-root", "repo");

  it("isInsideRoot handles .., absolute paths, temp dirs and look-alike names", () => {
    expect(isInsideRoot(root, "src/a.ts")).toBe(true);
    expect(isInsideRoot(root, ".")).toBe(true);
    expect(isInsideRoot(root, path.join(root, "x"))).toBe(true);
    expect(isInsideRoot(root, "..foo/x")).toBe(true); // a directory literally named "..foo"
    expect(isInsideRoot(root, "../sibling/x")).toBe(false);
    expect(isInsideRoot(root, "src/../../x")).toBe(false);
    expect(isInsideRoot(root, path.join(os.tmpdir(), "elsewhere.txt"))).toBe(false);
    expect(isInsideRoot(root, `${root}-evil/x`)).toBe(false);
    if (process.platform === "win32") {
      const otherDrive = root.toUpperCase().startsWith("D:") ? "E:\\x" : "D:\\x";
      expect(isInsideRoot(root, otherDrive)).toBe(false);
      expect(isInsideRoot(root, root.toUpperCase())).toBe(true); // case-insensitive on Windows
    }
  });

  it("toRootRelative re-bases repo-relative porcelain paths onto a sub-directory root", () => {
    expect(toRootRelative("", "src/a.ts")).toBe("src/a.ts");
    expect(toRootRelative("pkg/", "pkg/src/a.ts")).toBe("src/a.ts");
    expect(toRootRelative("pkg/", "sibling.txt")).toBe("../sibling.txt");
    expect(toRootRelative("packages/x/", "packages/y/z.ts")).toBe("../y/z.ts");
    expect(toRootRelative("pkg/", "other/dist/")).toBe("../other/dist/");
  });

  it("checkWriteScope rejects declared scopes outside the workspace root", () => {
    expect(checkWriteScope(root, [root, "src"]).verdict).toBe("allow");
    const d = checkWriteScope(root, ["src", "../sibling", path.join(os.tmpdir(), "x"), ""]);
    expect(d.verdict).toBe("deny");
    expect(d.risk).toBe("R3");
    expect(d.reasons).toHaveLength(3);
    expect(d.reasons.join("\n")).toMatch(/declared write scope outside the workspace root \(\.\.\/sibling\)/);
  });
});

describe("auditWorkspaceSnapshots (pure)", () => {
  const root = path.join(os.tmpdir(), "eff-wa-pure", "repo");
  const snap = (status: string[], contents: Record<string, string> = {}, prefix = ""): WorkspaceSnapshot => ({
    prefix,
    status,
    contents,
    unsigned: 0,
  });

  it("(a) a pre-dirty file rewritten with an unchanged status is detected (legacy diff misses it)", () => {
    const before = snap([" M a.ts"], { "a.ts": "sha256:1" });
    const after = snap([" M a.ts"], { "a.ts": "sha256:2" });
    expect(auditWorkspaceWrites({ before: before.status, after: after.status, workspaceRoot: root, readOnly: true, policy: P }).newlyChanged).toEqual([]);
    const r = auditWorkspaceSnapshots({ before, after, workspaceRoot: root, readOnly: true, policy: P });
    expect(r.newlyChanged).toEqual(["a.ts"]);
    expect(r.rewrittenDirty).toEqual(["a.ts"]);
    expect(r.decision.verdict).toBe("deny");
    expect(r.decision.reasons.join("\n")).toMatch(/already dirty before the run/);
    const same = auditWorkspaceSnapshots({ before, after: before, workspaceRoot: root, readOnly: true, policy: P });
    expect(same.decision.verdict).toBe("allow");
    expect(same.newlyChanged).toEqual([]);
  });

  it("(b) ignored entries that appear or change content are writes; protected ones deny", () => {
    const before = snap(["!! node_modules/", "!! cache.log"], { "cache.log": "sha256:1" });
    const appeared = auditWorkspaceSnapshots({
      before,
      after: snap(["!! node_modules/", "!! cache.log", "!! .env"], { "cache.log": "sha256:1" }),
      workspaceRoot: root,
      readOnly: false,
      policy: P,
    });
    expect(appeared.ignoredChanged).toEqual([".env"]);
    expect(appeared.decision.verdict).toBe("deny");
    expect(appeared.decision.reasons.join("\n")).toMatch(/protected path/);
    const rewritten = auditWorkspaceSnapshots({
      before,
      after: snap(["!! node_modules/", "!! cache.log"], { "cache.log": "sha256:2" }),
      workspaceRoot: root,
      readOnly: true,
      policy: P,
    });
    expect(rewritten.ignoredChanged).toEqual(["cache.log"]);
    expect(rewritten.rewrittenDirty).toEqual([]);
    expect(rewritten.decision.verdict).toBe("deny");
  });

  it("(c) with a sub-directory root, a repo path outside it is denied as outside the workspace root", () => {
    const before = snap([], {}, "pkg/");
    const after = snap(["?? pkg/src/x.ts", "?? sibling.txt"], {}, "pkg/");
    const legacy = auditWorkspaceWrites({ before: [], after: after.status, workspaceRoot: root, readOnly: false, policy: P });
    expect(legacy.decision.verdict).toBe("allow"); // misattributed to <root>/sibling.txt
    const r = auditWorkspaceSnapshots({ before, after, workspaceRoot: root, readOnly: false, policy: P, writeScope: [root] });
    expect(r.newlyChanged).toEqual(["src/x.ts", "../sibling.txt"]);
    expect(r.outsideRoot).toEqual(["../sibling.txt"]);
    expect(r.decision.verdict).toBe("deny");
    expect(r.decision.risk).toBe("R3");
    expect(r.decision.reasons.join("\n")).toMatch(/write outside the workspace root/);
  });

  it("(c) observed writes outside a narrower declared scope, and declared scopes outside the root, deny", () => {
    const before = snap([]);
    const after = snap(["?? src/x.ts", "?? docs/y.md"]);
    const narrow = auditWorkspaceSnapshots({ before, after, workspaceRoot: root, readOnly: false, policy: P, writeScope: ["src"] });
    expect(narrow.decision.verdict).toBe("deny");
    expect(narrow.decision.reasons.join("\n")).toMatch(/outside the declared write scope \(docs\/y\.md\)/);
    const escaping = auditWorkspaceSnapshots({ before, after: before, workspaceRoot: root, readOnly: false, policy: P, writeScope: ["../elsewhere"] });
    expect(escaping.decision.verdict).toBe("deny");
    expect(escaping.decision.reasons.join("\n")).toMatch(/declared write scope outside the workspace root/);
  });

  it("surfaces snapshot coverage limits as notes without denying", () => {
    const before = { ...snap([" M a.ts"]), unsigned: 3 };
    const r = auditWorkspaceSnapshots({ before, after: snap([" M a.ts"]), workspaceRoot: root, readOnly: true, policy: P });
    expect(r.decision.verdict).toBe("allow");
    expect(r.notes.join("\n")).toMatch(/3 dirty\/ignored file\(s\) over the snapshot bounds/);
  });
});

// ───────────── real git repos ─────────────

describe.concurrent("takeWorkspaceSnapshot (real git repo)", () => {
  it("signs dirty and small ignored files, never walks ignored directories, and is undefined outside git", ({ onTestFinished }) => {
    const ws = repo(onTestFinished, "", { ".gitignore": "node_modules/\n*.log\n", "src/a.ts": "export const a = 1;\n" });
    mkdirSync(path.join(ws.dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(ws.dir, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(path.join(ws.dir, "debug.log"), "log");
    writeFileSync(path.join(ws.dir, "src", "a.ts"), "export const a = 2;\n");
    const s = takeWorkspaceSnapshot(ws.dir)!;
    expect(s.prefix).toBe("");
    expect(s.status).toContain("!! node_modules/");
    expect(s.status).toContain("!! debug.log");
    expect(Object.keys(s.contents).sort()).toEqual(["debug.log", "src/a.ts"]);
    expect(s.contents["src/a.ts"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(s.contents).some((k) => k.startsWith("node_modules"))).toBe(false);

    const bounded = takeWorkspaceSnapshot(ws.dir, undefined, { limits: { maxIgnoredFiles: 0, maxFileBytes: 1 } })!;
    expect(bounded.unsigned).toBe(1);
    expect(bounded.contents["src/a.ts"]).toMatch(/^stat:/);

    const outside = scratchWorkspace();
    onTestFinished(outside.dispose);
    expect(takeWorkspaceSnapshot(outside.dir, undefined, { git: () => { throw new Error("not a git repository"); } })).toBeUndefined();
  }, SPAWN_TIMEOUT);

  it("reports the sub-directory prefix so paths can be re-based", ({ onTestFinished }) => {
    const ws = repo(onTestFinished, "", { "pkg/src/a.ts": "x\n" });
    const s = takeWorkspaceSnapshot(path.join(ws.dir, "pkg"))!;
    expect(s.prefix).toBe("pkg/");
  }, SPAWN_TIMEOUT);
});

describe.concurrent("pipeline write audit blind spots (real git repos)", () => {
  it(
    "(a) re-modifying a file that was already dirty before the run is a violation in a read-only task",
    async ({ onTestFinished }) => {
      const ws = repo(
        onTestFinished,
        agentThen("fs.appendFileSync('src/a.ts', '// agent edit\\n'); console.log('ANSWER: main is in src/a.ts');"),
        { "src/a.ts": "export const a = 1;\n" }
      );
      writeFileSync(path.join(ws.dir, "src", "a.ts"), "export const a = 1; // operator WIP\n");
      const { security, legacy } = recordingSecurity();
      const r = await run(ws, security, { task: "where is main defined?", category: "query" });
      expect(legacyAudit(legacy, ws.dir, true).newlyChanged).toEqual([]); // the pre-fix blind spot
      expect(r.status).toBe("violation");
      expect(r.writeAudit).toMatchObject({ verdict: "deny", newlyChanged: ["src/a.ts"], rewrittenDirty: ["src/a.ts"] });
      expect(r.security.verdict).toBe("deny");
      expect(r.statusReason).toMatch(/already dirty before the run/);
      expect(r.trace?.failure).toMatchObject({ stage: "violation" });
      expect(r.trace?.securityDecision?.verdict).toBe("deny");
      const audit = r.events.find((e) => e.stage === "security" && e.outcome === "write-audit:deny");
      expect(audit?.evidence).toContain("rewritten-dirty:src/a.ts");
    },
    SPAWN_TIMEOUT
  );

  it(
    "(a) control: an untouched pre-dirty file is not flagged, and a write category may re-edit it",
    async ({ onTestFinished }) => {
      const ws = repo(onTestFinished, agentThen("console.log('ANSWER: nothing to change');"), { "src/a.ts": "a\n" });
      writeFileSync(path.join(ws.dir, "src", "a.ts"), "a // WIP\n");
      const quiet = await run(ws, createDefaultSecurity(), { task: "where is a defined?", category: "query" });
      expect(quiet.status).toBe("completed");
      expect(quiet.writeAudit).toEqual({ verdict: "allow", newlyChanged: [] });

      writeFileSync(ws.agentScript, agentThen("fs.appendFileSync('src/a.ts', 'b\\n'); console.log('ANSWER: edited');"));
      const edit = await run(ws, createDefaultSecurity(), {});
      expect(edit.status).toBe("completed");
      expect(edit.writeAudit).toEqual({ verdict: "allow", newlyChanged: ["src/a.ts"], rewrittenDirty: ["src/a.ts"] });
    },
    SPAWN_TIMEOUT
  );

  it(
    "(b) writing a git-ignored protected file (.env) is a violation",
    async ({ onTestFinished }) => {
      const ws = repo(onTestFinished, agentThen("fs.writeFileSync('.env', 'TOKEN=x'); console.log('ANSWER: wrote env');"), {
        ".gitignore": ".env\nnode_modules/\n",
      });
      const { security, legacy } = recordingSecurity();
      const r = await run(ws, security, {});
      expect(legacyAudit(legacy, ws.dir, false).newlyChanged).toEqual([]); // invisible to plain git status
      expect(r.status).toBe("violation");
      expect(r.writeAudit).toMatchObject({ verdict: "deny", newlyChanged: [".env"], ignoredChanged: [".env"] });
      expect(r.security.risk).toBe("R3");
      expect(r.statusReason).toMatch(/protected path/);
    },
    SPAWN_TIMEOUT
  );

  it(
    "(b) rewriting an existing ignored file in a read-only task is a violation (content signature)",
    async ({ onTestFinished }) => {
      const ws = repo(onTestFinished, agentThen("fs.writeFileSync('notes.log', 'changed'); console.log('ANSWER: done');"), {
        ".gitignore": "*.log\n",
      });
      writeFileSync(path.join(ws.dir, "notes.log"), "original");
      const { security, legacy } = recordingSecurity();
      const r = await run(ws, security, { task: "where is main defined?", category: "query" });
      expect(legacyAudit(legacy, ws.dir, true).newlyChanged).toEqual([]);
      expect(r.status).toBe("violation");
      expect(r.writeAudit).toMatchObject({ verdict: "deny", newlyChanged: ["notes.log"], ignoredChanged: ["notes.log"] });
      expect(r.statusReason).toMatch(/read-only/);
    },
    SPAWN_TIMEOUT
  );

  it(
    "(c) a write to a sibling directory outside a sub-directory root is a violation",
    async ({ onTestFinished }) => {
      const ws = repo(onTestFinished, agentThen("fs.writeFileSync('../sibling.txt', 'x'); console.log('ANSWER: wrote');"), {
        "pkg/src/a.ts": "a\n",
      });
      const root = path.join(ws.dir, "pkg");
      const { security, legacy } = recordingSecurity();
      const r = await run({ dir: root, agentScript: ws.agentScript }, security, {
        validation: [`${quote(process.execPath)} ${quote(path.join(ws.dir, "pass.cjs"))}`],
      });
      const old = legacyAudit(legacy, root, false);
      expect(old.newlyChanged).toEqual(["sibling.txt"]);
      expect(old.decision.verdict).toBe("allow"); // the pre-fix misattribution
      expect(r.status).toBe("violation");
      expect(r.writeAudit).toMatchObject({ verdict: "deny", newlyChanged: ["../sibling.txt"], outsideRoot: ["../sibling.txt"] });
      expect(r.security.risk).toBe("R3");
      expect(r.statusReason).toMatch(/write outside the workspace root/);
      expect(r.contract.permissions?.write).toEqual([root]);
    },
    SPAWN_TIMEOUT
  );

  it(
    "(c) a gate whose declared write scope escapes the root blocks before anything runs",
    async ({ onTestFinished }) => {
      const ws = repo(onTestFinished, agentThen("fs.writeFileSync('x.txt', 'x'); console.log('ANSWER: wrote');"));
      const real = createDefaultSecurity();
      const security: PipelineSecurity = {
        ...real,
        checkWriteScope: (ctx) => real.checkWriteScope({ ...ctx, writeScope: [...(ctx.writeScope ?? []), "../outside"] }),
      };
      const r = await run(ws, security, {});
      expect(r.status).toBe("blocked");
      expect(r.security.verdict).toBe("deny");
      expect(r.security.reasons.join("\n")).toMatch(/declared write scope outside the workspace root \(\.\.\/outside\)/);
      expect(r.execution).toBeUndefined();
    },
    SPAWN_TIMEOUT
  );
});
