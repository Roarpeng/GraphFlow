import {
  type AdvisoryInput,
  type AdvisoryModelTier,
  buildEfficiencyAdvisory,
  type EfficiencyAdvisory,
  type ReuseMode,
} from "./efficiency-advisory.js";

/**
 * Layer B: Lightweight Meta-Advisory Reflection Engine (HTML §4).
 *
 * Implements a hybrid decision architecture:
 * 1. High confidence zone (> 0.7 or < 0.3): Layer A deterministic fast-path
 *    with zero latency and zero LLM calls.
 * 2. Gray zone (0.3 ~ 0.7 similarity): Lightweight economy model reflection
 *    evaluating whether REUSE / ADAPT / FRESH is safe (semantic similarity ≠ safe reuse)
 *    and whether model tier escalation is warranted.
 * 3. Graceful fallback: If no LLM is configured or the reflector fails, smoothly
 *    falls back to Layer A deterministic rules without ever throwing.
 */

export const SIMILARITY_FAST_PATH_LOW = 0.3;
export const SIMILARITY_FAST_PATH_HIGH = 0.7;

/**
 * Returns true if the similarity falls within the ambiguous gray zone (0.3 <= s <= 0.7).
 */
export function isGrayZoneSimilarity(similarity?: number): boolean {
  if (similarity === undefined || Number.isNaN(similarity)) {
    return false;
  }
  return similarity >= SIMILARITY_FAST_PATH_LOW && similarity <= SIMILARITY_FAST_PATH_HIGH;
}

export interface MetaReflectionInput {
  task: string;
  taskComplexity: "simple" | "complex";
  executionMode: "bridge" | "llm";
  topSimilarity?: number | undefined;
  topEpisode?: {
    id: string;
    task: string;
    score: number;
    similarity?: number;
  } | undefined;
  similarEpisodes: Array<{
    id: string;
    task: string;
    score: number;
    similarity?: number;
  }>;
}

export interface MetaReflectionVerdict {
  reuseMode: ReuseMode;
  confidence: number;
  suggestedTier?: AdvisoryModelTier;
  reasoning: string;
}

/** Function signature for a lightweight economy model reflector. */
export type MetaReflector = (
  input: MetaReflectionInput
) => Promise<MetaReflectionVerdict | undefined | null>;

export interface MetaAdvisoryOptions {
  /** Optional lightweight economy model reflector */
  metaReflector?: MetaReflector;
  /** Force Layer A deterministic path even in the gray zone */
  bypassMetaReflection?: boolean;
}

/**
 * Evaluates efficiency advisory using the Layer B hybrid engine.
 *
 * - Fast path (>0.7 or <0.3): Zero-LLM deterministic Layer A.
 * - Gray zone (0.3..0.7): Lightweight model reflection when available.
 * - Missing/failing LLM: Smooth zero-throw fallback to Layer A.
 */
export async function evaluateMetaAdvisory(
  input: AdvisoryInput,
  options: MetaAdvisoryOptions = {}
): Promise<EfficiencyAdvisory> {
  const startedAt = Date.now();
  const similarEpisodes = input.similarEpisodes ?? [];
  const episodesWithSimilarity = similarEpisodes.filter((e) => e.similarity !== undefined);

  let topEpisode: (typeof similarEpisodes)[0] | undefined;
  let topSimilarity: number | undefined;

  if (episodesWithSimilarity.length > 0) {
    topEpisode = episodesWithSimilarity.reduce((best, curr) =>
      curr.similarity! > best.similarity! ? curr : best
    );
    topSimilarity = topEpisode.similarity;
  }

  const inGrayZone = isGrayZoneSimilarity(topSimilarity);

  // 1. High Confidence Fast-Path: outside gray zone or explicitly bypassed
  if (!inGrayZone || options.bypassMetaReflection) {
    return buildEfficiencyAdvisory(input);
  }

  // 2. Gray Zone: no LLM reflector provided -> smooth fallback to Layer A
  if (!options.metaReflector) {
    const base = buildEfficiencyAdvisory(input);
    return {
      ...base,
      decision: {
        ...base.decision,
        provenance: "deterministic",
        llmCalls: 0,
        metaReflection: {
          fallback: true,
          reasoning: "Gray zone detected (0.3 <= sim <= 0.7) but no metaReflector provided. Reverted to Layer A.",
        },
      },
    };
  }

  // 3. Gray Zone: call lightweight economy model for Meta-Reflection
  try {
    const reflectionInput: MetaReflectionInput = {
      task: input.task,
      taskComplexity: input.taskComplexity,
      executionMode: input.executionMode,
      topSimilarity,
      topEpisode,
      similarEpisodes,
    };

    const verdict = await options.metaReflector(reflectionInput);

    if (!verdict) {
      // Empty verdict -> smooth fallback
      const base = buildEfficiencyAdvisory(input);
      return {
        ...base,
        decision: {
          ...base.decision,
          provenance: "deterministic",
          llmCalls: 0,
          metaReflection: {
            fallback: true,
            reasoning: "MetaReflector returned empty verdict. Reverted to Layer A.",
          },
        },
      };
    }

    // Successfully reflected with economy model
    const base = buildEfficiencyAdvisory(input);
    const durationMs = Math.max(0, Math.round(input.durationMs + (Date.now() - startedAt)));

    return {
      ...base,
      reuseMode: verdict.reuseMode,
      confidence: Math.max(0, Math.min(1, verdict.confidence)),
      worker: {
        ...base.worker,
        ...(verdict.suggestedTier ? { modelTier: verdict.suggestedTier } : {}),
      },
      decision: {
        provenance: "llm",
        llmCalls: 1,
        durationMs,
        metaReflection: {
          fallback: false,
          reasoning: verdict.reasoning,
          confidence: verdict.confidence,
        },
      },
    };
  } catch (error) {
    // Graceful error recovery: never throw on reflector failure
    const base = buildEfficiencyAdvisory(input);
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      decision: {
        ...base.decision,
        provenance: "deterministic",
        llmCalls: 0,
        metaReflection: {
          fallback: true,
          reasoning: `MetaReflector threw error: ${errMessage}. Reverted to Layer A.`,
        },
      },
    };
  }
}
