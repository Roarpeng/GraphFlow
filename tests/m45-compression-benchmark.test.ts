import { describe, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { buildLayeredContextPackage, buildEnhancedContextPackage } from "../src/graph/context-slicer";
import type { EmbeddingProvider } from "../src/learning/embeddings";
import { join } from "node:path";

function simpleEmbedding(text: string, dim = 384): number[] {
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] = (vec[i % dim] ?? 0) + text.charCodeAt(i);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  if (norm === 0) return vec;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) * inv;
  return vec;
}

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      return simpleEmbedding(text);
    },
    async warmup(): Promise<void> {},
  };
}

/**
 * Real-world compression benchmark on GraphFlow's own codebase.
 *
 * Uses an isolated in-memory graph client (never touches the real graph-store.json)
 * so it is safe to run in parallel with other tests.
 *
 * Scenarios:
 *   1. Baseline: keyword + layer quotas only
 *   2. Graph compression: + edge weights + PageRank + connected subgraph
 *   3. Full enhanced: + vector recall
 *
 * Expected improvements:
 *   - Graph compression: fewer nodes via centrality, ~7% token reduction, faster
 *   - Full enhanced: better recall via vector fusion
 */

const BENCH_CONFIG = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory", // isolated, no shared file
    maxContextTokens: 3000,
  },
  learningPolicy: {
    enableFlywheel: false,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

const SRC_DIR = join(process.cwd(), "src");

describe("M45 Real-World Compression Benchmark (GraphFlow codebase)", () => {
  const queries = [
    "orchestrator task routing",
    "graph context compression",
    "semantic enrichment minicpm",
    "provider fallback health check",
    "embedding vector search",
  ];

  it("benchmarks baseline (keyword + layer quotas)", async () => {
    const config = BENCH_CONFIG;
    const client = createGraphClient(config);

    // Index GraphFlow's own src/ directory.
    console.log("[benchmark] Indexing GraphFlow codebase...");
    const indexed = await indexWorkspaceFiles(client, SRC_DIR, {
      includeExtensions: [".ts"],
    });
    console.log(`[benchmark] Indexed: ${indexed.indexedFiles} files, ${indexed.indexedSymbols} symbols\n`);

    const results: Array<{ query: string; nodes: number; tokens: number; time: number }> = [];

    for (const query of queries) {
      const start = Date.now();
      const pkg = await buildLayeredContextPackage(client, query, 3000, {
        layerQuota: { l1: 30, l2: 15, l3: 10 },
      });
      const elapsed = Date.now() - start;
      results.push({
        query,
        nodes: pkg.anchorChannel.length,
        tokens: pkg.tokenEstimate,
        time: elapsed,
      });
    }

    console.log("=== Baseline (keyword + quotas) ===");
    console.table(results);
    const avgTokens = results.reduce((sum, r) => sum + r.tokens, 0) / results.length;
    const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
    console.log(`Average: ${avgTokens.toFixed(0)} tokens, ${avgTime.toFixed(0)}ms\n`);
  }, 120000);

  it("benchmarks graph compression (edge weights + PageRank)", async () => {
    const config = BENCH_CONFIG;
    const client = createGraphClient(config);

    console.log("[benchmark] Indexing GraphFlow codebase...");
    const indexed = await indexWorkspaceFiles(client, SRC_DIR, {
      includeExtensions: [".ts"],
    });
    console.log(`[benchmark] Indexed: ${indexed.indexedFiles} files, ${indexed.indexedSymbols} symbols\n`);

    const results: Array<{ query: string; nodes: number; tokens: number; time: number }> = [];

    for (const query of queries) {
      const start = Date.now();
      const pkg = await buildEnhancedContextPackage(client, query, query, 3000, {
        layerQuota: { l1: 30, l2: 15, l3: 10 },
        enableGraphCompression: true,
      });
      const elapsed = Date.now() - start;
      results.push({
        query,
        nodes: pkg.anchorChannel.length,
        tokens: pkg.tokenEstimate,
        time: elapsed,
      });
    }

    console.log("=== Graph Compression (structure-based) ===");
    console.table(results);
    const avgTokens = results.reduce((sum, r) => sum + r.tokens, 0) / results.length;
    const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
    console.log(`Average: ${avgTokens.toFixed(0)} tokens, ${avgTime.toFixed(0)}ms\n`);
  }, 120000);

  it("benchmarks full enhanced compression (graph + vector)", async () => {
    const config = BENCH_CONFIG;
    const client = createGraphClient(config);

    console.log("[benchmark] Indexing GraphFlow codebase with embeddings...");
    const embeddingProvider = createMockEmbeddingProvider();
    const indexed = await indexWorkspaceFiles(client, SRC_DIR, {
      includeExtensions: [".ts"],
      embeddingProvider,
    });
    console.log(`[benchmark] Indexed: ${indexed.indexedFiles} files, ${indexed.indexedSymbols} symbols\n`);

    const results: Array<{ query: string; nodes: number; tokens: number; time: number }> = [];

    for (const query of queries) {
      const start = Date.now();
      const pkg = await buildEnhancedContextPackage(client, query, query, 3000, {
        layerQuota: { l1: 30, l2: 15, l3: 10 },
        enableGraphCompression: true,
        embeddingProvider,
        enableVectorRecall: true,
      });
      const elapsed = Date.now() - start;
      results.push({
        query,
        nodes: pkg.anchorChannel.length,
        tokens: pkg.tokenEstimate,
        time: elapsed,
      });
    }

    console.log("=== Full Enhanced (graph + vector) ===");
    console.table(results);
    const avgTokens = results.reduce((sum, r) => sum + r.tokens, 0) / results.length;
    const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
    console.log(`Average: ${avgTokens.toFixed(0)} tokens, ${avgTime.toFixed(0)}ms\n`);
  }, 180000);
});
