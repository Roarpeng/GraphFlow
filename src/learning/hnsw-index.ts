import { logger } from "../utils/logger";
import type { GraphNode } from "../core/types";
import { cosineSimilarity, extractEmbedding } from "./embeddings";

/**
 * HNSW (Hierarchical Navigable Small World) vector index with graceful fallback.
 *
 * For large repos (1000+ nodes), linear cosine scan becomes a bottleneck.
 * This module uses hnswlib-node when available (10-100x faster ANN search),
 * and transparently falls back to brute-force scan otherwise.
 *
 * Design: the index is built lazily and cached. Adding/removing nodes marks
 * the index dirty so it rebuilds on next search.
 */

export interface VectorSearchResult {
  node: GraphNode;
  similarity: number;
}

interface HnswlibModule {
  HierarchicalNSW: new (space: string, dim: number) => HnswIndex;
}

interface HnswIndex {
  initIndex(maxElements: number): void;
  addPoint(point: number[], label: number): void;
  searchKnn(query: number[], k: number): { distances: number[]; neighbors: number[] };
  getCurrentCount(): number;
}

let hnswModulePromise: Promise<HnswlibModule | null> | null = null;

async function loadHnswlib(): Promise<HnswlibModule | null> {
  if (hnswModulePromise) return hnswModulePromise;
  hnswModulePromise = (async () => {
    try {
      const mod = (await import("hnswlib-node")) as unknown as HnswlibModule;
      if (mod && typeof mod.HierarchicalNSW === "function") {
        return mod;
      }
      return null;
    } catch {
      // Optional dependency not installed; fall back to linear scan.
      return null;
    }
  })();
  return hnswModulePromise;
}

export interface HnswVectorIndexOptions {
  /** Cosine space recommended for normalized embeddings. */
  space?: "cosine" | "l2" | "ip";
  /** Force linear scan even if hnswlib is available (for testing). */
  forceLinear?: boolean;
}

/**
 * A vector index over graph nodes that have embeddings attached.
 * Uses HNSW when available, otherwise brute-force cosine similarity.
 */
export class HnswVectorIndex {
  private nodes: GraphNode[] = [];
  private embeddings: number[][] = [];
  private dim = 0;
  private hnswIndex: HnswIndex | null = null;
  private dirty = true;
  private readonly space: string;
  private readonly forceLinear: boolean;
  private backendResolved: "hnsw" | "linear" | "pending" = "pending";

  constructor(options?: HnswVectorIndexOptions) {
    this.space = options?.space ?? "cosine";
    this.forceLinear = options?.forceLinear ?? false;
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
    this.dirty = true;
  }

  get size(): number {
    return this.nodes.length;
  }

  get backend(): "hnsw" | "linear" | "pending" {
    return this.backendResolved;
  }

  private async ensureIndex(): Promise<void> {
    if (!this.dirty) return;
    if (this.forceLinear || this.nodes.length === 0) {
      this.backendResolved = "linear";
      this.hnswIndex = null;
      this.dirty = false;
      return;
    }

    const mod = await loadHnswlib();
    if (!mod) {
      this.backendResolved = "linear";
      this.hnswIndex = null;
      this.dirty = false;
      return;
    }

    try {
      const index = new mod.HierarchicalNSW(this.space, this.dim);
      index.initIndex(this.nodes.length);
      for (let i = 0; i < this.embeddings.length; i += 1) {
        index.addPoint(this.embeddings[i]!, i);
      }
      this.hnswIndex = index;
      this.backendResolved = "hnsw";
    } catch (error) {
      logger.warn({ error }, "HNSW index build failed; using linear scan");
      this.hnswIndex = null;
      this.backendResolved = "linear";
    }
    this.dirty = false;
  }

  /** Returns top-K nodes by similarity to the query embedding. */
  async search(queryEmbedding: number[], topK: number, minSimilarity = 0): Promise<VectorSearchResult[]> {
    if (this.nodes.length === 0 || !queryEmbedding || queryEmbedding.length === 0) {
      return [];
    }

    await this.ensureIndex();

    if (this.hnswIndex && this.backendResolved === "hnsw") {
      return this.searchHnsw(queryEmbedding, topK, minSimilarity);
    }
    return this.searchLinear(queryEmbedding, topK, minSimilarity);
  }

  private searchHnsw(queryEmbedding: number[], topK: number, minSimilarity: number): VectorSearchResult[] {
    const k = Math.min(topK, this.nodes.length);
    const result = this.hnswIndex!.searchKnn(queryEmbedding, k);
    const out: VectorSearchResult[] = [];
    for (let i = 0; i < result.neighbors.length; i += 1) {
      const label = result.neighbors[i]!;
      const node = this.nodes[label];
      if (!node) continue;
      // For cosine space, hnswlib distance = 1 - cosine_similarity.
      const similarity = this.space === "cosine" ? 1 - result.distances[i]! : result.distances[i]!;
      if (similarity >= minSimilarity) {
        out.push({ node, similarity });
      }
    }
    return out;
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
