import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  armPipelineMode,
  BENCH_ARMS,
  createTaskWorkspace,
  judgeOracle,
  planBenchTasks,
  planBenchUnits,
  reuseExpectationOutcome,
  runGuards,
  withVerdict,
  workspaceChanges,
  type OracleVerdict,
} from "../src/bench-runner.js";
import type { EffTask, LongHorizonSession } from "../src/corpus.js";
import { measured } from "../src/measurement.js";
import type { TaskTrace } from "../src/trace.js";

const NODE = `"${process.execPath}"`;
const T = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

interface Fixture {
  root: string;
  repo: string;
  parent: string;
  base: string;
  hidden: string;
}

let fx: Fixture;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "eff-bench-runner-"));
  const repo = join(root, "repo");
  const parent = join(root, "worktrees");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Eff Test"]);
  git(repo, ["config", "user.email", "eff-test@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "src", "a.txt"), "hello world\n");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]).trim();
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(
    join(repo, "tests", "hidden.cjs"),
    [
      "const fs = require('fs');",
      "const text = fs.readFileSync('src/a.txt', 'utf8');",
      "process.exit(text.includes('hello') ? 0 : 1);",
    ].join("\n")
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add hidden test"]);
  const hidden = git(repo, ["rev-parse", "HEAD"]).trim();
  // Untracked node_modules: the workspace links it in and must never delete it.
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 42;\n");
  fx = { root, repo, parent, base, hidden };
});

afterAll(() => {
  if (!fx) return;
  try {
    git(fx.repo, ["worktree", "prune"]);
  } catch {
    // best effort
  }
  rmSync(fx.root, { recursive: true, force: true });
});

function withWorkspace<T>(revision: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const ws = createTaskWorkspace(fx.repo, revision, fx.parent);
  return fn(ws.dir).finally(() => ws.dispose());
}

describe("createTaskWorkspace", () => {
  it(
    "creates a detached worktree at the revision; dispose removes it and keeps the source node_modules",
    () => {
      const ws = createTaskWorkspace(fx.repo, fx.base, fx.parent);
      const name = basename(ws.dir);
      try {
        expect(ws.revision).toBe(fx.base);
        expect(existsSync(join(ws.dir, "src", "a.txt"))).toBe(true);
        expect(existsSync(join(ws.dir, "tests", "hidden.cjs"))).toBe(false);
        expect(git(ws.dir, ["rev-parse", "HEAD"]).trim()).toBe(fx.base);
        // Detached: symbolic-ref fails on a detached HEAD.
        expect(() => git(ws.dir, ["symbolic-ref", "-q", "HEAD"])).toThrow();
        expect(git(fx.repo, ["worktree", "list", "--porcelain"])).toContain(name);
        // node_modules linked in (junction on Windows, symlink elsewhere).
        const linked = join(ws.dir, "node_modules");
        expect(lstatSync(linked).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(linked, "dep", "index.js"), "utf8")).toContain("42");
      } finally {
        ws.dispose();
      }
      expect(existsSync(ws.dir)).toBe(false);
      expect(git(fx.repo, ["worktree", "list", "--porcelain"])).not.toContain(name);
      expect(existsSync(join(fx.repo, "node_modules", "dep", "index.js"))).toBe(true);
      // Idempotent.
      expect(() => ws.dispose()).not.toThrow();
    },
    T
  );

  it(
    "defaults to HEAD and resolves the revision to a full sha",
    () => {
      const ws = createTaskWorkspace(fx.repo, undefined, fx.parent);
      try {
        expect(ws.revision).toBe(fx.hidden);
        expect(existsSync(join(ws.dir, "tests", "hidden.cjs"))).toBe(true);
      } finally {
        ws.dispose();
      }
    },
    T
  );

  it("throws for an unknown revision", () => {
    expect(() => createTaskWorkspace(fx.repo, "0".repeat(40), fx.parent)).toThrow();
  });
});

describe("judgeOracle", () => {
  it("unjudged when the oracle is undefined", async () => {
    expect(await judgeOracle({ oracle: undefined, output: "anything", cwd: fx.repo })).toEqual({
      judged: false,
      passed: false,
      checks: [],
    });
  });

  it("outputAnyOf is case-insensitive and needs one hit", async () => {
    const pass = await judgeOracle({ oracle: { outputAnyOf: ["Model-Router", "nope"] }, output: "see src/routing/MODEL-ROUTER.ts", cwd: fx.repo });
    expect(pass.judged).toBe(true);
    expect(pass.passed).toBe(true);
    expect(pass.checks).toHaveLength(1);
    const fail = await judgeOracle({ oracle: { outputAnyOf: ["alpha", "beta"] }, output: "gamma", cwd: fx.repo });
    expect(fail).toMatchObject({ judged: true, passed: false });
  });

  it("outputAllOf needs every needle (one check per needle)", async () => {
    const pass = await judgeOracle({ oracle: { outputAllOf: ["foo", "BAR"] }, output: "Foo and bar", cwd: fx.repo });
    expect(pass.passed).toBe(true);
    expect(pass.checks).toHaveLength(2);
    const fail = await judgeOracle({ oracle: { outputAllOf: ["foo", "baz"] }, output: "foo only", cwd: fx.repo });
    expect(fail.passed).toBe(false);
    expect(fail.checks.map((c) => c.passed)).toEqual([true, false]);
  });

  it(
    "files regex matches against the workspace file (missing file fails)",
    () =>
      withWorkspace(fx.base, async (dir) => {
        const pass = await judgeOracle({ oracle: { files: [{ path: "src/a.txt", pattern: "^hello\\s+world" }] }, output: "", cwd: dir });
        expect(pass.passed).toBe(true);
        const fail = await judgeOracle({ oracle: { files: [{ path: "src/a.txt", pattern: "^goodbye" }] }, output: "", cwd: dir });
        expect(fail.passed).toBe(false);
        const missing = await judgeOracle({ oracle: { files: [{ path: "src/missing.txt", pattern: "." }] }, output: "", cwd: dir });
        expect(missing.passed).toBe(false);
      }),
    T
  );

  it(
    "commands must exit 0 in the workspace",
    () =>
      withWorkspace(fx.base, async (dir) => {
        const pass = await judgeOracle({ oracle: { commands: [`${NODE} -e "process.exit(0)"`] }, output: "", cwd: dir });
        expect(pass).toMatchObject({ judged: true, passed: true });
        const fail = await judgeOracle({
          oracle: { commands: [`${NODE} -e "process.exit(0)"`, `${NODE} -e "process.exit(3)"`] },
          output: "",
          cwd: dir,
        });
        expect(fail.passed).toBe(false);
        expect(fail.checks.map((c) => c.passed)).toEqual([true, false]);
      }),
    T
  );

  it(
    "refusal: signal required; noChanges fails once the workspace is modified",
    () =>
      withWorkspace(fx.base, async (dir) => {
        const oracle = { refusal: { signals: ["does not exist"], noChanges: true } };
        const clean = await judgeOracle({ oracle, output: "That file DOES NOT EXIST.", cwd: dir });
        expect(clean.passed).toBe(true);
        expect(clean.checks).toHaveLength(2);
        const noSignal = await judgeOracle({ oracle, output: "Done, fixed it.", cwd: dir });
        expect(noSignal.passed).toBe(false);
        writeFileSync(join(dir, "src", "new.txt"), "agent wrote this\n");
        expect(workspaceChanges(dir).length).toBe(1);
        const dirty = await judgeOracle({ oracle, output: "It does not exist", cwd: dir });
        expect(dirty.passed).toBe(false);
        expect(dirty.checks.find((c) => c.name.startsWith("no files changed"))?.passed).toBe(false);
        // Without noChanges only the signal is judged.
        const lenient = await judgeOracle({ oracle: { refusal: { signals: ["does not exist"] } }, output: "it does not exist", cwd: dir });
        expect(lenient.passed).toBe(true);
        expect(lenient.checks).toHaveLength(1);
      }),
    T
  );

  it(
    "overlayFrom checks out hidden tests from a commit before commands run",
    () =>
      withWorkspace(fx.base, async (dir) => {
        expect(existsSync(join(dir, "tests", "hidden.cjs"))).toBe(false);
        const verdict = await judgeOracle({
          oracle: { overlayFrom: { commit: fx.hidden, paths: ["tests/hidden.cjs"] }, commands: [`${NODE} tests/hidden.cjs`] },
          output: "",
          cwd: dir,
        });
        expect(existsSync(join(dir, "tests", "hidden.cjs"))).toBe(true);
        expect(verdict.checks.map((c) => c.passed)).toEqual([true, true]);
        expect(verdict.passed).toBe(true);
      }),
    T
  );

  it(
    "overlayFrom: hidden test fails when the agent broke the code; bad commit fails the overlay check",
    () =>
      withWorkspace(fx.base, async (dir) => {
        writeFileSync(join(dir, "src", "a.txt"), "goodbye\n");
        const broken = await judgeOracle({
          oracle: { overlayFrom: { commit: fx.hidden, paths: ["tests/hidden.cjs"] }, commands: [`${NODE} tests/hidden.cjs`] },
          output: "",
          cwd: dir,
        });
        expect(broken.checks.map((c) => c.passed)).toEqual([true, false]);
        expect(broken.passed).toBe(false);
        const badCommit = await judgeOracle({
          oracle: { overlayFrom: { commit: "f".repeat(40), paths: ["tests/nope.cjs"] }, commands: [`${NODE} -e "process.exit(0)"`] },
          output: "",
          cwd: dir,
        });
        expect(badCommit.checks[0]).toMatchObject({ passed: false });
        expect(badCommit.passed).toBe(false);
      }),
    T
  );
});

describe("runGuards", () => {
  it("undefined / empty guards -> undefined", async () => {
    expect(await runGuards(undefined, fx.repo)).toBeUndefined();
    expect(await runGuards([], fx.repo)).toBeUndefined();
  });

  it(
    "regression passed / failed",
    async () => {
      const ok = await runGuards([`${NODE} -e "process.exit(0)"`], fx.repo);
      expect(ok).toEqual({ passed: true, checks: [{ name: `guard: ${NODE} -e "process.exit(0)"`, passed: true }] });
      const bad = await runGuards([`${NODE} -e "process.exit(0)"`, `${NODE} -e "process.exit(2)"`], fx.repo);
      expect(bad?.passed).toBe(false);
      expect(bad?.checks.map((c) => c.passed)).toEqual([true, false]);
    },
    T
  );
});

function minimalTrace(overrides: Partial<TaskTrace> = {}): TaskTrace {
  return {
    schemaVersion: "1.0",
    traceId: "t-1",
    task: { text: "do the thing", taskId: "pipeline-hash", category: "bugfix" },
    run: { worker: "agent:node", mode: "conservative", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" },
    context: { tokens: measured(0), anchors: 0, cacheHit: false },
    llm: { calls: measured(0) },
    tools: [],
    rounds: measured(1),
    validation: [],
    result: { success: true },
    ...overrides,
  };
}

describe("withVerdict", () => {
  const passed: OracleVerdict = { judged: true, passed: true, checks: [{ name: "c", passed: true }] };
  const failed: OracleVerdict = { judged: true, passed: false, checks: [{ name: "c", passed: false }] };
  const unjudged: OracleVerdict = { judged: false, passed: false, checks: [] };

  it("judged: success follows the oracle, oracle block attached, bench task id + arm set", () => {
    const t = withVerdict(minimalTrace({ result: { success: true } }), failed, "rep-001", { arm: "graphflow" });
    expect(t.judged).toBe(true);
    expect(t.result.success).toBe(false);
    expect(t.oracle).toEqual({ passed: false, checks: [{ name: "c", passed: false }] });
    expect(t.task.taskId).toBe("rep-001");
    expect(t.task.text).toBe("do the thing");
    expect(t.run.arm).toBe("graphflow");
    const t2 = withVerdict(minimalTrace({ result: { success: false } }), passed, "rep-002");
    expect(t2.result.success).toBe(true);
    expect(t2.run.arm).toBeUndefined();
  });

  it("unjudged: success keeps the trace's own value and no oracle block", () => {
    const t = withVerdict(minimalTrace({ result: { success: true } }), unjudged, "cx-001");
    expect(t.judged).toBe(false);
    expect(t.oracle).toBeUndefined();
    expect(t.result.success).toBe(true);
    const t2 = withVerdict(minimalTrace({ result: { success: false } }), unjudged, "cx-002");
    expect(t2.result.success).toBe(false);
  });

  it("regression attached when provided; input trace not mutated", () => {
    const input = minimalTrace();
    const regression = { passed: false, checks: [{ name: "guard: x", passed: false }] };
    const t = withVerdict(input, passed, "reg-001", { arm: "baseline", regression });
    expect(t.regression).toEqual(regression);
    expect(input.regression).toBeUndefined();
    expect(input.task.taskId).toBe("pipeline-hash");
    expect(input.judged).toBeUndefined();
  });
});

describe("planBenchTasks", () => {
  const task = (id: string, cohort: EffTask["cohort"], baseCommit?: string): EffTask => ({
    id,
    cohort,
    category: "query",
    source: "authored",
    text: `task text for ${id}`,
    ...(baseCommit ? { baseCommit } : {}),
  });
  const tasks = [task("rep-001", "repetition", "a".repeat(40)), task("rep-002", "repetition"), task("reg-001", "regular", "b".repeat(40)), task("fail-001", "failure")];

  it("no filters: all tasks, revision = baseCommit or HEAD", () => {
    const plans = planBenchTasks(tasks);
    expect(plans.map((p) => p.task.id)).toEqual(["rep-001", "rep-002", "reg-001", "fail-001"]);
    expect(plans.map((p) => p.revision)).toEqual(["a".repeat(40), "HEAD", "b".repeat(40), "HEAD"]);
  });

  it("limit slices after filtering; non-positive limit is ignored", () => {
    expect(planBenchTasks(tasks, 2).map((p) => p.task.id)).toEqual(["rep-001", "rep-002"]);
    expect(planBenchTasks(tasks, 0)).toHaveLength(4);
    expect(planBenchTasks(tasks, -1)).toHaveLength(4);
  });

  it("only matches ids or cohorts", () => {
    expect(planBenchTasks(tasks, undefined, ["fail-001"]).map((p) => p.task.id)).toEqual(["fail-001"]);
    expect(planBenchTasks(tasks, undefined, ["repetition"]).map((p) => p.task.id)).toEqual(["rep-001", "rep-002"]);
    expect(planBenchTasks(tasks, 1, ["repetition", "regular"]).map((p) => p.task.id)).toEqual(["rep-001"]);
    expect(planBenchTasks(tasks, undefined, [])).toHaveLength(4);
    expect(planBenchTasks(tasks, undefined, ["nothing"])).toEqual([]);
  });

  it("only also matches a paraphrase family id", () => {
    const fam = [{ ...task("ext-rep-001", "repetition"), family: "fam-a" }, { ...task("ext-rep-002", "repetition"), family: "fam-a" }, task("ext-reg-001", "regular")];
    expect(planBenchTasks(fam, undefined, ["fam-a"]).map((p) => p.task.id)).toEqual(["ext-rep-001", "ext-rep-002"]);
  });
});

describe("planBenchUnits", () => {
  const goldenTask = (id: string): EffTask => ({ id, cohort: "regular", category: "query", source: "authored", text: `task text for ${id}`, baseCommit: "c".repeat(40) });
  const step = (sessionId: string, n: number, session: number, reuse: LongHorizonSession["steps"][number]["expect"]["reuse"]): LongHorizonSession["steps"][number] => ({
    id: `${sessionId}-s${n}`,
    step: n,
    session,
    category: "query",
    text: `step ${n} of ${sessionId}`,
    dependsOn: n > 1 ? [`${sessionId}-s${n - 1}`] : [],
    ...(reuse !== "fresh" ? { equivalentTo: `${sessionId}-s1` } : {}),
    expect: { reuse, memory: n > 1 ? "required" : "none", stateChange: false },
    oracle: { outputAnyOf: ["x"] },
  });
  const lhSession = (id: string, template: string): LongHorizonSession => ({
    id,
    dataset: "long-horizon-v1",
    template,
    title: `session ${id}`,
    baseCommit: "d".repeat(40),
    refs: [{ path: "README.md" }],
    steps: [step(id, 1, 1, "fresh"), step(id, 2, 2, "reuse-allowed"), step(id, 3, 2, "fresh")],
  });

  it("golden datasets: one single-step unit per task, no session id", () => {
    const units = planBenchUnits({ kind: "golden-extended", tasks: [goldenTask("a"), goldenTask("b")], violations: [] });
    expect(units.map((u) => u.id)).toEqual(["a", "b"]);
    expect(units.every((u) => u.steps.length === 1 && u.sessionId === undefined && u.revision === "c".repeat(40))).toBe(true);
    expect(units[0]!.steps[0]!.expect).toBeUndefined();
  });

  it("long-horizon: one unit per session, steps in order with session numbers and expectations", () => {
    const dataset = { kind: "long-horizon" as const, sessions: [lhSession("lh-001", "t1"), lhSession("lh-002", "t2"), lhSession("lh-003", "t1")], violations: [] };
    const units = planBenchUnits(dataset);
    expect(units.map((u) => u.sessionId)).toEqual(["lh-001", "lh-002", "lh-003"]);
    expect(units[0]!.revision).toBe("d".repeat(40));
    expect(units[0]!.steps.map((s) => [s.task.id, s.session, s.expect?.reuse])).toEqual([
      ["lh-001-s1", 1, "fresh"],
      ["lh-001-s2", 2, "reuse-allowed"],
      ["lh-001-s3", 2, "fresh"],
    ]);
    expect(planBenchUnits(dataset, undefined, ["t1"]).map((u) => u.id)).toEqual(["lh-001", "lh-003"]);
    expect(planBenchUnits(dataset, undefined, ["lh-002"]).map((u) => u.id)).toEqual(["lh-002"]);
    expect(planBenchUnits(dataset, 1, ["t1"]).map((u) => u.id)).toEqual(["lh-001"]);
    expect(planBenchUnits(dataset, undefined, ["lh-001-s1"])).toEqual([]);
  });
});

describe("reuseExpectationOutcome", () => {
  const expectOf = (reuse: "fresh" | "reuse-allowed" | "must-refresh") => ({ reuse, memory: "none" as const, stateChange: false });
  const traceWith = (reuseMode?: "REUSE" | "ADAPT" | "FRESH"): Pick<TaskTrace, "decision"> =>
    reuseMode ? ({ decision: { reuseMode } } as unknown as Pick<TaskTrace, "decision">) : {};

  it("no decision recorded (baseline arm) or no expectation -> not-observed", () => {
    expect(reuseExpectationOutcome(expectOf("must-refresh"), traceWith())).toEqual({ expected: "must-refresh", verdict: "not-observed" });
    expect(reuseExpectationOutcome(undefined, traceWith("REUSE"))).toEqual({ observed: "REUSE", verdict: "not-observed" });
  });

  it("stale, missed and unexpected reuse are told apart; ADAPT counts as a refresh", () => {
    expect(reuseExpectationOutcome(expectOf("must-refresh"), traceWith("REUSE")).verdict).toBe("stale-reuse");
    expect(reuseExpectationOutcome(expectOf("must-refresh"), traceWith("ADAPT")).verdict).toBe("consistent");
    expect(reuseExpectationOutcome(expectOf("reuse-allowed"), traceWith("FRESH")).verdict).toBe("missed-reuse");
    expect(reuseExpectationOutcome(expectOf("reuse-allowed"), traceWith("REUSE")).verdict).toBe("consistent");
    expect(reuseExpectationOutcome(expectOf("fresh"), traceWith("REUSE")).verdict).toBe("unexpected-reuse");
    expect(reuseExpectationOutcome(expectOf("fresh"), traceWith("FRESH"))).toEqual({ expected: "fresh", observed: "FRESH", verdict: "consistent" });
  });
});

describe("armPipelineMode", () => {
  it("maps all five arms", () => {
    expect([...BENCH_ARMS]).toEqual(["baseline", "graphflow", "shadow", "conservative", "adaptive"]);
    expect(armPipelineMode("baseline")).toEqual({ mode: "baseline", policy: "conservative" });
    expect(armPipelineMode("graphflow")).toEqual({ mode: "broker", policy: "conservative" });
    expect(armPipelineMode("shadow")).toEqual({ mode: "shadow", policy: "conservative" });
    expect(armPipelineMode("conservative")).toEqual({ mode: "broker", policy: "conservative" });
    expect(armPipelineMode("adaptive")).toEqual({ mode: "broker", policy: "adaptive" });
  });
});
