import { cosineSimilarity, type EmbeddingProvider } from "./embeddings";

export interface EmbeddingQualitySample {
  relatedSimilarity: number;
  unrelatedSimilarity: number;
  /** relatedSimilarity - unrelatedSimilarity; higher is better. */
  separationScore: number;
  dimensions: number;
  sampledAt: number;
}

export interface EmbeddingQualitySummary {
  provider?: string;
  model?: string;
  dimensions?: number;
  totalCalls: number;
  failures: number;
  failureRate: number;
  lastError?: string;
  lastCallAt?: number;
  lastSample?: EmbeddingQualitySample;
}

interface EmbeddingQualityState {
  provider?: string;
  model?: string;
  dimensions?: number;
  totalCalls: number;
  failures: number;
  lastError?: string;
  lastCallAt?: number;
  lastSample?: EmbeddingQualitySample;
}

const state: EmbeddingQualityState = {
  totalCalls: 0,
  failures: 0,
};

const RELATED_A = "graph context compression token savings";
const RELATED_B = "compress codebase context to reduce tokens";
const UNRELATED = "banana smoothie recipe with mango";

export function resetEmbeddingQualityStats(): void {
  state.provider = undefined;
  state.model = undefined;
  state.dimensions = undefined;
  state.totalCalls = 0;
  state.failures = 0;
  state.lastError = undefined;
  state.lastCallAt = undefined;
  state.lastSample = undefined;
}

export function configureEmbeddingQualityMeta(meta: {
  provider?: string;
  model?: string;
  dimensions?: number;
}): void {
  if (meta.provider !== undefined) {
    state.provider = meta.provider;
  }
  if (meta.model !== undefined) {
    state.model = meta.model;
  }
  if (meta.dimensions !== undefined) {
    state.dimensions = meta.dimensions;
  }
}

export function recordEmbeddingSuccess(dimensions?: number): void {
  state.totalCalls += 1;
  state.lastCallAt = Date.now();
  if (typeof dimensions === "number" && dimensions > 0) {
    state.dimensions = dimensions;
  }
}

export function recordEmbeddingFailure(error: unknown): void {
  state.totalCalls += 1;
  state.failures += 1;
  state.lastCallAt = Date.now();
  state.lastError = error instanceof Error ? error.message : String(error);
}

/**
 * Pure helper: score separation between related vs unrelated embedding vectors.
 * Used by the live sampler and unit tests (no provider required).
 */
export function scoreEmbeddingSeparation(
  relatedA: number[],
  relatedB: number[],
  unrelated: number[]
): EmbeddingQualitySample {
  const relatedSimilarity = cosineSimilarity(relatedA, relatedB);
  const unrelatedSimilarity = cosineSimilarity(relatedA, unrelated);
  return {
    relatedSimilarity,
    unrelatedSimilarity,
    separationScore: relatedSimilarity - unrelatedSimilarity,
    dimensions: relatedA.length,
    sampledAt: Date.now(),
  };
}

/**
 * Lightweight quality sample: related pair should be closer than an unrelated string.
 * Cheap — three embed calls. Failures are recorded but do not throw.
 */
export async function sampleEmbeddingQuality(
  provider: EmbeddingProvider
): Promise<EmbeddingQualitySample | undefined> {
  try {
    const [a, b, u] = await Promise.all([
      provider.embed(RELATED_A),
      provider.embed(RELATED_B),
      provider.embed(UNRELATED),
    ]);
    const sample = scoreEmbeddingSeparation(a, b, u);
    state.lastSample = sample;
    if (sample.dimensions > 0) {
      state.dimensions = sample.dimensions;
    }
    return sample;
  } catch (error) {
    recordEmbeddingFailure(error);
    return undefined;
  }
}

export function getEmbeddingQualitySummary(): EmbeddingQualitySummary {
  const totalCalls = state.totalCalls;
  const failures = state.failures;
  return {
    ...(state.provider ? { provider: state.provider } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(typeof state.dimensions === "number" ? { dimensions: state.dimensions } : {}),
    totalCalls,
    failures,
    failureRate: totalCalls === 0 ? 0 : failures / totalCalls,
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(typeof state.lastCallAt === "number" ? { lastCallAt: state.lastCallAt } : {}),
    ...(state.lastSample ? { lastSample: state.lastSample } : {}),
  };
}

/** Wrap a provider so embed success/failure is recorded for diagnose. */
export function wrapEmbeddingProviderWithQualityMonitor(
  provider: EmbeddingProvider,
  meta?: { provider?: string; model?: string; dimensions?: number }
): EmbeddingProvider {
  if (meta) {
    configureEmbeddingQualityMeta(meta);
  }

  return {
    async embed(text: string): Promise<number[]> {
      try {
        const vector = await provider.embed(text);
        recordEmbeddingSuccess(vector.length);
        return vector;
      } catch (error) {
        recordEmbeddingFailure(error);
        throw error;
      }
    },
    warmup: provider.warmup
      ? async () => {
          await provider.warmup!();
        }
      : undefined,
  };
}
