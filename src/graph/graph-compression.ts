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
 * PageRank caching: subgraph-scoped fingerprints + impact-area invalidation.
 *
 * PageRank is recomputed on every context query over largely-identical graph
 * snapshots. The previous cache keyed on a *full-graph* fingerprint, so any
 * unrelated node/edge change in a big workspace invalidated every entry and
 * the O(E) edge hashing was paid per call. Two layers replace it:
 *
 * 1. 子图化指纹（正确性兜底）：PageRank 迭代本就只使用两端都在子图内的边，
 *    指纹也只覆盖这些"相关边"——无关图变更不再误伤缓存条目，指纹哈希量从
 *    O(E) 降为 O(E_sub)，且数值结果与旧实现完全一致。
 * 2. 影响面标记（失效管理）：客户端写入/删除节点或边时调用 markGraphMutated()，
 *    按触及的节点标记失效；快速路径命中可跳过整轮全图边扫描。未标记的变更
 *    只要改变了相关边，指纹即会触发重算——指纹层保证任何路径都不会返回陈旧
 *    数值。
 */
const PAGE_RANK_CACHE_LIMIT = 8;
const pageRankCache = new Map<string, Map<string, number>>();

/** 快速路径条目：轻量键（子图 ids + 参数）→ 结果，附带影响面与失效刻度。 */
interface PageRankCacheEntry {
  lightKey: string;
  /** 插入时的全局变更刻度。 */
  tick: number;
  /** 该条目结果所依赖的节点集合（影响面）。 */
  covered: string[];
  ranks: Map<string, number>;
}

/** 全局变更刻度：每次 markGraphMutated 递增。 */
let mutationTick = 0;
/** 无范围（全局）变更时的刻度：所有更早的条目作废。 */
let unscopedEpoch = 0;
/** 细粒度影响面：节点 → 最近一次被触及的刻度。 */
const nodeEpochs = new Map<string, number>();
/** 细粒度刻度表上限，溢出时退化为全局失效（防止旧条目被"复活"）。 */
const NODE_EPOCH_LIMIT = 2048;

const fastPageRankCache = new Map<string, PageRankCacheEntry>();

/** Test/diagnostic hook: cache hit/miss counters (hits includes fast hits). */
export const pageRankCacheStats = { hits: 0, misses: 0, fastHits: 0 };

/** Test hook: clear the PageRank cache and mutation markers. */
export function resetPageRankCache(): void {
  pageRankCache.clear();
  fastPageRankCache.clear();
  pageRankCacheStats.hits = 0;
  pageRankCacheStats.misses = 0;
  pageRankCacheStats.fastHits = 0;
  mutationTick = 0;
  unscopedEpoch = 0;
  nodeEpochs.clear();
}

/**
 * 标记图发生变更，作为 PageRank 缓存的影响面失效信号：
 * - 不带 ids：影响面未知，全局失效（所有早于本次刻度的条目作废）；
 * - 带 ids：仅触及这些节点的条目失效。
 * 说明：该标记是"避免每次上下文打包全图重算"的优化手段；即使变更未被标记，
 * 子图指纹仍会兜底保证数值正确性（相关边变了 → 指纹不同 → 重算）。
 */
export function markGraphMutated(ids?: Iterable<string>): void {
  mutationTick += 1;
  if (ids) {
    const t = mutationTick;
    for (const id of ids) {
      nodeEpochs.set(id, t);
    }
    if (nodeEpochs.size > NODE_EPOCH_LIMIT) {
      // 忘记细粒度信息时退化为全局失效，避免旧条目在信息丢失后被误判有效。
      nodeEpochs.clear();
      unscopedEpoch = t;
    }
  } else {
    unscopedEpoch = mutationTick;
    nodeEpochs.clear();
  }
}

/** 条目是否仍有效：插入后未发生全局变更，且影响面内节点未被触及。 */
function entryIsValid(entry: PageRankCacheEntry): boolean {
  if (entry.tick < unscopedEpoch) {
    return false;
  }
  for (const id of entry.covered) {
    if ((nodeEpochs.get(id) ?? 0) > entry.tick) {
      return false;
    }
  }
  return true;
}

function fnvMix(h: number, value: number): number {
  h ^= value;
  return Math.imul(h, 0x01000193);
}

/** 轻量键：只覆盖子图节点 ids + 参数（快速路径查找用，O(|ids|)）。 */
function fingerprintNodeSet(
  ids: string[],
  damping: number,
  iterations: number
): string {
  let h = 0x811c9dc5;
  h = fnvMix(h, ids.length);
  h = fnvMix(h, Math.round(damping * 1000));
  h = fnvMix(h, iterations);
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      h = fnvMix(h, id.charCodeAt(i));
    }
  }
  return (h >>> 0).toString(36);
}

/**
 * 子图化指纹：ids + 相关边（两端都在子图内）+ 参数。
 * 相关边集合与迭代逻辑完全一致，因此数值结果与旧的全图指纹实现相同。
 */
function fingerprintSubgraph(
  ids: string[],
  relevantEdges: GraphEdge[],
  damping: number,
  iterations: number
): string {
  let h = 0x811c9dc5;
  h = fnvMix(h, ids.length);
  h = fnvMix(h, relevantEdges.length);
  h = fnvMix(h, Math.round(damping * 1000));
  h = fnvMix(h, iterations);
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      h = fnvMix(h, id.charCodeAt(i));
    }
  }
  for (const edge of relevantEdges) {
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

  const fastPathActive = unscopedEpoch > 0 || nodeEpochs.size > 0;
  const lightKey = fingerprintNodeSet(ids, damping, iterations);

  // 影响面快速路径：自条目插入后该子图未被触及（图稳定），跳过全图边扫描。
  if (fastPathActive) {
    const fastEntry = fastPageRankCache.get(lightKey);
    if (fastEntry && entryIsValid(fastEntry)) {
      pageRankCacheStats.hits += 1;
      pageRankCacheStats.fastHits += 1;
      fastPageRankCache.delete(lightKey);
      fastPageRankCache.set(lightKey, fastEntry);
      return new Map(fastEntry.ranks);
    }
  }

  // 子图化：先过滤出两端都在子图内的相关边（与迭代使用的边集完全一致）。
  const relevantEdges: GraphEdge[] = [];
  for (const edge of edges) {
    if (idSet.has(edge.from) && idSet.has(edge.to)) {
      relevantEdges.push(edge);
    }
  }

  const cacheKey = fingerprintSubgraph(ids, relevantEdges, damping, iterations);
  const cached = pageRankCache.get(cacheKey);
  if (cached) {
    pageRankCacheStats.hits += 1;
    // Refresh LRU position.
    pageRankCache.delete(cacheKey);
    pageRankCache.set(cacheKey, cached);
    // 顺带刷新快速路径条目（刻度和影响面都是当前值，结果仍然正确）。
    if (fastPathActive && !fastPageRankCache.has(lightKey)) {
      if (fastPageRankCache.size >= PAGE_RANK_CACHE_LIMIT) {
        const oldest = fastPageRankCache.keys().next().value;
        if (oldest !== undefined) {
          fastPageRankCache.delete(oldest);
        }
      }
      fastPageRankCache.set(lightKey, {
        lightKey,
        tick: mutationTick,
        covered: ids,
        ranks: cached,
      });
    }
    return new Map(cached);
  }
  pageRankCacheStats.misses += 1;

  // Build weighted outbound adjacency.
  const outWeight = new Map<string, number>();
  const outEdges = new Map<string, { to: string; w: number }[]>();
  for (const edge of relevantEdges) {
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

  // 同步维护快速路径条目（影响面 = 子图 ids）。
  if (fastPageRankCache.size >= PAGE_RANK_CACHE_LIMIT) {
    const oldest = fastPageRankCache.keys().next().value;
    if (oldest !== undefined) {
      fastPageRankCache.delete(oldest);
    }
  }
  fastPageRankCache.set(lightKey, {
    lightKey,
    tick: mutationTick,
    covered: ids,
    ranks: new Map(rank),
  });

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
