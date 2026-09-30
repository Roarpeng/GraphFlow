import type { GraphNode } from "../core/types";
import { cosineSimilarity, extractEmbedding } from "./embeddings";
import { logger } from "../utils/logger";

/**
 * Brute-force cosine scan over the nodes of a candidate set.
 *
 * hnswlib-node was dropped when its C++ build started breaking Windows CI; the
 * scan is what has run since. Vectors themselves live in node metadata
 * (`metadata.embeddingQ`, int8-quantized) inside the graph store — that is the
 * only copy, so there is nothing to persist or restore here beyond the
 * per-process memo below.
 */

export interface VectorSearchResult {
  node: GraphNode;
  similarity: number;
}

/** FNV-1a fingerprint over node ids + embedding checksums; identifies a vector set. */
export function computeVectorSetFingerprint(nodes: GraphNode[]): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 0x01000193);
  };
  let count = 0;
  for (const node of nodes) {
    const emb = extractEmbedding(node);
    if (!emb) continue;
    count += 1;
    mix(node.id.length);
    for (let i = 0; i < node.id.length; i += 1) mix(node.id.charCodeAt(i));
    mix(emb.length);
    // Cheap content checksum: quantized first/middle/last elements.
    mix(Math.round((emb[0] ?? 0) * 1e6));
    mix(Math.round((emb[emb.length >> 1] ?? 0) * 1e6));
    mix(Math.round((emb[emb.length - 1] ?? 0) * 1e6));
  }
  mix(count);
  return (h >>> 0).toString(36);
}

export class LinearVectorIndex {
  private nodes: GraphNode[] = [];
  private embeddings: number[][] = [];
  private dim = 0;

  /** Extracts the vectors of `nodes`, skipping the ones without a usable embedding. */
  load(nodes: GraphNode[]): void {
    this.nodes = [];
    this.embeddings = [];
    this.dim = 0;
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

  /** Returns top-K nodes by similarity to the query embedding. */
  search(queryEmbedding: number[], topK: number, minSimilarity = 0): VectorSearchResult[] {
    if (this.nodes.length === 0 || !queryEmbedding || queryEmbedding.length === 0) {
      return [];
    }
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

let sharedVectorIndex: { fingerprint: string; index: LinearVectorIndex } | undefined;

/** Test hook: clear the per-process memoized vector index. */
export function resetSharedVectorIndex(): void {
  sharedVectorIndex = undefined;
}

/**
 * Returns a vector index for the candidate set, reusing the per-process memoized
 * index while the set is unchanged (fingerprint match). Dequantizing the whole
 * set is the expensive part of a recall query, so the memo is the only cache
 * worth having: the candidate set is query-scoped, and any on-disk copy keyed
 * by it would be rewritten by the next query and never read back.
 */
export function getSharedVectorIndex(
  nodes: GraphNode[]
): { index: LinearVectorIndex; fingerprint: string; reused: boolean } {
  const fingerprint = computeVectorSetFingerprint(nodes);
  if (sharedVectorIndex && sharedVectorIndex.fingerprint === fingerprint) {
    return { index: sharedVectorIndex.index, fingerprint, reused: true };
  }

  const index = new LinearVectorIndex();
  try {
    index.load(nodes);
  } catch (error) {
    logger.warn({ error }, "Vector index build failed; recall falls back to keyword hits");
  }
  sharedVectorIndex = { fingerprint, index };
  return { index, fingerprint, reused: false };
}
