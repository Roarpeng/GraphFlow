import type { GraphNode } from "../core/types";
import { cosineSimilarity, extractEmbedding } from "./embeddings";

/**
 * HNSW (Hierarchical Navigable Small World) vector index.
 *
 * Previously used hnswlib-node for ANN search, but that has been removed
 * due to C++ compilation dependency issues. Now always uses linear scan.
 */

export interface VectorSearchResult {
  node: GraphNode;
  similarity: number;
}

export interface HnswVectorIndexOptions {
  /** Force linear scan (always true now, kept for API compatibility). */
  forceLinear?: boolean;
  /** Max elements threshold (no longer used, kept for API compatibility). */
  linearThreshold?: number;
}

/**
 * A vector index over graph nodes that have embeddings attached.
 * Uses brute-force cosine similarity (linear scan).
 */
export class HnswVectorIndex {
  private nodes: GraphNode[] = [];
  private embeddings: number[][] = [];
  private dim = 0;

  constructor(_options?: HnswVectorIndexOptions) {
    // options accepted for API compat; no-op for linear scan
  }

  /** Loads nodes with embeddings into the index. */
  load(nodes: GraphNode[]): void {
    this.nodes = [];
    this.embeddings = [];
    for (const node of nodes) {
      const emb = extractEmbedding(node);
      if (!emb) continue;
      if (this.dim === 0) this.dim = emb.length;
      if (emb.length !== this.dim) continue; // skip mismatched dims
      this.nodes.push(node);
      this.embeddings.push(emb);
    }
  }

  get size(): number {
    return this.nodes.length;
  }

  get backend(): "linear" {
    return "linear";
  }

  /** Persist is a no-op now. */
  save(): void {
    // no-op
  }

  /** Load index is a no-op now. */
  async loadIndex(): Promise<boolean> {
    return false;
  }

  /** Returns top-K nodes by similarity to the query embedding. */
  async search(queryEmbedding: number[], topK: number, minSimilarity = 0): Promise<VectorSearchResult[]> {
    if (this.nodes.length === 0 || !queryEmbedding || queryEmbedding.length === 0) {
      return [];
    }
    return this.searchLinear(queryEmbedding, topK, minSimilarity);
  }

  private searchLinear(queryEmbedding: number[], topK: number, minSimilarity: number): VectorSearchResult[] {
    const scored: VectorSearchResult[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      const sim = cosineSimilarity(queryEmbedding, this.embeddings[i]!);
      if (sim >= minSimilarity) {
        scored.push({ node: this.nodes[i]!, similarity: sim });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }
}
