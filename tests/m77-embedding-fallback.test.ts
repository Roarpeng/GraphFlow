import { describe, expect, it, beforeEach } from "vitest";
import {
  createHashEmbeddingProvider,
  createTransformersEmbeddingProvider,
  createResilientLocalEmbeddingProvider,
  cosineSimilarity,
  EMBEDDING_DIM,
  HASH_EMBEDDING_MODEL,
  resolveTransformersCacheDir,
} from "../src/learning/embeddings";
import {
  configureEmbeddingQualityMeta,
  getEmbeddingQualitySummary,
  resetEmbeddingQualityStats,
  wrapEmbeddingProviderWithQualityMonitor,
} from "../src/learning/embedding-quality";
import { createEmbeddingProviderFromConfig } from "../src/config/embedding-factory";
import type { GraphFlowConfig } from "../src/config/schema";

describe("M77 embedding hash fallback", () => {
  beforeEach(() => {
    resetEmbeddingQualityStats();
  });

  it("hash embedding is deterministic, 384-d, and unit-norm", async () => {
    const provider = createHashEmbeddingProvider();
    const a = await provider.embed("graph context compression");
    const b = await provider.embed("graph context compression");
    const c = await provider.embed("banana smoothie recipe");

    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(a).not.toEqual(c);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("resilient provider falls back to hash when transformers module is missing", async () => {
    let fallbackCalled = false;
    const provider = createResilientLocalEmbeddingProvider({
      loadModule: async () => {
        const err = new Error("Cannot find package '@xenova/transformers'");
        (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
        throw err;
      },
      onFallback: () => {
        fallbackCalled = true;
      },
    });

    const vector = await provider.embed("warmup probe");
    expect(vector).toHaveLength(EMBEDDING_DIM);
    expect(provider.getBackend()).toBe("hash");
    expect(fallbackCalled).toBe(true);

    // Second call stays on hash without re-throwing
    const again = await provider.embed("second call");
    expect(again).toHaveLength(EMBEDDING_DIM);
    expect(provider.getBackend()).toBe("hash");
  });

  it("resolves transformers cache dir from config before environment", () => {
    const oldValue = process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR;
    process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR = "/env/cache";
    try {
      expect(resolveTransformersCacheDir("/config/cache")).toBe("/config/cache");
      expect(resolveTransformersCacheDir()).toBe("/env/cache");
      expect(resolveTransformersCacheDir("   ")).toBe("/env/cache");
    } finally {
      if (oldValue === undefined) {
        delete process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR;
      } else {
        process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR = oldValue;
      }
    }
  });

  it("applies transformers cache dir before loading the pipeline", async () => {
    const transformerModule = {
      env: {} as { cacheDir?: string },
      pipeline: async () => {
        expect(transformerModule.env.cacheDir).toBe("/offline/model-cache");
        return async () => ({ data: [0.1, 0.2, 0.3] });
      },
    };
    const provider = createTransformersEmbeddingProvider({
      modelCacheDir: "/offline/model-cache",
      loadModule: async () => transformerModule,
    });

    await expect(provider.embed("cache probe")).resolves.toEqual([0.1, 0.2, 0.3]);
  });

  it("factory hash provider reports hash meta without failures", async () => {
    const config = {
      providers: {},
      graphPolicy: {},
      embeddingPolicy: { provider: "hash" as const },
    } as GraphFlowConfig;

    const provider = createEmbeddingProviderFromConfig(config);
    expect(provider).toBeDefined();
    const vec = await provider!.embed("token first context");
    expect(vec).toHaveLength(EMBEDDING_DIM);

    const summary = getEmbeddingQualitySummary();
    expect(summary.provider).toBe("hash");
    expect(summary.model).toBe(HASH_EMBEDDING_MODEL);
    expect(summary.failures).toBe(0);
    expect(summary.totalCalls).toBeGreaterThanOrEqual(1);
  });

  it("quality wrap records success after resilient hash fallback simulation", async () => {
    let calls = 0;
    const flakyThenHash = {
      async embed(text: string) {
        calls += 1;
        if (calls === 1) {
          const err = new Error("Cannot find package '@xenova/transformers'");
          (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
          throw err;
        }
        return createHashEmbeddingProvider().embed(text);
      },
    };

    // Simulate resilient behaviour: catch then hash
    const resilient = {
      async embed(text: string) {
        try {
          return await flakyThenHash.embed(text);
        } catch {
          return createHashEmbeddingProvider().embed(text);
        }
      },
    };

    const wrapped = wrapEmbeddingProviderWithQualityMonitor(resilient, {
      provider: "transformers",
      model: "Xenova/all-MiniLM-L6-v2",
      dimensions: EMBEDDING_DIM,
    });

    const vec = await wrapped.embed("query");
    expect(vec).toHaveLength(EMBEDDING_DIM);
    const summary = getEmbeddingQualitySummary();
    expect(summary.failures).toBe(0);
    expect(summary.totalCalls).toBe(1);
  });

  it("configureEmbeddingQualityMeta can switch to hash after fallback", () => {
    configureEmbeddingQualityMeta({
      provider: "transformers",
      model: "Xenova/all-MiniLM-L6-v2",
      dimensions: 384,
    });
    configureEmbeddingQualityMeta({
      provider: "hash",
      model: HASH_EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIM,
    });
    expect(getEmbeddingQualitySummary().provider).toBe("hash");
    expect(getEmbeddingQualitySummary().model).toBe(HASH_EMBEDDING_MODEL);
  });
});
