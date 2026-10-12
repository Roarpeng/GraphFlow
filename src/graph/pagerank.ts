/**
 * Personalized PageRank (PPR) over the code knowledge graph.
 *
 * Rationale (HippoRAG 2 / Aider repo-map insight): ranking the graph
 * neighborhood by PPR mass beats fixed-depth BFS expansion for multi-hop
 * questions ("what does X affect") — mass flows through hubs and accumulates
 * on load-bearing nodes regardless of hop distance, while weakly-attached
 * peers decay. The walk is UNDIRECTED (both edge directions carry mass),
 * mirroring the `"both"` direction `expandSubgraph` already uses for its
 * neighborhood walk, so callers (things that reference the seed) and callees
 * (things the seed references) both receive mass — HippoRAG 2 likewise
 * symmetrizes the graph before running PPR.
 *
 * Determinism: node ids and edges are canonicalized (sorted) before the
 * power iteration, so identical graphs always produce identical output
 * regardless of input array order, and equal-mass ties break by node id
 * where this module controls ordering.
 */

import type { GraphEdge, GraphNode } from "../core/types.js";

/**
 * Edge weights by relation kind for the PPR random walk.
 *
 * Weight table (strong → decorative):
 * | weight | relations | why |
 * |--------|-----------|-----|
 * | 1.00   | calls, references | direct symbol usage — the tightest coupling in the graph |
 * | 0.90   | imports           | module-level structural dependency |
 * | 0.85   | implements        | code fulfills a requirement (spec ↔ code coupling) |
 * | 0.80   | depends_on, prerequisite, inherits | declared dependency / ordering / type hierarchy |
 * | 0.70   | defines, documents | containment or description, not usage |
 * | 0.60   | derived_from, supersedes, part_of | provenance / replacement / containment chains |
 * | 0.50   | governed_by, validates | process governance, test-to-code (indirect signal) |
 * | 0.45   | changes, improves | task-run side effects, experience chains |
 * | 0.40   | same_topic        | dialogue cross-session link (semantic only) |
 * | 0.35   | next_section      | document reading order (decorative) |
 * | 0.30   | co_occurs         | text co-occurrence (decorative) |
 * | 0.25   | conflicts_with    | negative relation — a conflict is not flow |
 *
 * Unknown relation kinds fall back to 0.1 (weaker than any listed kind).
 */
export const PPR_EDGE_WEIGHTS: Record<GraphEdge["relation"], number> = {
  calls: 1.0,
  references: 1.0,
  imports: 0.9,
  implements: 0.85,
  depends_on: 0.8,
  prerequisite: 0.8,
  inherits: 0.8,
  defines: 0.7,
  documents: 0.7,
  derived_from: 0.6,
  supersedes: 0.6,
  part_of: 0.6,
  governed_by: 0.5,
  validates: 0.5,
  changes: 0.45,
  improves: 0.45,
  same_topic: 0.4,
  next_section: 0.35,
  co_occurs: 0.3,
  conflicts_with: 0.25,
};

export interface PprOptions {
  /** Damping factor (probability of following an edge vs teleporting to a seed). Default 0.85. */
  damping?: number;
  /** Max power-iteration rounds. Default 30; converges early below `tolerance`. */
  maxIterations?: number;
  /** L1 convergence tolerance. Default 1e-6. */
  tolerance?: number;
  /** Per-relation weight overrides merged over {@link PPR_EDGE_WEIGHTS}. */
  edgeWeights?: Partial<Record<GraphEdge["relation"], number>>;
  /**
   * Opaque salt mixed into the cache signature of
   * `computePersonalizedPageRankCached` — callers that pre-filter edges (e.g.
   * by relation set) disambiguate graphs whose cheap counts coincide.
   */
  cacheSalt?: string;
}

const DEFAULT_PPR_DAMPING = 0.85;
const DEFAULT_PPR_MAX_ITERATIONS = 30;
const DEFAULT_PPR_TOLERANCE = 1e-6;
/** Weight for relation kinds missing from the table (none today; defensive). */
const UNKNOWN_RELATION_WEIGHT = 0.1;

/**
 * Personalized PageRank by power iteration with restart (teleport) vector
 * uniform over `seeds`:
 *
 *   r_next(v) = (1 - damping) / |seeds|  [v ∈ seeds]
 *             + damping * Σ_{u→v} w(u,v)/strength(u) * r(u)
 *             + damping * dangling mass teleported back to the seeds
 *
 * - Seeds that are absent from the graph are ignored; when no seed resolves,
 *   the restart vector falls back to uniform over ALL nodes (plain PageRank),
 *   so callers never divide by zero.
 * - Seeds with no edges keep their restart mass (an isolated seed graph
 *   converges to exactly uniform mass over the seeds).
 * - Mass is conserved: the returned values sum to ~1.
 * - Deterministic: node ids, edges and neighbor lists are canonicalized by
 *   sort, so identical graphs yield byte-identical Maps (keys inserted in
 *   sorted-id order).
 *
 * @returns Map<nodeId, PPR mass> covering every node in `graph.nodes`.
 */
export function computePersonalizedPageRank(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  seeds: string[],
  options?: PprOptions
): Map<string, number> {
  const damping = options?.damping ?? DEFAULT_PPR_DAMPING;
  const maxIterations = options?.maxIterations ?? DEFAULT_PPR_MAX_ITERATIONS;
  const tolerance = options?.tolerance ?? DEFAULT_PPR_TOLERANCE;
  const weights = { ...PPR_EDGE_WEIGHTS, ...options?.edgeWeights };

  if (graph.nodes.length === 0) return new Map();

  // Canonical iteration order: sorted node ids, independent of input order.
  const ids = graph.nodes.map((node) => node.id).sort();
  const idSet = new Set(ids);

  // Restart vector: uniform over deduplicated seeds present in the graph;
  // uniform over all nodes when nothing resolves (never a zero division).
  const restartIds = [...new Set(seeds.filter((id) => idSet.has(id)))].sort();
  const teleportTargets = restartIds.length > 0 ? restartIds : ids;
  const restart = new Set(teleportTargets);
  const restartMass = 1 / teleportTargets.length;

  // Undirected weighted adjacency. Edges are canonicalized (sorted) first so
  // parallel-edge accumulation order — and therefore floating-point output —
  // is identical for any permutation of the same edge list.
  const relevantEdges = graph.edges
    .filter((edge) => idSet.has(edge.from) && idSet.has(edge.to))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.relation.localeCompare(b.relation) ||
        a.to.localeCompare(b.to)
    );

  const adjacency = new Map<string, { to: string; w: number }[]>(ids.map((id) => [id, []]));
  const strength = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const edge of relevantEdges) {
    const w = weights[edge.relation] ?? UNKNOWN_RELATION_WEIGHT;
    adjacency.get(edge.from)!.push({ to: edge.to, w });
    adjacency.get(edge.to)!.push({ to: edge.from, w });
    strength.set(edge.from, strength.get(edge.from)! + w);
    strength.set(edge.to, strength.get(edge.to)! + w);
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => a.to.localeCompare(b.to) || b.w - a.w);
  }

  let rank = new Map<string, number>(
    ids.map((id) => [id, restart.has(id) ? restartMass : 0])
  );

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const next = new Map<string, number>(
      ids.map((id) => [id, (1 - damping) * (restart.has(id) ? restartMass : 0)])
    );
    let dangling = 0;

    for (const id of ids) {
      const r = rank.get(id) ?? 0;
      const out = adjacency.get(id)!;
      if (out.length === 0) {
        dangling += r;
        continue;
      }
      const share = (damping * r) / (strength.get(id)!);
      for (const { to, w } of out) {
        next.set(to, (next.get(to) ?? 0) + share * w);
      }
    }

    // Dangling mass (isolated nodes) teleports back to the restart vector,
    // keeping total probability mass at 1.
    if (dangling > 0) {
      const back = (damping * dangling) / teleportTargets.length;
      for (const id of teleportTargets) {
        next.set(id, (next.get(id) ?? 0) + back);
      }
    }

    let delta = 0;
    for (const id of ids) {
      delta += Math.abs((next.get(id) ?? 0) - (rank.get(id) ?? 0));
    }
    rank = next;
    if (delta < tolerance) break;
  }

  return rank;
}

/**
 * PPR result cache: repeated packs in one session rank the same neighborhood
 * over an unchanged store, so the power iteration is memoized behind a cheap
 * version signature — node count + edge count + sorted seed ids + parameters
 * (no per-edge hashing; `cacheSalt` lets callers disambiguate pre-filtered
 * edge sets). TRADE-OFF: a rewrite that preserves both counts can serve a
 * stale entry until the signature changes; callers needing exact freshness
 * should use the pure `computePersonalizedPageRank`.
 */
const PPR_CACHE_LIMIT = 8;
const pprCache = new Map<string, Map<string, number>>();

/** Test/diagnostic hook: cache hit/miss counters. */
export const pprCacheStats = { hits: 0, misses: 0 };

/** Test hook: clear the PPR cache and counters. */
export function resetPprCache(): void {
  pprCache.clear();
  pprCacheStats.hits = 0;
  pprCacheStats.misses = 0;
}

function fnvMix(h: number, value: number): number {
  h ^= value;
  return Math.imul(h, 0x01000193);
}

function fnvString(h: number, value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    h = fnvMix(h, value.charCodeAt(i));
  }
  return h;
}

/** Cheap version signature: counts + sorted seeds + parameters (no edge hashing). */
function pprCacheSignature(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  seeds: string[],
  options?: PprOptions
): string {
  let h = 0x811c9dc5;
  h = fnvMix(h, graph.nodes.length);
  h = fnvMix(h, graph.edges.length);
  h = fnvMix(h, Math.round((options?.damping ?? DEFAULT_PPR_DAMPING) * 1000));
  h = fnvMix(h, options?.maxIterations ?? DEFAULT_PPR_MAX_ITERATIONS);
  // Tolerance participates via its string form: 1e-6 vs 1e-7 differ early.
  h = fnvString(h, String(options?.tolerance ?? DEFAULT_PPR_TOLERANCE));
  if (options?.cacheSalt) h = fnvString(h, options.cacheSalt);
  if (options?.edgeWeights) {
    for (const key of Object.keys(options.edgeWeights).sort()) {
      h = fnvString(h, key);
      h = fnvString(h, String(options.edgeWeights[key as GraphEdge["relation"]]));
    }
  }
  for (const id of [...new Set(seeds)].sort()) {
    h = fnvString(h, id);
  }
  return (h >>> 0).toString(36);
}

/**
 * Memoized `computePersonalizedPageRank` (see the cache note above). Returns
 * a defensive copy on hits so callers can never mutate a cached entry.
 */
export function computePersonalizedPageRankCached(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  seeds: string[],
  options?: PprOptions
): Map<string, number> {
  const key = pprCacheSignature(graph, seeds, options);
  const cached = pprCache.get(key);
  if (cached) {
    pprCacheStats.hits += 1;
    // LRU refresh.
    pprCache.delete(key);
    pprCache.set(key, cached);
    return new Map(cached);
  }
  pprCacheStats.misses += 1;
  const rank = computePersonalizedPageRank(graph, seeds, options);
  if (pprCache.size >= PPR_CACHE_LIMIT) {
    const oldest = pprCache.keys().next().value;
    if (oldest !== undefined) {
      pprCache.delete(oldest);
    }
  }
  pprCache.set(key, new Map(rank));
  return rank;
}
