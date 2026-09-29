import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { recordStaleVectorRefresh } from "./embedding-quality";
import { attachEmbedding, extractEmbedding, extractEmbeddingModel, type EmbeddingProvider } from "./embeddings";

/** Re-embedding is CPU-bound; bound each index run and converge over several runs. */
export const DEFAULT_STALE_EMBEDDING_REFRESH_LIMIT = 256;

export interface StaleEmbeddingRefreshResult {
  stale: number;
  refreshed: number;
  fingerprint?: string;
  /** Why the pass did nothing, when it did nothing. */
  skippedReason?: "no-snapshot" | "unknown-fingerprint" | "hash-backend";
}

function isStale(node: GraphNode, fingerprint: string, dim: number): boolean {
  const emb = extractEmbedding(node);
  if (!emb) return false;
  return emb.length !== dim || extractEmbeddingModel(node) !== fingerprint;
}

/**
 * Upgrade vectors written by another model (hash fallback, fp32 bge, …) to the
 * current provider. Only runs when the provider is semantic: a transient model
 * load failure that fell back to hash must never downgrade good vectors.
 */
export async function refreshStaleEmbeddings(
  client: GraphClient,
  provider: EmbeddingProvider,
  options?: { limit?: number; signal?: AbortSignal }
): Promise<StaleEmbeddingRefreshResult> {
  if (typeof provider.fingerprint !== "function") {
    return { stale: 0, refreshed: 0, skippedReason: "unknown-fingerprint" };
  }
  const snapshot = client.readSnapshot?.();
  if (!snapshot) {
    return { stale: 0, refreshed: 0, skippedReason: "no-snapshot" };
  }
  if (!snapshot.nodes.some((node) => extractEmbedding(node))) {
    return { stale: 0, refreshed: 0 };
  }

  // A resilient provider only settles (transformers vs hash) on first embed.
  const probe = await provider.embed("warmup");
  const fingerprint = provider.fingerprint();
  if (!fingerprint) {
    return { stale: 0, refreshed: 0, skippedReason: "unknown-fingerprint" };
  }
  const dim = probe.length;
  const staleNodes = snapshot.nodes.filter((node) => node.content && isStale(node, fingerprint, dim));
  if (fingerprint.startsWith("fnv1a-")) {
    const result = { stale: staleNodes.length, refreshed: 0, fingerprint, skippedReason: "hash-backend" as const };
    recordStaleVectorRefresh(result);
    return result;
  }

  const limit = options?.limit ?? DEFAULT_STALE_EMBEDDING_REFRESH_LIMIT;
  const updated: GraphNode[] = [];
  for (const node of staleNodes.slice(0, limit)) {
    if (options?.signal?.aborted) break;
    const emb = await provider.embed(node.content);
    updated.push(attachEmbedding(node, emb, fingerprint));
  }
  if (updated.length > 0) {
    await client.upsertNodes(updated);
  }
  const result = { stale: staleNodes.length, refreshed: updated.length, fingerprint };
  recordStaleVectorRefresh(result);
  return result;
}
