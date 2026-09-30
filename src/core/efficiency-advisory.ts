import { createHash } from "node:crypto";
import type { FusedStep } from "./fused-descriptor";

/**
 * Efficiency Agent groundwork — Layer A (deterministic) Shadow advisory.
 *
 * The advisory is the Execution Contract embryo: a superset of the fields
 * `graphflow_run`'s executionDescriptor already carries. It answers, with ZERO
 * LLM calls, the six advisor questions from the 2.x plan:
 *   REUSE? CONTEXT? TOOL? MODEL? EXECUTION MODE? VALIDATION?
 * Workers are free to ignore it (Shadow mode) — it never executes anything.
 *
 * Everything here is pure and deterministic: identical inputs must produce
 * byte-identical advisories (except `decision.durationMs`, which is a
 * measured wall-clock fact, not a decision output).
 */

export type ReuseMode = "REUSE" | "ADAPT" | "FRESH";
export type AdvisoryModelTier = "economy" | "standard" | "heavy";
export type AdvisoryExecutionMode = "one-shot" | "loop";

/** Episode similarity floor before experience can justify an ADAPT verdict. */
export const EPISODE_SIMILARITY_THRESHOLD = 0.5;
/**
 * Legacy gate (outcome score >= this) used ONLY when a caller cannot supply
 * similarity. Keep distinct from the similarity floor: an outcome of 1 means
 * "this ranked episode passed", not "this episode resembles the task".
 */
export const EPISODE_ADAPT_THRESHOLD = 0.5;

export interface EfficiencyAdvisory {
  schemaVersion: "1.0";
  /** Stable hash of the normalized task text — the contract's identity key. */
  taskId: string;
  /** Shadow: advisory only. The efficiency layer never executes work in v0. */
  mode: "shadow";
  reuseMode: ReuseMode;
  /** 0..1 — calibrated by benchmark, never a promise of correctness. */
  confidence: number;
  signals: {
    taskComplexity: "simple" | "complex";
    executionMode: "bridge" | "llm";
    fusedStepCount: number;
    similarEpisodeCount: number;
    topEpisodeScore?: number;
    /** Max Jaccard similarity among similar episodes (the reuse gate's signal). */
    topEpisodeSimilarity?: number;
  };
  context: {
    source: "graphflow";
    /** Anchor ids the contract pins as required reading (v0: caller-supplied). */
    requiredAnchors: string[];
    maxTokens?: number;
  };
  worker: {
    modelTier: AdvisoryModelTier;
    executionMode: AdvisoryExecutionMode;
    maxRounds: number;
  };
  validation: string[];
  decision: {
    /**
     * "deterministic": the verdict was computed by rules, not a model call.
     * This is the decision-cost ledger's provenance marker — a deterministic
     * decision is billed at zero LLM cost by construction, and the ledger
     * relies on that marker instead of re-measuring.
     */
    provenance: "deterministic";
    llmCalls: 0;
    /** Measured wall-clock cost of computing this advisory. */
    durationMs: number;
  };
}

export interface AdvisoryInput {
  task: string;
  taskComplexity: "simple" | "complex";
  executionMode: "bridge" | "llm";
  fusedSteps?: FusedStep[];
  similarEpisodes?: Array<{ id: string; task: string; score: number; similarity?: number }>;
  requiredAnchors?: string[];
  maxContextTokens?: number;
  /** Measured advisory computation time (the caller owns the clock). */
  durationMs: number;
}

/** Normalize task text into the fingerprint input: case/space-insensitive. */
export function normalizeTaskForAdvisory(task: string): string {
  return task.trim().replace(/\s+/g, " ").toLowerCase();
}

export function advisoryTaskId(task: string): string {
  return `task:${createHash("sha256").update(normalizeTaskForAdvisory(task)).digest("hex").slice(0, 16)}`;
}

/**
 * REUSE gate, v0 conservative rules (plan §7):
 * - ADAPT when episodic memory shows a SIMILAR past task — gate on text
 *   similarity (Jaccard ≥ EPISODE_SIMILARITY_THRESHOLD) when the signal is
 *   present; fall back to the legacy outcome-score gate only when a caller
 *   cannot supply similarity. Gating on the outcome score alone made ADAPT
 *   fire whenever any pass episode happened to rank top-3 (49/50 ADAPT in
 *   the first full benchmark run).
 * - FRESH otherwise.
 * - REUSE is intentionally unreachable in v0: result reuse stays gated off
 *   until the benchmark proves it safe ("semantic similarity ≠ safe reuse").
 */
export function decideReuseMode(
  similarEpisodes: Array<{ score: number; similarity?: number }>
): { reuseMode: ReuseMode; confidence: number; qualifyingMetric: "similarity" | "score" } {
  const withSimilarity = similarEpisodes.filter(
    (e) => e.similarity !== undefined && e.similarity >= EPISODE_SIMILARITY_THRESHOLD
  );
  if (withSimilarity.length > 0) {
    const top = Math.max(...withSimilarity.map((e) => e.similarity!));
    const confidence = Math.min(
      0.8,
      0.55 + Math.min(0.2, (withSimilarity.length - 1) * 0.05) + (top - EPISODE_SIMILARITY_THRESHOLD) * 0.1
    );
    return {
      reuseMode: "ADAPT",
      confidence: Number(confidence.toFixed(2)),
      qualifyingMetric: "similarity",
    };
  }
  const legacy = similarEpisodes.filter((e) => e.similarity === undefined && e.score >= EPISODE_ADAPT_THRESHOLD);
  if (legacy.length > 0) {
    const top = Math.max(...legacy.map((e) => e.score));
    const confidence = Math.min(
      0.8,
      0.55 + Math.min(0.2, (legacy.length - 1) * 0.05) + (top - EPISODE_ADAPT_THRESHOLD) * 0.1
    );
    return {
      reuseMode: "ADAPT",
      confidence: Number(confidence.toFixed(2)),
      qualifyingMetric: "score",
    };
  }
  return { reuseMode: "FRESH", confidence: 0.5, qualifyingMetric: "similarity" };
}

/**
 * Model tier, deterministic mapping (compute avoidance: default to the
 * cheapest tier that matches task complexity; the deterministic layer NEVER
 * escalates to "heavy" — that jump belongs to a later, evidence-backed stage).
 */
export function decideModelTier(taskComplexity: "simple" | "complex"): AdvisoryModelTier {
  return taskComplexity === "complex" ? "standard" : "economy";
}

export function decideExecution(
  taskComplexity: "simple" | "complex"
): { executionMode: AdvisoryExecutionMode; maxRounds: number } {
  return taskComplexity === "complex"
    ? { executionMode: "loop", maxRounds: 2 }
    : { executionMode: "one-shot", maxRounds: 1 };
}

/** Validation gates ride in as the validate-classified fused step commands. */
export function deriveValidation(fusedSteps: FusedStep[]): string[] {
  const commands = fusedSteps
    .filter((step) => step.action === "validate" && step.command)
    .map((step) => step.command!.trim());
  return Array.from(new Set(commands)).slice(0, 8);
}

export function buildEfficiencyAdvisory(input: AdvisoryInput): EfficiencyAdvisory {
  const fusedSteps = input.fusedSteps ?? [];
  const similarEpisodes = input.similarEpisodes ?? [];
  const { reuseMode, confidence } = decideReuseMode(similarEpisodes);
  const topScore = similarEpisodes.length > 0 ? Math.max(...similarEpisodes.map((e) => e.score)) : undefined;
  const withSimilarity = similarEpisodes.filter((e) => e.similarity !== undefined);
  const topSimilarity =
    withSimilarity.length > 0 ? Math.max(...withSimilarity.map((e) => e.similarity!)) : undefined;

  return {
    schemaVersion: "1.0",
    taskId: advisoryTaskId(input.task),
    mode: "shadow",
    reuseMode,
    confidence,
    signals: {
      taskComplexity: input.taskComplexity,
      executionMode: input.executionMode,
      fusedStepCount: fusedSteps.length,
      similarEpisodeCount: similarEpisodes.length,
      ...(topScore !== undefined ? { topEpisodeScore: topScore } : {}),
      ...(topSimilarity !== undefined ? { topEpisodeSimilarity: topSimilarity } : {}),
    },
    context: {
      source: "graphflow",
      requiredAnchors: [...(input.requiredAnchors ?? [])],
      ...(input.maxContextTokens !== undefined ? { maxTokens: input.maxContextTokens } : {}),
    },
    worker: {
      modelTier: decideModelTier(input.taskComplexity),
      ...decideExecution(input.taskComplexity),
    },
    validation: deriveValidation(fusedSteps),
    decision: {
      provenance: "deterministic",
      llmCalls: 0,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    },
  };
}
