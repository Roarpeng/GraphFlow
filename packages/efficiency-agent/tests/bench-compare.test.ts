import { describe, expect, it } from "vitest";

import { compareArms, computeArmStats, provenanceRefusals, traceDurationMs } from "../src/bench-compare.js";
import { estimated, measured, proxy } from "../src/measurement.js";
import type { TaskTrace, TraceEvent } from "../src/trace.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");

interface Spec {
  id: string;
  durationMs?: number;
  costMs?: number;
  judged?: boolean;
  success?: boolean;
  reuseMode?: "REUSE" | "ADAPT" | "FRESH";
  decisionMs?: number;
  tokens?: number;
  llmCalls?: number;
  rounds?: number;
  cacheHit?: boolean;
  checks?: boolean[];
  regression?: boolean;
  replayable?: boolean;
}

function trace(spec: Spec): TaskTrace {
  const duration = spec.durationMs ?? 1_000;
  const success = spec.success ?? true;
  const at = (offset: number) => new Date(START + offset).toISOString();
  const events: TraceEvent[] = [
    { at: at(0), stage: "reuse-gate", outcome: spec.reuseMode ?? "FRESH", reason: "r", evidence: [], policyVersion: 0 },
    { at: at(1), stage: "execute", outcome: "completed", reason: "ran", evidence: [], policyVersion: 0 },
  ];
  const replayable = spec.replayable ?? true;
  const checks = (spec.checks ?? [success]).map((passed, i) => ({ name: `check-${i}`, passed }));
  return {
    schemaVersion: "1.0",
    traceId: `trace-${spec.id}`,
    task: { text: `text of ${spec.id}`, taskId: spec.id, category: "bugfix" },
    run: { worker: "agent:node", mode: "conservative", startedAt: at(0), finishedAt: at(duration) },
    context: { tokens: estimated(spec.tokens ?? 100, "prompt-chars/4", 0.7), anchors: 1, cacheHit: spec.cacheHit ?? false },
    llm: { calls: spec.llmCalls ? proxy(spec.llmCalls, "agent-cli-invocations", 0.2) : measured(0) },
    tools: [{ name: "agent:node", calls: measured(1) }],
    rounds: measured(spec.rounds ?? 1),
    validation: [],
    result: { success },
    ...(spec.costMs !== undefined ? { cost: { actual: measured(spec.costMs) } } : {}),
    ...(replayable
      ? {
          record: {
            decisionId: `d-${spec.id}`,
            policyVersion: 0,
            contractVersion: "1.0",
            toolVersions: {},
            cacheNamespace: "v1.g0",
          },
          events,
        }
      : {}),
    ...(spec.judged ? { judged: true, oracle: { passed: success, checks } } : spec.judged === false ? { judged: false } : {}),
    ...(spec.reuseMode
      ? { decision: { reuseMode: spec.reuseMode, durationMs: measured(spec.decisionMs ?? 0), llmCalls: measured(0) } }
      : {}),
    ...(spec.regression !== undefined
      ? { regression: { passed: spec.regression, checks: [{ name: "guard", passed: spec.regression }] } }
      : {}),
  };
}

describe("traceDurationMs", () => {
  it("measures finishedAt - startedAt; undefined without finishedAt or when negative", () => {
    expect(traceDurationMs(trace({ id: "a", durationMs: 250 }))).toBe(250);
    const t = trace({ id: "b" });
    delete t.run.finishedAt;
    expect(traceDurationMs(t)).toBeUndefined();
    const neg = trace({ id: "c" });
    neg.run.finishedAt = "2025-01-01T00:00:00.000Z";
    expect(traceDurationMs(neg)).toBeUndefined();
  });
});

describe("computeArmStats", () => {
  it("successRate counts judged traces only (null when nothing judged)", () => {
    const stats = computeArmStats([
      trace({ id: "1", judged: true, success: true }),
      trace({ id: "2", judged: true, success: false }),
      trace({ id: "3", success: true }), // unjudged success must not inflate
      trace({ id: "4", judged: false, success: true }),
    ]);
    expect(stats.traces).toBe(4);
    expect(stats.judged).toBe(2);
    expect(stats.successRate).toBe(0.5);
    expect(computeArmStats([trace({ id: "x", success: true })]).successRate).toBeNull();
  });

  it("fidelity = mean share of oracle checks passed on judged traces", () => {
    const stats = computeArmStats([
      trace({ id: "1", judged: true, success: false, checks: [true, false] }),
      trace({ id: "2", judged: true, success: true, checks: [true, true, true, true] }),
    ]);
    expect(stats.fidelity).toBe(0.75);
  });

  it("aggregates tokens, llm calls (with provenance), rounds, latency percentiles, cache/reuse/guard rates", () => {
    const stats = computeArmStats([
      trace({ id: "1", durationMs: 100, tokens: 100, llmCalls: 2, rounds: 1, cacheHit: true, reuseMode: "ADAPT", regression: true }),
      trace({ id: "2", durationMs: 300, tokens: 300, rounds: 2, reuseMode: "FRESH", regression: false }),
      trace({ id: "3", durationMs: 200, tokens: 200, rounds: 3 }),
    ]);
    expect(stats.avgContextTokens).toBe(200);
    expect(stats.contextTokensProvenance).toBe("estimated");
    expect(stats.totalLlmCalls).toBe(2);
    expect(stats.llmCallsProvenance).toBe("proxy+measured");
    expect(stats.totalToolCalls).toBe(3);
    expect(stats.avgRounds).toBe(2);
    expect(stats.latencyMs).toEqual({ avg: 200, p50: 200, p95: 300 });
    expect(stats.cacheHitRate).toBe(0.333);
    expect(stats.reuseRate).toBe(0.333);
    expect(stats.guardFailureRate).toBe(0.5);
    expect(computeArmStats([trace({ id: "g" })]).guardFailureRate).toBeNull();
  });

  it("totalCostMs prefers cost.actual over wall clock; decisionCostMs sums decision durations", () => {
    const stats = computeArmStats([
      trace({ id: "1", durationMs: 1_000, costMs: 400, reuseMode: "FRESH", decisionMs: 7 }),
      trace({ id: "2", durationMs: 600, reuseMode: "ADAPT", decisionMs: 3 }),
    ]);
    expect(stats.totalCostMs).toBe(1_000);
    expect(stats.decisionCostMs).toBe(10);
  });

  it("unsafeReuse counts judged failures whose decision.reuseMode is REUSE", () => {
    const stats = computeArmStats([
      trace({ id: "1", judged: true, success: false, reuseMode: "REUSE" }), // unsafe
      trace({ id: "2", judged: true, success: true, reuseMode: "REUSE" }),
      trace({ id: "3", judged: true, success: false, reuseMode: "ADAPT" }),
      trace({ id: "4", success: false, reuseMode: "REUSE" }), // unjudged
    ]);
    expect(stats.unsafeReuse).toBe(1);
  });

  it("replayable uses replayProblems", () => {
    const missingReuseGate = trace({ id: "3" });
    missingReuseGate.events = missingReuseGate.events!.filter((e) => e.stage !== "reuse-gate");
    const stats = computeArmStats([trace({ id: "1" }), trace({ id: "2", replayable: false }), missingReuseGate]);
    expect(stats.replayable).toBe(1);
  });
});

describe("compareArms", () => {
  it("pairs by task id (unpaired traces excluded, order independent)", () => {
    const report = compareArms(
      [trace({ id: "a" }), trace({ id: "b" }), trace({ id: "only-base" })],
      [trace({ id: "b" }), trace({ id: "only-cand" }), trace({ id: "a" })]
    );
    expect(report.tasksCompared).toBe(2);
    expect(report.baseline.traces).toBe(2);
    expect(report.candidate.traces).toBe(2);
  });

  it("falls back to task text when taskId is absent", () => {
    const b = trace({ id: "a" });
    const c = trace({ id: "a" });
    delete b.task.taskId;
    delete c.task.taskId;
    expect(compareArms([b], [c]).tasksCompared).toBe(1);
  });

  it("regressionRate: baseline passed, candidate failed, over pairs judged on both sides", () => {
    const report = compareArms(
      [
        trace({ id: "1", judged: true, success: true }),
        trace({ id: "2", judged: true, success: true }),
        trace({ id: "3", judged: true, success: false }),
        trace({ id: "4", success: true }), // unjudged on baseline -> excluded
      ],
      [
        trace({ id: "1", judged: true, success: false }), // regression
        trace({ id: "2", judged: true, success: true }),
        trace({ id: "3", judged: true, success: true }), // improvement, not regression
        trace({ id: "4", judged: true, success: false }),
      ]
    );
    expect(report.regressions).toEqual(["1"]);
    expect(report.regressionRate).toBe(0.333);
    expect(compareArms([trace({ id: "x" })], [trace({ id: "x" })]).regressionRate).toBeNull();
  });

  it("netSaving uses cost.actual (baseline - candidate)", () => {
    const report = compareArms(
      [trace({ id: "1", durationMs: 5_000, costMs: 1_000 }), trace({ id: "2", costMs: 1_000 })],
      [trace({ id: "1", durationMs: 9_000, costMs: 600 }), trace({ id: "2", costMs: 900 })]
    );
    expect(report.netSaving).toEqual({ ms: 500, pct: 25 });
    expect(report.gates.find((g) => g.name === "net saving > 0")?.passed).toBe(true);
  });

  it("gates PASS when the candidate is no worse on every axis", () => {
    const report = compareArms(
      [trace({ id: "1", judged: true, success: true, costMs: 1_000, durationMs: 1_000 })],
      [trace({ id: "1", judged: true, success: true, costMs: 800, durationMs: 900, reuseMode: "ADAPT" })]
    );
    const byName = Object.fromEntries(report.gates.map((g) => [g.name, g.passed]));
    expect(byName).toEqual({
      "success >= baseline": true,
      "0 unsafe reuse": true,
      "net saving > 0": true,
      "P95 latency controlled (<= baseline x1.10)": true,
      "100% trace replay": true,
    });
    expect(report.delta.reuseRate).toBe(1);
  });

  it("gates FAIL on regressions, unsafe reuse, cost/latency growth and unreplayable traces", () => {
    const report = compareArms(
      [trace({ id: "1", judged: true, success: true, costMs: 1_000, durationMs: 1_000 })],
      [trace({ id: "1", judged: true, success: false, costMs: 2_000, durationMs: 2_000, reuseMode: "REUSE", replayable: false })]
    );
    const byName = Object.fromEntries(report.gates.map((g) => [g.name, g.passed]));
    expect(byName).toEqual({
      "success >= baseline": false,
      "0 unsafe reuse": false,
      "net saving > 0": false,
      "P95 latency controlled (<= baseline x1.10)": false,
      "100% trace replay": false,
    });
    expect(report.delta.successRate).toBe(-1);
  });

  it("gates are null (N/A) when there is nothing to judge", () => {
    const empty = compareArms([], []);
    expect(empty.tasksCompared).toBe(0);
    const byName = Object.fromEntries(empty.gates.map((g) => [g.name, g.passed]));
    expect(byName["success >= baseline"]).toBeNull();
    expect(byName["net saving > 0"]).toBeNull();
    expect(byName["P95 latency controlled (<= baseline x1.10)"]).toBeNull();
    expect(byName["100% trace replay"]).toBeNull();
    expect(byName["0 unsafe reuse"]).toBe(true);
    expect(empty.netSaving.pct).toBeNull();

    const unjudged = compareArms([trace({ id: "1" })], [trace({ id: "1" })]);
    expect(unjudged.gates.find((g) => g.name === "success >= baseline")?.passed).toBeNull();
  });
});

describe("provenanceRefusals", () => {
  it("clean traces -> no refusals", () => {
    expect(provenanceRefusals("baseline", [trace({ id: "1", costMs: 3, reuseMode: "FRESH" })])).toEqual([]);
  });

  it("catches a bad Measurement with label[index] prefixes", () => {
    const good = trace({ id: "1" });
    const bad = trace({ id: "2" });
    bad.llm.calls = { value: 5, provenance: "estimated" };
    bad.rounds = { value: 1, provenance: "measured", confidence: 0.5 };
    bad.cost = { actual: { value: Number.NaN, provenance: "measured" } };
    const refusals = provenanceRefusals("candidate", [good, bad]);
    expect(refusals).toEqual([
      "candidate[1]: llm.calls: estimated values require a method string",
      "candidate[1]: rounds: measured values do not carry confidence",
      "candidate[1]: cost.actual: value is not a finite number",
    ]);
  });
});
