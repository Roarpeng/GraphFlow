import { describe, expect, it, vi } from "vitest";
import type { GraphNode } from "../src/core/types";
import { validateConfig } from "../src/config/loader";
import type { GraphClient } from "../src/graph/client-factory";
import { attachEmbedding } from "../src/learning/embeddings";
import { logger } from "../src/utils/logger";

vi.mock("../src/utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

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

describe("M78 full-graph vector recall", () => {
  it("defaults full-graph vector recall off and preserves explicit opt-in", () => {
    const baseConfig = {
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-5.3-codex" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 4000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory" as const,
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly" as const,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    };

    expect(validateConfig(baseConfig).embeddingPolicy?.enableFullGraphVectorRecall).toBe(false);
    expect(
      validateConfig({
        ...baseConfig,
        embeddingPolicy: { enableFullGraphVectorRecall: true },
      }).embeddingPolicy?.enableFullGraphVectorRecall
    ).toBe(true);
  });

  it("keeps vector recall scoped to keyword hits by default", async () => {
    const keyword = attachEmbedding(
      { id: "symbol:keyword", type: "Symbol", content: "keyword auth login handler" },
      [1, 0]
    );
    const semanticOnly = attachEmbedding(
      { id: "symbol:semantic", type: "Symbol", content: "semantic vector-only result" },
      [0, 1]
    );
    const client = graphClient([keyword, semanticOnly], [keyword]);
    const { buildLayeredContextPackage } = await import("../src/graph/context-slicer");

    const pkg = await buildLayeredContextPackage(client, "auth", 500, {
      embeddingProvider: { embed: async () => [0, 1] },
      enableEdgeExpansion: false,
      enableVectorRecall: true,
      vectorMinSimilarity: 0.9,
      vectorTopK: 1,
    });

    expect(pkg.anchorChannel.map((anchor) => anchor.id)).toEqual(["symbol:keyword"]);
  });

  it("recalls embedded nodes outside keyword hits when full-graph recall is enabled", async () => {
    const keyword = attachEmbedding(
      { id: "symbol:keyword", type: "Symbol", content: "keyword auth login handler" },
      [1, 0]
    );
    const semanticOnly = attachEmbedding(
      { id: "symbol:semantic", type: "Symbol", content: "semantic vector-only result" },
      [0, 1]
    );
    const client = graphClient([keyword, semanticOnly], [keyword]);
    const { buildLayeredContextPackage } = await import("../src/graph/context-slicer");

    const pkg = await buildLayeredContextPackage(client, "auth", 500, {
      embeddingProvider: { embed: async () => [0, 1] },
      enableEdgeExpansion: false,
      enableFullGraphVectorRecall: true,
      enableVectorRecall: true,
      vectorMinSimilarity: 0.9,
      vectorTopK: 1,
    } as Parameters<typeof buildLayeredContextPackage>[3] & {
      enableFullGraphVectorRecall: boolean;
    });

    expect(pkg.anchorChannel.map((anchor) => anchor.id)).toEqual([
      "symbol:keyword",
      "symbol:semantic",
    ]);
  });

  it("logs adaptive budget estimates at debug level", async () => {
    const client = graphClient([], []);
    const { buildEnhancedContextPackage } = await import("../src/graph/context-slicer");

    await buildEnhancedContextPackage(client, "refactor", "refactor authentication module", 100, {
      enableEdgeExpansion: false,
      taskMode: "complex",
    });

    expect(logger.debug).toHaveBeenCalledWith(expect.any(Object), "Adaptive budget estimated");
    expect(logger.info).not.toHaveBeenCalledWith(expect.any(Object), "Adaptive budget estimated");
  });
});
