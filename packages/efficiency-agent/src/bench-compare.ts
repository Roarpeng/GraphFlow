import { replayProblems } from "./observability/replay.js";
import type { TaskTrace } from "./trace.js";
import { validateTraceProvenance } from "./trace.js";

/**
 * Benchmark comparison (spec §18 metrics, §10 Net Saving, §28 acceptance
 * gates). Traces are paired by benchmark task id; success counts
 * oracle-judged traces only, so unjudged tasks can never inflate a rate.
 */

export interface ArmStats {
  traces: number;
  judged: number;
  successRate: number | null;
  /** Mean share of oracle checks passed on judged traces. */
  fidelity: number | null;
  avgContextTokens: number;
  contextTokensProvenance: string;
  totalLlmCalls: number;
  llmCallsProvenance: string;
  totalToolCalls: number;
  avgRounds: number;
  latencyMs: { avg: number | null; p50: number | null; p95: number | null };
  cacheHitRate: number;
  /** Share of runs whose applied decision reused something (REUSE or ADAPT). */
  reuseRate: number;
  /** Share of runs whose regression guards failed. */
  guardFailureRate: number | null;
  /** Wall-clock cost (ms, measured) including the decision itself. */
  totalCostMs: number;
  decisionCostMs: number;
  unsafeReuse: number;
  replayable: number;
}

export interface CompareGate {
  name: string;
  passed: boolean | null;
  detail: string;
}

export interface CompareReport {
  tasksCompared: number;
  baseline: ArmStats;
  candidate: ArmStats;
  delta: {
    successRate: number | null;
    fidelity: number | null;
    avgContextTokens: number;
    totalLlmCalls: number;
    totalToolCalls: number;
    avgRounds: number;
    latencyP95Ms: number | null;
    cacheHitRate: number;
    reuseRate: number;
  };
  /** Paired: baseline oracle passed, candidate oracle failed. */
  regressionRate: number | null;
  regressions: string[];
  netSaving: { ms: number; pct: number | null };
  gates: CompareGate[];
}

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function traceDurationMs(trace: TaskTrace): number | undefined {
  if (!trace.run.finishedAt) return undefined;
  const ms = Date.parse(trace.run.finishedAt) - Date.parse(trace.run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function computeArmStats(traces: TaskTrace[]): ArmStats {
  const n = traces.length || 1;
  const judged = traces.filter((t) => t.judged === true);
  const durations = traces.map(traceDurationMs).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
  const fidelities = judged
    .map((t) => t.oracle?.checks ?? [])
    .filter((checks) => checks.length > 0)
    .map((checks) => checks.filter((c) => c.passed).length / checks.length);
  const guarded = traces.filter((t) => t.regression !== undefined);
  return {
    traces: traces.length,
    judged: judged.length,
    successRate: judged.length > 0 ? round(judged.filter((t) => t.result.success).length / judged.length) : null,
    fidelity: fidelities.length > 0 ? round(fidelities.reduce((a, b) => a + b, 0) / fidelities.length) : null,
    avgContextTokens: Math.round(traces.reduce((acc, t) => acc + t.context.tokens.value, 0) / n),
    contextTokensProvenance: Array.from(new Set(traces.map((t) => t.context.tokens.provenance))).join("+") || "n/a",
    totalLlmCalls: traces.reduce((acc, t) => acc + t.llm.calls.value, 0),
    llmCallsProvenance: Array.from(new Set(traces.map((t) => t.llm.calls.provenance))).join("+") || "n/a",
    totalToolCalls: traces.reduce((acc, t) => acc + t.tools.reduce((s, tool) => s + tool.calls.value, 0), 0),
    avgRounds: round(traces.reduce((acc, t) => acc + t.rounds.value, 0) / n, 2),
    latencyMs: {
      avg: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
    },
    cacheHitRate: round(traces.filter((t) => t.context.cacheHit).length / n),
    reuseRate: round(traces.filter((t) => t.decision && t.decision.reuseMode !== "FRESH").length / n),
    guardFailureRate: guarded.length > 0 ? round(guarded.filter((t) => !t.regression!.passed).length / guarded.length) : null,
    totalCostMs: traces.reduce((acc, t) => acc + (t.cost?.actual?.value ?? traceDurationMs(t) ?? 0), 0),
    decisionCostMs: traces.reduce((acc, t) => acc + (t.decision?.durationMs.value ?? 0), 0),
    // A reused/adapted result that the oracle then failed is an unsafe reuse.
    unsafeReuse: traces.filter((t) => t.judged === true && !t.result.success && t.decision?.reuseMode === "REUSE").length,
    replayable: traces.filter((t) => replayProblems(t).length === 0).length,
  };
}

export function provenanceRefusals(label: string, traces: TaskTrace[]): string[] {
  const refusals: string[] = [];
  traces.forEach((t, i) => validateTraceProvenance(t).forEach((v) => refusals.push(`${label}[${i}]: ${v}`)));
  return refusals;
}

export function compareArms(baselineTraces: TaskTrace[], candidateTraces: TaskTrace[]): CompareReport {
  const key = (t: TaskTrace) => t.task.taskId ?? t.task.text;
  const baseByKey = new Map(baselineTraces.map((t) => [key(t), t]));
  const candByKey = new Map(candidateTraces.map((t) => [key(t), t]));
  const pairedKeys = [...baseByKey.keys()].filter((k) => candByKey.has(k));
  const base = pairedKeys.map((k) => baseByKey.get(k)!);
  const cand = pairedKeys.map((k) => candByKey.get(k)!);
  const b = computeArmStats(base);
  const c = computeArmStats(cand);

  const bothJudged = pairedKeys.filter((k) => baseByKey.get(k)!.judged === true && candByKey.get(k)!.judged === true);
  const regressions = bothJudged.filter((k) => baseByKey.get(k)!.result.success && !candByKey.get(k)!.result.success);
  const netMs = b.totalCostMs - c.totalCostMs;
  const diff = (x: number | null, y: number | null) => (x === null || y === null ? null : round(y - x));

  const gates: CompareGate[] = [
    {
      name: "success >= baseline",
      passed: b.successRate === null || c.successRate === null ? null : c.successRate >= b.successRate,
      detail: `${b.successRate ?? "n/a"} -> ${c.successRate ?? "n/a"} (judged ${b.judged}/${c.judged})`,
    },
    { name: "0 unsafe reuse", passed: c.unsafeReuse === 0, detail: `${c.unsafeReuse} reused result(s) failed the oracle` },
    {
      name: "net saving > 0",
      passed: pairedKeys.length === 0 ? null : netMs > 0,
      detail: `${netMs}ms (baseline ${b.totalCostMs}ms - candidate ${c.totalCostMs}ms incl. ${c.decisionCostMs}ms decision)`,
    },
    {
      name: "P95 latency controlled (<= baseline x1.10)",
      passed: b.latencyMs.p95 === null || c.latencyMs.p95 === null ? null : c.latencyMs.p95 <= b.latencyMs.p95 * 1.1,
      detail: `${b.latencyMs.p95 ?? "n/a"}ms -> ${c.latencyMs.p95 ?? "n/a"}ms`,
    },
    {
      name: "100% trace replay",
      passed: c.traces === 0 ? null : c.replayable === c.traces,
      detail: `${c.replayable}/${c.traces} candidate traces replayable`,
    },
  ];

  return {
    tasksCompared: pairedKeys.length,
    baseline: b,
    candidate: c,
    delta: {
      successRate: diff(b.successRate, c.successRate),
      fidelity: diff(b.fidelity, c.fidelity),
      avgContextTokens: c.avgContextTokens - b.avgContextTokens,
      totalLlmCalls: c.totalLlmCalls - b.totalLlmCalls,
      totalToolCalls: c.totalToolCalls - b.totalToolCalls,
      avgRounds: round(c.avgRounds - b.avgRounds, 2),
      latencyP95Ms: b.latencyMs.p95 === null || c.latencyMs.p95 === null ? null : c.latencyMs.p95 - b.latencyMs.p95,
      cacheHitRate: round(c.cacheHitRate - b.cacheHitRate),
      reuseRate: round(c.reuseRate - b.reuseRate),
    },
    regressionRate: bothJudged.length > 0 ? round(regressions.length / bothJudged.length) : null,
    regressions,
    netSaving: { ms: netMs, pct: b.totalCostMs > 0 ? round((netMs / b.totalCostMs) * 100, 1) : null },
    gates,
  };
}
