import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { recordVectorBackfill } from "./embedding-quality";
import {
  DEFAULT_EMBEDDING_RUN_DEADLINE_MS,
  DEFAULT_EMBEDDING_RUN_LIMIT,
  attachEmbedding,
  extractEmbedding,
  extractEmbeddingModel,
  isHashFingerprint,
  type EmbeddingProvider,
} from "./embeddings";

export { DEFAULT_EMBEDDING_RUN_LIMIT, DEFAULT_EMBEDDING_RUN_DEADLINE_MS };

export interface VectorBackfillResult {
  /** Nodes with content but no vector at all, as found before this pass. */
  missing: number;
  /** Nodes carrying a vector from another model or dimension, as found before this pass. */
  stale: number;
  refreshed: number;
  fingerprint?: string;
  /** Per-run ceiling that was in force, so `refreshed` ≪ `missing` reads as a budget, not a bug. */
  budget?: { limit: number; deadlineMs: number };
  /** Why the pass did nothing, when it did nothing. */
  skippedReason?: "no-snapshot" | "unknown-fingerprint";
}

function needsReembed(node: GraphNode): boolean {
  return Boolean(node.content) && !extractEmbedding(node);
}

function isStale(node: GraphNode, fingerprint: string, dim: number): boolean {
  const emb = extractEmbedding(node);
  if (!emb) return false;
  return emb.length !== dim || extractEmbeddingModel(node) !== fingerprint;
}

/**
 * Give the store vectors: fill nodes that never got one, and upgrade nodes
 * whose vector came from another model (hash fallback, fp32 bge, an unstamped
 * legacy `metadata.embedding`).
 *
 * Re-embedding is CPU-bound, so both the node count and the wall clock are
 * capped; a large store converges over several index runs rather than blocking
 * one. A transient model-load failure that fell the provider back to hash must
 * never overwrite semantic vectors, so the hash backend only fills gaps.
 */
export async function ensureEmbeddings(
  client: GraphClient,
  provider: EmbeddingProvider,
  options?: { limit?: number; deadlineMs?: number; signal?: AbortSignal }
): Promise<VectorBackfillResult> {
  if (typeof provider.fingerprint !== "function") {
    return { missing: 0, stale: 0, refreshed: 0, skippedReason: "unknown-fingerprint" };
  }
  const snapshot = client.readSnapshot?.();
  if (!snapshot) {
    return { missing: 0, stale: 0, refreshed: 0, skippedReason: "no-snapshot" };
  }

  // A resilient provider only settles (transformers vs hash) on first embed.
  const probe = await provider.embed("warmup");
  const fingerprint = provider.fingerprint();
  if (!fingerprint) {
    return { missing: 0, stale: 0, refreshed: 0, skippedReason: "unknown-fingerprint" };
  }
  const dim = probe.length;

  const staleNodes: GraphNode[] = [];
  const missingNodes: GraphNode[] = [];
  for (const node of snapshot.nodes) {
    if (isStale(node, fingerprint, dim)) staleNodes.push(node);
    else if (needsReembed(node)) missingNodes.push(node);
  }

  const hashBackend = isHashFingerprint(fingerprint);
  const work = hashBackend ? missingNodes : [...staleNodes, ...missingNodes];

  const limit = options?.limit ?? DEFAULT_EMBEDDING_RUN_LIMIT;
  const deadlineMs = options?.deadlineMs ?? DEFAULT_EMBEDDING_RUN_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  const updated: GraphNode[] = [];
  for (const node of work) {
    if (updated.length >= limit || options?.signal?.aborted || Date.now() >= deadline) break;
    const emb = await provider.embed(node.content ?? "");
    if (!Array.isArray(emb) || emb.length === 0) continue;
    updated.push(attachEmbedding(node, emb, fingerprint));
  }
  if (updated.length > 0) {
    await client.upsertNodes(updated);
  }

  const result: VectorBackfillResult = {
    missing: missingNodes.length,
    stale: staleNodes.length,
    refreshed: updated.length,
    fingerprint,
    budget: { limit, deadlineMs },
  };
  recordVectorBackfill(result);
  return result;
}
