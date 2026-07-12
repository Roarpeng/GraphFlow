import { describe, expect, it, beforeEach } from "vitest";
import {
  getEmbeddingQualitySummary,
  recordEmbeddingFailure,
  recordEmbeddingSuccess,
  resetEmbeddingQualityStats,
  scoreEmbeddingSeparation,
  wrapEmbeddingProviderWithQualityMonitor,
  configureEmbeddingQualityMeta,
} from "../src/learning/embedding-quality";
import type { EmbeddingProvider } from "../src/learning/embeddings";
import { diagnoseRoutingResult } from "../src/surfaces/cli/runtime";

function unit(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe("embedding quality monitor", () => {
  beforeEach(() => {
    resetEmbeddingQualityStats();
  });

  it("scores related vectors higher than unrelated ones", () => {
    const relatedA = unit([1, 0.9, 0.1]);
    const relatedB = unit([0.95, 1, 0.05]);
    const unrelated = unit([0, 0, 1]);

    const sample = scoreEmbeddingSeparation(relatedA, relatedB, unrelated);

    expect(sample.relatedSimilarity).toBeGreaterThan(sample.unrelatedSimilarity);
    expect(sample.separationScore).toBeGreaterThan(0.2);
    expect(sample.dimensions).toBe(3);
  });

  it("tracks success/failure rates and exposes summary", () => {
    configureEmbeddingQualityMeta({
      provider: "transformers",
      model: "Xenova/all-MiniLM-L6-v2",
      dimensions: 384,
    });
    recordEmbeddingSuccess(384);
    recordEmbeddingSuccess(384);
    recordEmbeddingFailure(new Error("boom"));

    const summary = getEmbeddingQualitySummary();
    expect(summary.provider).toBe("transformers");
    expect(summary.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(summary.dimensions).toBe(384);
    expect(summary.totalCalls).toBe(3);
    expect(summary.failures).toBe(1);
    expect(summary.failureRate).toBeCloseTo(1 / 3);
    expect(summary.lastError).toBe("boom");
  });

  it("wraps providers to record embed outcomes", async () => {
    let calls = 0;
    const base: EmbeddingProvider = {
      async embed() {
        calls += 1;
        if (calls === 2) {
          throw new Error("embed failed");
        }
        return [0.1, 0.2, 0.3];
      },
    };
    const wrapped = wrapEmbeddingProviderWithQualityMonitor(base, {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    await expect(wrapped.embed("ok")).resolves.toEqual([0.1, 0.2, 0.3]);
    await expect(wrapped.embed("bad")).rejects.toThrow("embed failed");

    const summary = getEmbeddingQualitySummary();
    expect(summary.totalCalls).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.provider).toBe("openai");
  });

  it("exposes embeddingQuality on diagnose result", () => {
    configureEmbeddingQualityMeta({ provider: "transformers", dimensions: 384 });
    recordEmbeddingSuccess(384);

    const diagnosis = diagnoseRoutingResult();
    expect(diagnosis.embeddingQuality).toBeDefined();
    expect(diagnosis.embeddingQuality?.provider).toBe("transformers");
    expect(diagnosis.embeddingQuality?.totalCalls).toBeGreaterThanOrEqual(1);
  });
});
