import type { GraphEdge, GraphNode } from "../core/types.js";
import type { ConnectedSubgraphOptions } from "./graph-compression.js";
import type { TaskMode } from "./adaptive-budget.js";
import type { EmbeddingProvider } from "../learning/embeddings.js";

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
  /** Agent-translated English search terms (see Skill CJK workflow). */
  englishQuery?: string;
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