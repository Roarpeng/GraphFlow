import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphNode } from "../core/types";
import { cosineSimilarity, extractEmbedding } from "./embeddings";
import { logger } from "../utils/logger";

/**
 * HNSW (Hierarchical Navigable Small World) vector index.
 *
 * Previously used hnswlib-node for ANN search, but that has been removed
 * due to C++ compilation dependency issues. Now always uses linear scan,
 * with per-process memoization and optional disk persistence so the index
 * is not rebuilt on every query / every MCP server restart.
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

/** Skip disk persistence above this many vectors (file would be tens of MB). */
const PERSIST_MAX_VECTORS = 20_000;
const PERSIST_VERSION = 1;

interface PersistedVectorIndex {
  version: number;
  fingerprint: string;
  dim: number;
  ids: string[];
  /** base64-encoded Float32Array, flattened row-major. */
  data: string;
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

  /** Serialize the loaded vectors for disk persistence. */
  serialize(): { dim: number; ids: string[]; data: string } {
    const flat = new Float32Array(this.embeddings.length * this.dim);
    for (let i = 0; i < this.embeddings.length; i += 1) {
      flat.set(this.embeddings[i]!, i * this.dim);
    }
    return {
      dim: this.dim,
      ids: this.nodes.map((n) => n.id),
      data: Buffer.from(flat.buffer).toString("base64"),
    };
  }

  /**
   * Rebuild an index from persisted vectors, binding to CURRENT graph nodes
   * (matched by id) so callers always see fresh node content.
   */
  static deserialize(
    dim: number,
    ids: string[],
    data: string,
    nodesById: Map<string, GraphNode>
  ): HnswVectorIndex | undefined {
    const index = new HnswVectorIndex();
    const buf = Buffer.from(data, "base64");
    const flat = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    if (flat.length !== ids.length * dim) {
      return undefined;
    }
    index.dim = dim;
    for (let i = 0; i < ids.length; i += 1) {
      const node = nodesById.get(ids[i]!);
      if (!node) return undefined;
      index.nodes.push(node);
      index.embeddings.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
    }
    return index;
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

// ── Shared memoized index + disk persistence ─────────────────────────────

let sharedVectorIndex: { fingerprint: string; index: HnswVectorIndex } | undefined;

/** Test hook: clear the per-process memoized vector index. */
export function resetSharedVectorIndex(): void {
  sharedVectorIndex = undefined;
}

function tryLoadPersistedIndex(
  filePath: string,
  fingerprint: string,
  nodes: GraphNode[]
): HnswVectorIndex | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PersistedVectorIndex;
    if (parsed.version !== PERSIST_VERSION || parsed.fingerprint !== fingerprint) {
      return undefined;
    }
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    return HnswVectorIndex.deserialize(parsed.dim, parsed.ids, parsed.data, nodesById);
  } catch (error) {
    logger.warn({ error, filePath }, "Failed to load persisted vector index; rebuilding");
    return undefined;
  }
}

function tryPersistIndex(filePath: string, fingerprint: string, index: HnswVectorIndex): void {
  try {
    if (index.size === 0 || index.size > PERSIST_MAX_VECTORS) return;
    const serialized = index.serialize();
    const payload: PersistedVectorIndex = {
      version: PERSIST_VERSION,
      fingerprint,
      dim: serialized.dim,
      ids: serialized.ids,
      data: serialized.data,
    };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload), "utf8");
  } catch (error) {
    logger.warn({ error, filePath }, "Failed to persist vector index");
  }
}

/**
 * Returns a vector index for the candidate set, reusing the per-process
 * memoized index when the set is unchanged (fingerprint match). On a memo
 * miss, optionally restores from `persistPath` (fingerprint-validated) and
 * persists freshly built indexes for the next process start.
 */
export function getSharedVectorIndex(
  nodes: GraphNode[],
  persistPath?: string
): { index: HnswVectorIndex; fingerprint: string; reused: boolean; restoredFromDisk: boolean } {
  const fingerprint = computeVectorSetFingerprint(nodes);
  if (sharedVectorIndex && sharedVectorIndex.fingerprint === fingerprint) {
    return { index: sharedVectorIndex.index, fingerprint, reused: true, restoredFromDisk: false };
  }

  if (persistPath) {
    const restored = tryLoadPersistedIndex(persistPath, fingerprint, nodes);
    if (restored) {
      sharedVectorIndex = { fingerprint, index: restored };
      return { index: restored, fingerprint, reused: false, restoredFromDisk: true };
    }
  }

  const index = new HnswVectorIndex();
  index.load(nodes);
  sharedVectorIndex = { fingerprint, index };
  if (persistPath) {
    tryPersistIndex(persistPath, fingerprint, index);
  }
  return { index, fingerprint, reused: false, restoredFromDisk: false };
}
