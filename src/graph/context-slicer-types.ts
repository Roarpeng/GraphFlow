import type { GraphEdge, GraphNode } from "../core/types.js";
import type { EmbeddingProvider } from "../learning/embeddings.js";
import type { ConnectedSubgraphOptions } from "./graph-compression.js";
import type { ClusteringOptions, SummarizerOptions, DensifierOptions } from "./semantic-compression.js";
import type { TaskMode } from "./adaptive-budget.js";
import type { CompressionModelHandle } from "./compression-model.js";

export interface ContextSlice {
  items: string[];
  tokenEstimate: number;
}

export type ContextLayer = "L1" | "L2" | "L3";

export interface ContextAnchorItem {
  id: string;
  type: GraphNode["type"];
  layer: ContextLayer;
}

export interface LayeredContextPackage {
  summaryChannel: string[];
  anchorChannel: ContextAnchorItem[];
  tokenEstimate: number;
  truncated: boolean;
}

export interface LayeredPackageOptions {
  layerQuota?: {
    l1: number;
    l2: number;
    l3: number;
  };
  enableEdgeExpansion?: boolean;
  enableVectorRecall?: boolean;
  embeddingProvider?: EmbeddingProvider;
  vectorTopK?: number;
  vectorMinSimilarity?: number;
  /** Use HNSW ANN index for large candidate sets (>=200 nodes). Default true. */
  enableHnsw?: boolean;
  /** Enable graph-structure compression (edge weights, PageRank, connected subgraph). */
  enableGraphCompression?: boolean;
  graphCompressionOptions?: ConnectedSubgraphOptions;
  /** Enable semantic compression via minicpm-1b (clustering, summarization, densification). */
  enableSemanticCompression?: boolean;
  clusteringOptions?: ClusteringOptions;
  summarizerOptions?: SummarizerOptions;
  densifierOptions?: DensifierOptions;
  /** Unified compression model handle (auto-selects external economy tier or embedded minicpm). */
  compressionModel?: CompressionModelHandle;
  /** Return RepoMap overview if token budget is low. */
  enableRepoMapFallback?: boolean;
  /** Adaptive budget estimation based on task complexity. */
  taskMode?: TaskMode;
}

export interface SubgraphExpansionOptions {
  hops?: number;
  maxNodes?: number;
  relations?: GraphEdge["relation"][];
}

export interface ContextRefillManager {
  initialPackage(query: string): Promise<LayeredContextPackage>;
  refill(evidenceHints: string[]): Promise<string[]>;
}

export const DEFAULT_EXPANSION_RELATIONS: GraphEdge["relation"][] = [
  "references",
  "imports",
  "depends_on",
  "prerequisite",
  "calls",
  "defines",
];

export const ARCHITECTURE_QUERY = /architecture|refactor|module|design|架构|模块/i;