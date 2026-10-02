import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffTask, EffTaskOracle, LongHorizonSession, LongHorizonStepExpect, ParsedBenchDataset } from "./corpus.js";
import type { TaskTrace } from "./trace.js";
import { createLocalCommandWorker } from "./workers/local-command-worker.js";

/**
 * Real benchmark plumbing (2.x plan §24/§25): every task runs in its own git
 * worktree at its base revision, the agent really executes, and the result is
 * judged by the task's oracle. Nothing here synthesises a duration, an outcome
 * or a token count — a task without an oracle is reported as unjudged.
 */

/**
 * Spec §18 tracks: A baseline (native worker), B graphflow (GraphFlow context
 * only, no reuse/routing), C shadow (decisions recorded, not applied),
 * D adaptive (full agent); conservative is D without result replay.
 */
export type BenchArm = "baseline" | "graphflow" | "shadow" | "conservative" | "adaptive";
export const BENCH_ARMS: readonly BenchArm[] = ["baseline", "graphflow", "shadow", "conservative", "adaptive"];

export interface OracleVerdict {
  judged: boolean;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean }>;
}

export interface OracleJudgeInput {
  oracle: EffTaskOracle | undefined;
  /** The agent's final output (answer / change summary). */
  output: string;
  /** Task workspace the agent worked in. */
  cwd: string;
  commandTimeoutMs?: number;
}

const DEFAULT_ORACLE_TIMEOUT_MS = 10 * 60_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** Working-tree changes, ignoring the efficiency layer's own state dir. */
export function workspaceChanges(cwd: string): string[] {
  try {
    // node_modules is the symlink createTaskWorkspace adds; `node_modules/` ignore rules skip
    // directories only, so on POSIX git reports the link itself as untracked.
    return git(cwd, ["status", "--porcelain", "--", ".", ":(exclude)graphflow-out", ":(exclude)node_modules"])
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

export async function judgeOracle(input: OracleJudgeInput): Promise<OracleVerdict> {
  const { oracle } = input;
  if (!oracle) return { judged: false, passed: false, checks: [] };
  const checks: OracleVerdict["checks"] = [];
  const text = input.output.toLowerCase();

  if (oracle.outputAnyOf) {
    checks.push({
      name: `output includes any of [${oracle.outputAnyOf.join(", ")}]`,
      passed: oracle.outputAnyOf.some((needle) => text.includes(needle.toLowerCase())),
    });
  }
  if (oracle.outputAllOf) {
    for (const needle of oracle.outputAllOf) {
      checks.push({ name: `output includes "${needle}"`, passed: text.includes(needle.toLowerCase()) });
    }
  }
  if (oracle.refusal) {
    checks.push({
      name: "agent rejected the false premise",
      passed: oracle.refusal.signals.some((signal) => text.includes(signal.toLowerCase())),
    });
    if (oracle.refusal.noChanges) {
      const changes = workspaceChanges(input.cwd);
      checks.push({ name: `no files changed (${changes.length} changed)`, passed: changes.length === 0 });
    }
  }
  if (oracle.files) {
    for (const file of oracle.files) {
      let content = "";
      try {
        content = readFileSync(join(input.cwd, file.path), "utf8");
      } catch {
        // Missing file: the pattern cannot match.
      }
      checks.push({ name: `${file.path} matches /${file.pattern}/`, passed: new RegExp(file.pattern).test(content) });
    }
  }
  if (oracle.overlayFrom) {
    let overlaid = true;
    try {
      git(input.cwd, ["checkout", oracle.overlayFrom.commit, "--", ...oracle.overlayFrom.paths]);
    } catch {
      overlaid = false;
    }
    checks.push({ name: `hidden tests applied from ${oracle.overlayFrom.commit}`, passed: overlaid });
  }
  if (oracle.commands) {
    const runner = createLocalCommandWorker({
      name: "oracle",
      defaultTimeoutMs: input.commandTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
    });
    for (const spec of oracle.commands) {
      const command = await runner.prepare([spec]);
      if (!command) {
        checks.push({ name: `oracle: ${spec}`, passed: false });
        continue;
      }
      const obs = await runner.execute({ ...command, cwd: input.cwd });
      checks.push({ name: `oracle: ${spec}`, passed: obs.exitCode === 0 });
    }
  }
  return { judged: true, passed: checks.length > 0 && checks.every((check) => check.passed), checks };
}

export interface TaskWorkspace {
  dir: string;
  revision: string;
  dispose(): void;
}

/**
 * Isolated worktree at `revision` (default HEAD). The repository's
 * node_modules is linked in (junction on Windows) so validation can run; the
 * link is removed before the worktree so cleanup never touches the original.
 */
export function createTaskWorkspace(repoRoot: string, revision = "HEAD", parentDir = tmpdir()): TaskWorkspace {
  mkdirSync(parentDir, { recursive: true });
  const dir = join(parentDir, `eff-bench-${randomBytes(4).toString("hex")}`);
  git(repoRoot, ["worktree", "add", "--detach", dir, revision]);
  const resolved = git(dir, ["rev-parse", "HEAD"]).trim();
  const sourceModules = join(repoRoot, "node_modules");
  const linkedModules = join(dir, "node_modules");
  if (existsSync(sourceModules) && !existsSync(linkedModules)) {
    symlinkSync(sourceModules, linkedModules, process.platform === "win32" ? "junction" : "dir");
  }
  let disposed = false;
  return {
    dir,
    revision: resolved,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (lstatSync(linkedModules).isSymbolicLink()) unlinkSync(linkedModules);
      } catch {
        // No link was created.
      }
      try {
        git(repoRoot, ["worktree", "remove", "--force", dir]);
      } catch {
        if (existsSync(linkedModules)) return; // never recurse into a link we could not remove
        rmSync(dir, { recursive: true, force: true });
        try {
          git(repoRoot, ["worktree", "prune"]);
        } catch {
          // Best effort.
        }
      }
    },
  };
}

/** Attach the oracle verdict to a pipeline trace; success follows the oracle when judged. */
export function withVerdict(
  trace: TaskTrace,
  verdict: OracleVerdict,
  benchTaskId: string,
  extra: { arm?: BenchArm; regression?: TaskTrace["regression"] } = {}
): TaskTrace {
  return {
    ...trace,
    task: { ...trace.task, taskId: benchTaskId },
    ...(extra.arm ? { run: { ...trace.run, arm: extra.arm } } : {}),
    judged: verdict.judged,
    ...(verdict.judged ? { oracle: { passed: verdict.passed, checks: verdict.checks } } : {}),
    ...(extra.regression ? { regression: extra.regression } : {}),
    result: { success: verdict.judged ? verdict.passed : trace.result.success },
  };
}

/**
 * Regression guards: commands that must still pass after the agent ran.
 * They never judge success; a failing guard feeds the regression rate.
 */
export async function runGuards(
  guards: readonly string[] | undefined,
  cwd: string,
  commandTimeoutMs = DEFAULT_ORACLE_TIMEOUT_MS
): Promise<TaskTrace["regression"] | undefined> {
  if (!guards || guards.length === 0) return undefined;
  const runner = createLocalCommandWorker({ name: "guard", defaultTimeoutMs: commandTimeoutMs });
  const checks: Array<{ name: string; passed: boolean }> = [];
  for (const spec of guards) {
    const command = await runner.prepare([spec]);
    if (!command) {
      checks.push({ name: `guard: ${spec}`, passed: false });
      continue;
    }
    const obs = await runner.execute({ ...command, cwd });
    checks.push({ name: `guard: ${spec}`, passed: obs.exitCode === 0 });
  }
  return { passed: checks.every((c) => c.passed), checks };
}

export function armPipelineMode(arm: BenchArm): { mode: "baseline" | "shadow" | "broker"; policy: "conservative" | "adaptive" } {
  switch (arm) {
    case "baseline":
      return { mode: "baseline", policy: "conservative" };
    case "shadow":
      return { mode: "shadow", policy: "conservative" };
    case "adaptive":
      return { mode: "broker", policy: "adaptive" };
    case "graphflow":
    default:
      return { mode: "broker", policy: "conservative" };
  }
}

export interface BenchTaskPlan {
  task: EffTask;
  revision: string;
}

export function planBenchTasks(tasks: EffTask[], limit?: number, only?: string[]): BenchTaskPlan[] {
  const filtered =
    only && only.length > 0
      ? tasks.filter((task) => only.includes(task.id) || only.includes(task.cohort) || (task.family !== undefined && only.includes(task.family)))
      : tasks;
  const limited = limit && limit > 0 ? filtered.slice(0, limit) : filtered;
  return limited.map((task) => ({ task, revision: task.baseCommit ?? "HEAD" }));
}

/** What one bench step needs to execute and be judged. */
export type BenchStepTask = Pick<EffTask, "id" | "category" | "text" | "oracle" | "guards">;

export interface BenchStep {
  task: BenchStepTask;
  /** Long-horizon only: agent session number and the expected memory/reuse behaviour. */
  session?: number;
  expect?: LongHorizonStepExpect;
}

/**
 * One workspace's worth of work. Golden tasks are single-step units, each in a
 * fresh worktree; a long-horizon session is one unit whose steps run in order
 * in the SAME worktree, so every step sees the state earlier steps left.
 */
export interface BenchUnit {
  id: string;
  revision: string;
  sessionId?: string;
  steps: BenchStep[];
}

function sessionUnit(session: LongHorizonSession): BenchUnit {
  return {
    id: session.id,
    revision: session.baseCommit,
    sessionId: session.id,
    steps: session.steps.map((step) => ({
      task: { id: step.id, category: step.category, text: step.text, oracle: step.oracle, ...(step.guards ? { guards: step.guards } : {}) },
      session: step.session,
      expect: step.expect,
    })),
  };
}

/**
 * Units for any §18 dataset. `only` matches task ids, cohorts and families
 * (golden) or session ids and templates (long-horizon); `limit` counts units.
 */
export function planBenchUnits(dataset: ParsedBenchDataset, limit?: number, only?: string[]): BenchUnit[] {
  if (dataset.kind !== "long-horizon") {
    return planBenchTasks(dataset.tasks, limit, only).map((plan) => ({ id: plan.task.id, revision: plan.revision, steps: [{ task: plan.task }] }));
  }
  const filtered = only && only.length > 0 ? dataset.sessions.filter((s) => only.includes(s.id) || only.includes(s.template)) : dataset.sessions;
  const limited = limit && limit > 0 ? filtered.slice(0, limit) : filtered;
  return limited.map(sessionUnit);
}

export type ReuseVerdict = "consistent" | "missed-reuse" | "stale-reuse" | "unexpected-reuse" | "not-observed";

/**
 * Compare a long-horizon step's expectation with what the trace recorded.
 * Only `stale-reuse` (replaying a result after the workspace changed) is a
 * correctness failure; `missed-reuse` is lost efficiency. Arms that make no
 * reuse decision (baseline) are `not-observed`, never counted either way.
 */
export function reuseExpectationOutcome(
  expect: LongHorizonStepExpect | undefined,
  trace: Pick<TaskTrace, "decision">
): { expected?: LongHorizonStepExpect["reuse"]; observed?: string; verdict: ReuseVerdict } {
  const observed = trace.decision?.reuseMode;
  if (!expect || !observed) return { ...(expect ? { expected: expect.reuse } : {}), ...(observed ? { observed } : {}), verdict: "not-observed" };
  const reused = observed === "REUSE";
  let verdict: ReuseVerdict = "consistent";
  if (expect.reuse === "reuse-allowed" && observed === "FRESH") verdict = "missed-reuse";
  else if (expect.reuse === "must-refresh" && reused) verdict = "stale-reuse";
  else if (expect.reuse === "fresh" && reused) verdict = "unexpected-reuse";
  return { expected: expect.reuse, observed, verdict };
}
