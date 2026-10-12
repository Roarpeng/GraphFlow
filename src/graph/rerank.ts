/**
 * Lightweight embedding rerank stage.
 *
 * After lexical recall + vector fusion (and optional graph compression) the
 * fused hit list is still ranked mostly by keyword/RRF score. When the caller
 * enables it (`LayeredPackageOptions.enableRerank`) and a semantic embedding
 * backend is available, this stage embeds the query and each hit's searchable
 * text once and re-sorts the top of the list by cosine similarity — a cheap
 * cross-encoder stand-in with no new dependencies.
 *
 * Gating (failure-safe): reranking is SKIPPED — the input list returned
 * unchanged, in order — when the embedding provider is missing, its
 * fingerprint is absent, the fingerprint is hash-like (`fnv1a-*` vectors carry
 * no semantics), the query embed fails, or the list has <= 1 hit. Individual
 * hit embed failures keep the hit but sink it (similarity -1) instead of
 * dropping it.
 */

import type { GraphNode } from "../core/types.js";
import { cosineSimilarity, isHashFingerprint } from "../learning/embeddings.js";
import { nodeSearchableText } from "./graph-utils.js";

export interface RerankEmbeddingProvider {
  embed(text: string): Promise<number[]>;
  fingerprint?(): string | undefined;
}

export interface RerankOptions {
  /** Keep only the first N hits after sorting. Default: keep all. */
  topN?: number;
  /**
   * When true, the survivors (after topN selection) are restored to their
   * ORIGINAL input order — rerank picks WHO stays, order stays the caller's.
   * Default false (similarity order).
   */
  keepOrder?: boolean;
}

/** Pool size the package builders rerank ("top ~40" of the fused hit list). */
export const RERANK_POOL_LIMIT = 40;

/**
 * True when the provider can produce semantic vectors: present, with a
 * non-empty fingerprint that is not hash-like.
 */
export function isRerankProviderUsable(
  embeddingProvider: RerankEmbeddingProvider | undefined
): embeddingProvider is RerankEmbeddingProvider {
  if (!embeddingProvider || typeof embeddingProvider.embed !== "function") {
    return false;
  }
  const fingerprint = embeddingProvider.fingerprint?.();
  return typeof fingerprint === "string" && fingerprint.length > 0 && !isHashFingerprint(fingerprint);
}

/**
 * Rerank hits by embedding cosine similarity to the query.
 *
 * Deterministic total order: similarity desc, then node id asc (stable sort —
 * the same input list always yields the same output). Nodes whose embedding
 * fails or whose dimension mismatches the query vector score -1 and sort
 * after every scored hit, again by id.
 */
export async function rerankHitsByEmbedding(
  hits: readonly GraphNode[],
  query: string,
  embeddingProvider: RerankEmbeddingProvider | undefined,
  options?: RerankOptions
): Promise<GraphNode[]> {
  if (!isRerankProviderUsable(embeddingProvider)) {
    return [...hits];
  }
  if (hits.length <= 1) {
    return [...hits];
  }

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embeddingProvider.embed(query);
  } catch {
    return [...hits];
  }
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return [...hits];
  }

  // Sequential embeds: deterministic call order, and local ONNX backends are
  // not guaranteed reentrant.
  const scored: { hit: GraphNode; index: number; sim: number }[] = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]!;
    let sim = -1;
    try {
      const emb = await embeddingProvider.embed(nodeSearchableText(hit));
      if (emb && emb.length === queryEmbedding.length) {
        sim = cosineSimilarity(queryEmbedding, emb);
      }
    } catch {
      sim = -1; // failure-safe: keep the hit, sink it below every scored one
    }
    scored.push({ hit, index, sim });
  }

  const ranked = scored
    .map((entry) => ({ ...entry }))
    .sort((a, b) => b.sim - a.sim || a.hit.id.localeCompare(b.hit.id));

  const topN = options?.topN;
  const selected =
    topN !== undefined && Number.isFinite(topN) && topN >= 0 ? ranked.slice(0, topN) : ranked;

  if (options?.keepOrder) {
    return selected.sort((a, b) => a.index - b.index).map((entry) => entry.hit);
  }
  return selected.map((entry) => entry.hit);
}

/**
 * Package-builder entry point: rerank the fused hit list's top
 * {@link RERANK_POOL_LIMIT} entries. When the provider is unusable the FULL
 * original list is returned untouched — no pool truncation on a skipped stage.
 */
export async function rerankTopHitsForPackage(
  hits: readonly GraphNode[],
  query: string,
  embeddingProvider: RerankEmbeddingProvider | undefined
): Promise<GraphNode[]> {
  if (!isRerankProviderUsable(embeddingProvider) || hits.length <= 1) {
    return [...hits];
  }
  const pool = hits.slice(0, RERANK_POOL_LIMIT);
  return rerankHitsByEmbedding(pool, query, embeddingProvider, { topN: RERANK_POOL_LIMIT });
}
