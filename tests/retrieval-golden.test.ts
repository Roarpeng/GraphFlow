import { beforeAll, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import { join } from "node:path";

/**
 * Retrieval-quality golden set (P0 regression gate).
 *
 * Indexes GraphFlow's own `src/` tree once into an isolated in-memory graph,
 * then asserts that representative queries surface the expected source files
 * in the compressed context package (summary lines + anchor ids).
 *
 * Why: the token-savings benchmark proves we ship ~1% of the tokens, but
 * nothing proved the surviving 1% is the *right* 1%. This suite locks in
 * retrieval correctness so compression/ranking changes cannot silently
 * degrade recall. Extend GOLDEN_SET whenever a retrieval bug is fixed.
 */

const GOLDEN_CONFIG = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory", // isolated, never touches the real graph store
    maxContextTokens: 3000,
  },
  learningPolicy: {
    enableFlywheel: false,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

const SRC_DIR = join(process.cwd(), "src");

/**
 * Each entry: a natural-language query and a set of alternative substrings;
 * the query passes when ANY expected substring appears in the package output
 * (anchor node ids carry their source path, e.g. `file:src/core/orchestrator.ts`).
 */
const GOLDEN_SET: ReadonlyArray<{ query: string; expectAny: string[] }> = [
  { query: "orchestrate task routing", expectAny: ["orchestrator"] },
  { query: "dag execution engine", expectAny: ["dag-engine", "executedag"] },
  { query: "triage task classification simple complex", expectAny: ["triage"] },
  { query: "model router provider selection", expectAny: ["model-router", "modelrouter"] },
  { query: "provider health fallback chain", expectAny: ["provider-health", "providerhealth"] },
  { query: "graph compression pagerank centrality", expectAny: ["graph-compression", "pagerank"] },
  { query: "context slicer layered package", expectAny: ["context-slicer"] },
  { query: "skill flywheel hints scoring", expectAny: ["skill-flywheel", "skillflywheel"] },
  { query: "episodic memory similar episodes", expectAny: ["episodic-memory", "episodicmemory"] },
  { query: "embedding cosine similarity vector", expectAny: ["embeddings", "cosine"] },
  { query: "file watcher incremental index on save", expectAny: ["file-watcher", "filewatcher"] },
  { query: "sqlite graph storage fts5", expectAny: ["sqlite-client", "sqlite"] },
  { query: "repo map module overview", expectAny: ["repo-map", "repomap"] },
  { query: "token savings statistics", expectAny: ["token-savings", "tokensavings"] },
  { query: "mcp server tool definitions", expectAny: ["tool-definitions", "mcp"] },
  { query: "cli output json formatting", expectAny: ["output", "formatcliresult"] },
  { query: "agent delegation work items bridge", expectAny: ["agent-delegation", "workitem"] },
  { query: "six hats insight planning", expectAny: ["insight", "sixhats", "brainstormer"] },
  { query: "hnsw approximate nearest neighbor index", expectAny: ["hnsw"] },
  { query: "adaptive token budget estimation", expectAny: ["adaptive-budget", "estimatecontextbudget"] },
  { query: "artifact export import graph snapshot", expectAny: ["artifact-manager", "artifact"] },
  { query: "nightly learning trainer", expectAny: ["nightly-trainer", "nightlytrainer"] },
  { query: "reflect episodes extract lessons", expectAny: ["reflector", "reflect"] },
  { query: "dag checkpoint recovery taskrun", expectAny: ["dag-checkpoint", "checkpoint"] },
  { query: "cancellation timeout controller", expectAny: ["cancellation", "runtime-controller"] },
  { query: "language indexers tree sitter wasm", expectAny: ["language-indexers", "tree-sitter", "tree_sitter"] },
];

const CONTEXT_TOKEN_BUDGET = 800;

let client: GraphClient;

async function packageText(query: string): Promise<string> {
  const pkg = await buildEnhancedContextPackage(
    client,
    query,
    query,
    CONTEXT_TOKEN_BUDGET,
    { enableGraphCompression: true }
  );
  return [
    ...pkg.summaryChannel,
    ...pkg.anchorChannel.map((anchor) => anchor.id),
  ]
    .join("\n")
    .toLowerCase();
}

describe("Retrieval golden set (recall regression gate)", () => {
  beforeAll(async () => {
    client = createGraphClient(GOLDEN_CONFIG);
    await indexWorkspaceFiles(client, SRC_DIR, GOLDEN_CONFIG.graphPolicy);
  }, 120_000);

  it(`golden set covers ${GOLDEN_SET.length} queries`, () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(20);
  });

  for (const { query, expectAny } of GOLDEN_SET) {
    it(`retrieves expected context for: "${query}"`, async () => {
      const haystack = await packageText(query);
      const hit = expectAny.some((needle) => haystack.includes(needle.toLowerCase()));
      expect(
        hit,
        `query "${query}" should surface one of [${expectAny.join(", ")}] in the context package`
      ).toBe(true);
    });
  }

  it("reports aggregate recall hit rate", async () => {
    let hits = 0;
    for (const { query, expectAny } of GOLDEN_SET) {
      const haystack = await packageText(query);
      if (expectAny.some((needle) => haystack.includes(needle.toLowerCase()))) {
        hits += 1;
      }
    }
    const hitRate = hits / GOLDEN_SET.length;
    console.log(`[golden-set] recall hit rate: ${hits}/${GOLDEN_SET.length} (${(hitRate * 100).toFixed(1)}%)`);
    expect(hitRate).toBeGreaterThanOrEqual(0.8);
  });
});
