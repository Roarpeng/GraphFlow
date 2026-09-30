import {
  validateMeasurement,
  weakestProvenance,
  type Measurement,
} from "./measurement.js";

/**
 * TaskTrace v1 — the per-task record the P0 benchmark runner writes for every
 * run (baseline and advised). One line per task in the benchmark JSONL. The
 * schema mirrors schemas/trace-v1.schema.json; this module owns the
 * provenance gate that makes two traces comparable.
 */

export interface TraceTaskInfo {
  text: string;
  /** Substrate advisory task hash (advisoryTaskId) when the task went through graphflow_run. */
  taskId?: string;
  /** Benchmark task category: query | single-file | multi-file | bugfix | refactor | test | docs | config | cross-module | deliberate-failure. */
  category: string;
}

export interface TraceRunInfo {
  worker: string;
  /** baseline = no efficiency layer; shadow/conservative/adaptive per the 2.x rollout. */
  mode: "baseline" | "shadow" | "conservative" | "adaptive";
  startedAt: string;
  finishedAt?: string;
}

export interface TraceContext {
  tokens: Measurement;
  anchors: number;
  cacheHit: boolean;
  /** Present when a cache entry was rejected — the reason it was not reused. */
  invalidationReason?: string;
}

export interface TraceLlm {
  calls: Measurement;
  inputTokens?: Measurement;
  outputTokens?: Measurement;
  totalTokens?: Measurement;
  costUsd?: Measurement;
}

export interface TraceToolUse {
  name: string;
  calls: Measurement;
  latencyMs?: Measurement;
}

export interface TraceDecision {
  reuseMode: "REUSE" | "ADAPT" | "FRESH";
  durationMs: Measurement;
  llmCalls: Measurement;
  /** Decision cost share of total task cost, 0..1. */
  costShare?: Measurement;
}

export interface TaskTrace {
  schemaVersion: "1.0";
  traceId: string;
  task: TraceTaskInfo;
  run: TraceRunInfo;
  context: TraceContext;
  llm: TraceLlm;
  tools: TraceToolUse[];
  /** Replan/retry rounds actually consumed. */
  rounds: Measurement;
  validation: Array<{ name: string; passed: boolean }>;
  result: { success: boolean };
  decision?: TraceDecision;
  failure?: { stage: string; reason: string };
}

const isMeasurement = (v: unknown): v is Measurement =>
  typeof v === "object" && v !== null && "provenance" in v && "value" in v;

/**
 * R6 gate: collect every provenance violation in a trace. An empty array
 * means the trace may enter an A/B comparison; any violation disqualifies it.
 */
export function validateTraceProvenance(trace: TaskTrace): string[] {
  const violations: string[] = [];
  const check = (field: string, m: Measurement | undefined): void => {
    if (m === undefined) return;
    violations.push(...validateMeasurement(field, m));
  };

  check("context.tokens", trace.context.tokens);
  check("llm.calls", trace.llm.calls);
  check("llm.inputTokens", trace.llm.inputTokens);
  check("llm.outputTokens", trace.llm.outputTokens);
  check("llm.totalTokens", trace.llm.totalTokens);
  check("llm.costUsd", trace.llm.costUsd);
  check("rounds", trace.rounds);
  trace.tools.forEach((tool, index) => {
    check(`tools[${index}].calls`, tool.calls);
    check(`tools[${index}].latencyMs`, tool.latencyMs);
  });
  if (trace.decision) {
    check("decision.durationMs", trace.decision.durationMs);
    check("decision.llmCalls", trace.decision.llmCalls);
    check("decision.costShare", trace.decision.costShare);
  }
  return violations;
}

/** R5 applied at the trace level: what the headline totals may honestly claim. */
export function traceHeadlineProvenance(trace: TaskTrace): {
  tokens: string;
  llmCalls: string;
  rounds: string;
} {
  const parts = [trace.llm.calls, trace.llm.totalTokens, trace.context.tokens, trace.rounds].filter(
    (m): m is Measurement => isMeasurement(m)
  );
  const weakest = weakestProvenance(parts.map((m) => m.provenance));
  return {
    tokens: trace.context.tokens.provenance,
    llmCalls: trace.llm.calls.provenance,
    rounds: weakest === "measured" ? trace.rounds.provenance : weakest,
  };
}
