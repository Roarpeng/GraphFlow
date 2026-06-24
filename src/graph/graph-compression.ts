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
