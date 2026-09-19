import { describe, expect, it, beforeEach, vi } from "vitest";
import type { GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import {
  createEmbeddingProviderFromConfig,
  resolveActiveEmbeddingBackend,
  resolveEffectiveEmbeddingBackend,
} from "../src/config/embedding-factory";
import { getDefaultConfig } from "../src/config/defaults";
import type { GraphFlowConfig } from "../src/config/schema";
import {
  createHashEmbeddingProvider,
  createResilientLocalEmbeddingProvider,
  EMBEDDING_DIM,
} from "../src/learning/embeddings";
import {
  configureEmbeddingQualityBackend,
  getEmbeddingQualitySummary,
  resetEmbeddingQualityStats,
} from "../src/learning/embedding-quality";

function graphClient(nodes: GraphNode[], keywordHits: GraphNode[]): GraphClient {
  return {
    async upsertNodes() {
      /* test stub */
    },
    async upsertEdges() {
      /* test stub */
    },
    async queryByKeyword() {
      return keywordHits;
    },
    readSnapshot() {
      return { nodes, edges: [] };
    },
  };
}

function defaultConfigWith(overrides: {
  embeddingProvider?: "fnv" | "transformers";
  embeddingPolicy?: Partial<GraphFlowConfig["embeddingPolicy"]>;
}): GraphFlowConfig {
  const base = getDefaultConfig();
  return {
    ...base,
    graphPolicy: {
      ...base.graphPolicy,
      ...(overrides.embeddingProvider !== undefined
        ? { embeddingProvider: overrides.embeddingProvider }
        : {}),
    },
    ...(overrides.embeddingPolicy !== undefined
      ? { embeddingPolicy: { ...base.embeddingPolicy, ...overrides.embeddingPolicy } }
      : {}),
  };
}

describe("P0-1 semantic embedding backend", () => {
  beforeEach(() => {
    resetEmbeddingQualityStats();
  });

  it("default config is transformers (R7-b semantic-on, resilient local with hash fallback)", async () => {
    const config = getDefaultConfig();
    expect(config.graphPolicy.embeddingProvider).toBe("transformers");
    expect(resolveEffectiveEmbeddingBackend(config)).toBe("transformers");

    // Intent only — do NOT call embed() here: the resilient provider would
    // attempt a real transformers pipeline load (network + 60s timeout).
    // Fallback behaviour is covered by the resilient-provider tests below.
    const provider = createEmbeddingProviderFromConfig(config);
    expect(provider).toBeDefined();

    const summary = getEmbeddingQualitySummary();
    expect(summary.provider).toBe("transformers");
    // Diagnose reports semantic intent before the first embed settles
    expect(resolveActiveEmbeddingBackend(config)).toBe("semantic");
  });

  it("explicit fnv opts out to pure-offline hash; unset/legacy defaults stay semantic-on", () => {
    const explicitFnv = defaultConfigWith({
      embeddingProvider: "fnv",
      embeddingPolicy: { provider: "transformers" },
    });
    expect(resolveEffectiveEmbeddingBackend(explicitFnv)).toBe("fnv");
  });

  it("legacy explicit openai provider (with key) keeps working", () => {
    const config = defaultConfigWith({
      embeddingProvider: "fnv",
      embeddingPolicy: { provider: "openai", apiKey: "sk-test" },
    });
    expect(resolveEffectiveEmbeddingBackend(config)).toBe("openai");
  });

  it("transformers configured → semantic intent in diagnose before first embed", () => {
    const config = defaultConfigWith({ embeddingProvider: "transformers" });
    expect(resolveEffectiveEmbeddingBackend(config)).toBe("transformers");
    expect(resolveActiveEmbeddingBackend(config)).toBe("semantic");
  });

  it("transformers configured and healthy → provider used for query embedding in recall path", async () => {
    const nodes = [
      { id: "symbol:auth", type: "Symbol", content: "auth login handler" },
      { id: "symbol:cache", type: "Symbol", content: "cache invalidation helper" },
    ] as GraphNode[];
    const client = graphClient(nodes, nodes);
    const { buildLayeredContextPackage } = await import("../src/graph/context-slicer");

    // Injectable fake provider standing in for the healthy MiniLM backend
    const fakeProvider = {
      embed: vi.fn(async (text: string) => createHashEmbeddingProvider().embed(text)),
    };

    const pkg = await buildLayeredContextPackage(client, "auth login", 500, {
      embeddingProvider: fakeProvider,
      enableVectorRecall: true,
      enableEdgeExpansion: false,
    });

    // Query embedding went through the configured semantic provider
    expect(fakeProvider.embed).toHaveBeenCalled();
    expect(fakeProvider.embed.mock.calls[0]?.[0]).toContain("auth");
    expect(pkg.anchorChannel.length).toBeGreaterThan(0);
    expect(pkg.anchorChannel.map((a) => a.id)).toContain("symbol:auth");
  });

  it("transformer failure falls back to FNV-1a hash with logged warning", async () => {
    // Resilient provider: module load fails (e.g. missing model cache) → hash
    let fallbackCalled = false;
    const provider = createResilientLocalEmbeddingProvider({
      loadModule: async () => {
        throw new Error("pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') timed out");
      },
      onFallback: () => {
        fallbackCalled = true;
      },
    });

    const vec = await provider.embed("semantic probe");
    expect(vec).toHaveLength(EMBEDDING_DIM);
    expect(provider.getBackend()).toBe("hash");
    expect(provider.getFallbackReason()).not.toBeNull();
    expect(fallbackCalled).toBe(true);

    // Second call stays on hash without re-attempting transformers
    await provider.embed("second probe");
    expect(provider.getBackend()).toBe("hash");
  });

  it("recall path degrades to keyword hits when the provider throws", async () => {
    const nodes = [
      { id: "symbol:auth", type: "Symbol", content: "auth login handler" },
    ] as GraphNode[];
    const client = graphClient(nodes, nodes);
    const { buildLayeredContextPackage } = await import("../src/graph/context-slicer");

    const throwingProvider = {
      embed: vi.fn(async () => {
        throw new Error("model cache missing");
      }),
    };

    const pkg = await buildLayeredContextPackage(client, "auth", 500, {
      embeddingProvider: throwingProvider,
      enableVectorRecall: true,
      enableEdgeExpansion: false,
    });

    expect(throwingProvider.embed).toHaveBeenCalled();
    // Keyword path still yields results; no crash, no empty slice
    expect(pkg.anchorChannel.map((a) => a.id)).toContain("symbol:auth");
  });

  it("diagnose reports off after a transformers→hash fallback settles", () => {
    const config = defaultConfigWith({ embeddingProvider: "transformers" });
    expect(resolveActiveEmbeddingBackend(config)).toBe("semantic");
    // Simulate the quality monitor settling on the hash fallback
    configureEmbeddingQualityBackend("hash");
    expect(resolveActiveEmbeddingBackend(config)).toBe("off");
  });

  it("factory with fnv config never constructs a transformers provider", () => {
    const config = defaultConfigWith({ embeddingProvider: "fnv" });
    const provider = createEmbeddingProviderFromConfig(config);
    expect(provider).toBeDefined();
    // Construction is synchronous and pure-hash: no lazy transformers state
    const summary = getEmbeddingQualitySummary();
    expect(summary.backend).toBe("hash");
  });
});
