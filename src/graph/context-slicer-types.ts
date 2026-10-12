import type { GraphEdge, GraphNode } from "../core/types.js";
import type { ConnectedSubgraphOptions } from "./graph-compression.js";
import type { TaskMode } from "./adaptive-budget.js";
import type { EmbeddingProvider } from "../learning/embeddings.js";
import type { PprOptions } from "./pagerank.js";

export interface ContextSlice {
  items: string[];
  tokenEstimate: number;
}

export type ContextLayer = "L1" | "L2" | "L3";

export interface ContextAnchorItem {
  id: string;
  type: GraphNode["type"];
  layer: ContextLayer;
  /**
   * Normalized 0..1 query relevance (`computeAnchorRelevance` in
   * graph-search.ts): the share of query term tokens (CJK phrases and
   * overlapping bigrams included) present in the node's searchable text.
   * Attached post-pack by the slicer; absent when the anchor's node cannot
   * be resolved from the hit list / snapshot. Pure reporting signal for the
   * low-relevance query-translate trigger — it never gates packing.
   */
  relevance?: number;
}

export interface LayeredContextPackage {
  summaryChannel: string[];
  anchorChannel: ContextAnchorItem[];
  tokenEstimate: number;
  truncated: boolean;
  /** Declaration bodies quoted into the pack, and why the rest were left as pointers. */
  bodies?: import("./anchor-bodies.js").AnchorBodyStats;
}

export interface LayeredPackageOptions {
  layerQuota?: {
    l1: number;
    l2: number;
    l3: number;
  };
  enableEdgeExpansion?: boolean;
  /**
   * Subgraph-expansion strategy used by neighbor injection when
   * `enableEdgeExpansion` is on (default `"bfs"`, unchanged legacy walk).
   * `"ppr"` ranks the seeded neighborhood by Personalized PageRank mass and
   * admits highest-mass neighbors first — see `SubgraphExpansionStrategy`.
   */
  expansionStrategy?: SubgraphExpansionStrategy;
  /** Enable graph-structure compression (edge weights, PageRank, connected subgraph). */
  enableGraphCompression?: boolean;
  graphCompressionOptions?: ConnectedSubgraphOptions;
  /** Return RepoMap overview if token budget is low. */
  enableRepoMapFallback?: boolean;
  /** Adaptive budget estimation based on task complexity. */
  taskMode?: TaskMode;
  /** Enable vector recall via embedding similarity search. */
  enableVectorRecall?: boolean;
  /** When true, vector recall searches all snapshot nodes with embeddings instead of keyword hits only. Default false. */
  enableFullGraphVectorRecall?: boolean;
  /** Embedding provider for vector recall. Required when enableVectorRecall is true. */
  embeddingProvider?: EmbeddingProvider;
  /** Top-K results for vector recall. Default 8. */
  vectorTopK?: number;
  /** Minimum cosine similarity for vector recall. Default 0.05. */
  vectorMinSimilarity?: number;
  /** Workspace root for CJK query expansion (path token hints). */
  workspaceRoot?: string;
  /** Quote declaration bodies for the first symbol anchors. Default true. */
  enableSymbolBodies?: boolean;
  /** Agent-translated English search terms (see Skill CJK workflow). */
  englishQuery?: string;
  /** Hard cap on anchor count. Default 15. Set to Infinity to disable. */
  maxAnchors?: number;
  /**
   * Always inject L2 module nodes and L3 skill/decision nodes regardless of query pattern.
   * When packing L3, Decision/goal alignment/deviation nodes are pinned so budget
   * truncation cannot drop them (Governance Decay). Default false.
   */
  enableAlwaysOnLayers?: boolean;
  /**
   * Rerank the fused hit list (top ~40) by embedding cosine similarity AFTER
   * vector fusion / graph compression and BEFORE hit packaging
   * (`rerankHitsByEmbedding` in `src/graph/rerank.ts`). Requires a non-hash
   * `embeddingProvider`; the stage self-skips (returns the list unchanged)
   * when the provider is missing, fingerprint-less, or hash-like.
   * Default false — zero behavior change.
   */
  enableRerank?: boolean;
}

/** Governance pin kinds for L3 Decision/goal nodes. */
export type L3PinKind = "alignment" | "deviation" | "goal";

/**
 * Subgraph-expansion strategy for `expandSubgraph`:
 * - `"bfs"` (default): fixed-depth neighborhood walk — the original behavior,
 *   unchanged when the option is absent.
 * - `"ppr"`: rank the multi-hop neighborhood by Personalized PageRank mass
 *   (HippoRAG 2-style) seeded from the anchor ids, admitting neighbors in
 *   descending mass until the node limit. Under `"ppr"`, `hops` controls the
 *   radius of the candidate POOL to rank and defaults to 2 (multi-hop reach).
 */
export type SubgraphExpansionStrategy = "bfs" | "ppr";

export interface SubgraphExpansionOptions {
  hops?: number;
  maxNodes?: number;
  relations?: GraphEdge["relation"][];
  /** Expansion strategy. Default `"bfs"` — zero behavior change when omitted. */
  expansionStrategy?: SubgraphExpansionStrategy;
  /** Tuning for the `"ppr"` strategy (damping / iterations / tolerance / edge weights). */
  ppr?: PprOptions;
}

export interface ContextRefillManager {
  initialPackage(query: string): Promise<LayeredContextPackage>;
  /** Mark anchors of an already-built package as seen, without rebuilding it. */
  seed(anchorIds: Iterable<string>): void;
  refill(evidenceHints: string[]): Promise<string[]>;
  /**
   * Which ladder stage satisfied each hint of the most recent `refill()` call
   * (see `RefillStageChoice`). Additive reporting field — consumers that only
   * call initialPackage/seed/refill are unaffected.
   */
  readonly lastStages?: readonly RefillStageChoice[];
}

/**
 * Token-cost multipliers of the refill escalation ladder. The charged cost of
 * an anchor line is `estimateTokens(line) * weight(stage)`: lexical recall is
 * the unit cost (weight 1 — exactly the legacy accounting), vector recall
 * models the hint-embedding overhead, and a full File-node read is the most
 * expensive. Applied against the manager's cumulative refill budget.
 */
export interface RefillCostWeights {
  lexical: number;
  vector: number;
  file: number;
}

/** Which ladder stage satisfied one refill hint (or `"none"` when all stages missed). */
export interface RefillStageChoice {
  hint: string;
  stage: "lexical" | "vector" | "file" | "none";
  /** Anchor id committed for this hint (absent for stage "none"). */
  anchorId?: string;
  /** Charged token cost (estimate * stage weight) actually spent. */
  tokens: number;
}

/** Additive options for `createContextRefillManager`'s escalation ladder. */
export interface ContextRefillManagerOptions {
  /**
   * Provider for stage-2 vector recall on a hint. Stage 2 is skipped entirely
   * (and the ladder falls through to stage 3) when absent or hash-like.
   */
  embeddingProvider?: EmbeddingProvider;
  /** Per-stage cost multipliers (defaults: lexical 1, vector 2, file 4). */
  costWeights?: Partial<RefillCostWeights>;
}

export const DEFAULT_EXPANSION_RELATIONS: GraphEdge["relation"][] = [
  "references",
  "imports",
  "depends_on",
  "prerequisite",
  "calls",
  "defines",
  "documents",
  "implements",
  "derived_from",
];

/**
 * Overview / architecture retrieval intent (EN + CJK).
 * Used to surface orchestrator / MCP / README hubs and demote peripheral leaves.
 */
export const ARCHITECTURE_QUERY =
  /architecture|architect|orchestrat|refactor|module|design|structure|overview|package[\s_-]*structure|mcp|readme|架构|模块|顶层|发布|概览|结构|设计|分层/i;