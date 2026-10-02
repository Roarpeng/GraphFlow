import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync as read } from "node:fs";
import {
  BRIDGE_SCOPE_NOTE,
  CORPUS_PATH,
  compareEffBench,
  loadCorpus,
  readTraces,
  runEffBench,
} from "../benchmarks/eff-bench-lib";
import { parseEffTaskCorpus } from "../packages/efficiency-agent/src/corpus";
import { validateTraceProvenance, type TaskTrace } from "../packages/efficiency-agent/src/trace";
import type {
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "../packages/efficiency-agent/src/domain";
import { runTaskResult } from "../src/surfaces/cli/runtime";
import type { RunTaskSummary } from "../src/surfaces/cli/runtime/types";

type ReuseMode = "REUSE" | "ADAPT" | "FRESH";

function fakeSummary(
  text: string,
  reuseMode: ReuseMode,
  extra: { validation?: string[]; status?: RunTaskSummary["status"]; feedback?: string; durationMs?: number } = {}
): RunTaskSummary {
  return {
    status: extra.status ?? "DELEGATED",
    attempts: 0,
    feedback: extra.feedback ?? "[DELEGATED] packaged",
    executionDescriptor: { action: "execute", task: text, context: "x".repeat(400), retryHints: [] },
    advisory: {
      taskId: `t-${text.length}-${reuseMode}`,
      reuseMode,
      validation: extra.validation ?? [],
      context: { source: "graphflow", requiredAnchors: ["a1", "a2"] },
      worker: { modelTier: "economy", executionMode: "one-shot", maxRounds: 1 },
      decision: { provenance: "deterministic", llmCalls: 0, durationMs: extra.durationMs ?? 3 },
    } as unknown as RunTaskSummary["advisory"],
  };
}

const MODES: ReuseMode[] = ["REUSE", "ADAPT", "FRESH"];

function recordingWorker(): WorkerAdapter & { executed: number } {
  const worker = {
    name: "recording-worker",
    executed: 0,
    async prepare(validation: string[]): Promise<WorkerCommand | undefined> {
      return validation.length > 0 ? { command: validation[0]!, args: [] } : undefined;
    },
    async execute(): Promise<WorkerObservation> {
      worker.executed += 1;
      return { exitCode: 0, durationMs: 1 };
    },
    async validate(observation: WorkerObservation) {
      const passed = observation.exitCode === 0;
      return { passed, checks: [{ name: "exit-code", passed }] };
    },
    async stop(): Promise<void> {},
  };
  return worker;
}

describe("eff benchmark corpus (§24 composition)", () => {
  it("ships exactly 50 tasks in the 20/15/10/5 cohort composition", () => {
    const { tasks, violations } = parseEffTaskCorpus(read(CORPUS_PATH, "utf8"));
    expect(CORPUS_PATH.endsWith("golden-v1.jsonl")).toBe(true);
    expect(violations).toEqual([]);
    expect(tasks).toHaveLength(50);
    const cohorts = tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.cohort] = (acc[t.cohort] ?? 0) + 1;
      return acc;
    }, {});
    expect(cohorts).toEqual({ repetition: 20, regular: 15, complex: 10, failure: 5 });
  });

  it("refuses a malformed corpus instead of benchmarking garbage", () => {
    const { violations } = parseEffTaskCorpus(
      JSON.stringify({ id: "x", cohort: "regular", text: "too short" }) + "\n"
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.startsWith("composition"))).toBe(true);
  });
});

describe("eff benchmark runner (offline arms, real substrate)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "graphflow-eff-bench-test-"));
  const baselineOut = join(outDir, "baseline.jsonl");
  const shadowOut = join(outDir, "shadow.jsonl");

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("baseline and shadow arms emit honest, provenance-clean traces", async () => {
    // A shared limit slice keeps this fast; the full-50 run is exercised by
    // the npm script and its numbers land in graphflow-out (gitignored).
    const baseline = await runEffBench({ mode: "baseline", limit: 6, outPath: baselineOut });
    expect(baseline.tasksRun).toBe(6);
    expect(baseline.provenanceViolations).toEqual([]);
    expect(baseline.executionMode).toBe("bridge");
    expect(baseline.judgedTraces).toBe(0);
    expect(baseline.successRate).toBeNull();
    expect(baseline.scope).toBe(BRIDGE_SCOPE_NOTE);

    // Wrap the real substrate only to observe what it returned per task.
    const substrate: RunTaskSummary[] = [];
    const shadow = await runEffBench({
      mode: "shadow",
      limit: 6,
      outPath: shadowOut,
      runTask: async (text, configPath) => {
        const summary = await runTaskResult(text, configPath);
        substrate.push(summary);
        return summary;
      },
    });
    expect(shadow.tasksRun).toBe(6);
    expect(shadow.provenanceViolations).toEqual([]);
    expect(shadow.judgedTraces).toBe(0);
    expect(shadow.successRate).toBeNull();

    const traces: TaskTrace[] = readFileSync(shadowOut, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TaskTrace);
    expect(traces).toHaveLength(6);
    traces.forEach((trace, i) => {
      expect(validateTraceProvenance(trace)).toEqual([]);
      expect(trace.run.mode).toBe("shadow");
      expect(trace.judged).toBe(false);
      expect(trace.validation).toEqual([]);
      expect(trace.validationStatus).toBe("not-run");
      // Packaging status, not an outcome.
      expect(trace.result.success).toBe(
        substrate[i]!.status === "DELEGATED" && !substrate[i]!.feedback.includes("(recovered from: ")
      );
      expect(trace.llm.calls).toEqual({ value: 0, provenance: "measured" });
      expect(trace.context.tokens.provenance).not.toBe("measured");
      expect(trace.context.tokens.method).toBe("descriptor-chars/4");
      expect(trace.context.cacheHit).toBe(false);
      expect(trace.decision?.reuseMode).toBe(substrate[i]!.advisory?.reuseMode);
    });
    for (const trace of readTraces(baselineOut)) {
      expect(trace.judged).toBe(false);
      expect(trace.decision).toBeUndefined();
    }
  }, 60_000);

  it("compare accepts clean arms, reports decision overhead and N/A success", () => {
    const report = compareEffBench(baselineOut, shadowOut);
    expect(report.ok).toBe(true);
    expect(report.tasksCompared).toBe(6);
    expect(report.baseline!.totalLlmCalls).toBe(0);
    expect(report.baseline!.judgedTraces).toBe(0);
    expect(report.baseline!.successRate).toBeNull();
    expect(report.shadow!.successRate).toBeNull();
    expect(report.comparison!.tokenProvenance).not.toBe("measured");
    expect(report.shadow!.avgDecisionDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.shadow!.avgDecisionCostShare ?? 0).toBeLessThan(1);
  });

  it("compare refuses a trace with a provenance violation (R6)", () => {
    const dirty = join(outDir, "dirty.jsonl");
    const clean = JSON.parse(
      readFileSync(shadowOut, "utf8").trim().split("\n")[0]!
    ) as TaskTrace;
    const lying: TaskTrace = {
      ...clean,
      llm: { calls: { value: 3, provenance: "estimated" } }, // no method
    };
    writeFileSync(dirty, `${JSON.stringify(clean)}\n${JSON.stringify(lying)}\n`, "utf8");
    const report = compareEffBench(baselineOut, dirty);
    expect(report.ok).toBe(false);
    expect(report.refusedBy?.some((r) => r.includes("estimated values require a method"))).toBe(
      true
    );
  });
});

describe("eff benchmark runner honesty (stubbed substrate)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "graphflow-eff-bench-honesty-"));
  const corpus = loadCorpus();
  const cohortOf = (text: string) => corpus.find((t) => t.text === text)!.cohort;

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("bridge outcomes are packaging status for every cohort, never cohort-derived", async () => {
    const outPath = join(outDir, "bridge-shadow.jsonl");
    const returned: RunTaskSummary[] = [];
    const summary = await runEffBench({
      mode: "shadow",
      outPath,
      runTask: async (text) => {
        const s = fakeSummary(text, MODES[returned.length % 3]!);
        returned.push(s);
        return s;
      },
    });
    expect(summary.tasksRun).toBe(50);
    expect(summary.packagedCount).toBe(50);
    expect(summary.executedCount).toBe(0);
    expect(summary.judgedTraces).toBe(0);
    expect(summary.successRate).toBeNull();
    expect(summary.provenanceViolations).toEqual([]);
    expect(summary.reuseModeDistribution.REUSE).toBeGreaterThan(0);

    const traces = readTraces(outPath);
    expect(traces.filter((t) => cohortOf(t.task.text) === "failure")).toHaveLength(5);
    traces.forEach((trace, i) => {
      expect(trace.judged).toBe(false);
      expect(trace.result.success).toBe(true);
      expect(trace.failure).toBeUndefined();
      expect(trace.validation).toEqual([]);
      expect(trace.decision!.reuseMode).toBe(returned[i]!.advisory!.reuseMode);
      expect(trace.decision!.durationMs).toEqual({ value: 3, provenance: "measured" });
      expect(trace.context.cacheHit).toBe(false);
      expect(trace.context.anchors).toBe(2);
      expect(trace.context.tokens).toMatchObject({ value: 100, method: "descriptor-chars/4" });
      expect(["estimated", "proxy"]).toContain(trace.context.tokens.provenance);
    });
  });

  it("packaging failures and substrate crash-recovery are not reported as packaged", async () => {
    const outPath = join(outDir, "bridge-failures.jsonl");
    let call = 0;
    const summary = await runEffBench({
      mode: "shadow",
      limit: 3,
      outPath,
      runTask: async (text) => {
        call += 1;
        if (call === 1) return fakeSummary(text, "FRESH", { status: "HUMAN_REVIEW_REQUIRED", feedback: "boom" });
        if (call === 2) {
          return fakeSummary(text, "FRESH", {
            feedback: "[DELEGATED] No LLM configured; operating in bridge mode (recovered from: index failed)",
            durationMs: 0,
          });
        }
        throw new Error("substrate exploded");
      },
    });
    expect(summary.packagedCount).toBe(0);
    expect(summary.provenanceViolations).toEqual([]);
    const traces = readTraces(outPath);
    for (const trace of traces) {
      expect(trace.result.success).toBe(false);
      expect(trace.judged).toBe(false);
      expect(trace.failure?.stage).toBe("packaging");
    }
    // The fallback path's constant-0 duration is not an instrument reading.
    expect(traces[1]!.decision!.durationMs.provenance).not.toBe("measured");
    expect(summary.avgDecisionDurationMs).toBe(3);
  });

  it("shadow worker arm executes REUSE tasks and records the advisory verbatim", async () => {
    const outPath = join(outDir, "worker-shadow.jsonl");
    const worker = recordingWorker();
    const summary = await runEffBench({
      mode: "shadow",
      limit: 3,
      outPath,
      workerAdapter: worker,
      runTask: async (text) => fakeSummary(text, "REUSE", { validation: ["real-check"] }),
    });
    expect(summary.executionMode).toBe("worker");
    expect(worker.executed).toBe(3);
    expect(summary.executedCount).toBe(3);
    expect(summary.judgedTraces).toBe(0);
    expect(summary.successRate).toBeNull();
    expect(summary.provenanceViolations).toEqual([]);
    for (const trace of readTraces(outPath)) {
      expect(trace.decision!.reuseMode).toBe("REUSE");
      expect(trace.context.cacheHit).toBe(false);
      expect(trace.judged).toBe(false);
      expect(trace.validation).toEqual([{ name: "exit-code", passed: true }]);
      expect(trace.validationStatus).toBe("passed");
      expect(trace.context.tokens.provenance).not.toBe("measured");
      expect(trace.context.tokens.method).toBe("descriptor-chars/4");
      expect(trace.llm.totalTokens).toBeUndefined();
    }
  });

  it("worker arm never simulates validation: no commands means nothing runs, for every cohort", async () => {
    const outPath = join(outDir, "worker-novalidation.jsonl");
    const worker = recordingWorker();
    const summary = await runEffBench({
      mode: "baseline",
      outPath,
      workerAdapter: worker,
      runTask: async (text) => fakeSummary(text, "FRESH"),
    });
    expect(summary.tasksRun).toBe(50);
    expect(worker.executed).toBe(0);
    expect(summary.executedCount).toBe(0);
    for (const trace of readTraces(outPath)) {
      expect(trace.validation).toEqual([]);
      expect(trace.validationStatus).toBe("not-run");
      expect(trace.result.success).toBe(false);
      expect(trace.judged).toBe(false);
      expect(trace.failure?.stage).toBe("validate");
    }
  });

  it("operator-supplied validation commands really execute via the local worker", async () => {
    const outPath = join(outDir, "worker-local.jsonl");
    const summary = await runEffBench({
      mode: "baseline",
      limit: 2,
      outPath,
      worker: "local",
      validationCommands: ["node --version"],
      runTask: async (text) => fakeSummary(text, "FRESH"),
    });
    expect(summary.executedCount).toBe(2);
    for (const trace of readTraces(outPath)) {
      expect(trace.validation.find((c) => c.name === "exit-code")).toEqual({ name: "exit-code", passed: true });
      expect(trace.result.success).toBe(true);
      expect(trace.judged).toBe(false);
    }
  }, 30_000);

  it("runner source carries no cohort-derived outcomes or simulated exit commands", () => {
    const source = read(join(__dirname, "..", "benchmarks", "eff-bench-lib.ts"), "utf8");
    expect(source).not.toMatch(/updateEpisodeOutcome/);
    expect(source).not.toMatch(/process\.exit\(/);
    expect(source).not.toMatch(/cohort\s*===/);
    expect(source).not.toMatch(/measured\(\s*Math\.ceil/);
  });
});
