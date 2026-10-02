import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSpawn } from "../src/host/spawn-command.js";
import { classifyHarnessComplexity, classifyTaskCategory, isReadOnlyCategory } from "../src/agent/classify.js";
import {
  createExperienceStore,
  jaccard,
  searchExperience,
  toTrajectories,
  type ExperienceRecord,
  type RunStatus,
} from "../src/agent/experience.js";
import { collectProjectFacts, rankRelevantFiles, taskTokens } from "../src/host/project-facts.js";
import { createAgentTaskWorker, type AgentExecutorSpec } from "../src/workers/agent-task-worker.js";
import { createLocalCommandWorker } from "../src/workers/local-command-worker.js";
import { scratchWorkspace } from "./helpers/pipeline-fixtures.js";

const T = 30_000;
const cleanups: Array<() => void> = [];
function tmp(prefix = "eff-host-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

// ───────────── resolveSpawn ─────────────

describe("resolveSpawn", () => {
  it("non-Windows: passthrough, never via a shim", () => {
    expect(resolveSpawn("npx", ["vitest", "run"], "linux", {})).toEqual({ command: "npx", args: ["vitest", "run"], viaCmdShim: false });
    expect(resolveSpawn("tool.cmd", ["a"], "darwin", {})).toEqual({ command: "tool.cmd", args: ["a"], viaCmdShim: false });
  });

  it("Windows: a .cmd shim found on PATH routes through cmd.exe with every argument quoted", () => {
    const dir = tmp();
    const shim = join(dir, "tool.cmd");
    writeFileSync(shim, "@echo off\r\n");
    const env = { PATH: dir, PATHEXT: ".EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    const r = resolveSpawn("tool", ["a b", 'say "hi"'], "win32", env);
    expect(r.viaCmdShim).toBe(true);
    expect(r.windowsVerbatimArguments).toBe(true);
    expect(r.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(r.args[3]).toBe(`""${shim}" "a b" "say ""hi""""`);
  });

  it("Windows: explicit .bat path routes via the shim; ComSpec falls back to cmd.exe", () => {
    const r = resolveSpawn("C:\\tools\\run.bat", ["x"], "win32", {});
    expect(r).toMatchObject({ command: "cmd.exe", viaCmdShim: true });
    expect(r.args[3]).toBe(`""C:\\tools\\run.bat" "x""`);
  });

  it("Windows: plain executables (absolute .exe, or not found on PATH) spawn directly", () => {
    expect(resolveSpawn("C:\\node\\node.exe", ["-v"], "win32", {})).toEqual({ command: "C:\\node\\node.exe", args: ["-v"], viaCmdShim: false });
    const empty = tmp();
    expect(resolveSpawn("definitely-not-a-tool", ["a"], "win32", { PATH: empty })).toEqual({
      command: "definitely-not-a-tool",
      args: ["a"],
      viaCmdShim: false,
    });
    const dir = tmp();
    writeFileSync(join(dir, "real.exe"), "");
    expect(resolveSpawn("real", [], "win32", { PATH: dir, PATHEXT: ".EXE;.CMD" }).command).toBe(join(dir, "real.exe"));
  });

  it("default platform (process.platform): node itself always spawns directly", () => {
    const r = resolveSpawn(process.execPath, ["-v"]);
    expect(r.viaCmdShim).toBe(false);
    expect(r.command).toBe(process.execPath);
    if (process.platform !== "win32") {
      expect(resolveSpawn("anything.cmd", [])).toEqual({ command: "anything.cmd", args: [], viaCmdShim: false });
    }
  });

  it.runIf(process.platform === "win32")(
    "Windows: a resolved .cmd shim really runs, with spaces and quotes intact",
    () => {
      const dir = tmp("eff shim ");
      writeFileSync(join(dir, "echoer.cmd"), "@echo off\r\necho ARG1=%~1\r\n");
      const env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` };
      const spec = resolveSpawn("echoer", ["hello world"], "win32", env);
      expect(spec.viaCmdShim).toBe(true);
      const result = spawnSync(spec.command, spec.args, {
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments ?? false,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ARG1=hello world");
    },
    T
  );
});

// ───────────── classify ─────────────

describe("classifyTaskCategory / isReadOnlyCategory / classifyHarnessComplexity", () => {
  const cases: Array<[string, string]> = [
    ["Where is the model router configured in this project?", "query"],
    ["Fix the build?", "query"],
    ["Explain the reuse gate", "query"],
    ["list all exported symbols", "query"],
    ["Fix loadAllEpisodes so it no longer stops at 200 episodes", "bugfix"],
    ["The parser is broken on empty input", "bugfix"],
    ["修复登录错误", "bugfix"],
    ["Refactor graph store transport selection", "refactor"],
    ["Consolidate the benchmark runners", "refactor"],
    ["Design and implement per-project memory isolation across agent tools", "cross-module"],
    ["Make dialogue recall workspace-scoped end to end", "cross-module"],
    ["Add tests for the cost optimizer", "test"],
    ["Update the README with install steps", "docs"],
    ["Change the timeout setting", "config"],
    ["Export seedWorkbenchFromPlan from the CLI runtime index module", "single-file"],
    ["The parser crashes on empty input", "bugfix"],
    ["Login crashed after the upgrade", "bugfix"],
    ["Two tests failed in CI", "bugfix"],
  ];
  for (const [task, category] of cases) {
    it(`"${task}" -> ${category}`, () => {
      expect(classifyTaskCategory(task)).toBe(category);
    });
  }

  it("read-only categories are query/docs/config only", () => {
    for (const c of ["query", "docs", "config"]) expect(isReadOnlyCategory(c)).toBe(true);
    for (const c of ["bugfix", "refactor", "single-file", "multi-file", "cross-module", "test", "deliberate-failure"]) {
      expect(isReadOnlyCategory(c)).toBe(false);
    }
  });

  it("harness complexity: REUSE trivial, read-only simple, cross-cutting complex, else by file count", () => {
    expect(classifyHarnessComplexity({ category: "bugfix", reuseMode: "REUSE", relevantFileCount: 10 })).toBe("trivial");
    expect(classifyHarnessComplexity({ category: "query", reuseMode: "FRESH", relevantFileCount: 10 })).toBe("simple");
    expect(classifyHarnessComplexity({ category: "docs", reuseMode: "ADAPT", relevantFileCount: 0 })).toBe("simple");
    for (const c of ["cross-module", "refactor", "multi-file"]) {
      expect(classifyHarnessComplexity({ category: c, reuseMode: "FRESH", relevantFileCount: 1 })).toBe("complex");
    }
    expect(classifyHarnessComplexity({ category: "bugfix", reuseMode: "FRESH", relevantFileCount: 4 })).toBe("medium");
    expect(classifyHarnessComplexity({ category: "bugfix", reuseMode: "ADAPT", relevantFileCount: 5 })).toBe("complex");
  });
});

// ───────────── experience ─────────────

function rec(overrides: Partial<ExperienceRecord> & { status: RunStatus }): ExperienceRecord {
  return {
    taskId: `id-${Math.random().toString(16).slice(2, 8)}`,
    task: "fix the model router fallback",
    category: "bugfix",
    worker: "agent:node",
    reuseMode: "FRESH",
    modelTier: "standard",
    rounds: 1,
    durationMs: 100,
    agentInvocations: 1,
    cacheHits: 0,
    cacheMisses: 1,
    validationPassed: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("experience store", () => {
  it("append/read round-trip on a temp file; missing file reads empty; corrupt lines skipped", () => {
    const file = join(tmp(), "nested", "history.jsonl");
    const store = createExperienceStore(file);
    expect(store.read()).toEqual([]);
    const a = rec({ status: "completed", taskId: "a" });
    const b = rec({ status: "failed", taskId: "b", lesson: "validate: npm test" });
    store.append(a);
    store.append(b);
    writeFileSync(file, `${JSON.stringify(a)}\n{ corrupt\n${JSON.stringify({ nope: 1 })}\n${JSON.stringify(b)}\n`);
    expect(store.read()).toEqual([a, b]);
  });

  it("jaccard / searchExperience: floor, limit and best-first order", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    const history = [
      rec({ status: "completed", taskId: "near", task: "fix the model router fallback path", finishedAt: "2026-01-01T00:00:02.000Z" }),
      rec({ status: "completed", taskId: "exact", task: "fix the model router fallback" }),
      rec({ status: "completed", taskId: "far", task: "update readme install docs" }),
    ];
    const hits = searchExperience("Fix the model router fallback", history);
    expect(hits.map((h) => h.record.taskId)).toEqual(["exact", "near"]);
    expect(hits[0]!.similarity).toBe(1);
    expect(searchExperience("Fix the model router fallback", history, { limit: 1 })).toHaveLength(1);
    expect(searchExperience("Fix the model router fallback", history, { floor: 0 })).toHaveLength(3);
    expect(searchExperience("completely unrelated words here", history)).toEqual([]);
  });

  it("toTrajectories excludes not-executed / advisory-only / blocked / validation-only runs", () => {
    const history: ExperienceRecord[] = [
      rec({ status: "completed", taskId: "c" }),
      rec({ status: "reused", taskId: "r" }),
      rec({ status: "failed", taskId: "f", lesson: "validate: x" }),
      rec({ status: "unverified", taskId: "u", rounds: 0 }),
      rec({ status: "budget-exhausted", taskId: "be" }),
      rec({ status: "violation", taskId: "v" }),
      rec({ status: "not-executed", taskId: "ne" }),
      rec({ status: "advisory-only", taskId: "ao" }),
      rec({ status: "blocked", taskId: "bl" }),
      rec({ status: "validation-only", taskId: "vo" }),
    ];
    const t = toTrajectories(history);
    expect(t.map((x) => x.taskId)).toEqual(["c", "r", "f", "u", "be", "v"]);
    const byId = Object.fromEntries(t.map((x) => [x.taskId, x]));
    expect(byId.c!.success).toBe(true);
    expect(byId.r!.success).toBe(true);
    expect(byId.f!.success).toBe(false);
    expect(byId.f!.failureStage).toBe("validate: x");
    expect(byId.u!.failureStage).toBe("unverified");
    expect(byId.u!.rounds).toBe(1);
    expect(byId.c!.failureStage).toBeUndefined();
  });
});

// ───────────── project facts ─────────────

describe("collectProjectFacts", () => {
  function makeRepo(): string {
    const repo = tmp("eff-facts-");
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Eff Test"]);
    git(repo, ["config", "user.email", "eff-test@example.invalid"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "router.ts"), "export function routeModel() { return 1; }\nexport const TIER = 'x';\n");
    writeFileSync(join(repo, "src", "other.ts"), "export class Unrelated {}\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "facts-fixture", scripts: { test: "vitest" }, dependencies: { a: "1" } }));
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init facts fixture"]);
    return repo;
  }

  it(
    "git repo: 40-hex gitHead, relevant file hashes, lock hash, twin facts",
    () => {
      const repo = makeRepo();
      const facts = collectProjectFacts(repo, "Fix routeModel in src/router.ts");
      expect(facts.isGitRepo).toBe(true);
      expect(facts.projectState.gitHead).toMatch(/^[0-9a-f]{40}$/);
      expect(facts.projectState.gitHead).toBe(git(repo, ["rev-parse", "HEAD"]).trim());
      expect(facts.relevantFiles[0]).toBe("src/router.ts");
      expect(facts.projectState.relevantFileHashes["src/router.ts"]).toMatch(/^[0-9a-f]{16}$/);
      expect(facts.relevantFiles).not.toContain("package.json");
      expect(Object.keys(facts.projectState.relevantFileHashes)).toEqual(facts.relevantFiles);
      expect(facts.projectState.dependencyLockHash).toMatch(/^package-lock\.json:[0-9a-f]{16}$/);
      expect(facts.projectState.workingTreeHash).toMatch(/^[0-9a-f]{16}$/);
      expect(facts.symbolsByFile.get("src/router.ts")).toEqual(["routeModel", "TIER"]);
      expect(facts.twinFacts.packageJson).toMatchObject({ name: "facts-fixture", dependencies: ["a"] });
      expect(facts.twinFacts.recentCommits).toHaveLength(1);
      expect(facts.twinFacts.fileMap.map((f) => f.path).sort()).toEqual(["package-lock.json", "package.json", "src/other.ts", "src/router.ts"]);
    },
    T
  );

  it(
    "file edits change the relevant hash and working tree hash; graphflow-out churn does not",
    () => {
      const repo = makeRepo();
      const before = collectProjectFacts(repo, "Fix routeModel in src/router.ts");
      mkdirSync(join(repo, "graphflow-out"), { recursive: true });
      writeFileSync(join(repo, "graphflow-out", "state.json"), "{}");
      const afterState = collectProjectFacts(repo, "Fix routeModel in src/router.ts");
      expect(afterState.projectState.workingTreeHash).toBe(before.projectState.workingTreeHash);
      writeFileSync(join(repo, "src", "router.ts"), "export function routeModel() { return 2; }\n");
      const afterEdit = collectProjectFacts(repo, "Fix routeModel in src/router.ts");
      expect(afterEdit.projectState.workingTreeHash).not.toBe(before.projectState.workingTreeHash);
      expect(afterEdit.projectState.relevantFileHashes["src/router.ts"]).not.toBe(before.projectState.relevantFileHashes["src/router.ts"]);
      expect(afterEdit.projectState.gitHead).toBe(before.projectState.gitHead);
    },
    T
  );

  it(
    "non-git directory: no gitHead, no listed files, isGitRepo false",
    () => {
      const dir = tmp("eff-nogit-");
      writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
      const facts = collectProjectFacts(dir, "update index.ts");
      expect(facts.isGitRepo).toBe(false);
      expect(facts.projectState.gitHead).toBeUndefined();
      expect(facts.projectState.workingTreeHash).toBeUndefined();
      expect(facts.twinFacts.fileMap).toEqual([]);
      // extraRelevantFiles still binds known files that exist.
      const withExtra = collectProjectFacts(dir, "update index.ts", { extraRelevantFiles: ["index.ts", "missing.ts"] });
      expect(withExtra.relevantFiles).toEqual(["index.ts"]);
    },
    T
  );

  it("taskTokens / rankRelevantFiles are deterministic", () => {
    expect(taskTokens("Fix routeModel in src/router.ts")).toEqual(["fix", "route", "model", "src", "router"]);
    const symbols = new Map([["b/router.ts", ["routeModel"]]]);
    expect(rankRelevantFiles("fix routeModel", ["b/router.ts", "a/router.ts", "z.md"], symbols)).toEqual(["b/router.ts"]);
    // Verbatim path mention (+100) beats a symbol hit; ties break on path.
    expect(rankRelevantFiles("fix routeModel in a/router.ts", ["b/router.ts", "a/router.ts", "z.md"], symbols)).toEqual([
      "a/router.ts",
      "b/router.ts",
    ]);
    expect(rankRelevantFiles("model router", ["y/model.ts", "x/model.ts"], new Map())).toEqual(["x/model.ts", "y/model.ts"]);
  });
});

// ───────────── agent task worker ─────────────

describe("createAgentTaskWorker", () => {
  function spec(script: string, overrides: Partial<AgentExecutorSpec> = {}): AgentExecutorSpec {
    return { command: process.execPath, args: [script], promptVia: "stdin", timeoutMs: 20_000, ...overrides };
  }
  const nodeCmd = (file: string) => `"${process.execPath}" "${file}"`;

  it(
    "real round via the node fake agent: prompt on stdin, validation passes",
    async () => {
      const ws = scratchWorkspace();
      cleanups.push(() => ws.dispose());
      const prompts: string[] = [];
      const worker = createAgentTaskWorker({
        executor: spec(ws.agentScript),
        cwd: ws.dir,
        validation: [nodeCmd(join(ws.dir, "pass.cjs"))],
        buildPrompt: (round) => {
          const p = `round ${round}: do the task`;
          prompts.push(p);
          return p;
        },
      });
      expect(worker.name).toBe(`agent:${process.execPath}`);
      const cmd = await worker.prepare([]);
      expect(cmd).toMatchObject({ command: process.execPath, args: [ws.agentScript], cwd: ws.dir, timeoutMs: 20_000 });
      const obs = await worker.execute(cmd!);
      expect(obs.exitCode).toBe(0);
      expect(obs.stdoutTail).toContain(`ANSWER: handled task; prompt chars=${prompts[0]!.length}`);
      const outcome = await worker.validate(obs);
      expect(outcome.passed).toBe(true);
      expect(outcome.checks.map((c) => c.name)).toEqual(["agent-exit-code", `validate: ${nodeCmd(join(ws.dir, "pass.cjs"))}`]);
      expect(worker.unverified()).toBe(false);
      expect(worker.invocations()).toBe(1);
      expect(worker.lastOutput()).toContain("ANSWER:");
      await worker.stop();
    },
    T
  );

  it(
    "unverified when there is no validation (never success)",
    async () => {
      const ws = scratchWorkspace();
      cleanups.push(() => ws.dispose());
      const worker = createAgentTaskWorker({ executor: spec(ws.agentScript), cwd: ws.dir, validation: [], buildPrompt: () => "p" });
      const obs = await worker.execute((await worker.prepare([]))!);
      const outcome = await worker.validate(obs);
      expect(outcome.passed).toBe(false);
      expect(outcome.checks).toEqual([
        { name: "agent-exit-code", passed: true },
        { name: "no-validation-commands", passed: false },
      ]);
      expect(worker.unverified()).toBe(true);
    },
    T
  );

  it(
    "failing validation feeds the failure back into the next round's prompt",
    async () => {
      const ws = scratchWorkspace();
      cleanups.push(() => ws.dispose());
      const feedbacks: Array<string | undefined> = [];
      const worker = createAgentTaskWorker({
        executor: spec(ws.agentScript),
        cwd: ws.dir,
        validation: [nodeCmd(join(ws.dir, "fail.cjs"))],
        buildPrompt: (_round, feedback) => {
          feedbacks.push(feedback);
          return "p";
        },
      });
      const first = await worker.validate(await worker.execute((await worker.prepare([]))!));
      expect(first.passed).toBe(false);
      expect(worker.unverified()).toBe(false);
      await worker.prepare([]);
      expect(feedbacks[0]).toBeUndefined();
      expect(feedbacks[1]).toContain("failed (exit 1)");
      expect(feedbacks[1]).toContain("assertion failed");
    },
    T
  );

  it(
    "non-zero agent exit fails without running validation; promptVia=arg substitutes {prompt}",
    async () => {
      const ws = scratchWorkspace("console.log('ARG=' + process.argv[2]); process.exit(process.argv[2] === 'boom' ? 7 : 0);");
      cleanups.push(() => ws.dispose());
      const worker = createAgentTaskWorker({
        executor: spec(ws.agentScript, { args: [ws.agentScript, "{prompt}"], promptVia: "arg" }),
        cwd: ws.dir,
        validation: [nodeCmd(join(ws.dir, "pass.cjs"))],
        buildPrompt: () => "boom",
      });
      const cmd = await worker.prepare([]);
      expect(cmd!.args).toEqual([ws.agentScript, "boom"]);
      const obs = await worker.execute(cmd!);
      expect(obs.exitCode).toBe(7);
      expect(obs.stdoutTail).toContain("ARG=boom");
      const outcome = await worker.validate(obs);
      expect(outcome).toEqual({ passed: false, checks: [{ name: "agent-exit-code", passed: false }] });
    },
    T
  );

  it(
    "stop() kills a sleeping agent promptly",
    async () => {
      const ws = scratchWorkspace("setTimeout(() => console.log('woke'), 60000);");
      cleanups.push(() => ws.dispose());
      const worker = createAgentTaskWorker({ executor: spec(ws.agentScript, { timeoutMs: 60_000 }), cwd: ws.dir, validation: [], buildPrompt: () => "p" });
      const started = Date.now();
      const running = worker.execute((await worker.prepare([]))!);
      await new Promise((r) => setTimeout(r, 500));
      await worker.stop();
      const obs = await running;
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(obs.exitCode).not.toBe(0);
      expect(obs.stdoutTail ?? "").not.toContain("woke");
      // Second stop is a no-op.
      await expect(worker.stop()).resolves.toBeUndefined();
    },
    T
  );

  it(
    "timeout kills the agent and reports it",
    async () => {
      const ws = scratchWorkspace("setTimeout(() => {}, 60000);");
      cleanups.push(() => ws.dispose());
      const worker = createAgentTaskWorker({ executor: spec(ws.agentScript, { timeoutMs: 500 }), cwd: ws.dir, validation: [], buildPrompt: () => "p" });
      const obs = await worker.execute((await worker.prepare([]))!);
      expect(obs.exitCode).not.toBe(0);
      expect(obs.stderrTail).toContain("[agent] timed out after 500ms");
    },
    T
  );

  /** A .cmd shim whose real process (node) outlives cmd.exe unless the whole tree is killed. */
  function sleepingShim(): string {
    const dir = tmp("eff-shim-timeout-");
    writeFileSync(join(dir, "sleep.cjs"), "setTimeout(() => {}, 8000);\n");
    const shim = join(dir, "agent.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${join(dir, "sleep.cjs")}"\r\n`);
    return shim;
  }

  it.runIf(process.platform === "win32")(
    "Windows: an agent behind a .cmd shim is killed as a tree on timeout",
    async () => {
      const shim = sleepingShim();
      const worker = createAgentTaskWorker({
        executor: { command: shim, args: [], promptVia: "stdin", timeoutMs: 500 },
        cwd: tmp(),
        validation: [],
        buildPrompt: () => "p",
      });
      const started = Date.now();
      const obs = await worker.execute((await worker.prepare([]))!);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(obs.stderrTail).toContain("[agent] timed out after 500ms");
    },
    T
  );

  it.runIf(process.platform === "win32")(
    "Windows: a validation command behind a .cmd shim is killed as a tree on timeout",
    async () => {
      const shim = sleepingShim();
      const worker = createLocalCommandWorker({ defaultTimeoutMs: 500 });
      const started = Date.now();
      const obs = await worker.execute({ command: shim, args: [] });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(obs.exitCode).toBeUndefined();
      expect(obs.stderrTail).toContain("process tree killed after timeout 500ms");
      expect((await worker.validate(obs)).passed).toBe(false);
    },
    T
  );
});
