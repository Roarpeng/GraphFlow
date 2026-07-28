import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

/**
 * Graph-structure-based context compression.
 *
 * Unlike token-level pruning (LLMLingua-style), this module compresses by
 * exploiting the graph topology: edge-weighted connectivity + centrality
 * ranking keeps the most "load-bearing" nodes and drops peripheral ones,
 * with zero LLM cost.
 */

export const DEFAULT_EDGE_WEIGHTS: Record<GraphEdge["relation"], number> = {
  references: 1.0,
  imports: 0.85,
  depends_on: 0.7,
  prerequisite: 0.7,
  defines: 0.6,
  calls: 0.65,
  inherits: 0.6,
  validates: 0.5,
  changes: 0.4,
  improves: 0.4,
  co_occurs: 0.3,
  conflicts_with: 0.2,
  part_of: 0.75,
  next_section: 0.5,
};

export interface ConnectedSubgraphOptions {
  edgeWeights?: Partial<Record<GraphEdge["relation"], number>>;
  maxNodes?: number;
  hops?: number;
  /** Minimum accumulated edge weight to keep a node (prunes weakly-connected). */
  minNodeWeight?: number;
}

export interface RankedNode {
  node: GraphNode;
  score: number;
}

/**
 * Extracts a connected subgraph centered on the seed nodes, ranking members
 * by edge-weighted proximity. Returns nodes sorted by relevance (seeds first).
 */
export async function extractConnectedSubgraph(
  client: GraphClient,
  seeds: GraphNode[],
  options?: ConnectedSubgraphOptions
): Promise<RankedNode[]> {
  if (typeof client.getNeighbors !== "function" || seeds.length === 0) {
    return seeds.map((node) => ({ node, score: 1 }));
  }

  const weights = { ...DEFAULT_EDGE_WEIGHTS, ...options?.edgeWeights };
  const maxNodes = options?.maxNodes ?? 30;
  const hops = options?.hops ?? 2;
  const minNodeWeight = options?.minNodeWeight ?? 0;

  // Seeds start with full score; each hop decays.
  const scores = new Map<string, number>();
  const nodeById = new Map<string, GraphNode>();
  for (const seed of seeds) {
    scores.set(seed.id, 1);
    nodeById.set(seed.id, seed);
  }

  let frontier = seeds.map((s) => s.id);
  const relations = Object.keys(weights) as GraphEdge["relation"][];

  for (let depth = 0; depth < hops; depth += 1) {
    if (frontier.length === 0 || nodeById.size >= maxNodes) break;
    const decay = 1 / (depth + 2); // hop 0 -> 0.5, hop 1 -> 0.33, ...
    const neighbors = await client.getNeighbors(frontier, relations, "both");
    const nextFrontier: string[] = [];

    for (const { node, via } of neighbors) {
      const edgeWeight = weights[via] ?? 0.1;
      const contribution = edgeWeight * decay;
      const prev = scores.get(node.id) ?? 0;
      scores.set(node.id, prev + contribution);
      if (!nodeById.has(node.id)) {
        nodeById.set(node.id, node);
        nextFrontier.push(node.id);
      }
    }
    frontier = nextFrontier;
  }

  const ranked: RankedNode[] = [];
  for (const [id, score] of scores.entries()) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (score < minNodeWeight) continue;
    ranked.push({ node, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxNodes);
}

export interface PageRankOptions {
  damping?: number;
  iterations?: number;
  edgeWeights?: Partial<Record<GraphEdge["relation"], number>>;
}

/**
 * PageRank is recomputed on every context query over largely-identical graph
 * snapshots. Cache results keyed by a full fingerprint of (node ids, edges,
 * damping, iterations) so repeated previews on an unchanged graph skip the
 * 20-iteration O(E) loop. Small LRU: graph snapshots turn over on reindex.
 */
const PAGE_RANK_CACHE_LIMIT = 8;
const pageRankCache = new Map<string, Map<string, number>>();

/** Test/diagnostic hook: cache hit/miss counters. */
export const pageRankCacheStats = { hits: 0, misses: 0 };

/** Test hook: clear the PageRank cache. */
export function resetPageRankCache(): void {
  pageRankCache.clear();
  pageRankCacheStats.hits = 0;
  pageRankCacheStats.misses = 0;
}

function fnvMix(h: number, value: number): number {
  h ^= value;
  return Math.imul(h, 0x01000193);
}

function fingerprintPageRankInput(
  ids: string[],
  edges: GraphEdge[],
  damping: number,
  iterations: number
): string {
  let h = 0x811c9dc5;
  h = fnvMix(h, ids.length);
  h = fnvMix(h, edges.length);
  h = fnvMix(h, Math.round(damping * 1000));
  h = fnvMix(h, iterations);
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      h = fnvMix(h, id.charCodeAt(i));
    }
  }
  // Full edge hash (not sampled): a stale hit would blend wrong centrality
  // into ranking, so fingerprint correctness matters more than the O(E) cost,
  // which is still ~20x cheaper than the PageRank iterations it replaces.
  for (const edge of edges) {
    for (let i = 0; i < edge.from.length; i += 1) h = fnvMix(h, edge.from.charCodeAt(i));
    for (let i = 0; i < edge.relation.length; i += 1) h = fnvMix(h, edge.relation.charCodeAt(i));
    for (let i = 0; i < edge.to.length; i += 1) h = fnvMix(h, edge.to.charCodeAt(i));
  }
  return (h >>> 0).toString(36);
}

/**
 * Computes weighted PageRank over a node/edge set. Used to surface "central"
 * nodes (frequently-referenced functions, core modules) that should be
 * prioritized in the context budget.
 */
export function computePageRank(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options?: PageRankOptions
): Map<string, number> {
  const damping = options?.damping ?? 0.85;
  const iterations = options?.iterations ?? 20;
  const weights = { ...DEFAULT_EDGE_WEIGHTS, ...options?.edgeWeights };

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const n = ids.length;
  if (n === 0) return new Map();

  const cacheKey = fingerprintPageRankInput(ids, edges, damping, iterations);
  const cached = pageRankCache.get(cacheKey);
  if (cached) {
    pageRankCacheStats.hits += 1;
    // Refresh LRU position.
    pageRankCache.delete(cacheKey);
    pageRankCache.set(cacheKey, cached);
    return new Map(cached);
  }
  pageRankCacheStats.misses += 1;

  // Build weighted outbound adjacency.
  const outWeight = new Map<string, number>();
  const outEdges = new Map<string, { to: string; w: number }[]>();
  for (const edge of edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    const w = weights[edge.relation] ?? 0.1;
    const list = outEdges.get(edge.from) ?? [];
    list.push({ to: edge.to, w });
    outEdges.set(edge.from, list);
    outWeight.set(edge.from, (outWeight.get(edge.from) ?? 0) + w);
  }

  let rank = new Map<string, number>(ids.map((id) => [id, 1 / n]));
  const base = (1 - damping) / n;

  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Map<string, number>(ids.map((id) => [id, base]));
    let danglingSum = 0;

    for (const id of ids) {
      const out = outEdges.get(id);
      const r = rank.get(id) ?? 0;
      if (!out || out.length === 0) {
        danglingSum += r;
        continue;
      }
      const total = outWeight.get(id) ?? 1;
      for (const { to, w } of out) {
        next.set(to, (next.get(to) ?? 0) + damping * r * (w / total));
      }
    }

    // Redistribute dangling-node mass uniformly.
    if (danglingSum > 0) {
      const share = (damping * danglingSum) / n;
      for (const id of ids) {
        next.set(id, (next.get(id) ?? 0) + share);
      }
    }

    rank = next;
  }

  // Store in LRU cache (evict oldest when full).
  if (pageRankCache.size >= PAGE_RANK_CACHE_LIMIT) {
    const oldest = pageRankCache.keys().next().value;
    if (oldest !== undefined) {
      pageRankCache.delete(oldest);
    }
  }
  pageRankCache.set(cacheKey, new Map(rank));

  return rank;
}

/**
 * Re-ranks a candidate node list by blending retrieval order with PageRank
 * centrality. alpha controls the centrality weight (0 = pure retrieval order).
 */
export function blendWithCentrality(
  candidates: GraphNode[],
  pageRank: Map<string, number>,
  alpha = 0.3
): GraphNode[] {
  if (candidates.length === 0) return candidates;
  const maxPr = Math.max(1e-9, ...Array.from(pageRank.values()));

  const scored = candidates.map((node, index) => {
    const retrievalScore = 1 - index / candidates.length; // higher = earlier
    const centrality = (pageRank.get(node.id) ?? 0) / maxPr;
    const score = (1 - alpha) * retrievalScore + alpha * centrality;
    return { node, score, index };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map((s) => s.node);
}
