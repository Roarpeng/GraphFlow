/**
 * Shared context-packaging core.
 *
 * `buildLayeredContextPackage` and `buildEnhancedContextPackage` used to
 * duplicate retrieval + L1/L2/L3 quota packing (~60% overlap). Both public
 * functions keep their signatures and extras; this module owns the common
 * recall/pack steps so behavior stays identical.
 */

import { logger } from "../utils/logger.js";
import type { GraphEdge, GraphNode } from "../core/types.js";
import {
  cosineSimilarity,
  extractEmbedding,
  filterCompatibleEmbeddingNodes,
  isHashFingerprint,
  reciprocalRankFusion,
} from "../learning/embeddings.js";
import { recordIncompatibleVectorsSkipped } from "../learning/embedding-quality.js";
import { getSharedVectorIndex } from "../learning/vector-index.js";
import { createAnchorBodyReader, type AnchorBodyReader, type AnchorBodyStats } from "./anchor-bodies.js";
import type { GraphClient } from "./client-factory.js";
import { rankNodesForContextQuery, composeContextQuery, buildSearchScoreTokens } from "./graph-utils.js";
import { collectExpandedKeywordHits } from "./query-expand.js";
import {
  CANDIDATE_MAX_SYMBOLS_PER_FILE,
  diversifyHitsBySourceFile,
  prepareHitsForPackaging,
} from "./hit-diversify.js";
import { collectImportRelatedFiles } from "./symbol-extract.js";
import {
  estimateTokens,
  classifyLayer,
  canUseLayer,
  markLayerUsed,
  deriveModuleId,
  extractFileFromSymbolId,
} from "./context-slicer-utils.js";
import type {
  ContextAnchorItem,
  LayeredContextPackage,
  LayeredPackageOptions,
  SubgraphExpansionOptions,
} from "./context-slicer-types.js";
import { DEFAULT_EXPANSION_RELATIONS, ARCHITECTURE_QUERY } from "./context-slicer-types.js";
import { computePersonalizedPageRankCached } from "./pagerank.js";

const L3_PIN_HINT = /alignment|deviation|goal/i;

/** Max matched dialogue turns packed per preview (after effective-turns filter). */
const DIALOGUE_PACK_MAX_TURNS = 3;
const VECTOR_RRF_WEIGHT = 0.5;

/**
 * Presentation order of the layers inside `anchorChannel`: L1 code first, L2
 * modules, L3 governance/dialogue last — the order the pack stages already
 * produced, made explicit now that the exit sort needs a total order.
 */
const LAYER_RANK: Record<"L1" | "L2" | "L3", number> = { L1: 0, L2: 1, L3: 2 };

export type DuplicateModulePolicy = "continue" | "break";

export interface PackState {
  summaryChannel: string[];
  anchorChannel: ContextAnchorItem[];
  added: Set<string>;
  quota: { l1: number; l2: number; l3: number };
  used: { l1: number; l2: number; l3: number };
  maxTokens: number;
  maxAnchors?: number;
  /** Optional declaration bodies for the top symbol anchors; absent = id-only pack. */
  bodyReader?: AnchorBodyReader;
  bodyStats?: AnchorBodyStats;
  /** L1 symbol anchors worth quoting, collected during packing. */
  bodyCandidates?: GraphNode[];
}

export interface PackBudget {
  tokens: number;
  truncated: boolean;
}

interface DialogueContextLine {
  kind: "turn" | "summary";
  text: string;
  node?: GraphNode;
  correctionLine?: string;
}

/**
 * Governance pins for L3: Decision/goal nodes that packing must prefer so
 * budget truncation cannot drop alignment / deviation / goal constraints.
 */
export function isPinnedL3Node(node: GraphNode): boolean {
  if (node.id.startsWith("goal:")) {
    return true;
  }
  if (node.type !== "Decision") {
    return false;
  }
  if (L3_PIN_HINT.test(node.content)) {
    return true;
  }
  if (node.metadata && L3_PIN_HINT.test(JSON.stringify(node.metadata))) {
    return true;
  }
  return false;
}

export function createPackState(
  maxTokens: number,
  options?: LayeredPackageOptions,
  maxAnchors?: number
): PackState {
  const state: PackState = {
    summaryChannel: [],
    anchorChannel: [],
    added: new Set<string>(),
    quota: {
      l1: options?.layerQuota?.l1 ?? Number.POSITIVE_INFINITY,
      l2: options?.layerQuota?.l2 ?? Number.POSITIVE_INFINITY,
      l3: options?.layerQuota?.l3 ?? Number.POSITIVE_INFINITY,
    },
    used: { l1: 0, l2: 0, l3: 0 },
    maxTokens,
  };
  if (maxAnchors !== undefined) {
    state.maxAnchors = maxAnchors;
  }
  // Quote real declaration bodies into the pack for the first few L1 symbols.
  // Off only when explicitly disabled or when we do not know the workspace.
  if (options?.enableSymbolBodies !== false && options?.workspaceRoot) {
    const { reader, stats } = createAnchorBodyReader({
      workspaceRoot: options.workspaceRoot,
      maxTokens,
    });
    state.bodyReader = reader;
    state.bodyStats = stats;
    state.bodyCandidates = [];
  }
  return state;
}

export function toLayeredPackage(state: PackState, budget: PackBudget): LayeredContextPackage {
  return {
    summaryChannel: state.summaryChannel,
    // 分数决定选谁进入包，id 决定包内顺序 / The score decides WHO enters the
    // package, the id decides the order inside it.
    //
    // Every decision that quality depends on — quota truncation, budget stops,
    // neighbor-expansion seeds (`anchorChannel.slice(0, 5)`), module-id
    // derivation — reads the channel in packed (score) order BEFORE this sort,
    // so selection is untouched. The sort only fixes presentation. Score order
    // is not byte-stable across rounds: equal-score tie groups inherit store
    // row order and `expandSubgraph`'s BFS insertion order, so the same anchor
    // set could serialize differently on a rebuild. (layer, id) is a total,
    // content-derived order — the host's prefix cache only hits while leading
    // bytes repeat, so stable order is what makes the package cacheable at all.
    anchorChannel: [...state.anchorChannel].sort(
      (a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || a.id.localeCompare(b.id)
    ),
    tokenEstimate: budget.tokens,
    truncated: budget.truncated,
    ...(state.bodyStats ? { bodies: state.bodyStats } : {}),
  };
}

/**
 * Expand a subgraph around `seedIds` (seed nodes themselves are excluded).
 *
 * Two strategies (`options.expansionStrategy`):
 * - `"bfs"` (default, unchanged): fixed-depth neighborhood walk admitting
 *   neighbors in encounter order until `maxNodes`.
 * - `"ppr"`: collect a multi-hop candidate pool, rank it with Personalized
 *   PageRank seeded from the seed ids (HippoRAG 2-style), and admit neighbors
 *   in descending PPR mass until `maxNodes` — high-mass hubs can displace
 *   weakly-attached direct peers that plain encounter order would keep.
 *
 * Both strategies feed the same downstream budget/quota plumbing: callers
 * (`injectNeighborExpansion`) iterate the returned list in order until the
 * pack budget stops them, so ordering IS the admission priority.
 */
export async function expandSubgraph(
  client: GraphClient,
  seedIds: string[],
  options?: SubgraphExpansionOptions
): Promise<GraphNode[]> {
  if (typeof client.getNeighbors !== "function") return [];
  if (options?.expansionStrategy === "ppr") {
    return expandSubgraphByPagerank(client, seedIds, options);
  }
  return expandSubgraphByBfs(client, seedIds, options);
}

async function expandSubgraphByBfs(
  client: GraphClient,
  seedIds: string[],
  options?: SubgraphExpansionOptions
): Promise<GraphNode[]> {
  if (typeof client.getNeighbors !== "function") return [];
  const hops = options?.hops ?? 1;
  const maxNodes = options?.maxNodes ?? 20;
  const relations = options?.relations ?? DEFAULT_EXPANSION_RELATIONS;

  const excluded = new Set(seedIds);
  const collected = new Map<string, GraphNode>();
  let frontier = [...seedIds];

  for (let depth = 0; depth < hops; depth += 1) {
    if (frontier.length === 0) break;
    const neighbors = await client.getNeighbors(frontier, relations, "both");
    const nextFrontier: string[] = [];
    for (const { node } of neighbors) {
      if (excluded.has(node.id) || collected.has(node.id)) continue;
      collected.set(node.id, node);
      nextFrontier.push(node.id);
      if (collected.size >= maxNodes) break;
    }
    if (collected.size >= maxNodes) break;
    frontier = nextFrontier;
  }

  return Array.from(collected.values());
}

/** Candidate-pool floor / factor: rank at least a handful more nodes than the limit admits. */
const PPR_POOL_MIN = 50;
const PPR_POOL_FACTOR = 5;

/**
 * PPR expansion strategy: pool = relation-filtered undirected BFS within
 * `hops` (default 2) around the seeds; the pool is then ranked by cached
 * Personalized PageRank seeded from the seed ids and truncated to `maxNodes`
 * in descending mass (ties by node id — deterministic output for identical
 * graphs). Falls back to the BFS walk when the client exposes no snapshot.
 */
async function expandSubgraphByPagerank(
  client: GraphClient,
  seedIds: string[],
  options: SubgraphExpansionOptions
): Promise<GraphNode[]> {
  const snapshot = client.readSnapshot?.();
  if (!snapshot) {
    logger.debug("expandSubgraph ppr: client has no readSnapshot, falling back to bfs");
    return expandSubgraphByBfs(client, seedIds, { ...options, expansionStrategy: "bfs" });
  }

  const hops = options.hops ?? 2;
  const maxNodes = options.maxNodes ?? 20;
  const relations = options.relations ?? DEFAULT_EXPANSION_RELATIONS;
  const relationSet = new Set<GraphEdge["relation"]>(relations);
  const poolCap = Math.max(PPR_POOL_MIN, maxNodes * PPR_POOL_FACTOR);

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const seeds = [...new Set(seedIds)].filter((id) => nodeById.has(id));
  if (seeds.length === 0) return [];

  // Undirected relation-filtered adjacency over existing endpoints, in
  // canonical (sorted) order so the pool and PPR output are deterministic.
  const adjacency = new Map<string, string[]>(snapshot.nodes.map((node) => [node.id, []]));
  const subEdges: GraphEdge[] = [];
  for (const edge of snapshot.edges) {
    if (!relationSet.has(edge.relation)) continue;
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    adjacency.get(edge.to)!.push(edge.from);
    subEdges.push(edge);
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => a.localeCompare(b));
  }

  // Candidate pool: BFS from the seeds, seeds themselves excluded.
  const excluded = new Set(seeds);
  const pool = new Set<string>();
  let frontier = [...seeds].sort();
  for (let depth = 0; depth < hops && frontier.length > 0; depth += 1) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (excluded.has(neighbor) || pool.has(neighbor)) continue;
        pool.add(neighbor);
        nextFrontier.push(neighbor);
        if (pool.size >= poolCap) break;
      }
      if (pool.size >= poolCap) break;
    }
    frontier = nextFrontier;
  }
  if (pool.size === 0) return [];

  // PPR runs over the pool + seeds (the seeds anchor the walk), with only the
  // induced edges — the cached variant memoizes per cheap store signature.
  const subNodeIds = new Set<string>([...pool, ...seeds]);
  const subNodes = snapshot.nodes.filter((node) => subNodeIds.has(node.id));
  const inducedEdges = subEdges.filter(
    (edge) => subNodeIds.has(edge.from) && subNodeIds.has(edge.to)
  );
  const ranks = computePersonalizedPageRankCached(
    { nodes: subNodes, edges: inducedEdges },
    seeds,
    {
      ...options.ppr,
      cacheSalt: [...relationSet].sort().join(","),
    }
  );

  // Descending PPR mass, ties broken by node id — the deterministic admission order.
  const ranked = [...pool]
    .map((id) => ({ id, mass: ranks.get(id) ?? 0 }))
    .sort((a, b) => b.mass - a.mass || a.id.localeCompare(b.id))
    .slice(0, maxNodes);

  const expanded: GraphNode[] = [];
  for (const { id } of ranked) {
    const node = nodeById.get(id);
    if (node) expanded.push(node);
  }
  return expanded;
}

export function vectorRecall(
  nodes: GraphNode[],
  queryEmbedding: number[],
  topK: number,
  minSimilarity: number
): GraphNode[] {
  if (!queryEmbedding || queryEmbedding.length === 0) return [];
  const scored: { node: GraphNode; sim: number }[] = [];
  for (const node of nodes) {
    const emb = extractEmbedding(node);
    if (!emb || emb.length !== queryEmbedding.length) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= minSimilarity) scored.push({ node, sim });
  }
  scored.sort((a, b) => b.sim - a.sim || a.node.id.localeCompare(b.node.id));
  return scored.slice(0, topK).map((s) => s.node);
}

function collectVectorRecallCandidates(
  client: GraphClient,
  keywordHits: GraphNode[],
  enableFullGraphVectorRecall: boolean
): GraphNode[] {
  if (!enableFullGraphVectorRecall) {
    return keywordHits;
  }

  const byId = new Map<string, GraphNode>();
  for (const hit of keywordHits) {
    if (extractEmbedding(hit)) {
      byId.set(hit.id, hit);
    }
  }

  const snapshot = client.readSnapshot?.();
  if (!snapshot) {
    return keywordHits;
  }

  for (const node of snapshot.nodes) {
    if (extractEmbedding(node)) {
      byId.set(node.id, node);
    }
  }

  return byId.size > 0 ? Array.from(byId.values()) : keywordHits;
}

function linearVectorRecall(
  nodes: GraphNode[],
  queryEmbedding: number[],
  topK: number,
  minSimilarity: number
): GraphNode[] {
  const { index } = getSharedVectorIndex(nodes);
  return index.search(queryEmbedding, topK, minSimilarity).map((result) => result.node);
}

/**
 * Candidate-stage diversification: one hub file whose symbols match every
 * query token (e.g. a runtime/routing.ts matching "task"/"routing") can fill
 * the whole candidate list, so downstream compression and packing never even
 * SEE the true target. Cap Symbol candidates per file (loosely — the final
 * package cap stays DEFAULT_MAX_SYMBOLS_PER_FILE) so the candidate pool stays
 * cross-file. Order of the surviving candidates is unchanged (deterministic).
 */
export async function collectKeywordHits(
  client: GraphClient,
  query: string,
  options?: LayeredPackageOptions
): Promise<GraphNode[]> {
  const hits = await collectExpandedKeywordHits(
    client,
    query,
    options?.workspaceRoot,
    options?.englishQuery
  );
  return diversifyHitsBySourceFile(hits, {
    maxSymbolsPerFile: CANDIDATE_MAX_SYMBOLS_PER_FILE,
  });
}

/**
 * Fuse keyword hits with vector recall when enabled.
 * Returns `null` when vector recall is off so callers keep their current hit list
 * (enhanced may have already applied symbol boosting).
 * On failure, returns the original keyword hits (same reset both builders used).
 */
export async function fuseVectorRecallIfEnabled(
  client: GraphClient,
  query: string,
  keywordHits: GraphNode[],
  options: LayeredPackageOptions | undefined,
  logLabel: string
): Promise<GraphNode[] | null> {
  if (options?.enableVectorRecall !== true || !options.embeddingProvider) {
    return null;
  }
  try {
    const queryEmbedding = await options.embeddingProvider.embed(query);
    const topK = options.vectorTopK ?? 8;
    const minSim = options.vectorMinSimilarity ?? 0.05;
    // Semantic rescue: keyword recall came back empty (pure-CJK query against
    // English-only symbols with no glossary/path signal) — vector recall would
    // otherwise re-rank an empty list and stay empty. Widen candidates to the
    // full embedded graph for this call only. Gated on a non-hash backend:
    // FNV vectors carry no meaning and would inject noise. Nodes without any
    // vector (fresh store, backfill pending) still contribute nothing, so the
    // failure mode is identical to today, improving as vectors backfill.
    const providerFingerprint = options.embeddingProvider.fingerprint?.();
    const semanticRescue =
      keywordHits.length === 0 &&
      providerFingerprint !== undefined &&
      !isHashFingerprint(providerFingerprint);
    const { nodes: vectorCandidates, skipped } = filterCompatibleEmbeddingNodes(
      collectVectorRecallCandidates(
        client,
        keywordHits,
        options.enableFullGraphVectorRecall === true || semanticRescue
      ),
      queryEmbedding.length,
      providerFingerprint
    );
    recordIncompatibleVectorsSkipped(skipped);
    const vectorHits = linearVectorRecall(vectorCandidates, queryEmbedding, topK, minSim);
    // Half weight: vector candidates are a re-ranking of the keyword hits, and
    // prose (docs, skill copies) embeds closer to natural-language questions
    // than code does, so an equal vote let every doc copy outrank the code.
    return reciprocalRankFusion([keywordHits, vectorHits], 60, [1, VECTOR_RRF_WEIGHT]);
  } catch (error) {
    logger.warn({ error }, `Vector recall failed in ${logLabel}`);
    return keywordHits;
  }
}

export function preparePackageHits(
  hits: GraphNode[],
  query: string,
  options: LayeredPackageOptions | undefined,
  snapshotNodes: GraphNode[] | undefined
): GraphNode[] {
  const prepared = prepareHitsForPackaging(hits, {
    query,
    ...(options?.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
    ...(snapshotNodes !== undefined ? { allNodes: snapshotNodes } : {}),
  });
  return prepared;
}

function atAnchorCap(state: PackState): boolean {
  return state.maxAnchors !== undefined && state.anchorChannel.length >= state.maxAnchors;
}

export function tryAppendL3Node(
  node: GraphNode,
  state: PackState,
  budget: PackBudget
): "packed" | "budget" | "skip" {
  if (atAnchorCap(state)) {
    return "skip";
  }
  if (state.added.has(node.id)) {
    return "skip";
  }
  if (!canUseLayer("L3", state.quota, state.used)) {
    return "skip";
  }
  const summary = `${node.type}: ${node.content}`;
  const estimate = estimateTokens(summary);
  if (budget.tokens + estimate > state.maxTokens) {
    budget.truncated = true;
    return "budget";
  }
  state.summaryChannel.push(summary);
  state.anchorChannel.push({ id: node.id, type: node.type, layer: "L3" });
  state.added.add(node.id);
  budget.tokens += estimate;
  markLayerUsed("L3", state.used);
  return "packed";
}

function collectPinnedL3Nodes(
  ranked: GraphNode[],
  snapshotNodes: GraphNode[] | undefined,
  added: Set<string>
): GraphNode[] {
  const pins: GraphNode[] = [];
  const seen = new Set<string>();
  const consider = (node: GraphNode): void => {
    if (added.has(node.id) || seen.has(node.id) || !isPinnedL3Node(node)) {
      return;
    }
    seen.add(node.id);
    pins.push(node);
  };
  for (const node of ranked) consider(node);
  if (snapshotNodes) {
    // Same reason as the other capped scans: pins are taken in encounter order
    // until the budget stops them, so the whole-graph tail must be id-ordered.
    for (const node of snapshotNodes) consider(node);
  }
  return pins;
}

export function packPrimaryHits(hits: GraphNode[], state: PackState, budget: PackBudget): void {
  for (const hit of hits) {
    if (atAnchorCap(state)) {
      budget.truncated = true;
      break;
    }
    const layer = classifyLayer(hit);
    if (!canUseLayer(layer, state.quota, state.used)) {
      continue;
    }

    const summary = `${hit.type}: ${hit.content}`;
    const estimate = estimateTokens(summary);
    if (budget.tokens + estimate > state.maxTokens) {
      budget.truncated = true;
      break;
    }

    state.summaryChannel.push(summary);
    state.anchorChannel.push({ id: hit.id, type: hit.type, layer });
    state.added.add(hit.id);
    budget.tokens += estimate;
    markLayerUsed(layer, state.used);

    if (state.bodyCandidates && hit.type === "Symbol" && layer === "L1" && state.bodyCandidates.length < 6) {
      // Bodies are attached by `injectSymbolBodies`, after every anchor stage,
      // so a body can only ever spend budget an anchor left behind.
      state.bodyCandidates.push(hit);
    }
  }
}

/**
 * Quote the declaration bodies of the leading symbol anchors into the tail of
 * the package. Runs after every code-anchor stage and before dialogue: an
 * anchor is never displaced by a body, and dialogue keeps the same
 * additive-LAST invariant it already has.
 */
export function injectSymbolBodies(state: PackState, budget: PackBudget): void {
  const reader = state.bodyReader;
  const candidates = state.bodyCandidates;
  if (!reader || !candidates || candidates.length === 0) {
    return;
  }
  for (const hit of candidates) {
    const body = reader(hit, state.maxTokens - budget.tokens);
    if (!body) continue;
    state.summaryChannel.push(`body ${hit.id}\n${body}`);
    budget.tokens += estimateTokens(body);
  }
}

export async function injectL2Modules(
  client: GraphClient,
  hits: GraphNode[],
  state: PackState,
  budget: PackBudget,
  duplicatePolicy: DuplicateModulePolicy
): Promise<void> {
  if (budget.truncated || atAnchorCap(state)) {
    return;
  }

  const hitById = new Map<string, GraphNode>();
  for (const hit of hits) {
    hitById.set(hit.id, hit);
  }

  const moduleIds = new Set<string>();
  for (const anchor of state.anchorChannel) {
    if (anchor.layer !== "L1" || (anchor.type !== "File" && anchor.type !== "Symbol")) {
      continue;
    }
    const moduleId = deriveModuleId(anchor, hitById.get(anchor.id));
    if (moduleId) {
      moduleIds.add(moduleId);
    }
  }

  let moduleNodes: GraphNode[] = [];
  if (moduleIds.size > 0 && typeof client.getNodesByIds === "function") {
    moduleNodes = await client.getNodesByIds(Array.from(moduleIds));
  }

  for (const moduleId of moduleIds) {
    if (state.added.has(moduleId)) {
      if (duplicatePolicy === "break") {
        break;
      }
      continue;
    }
    if (atAnchorCap(state)) {
      break;
    }
    if (!canUseLayer("L2", state.quota, state.used)) {
      break;
    }

    const node =
      moduleNodes.find((n) => n.id === moduleId) ??
      ({ id: moduleId, type: "Module" as const, content: moduleId.slice("module:".length) });

    const summary = `${node.type}: ${node.content}`;
    const estimate = estimateTokens(summary);
    if (budget.tokens + estimate > state.maxTokens) {
      budget.truncated = true;
      break;
    }

    state.summaryChannel.push(summary);
    state.anchorChannel.push({ id: node.id, type: node.type, layer: "L2" });
    state.added.add(node.id);
    budget.tokens += estimate;
    markLayerUsed("L2", state.used);
  }
}

export async function injectL3SkillsAndPins(
  client: GraphClient,
  query: string,
  options: LayeredPackageOptions | undefined,
  snapshotNodes: GraphNode[] | undefined,
  state: PackState,
  budget: PackBudget
): Promise<void> {
  if (atAnchorCap(state)) {
    return;
  }
  const archIntent = ARCHITECTURE_QUERY.test(composeContextQuery(query, options?.englishQuery));
  if (!(options?.enableAlwaysOnLayers || archIntent)) {
    return;
  }

  const l3Candidates = rankNodesForContextQuery(
    (await client.queryByKeyword(query)).filter((n) => n.type === "Skill" || n.type === "Decision"),
    query,
    {
      scoreTokens: buildSearchScoreTokens(query, options?.englishQuery),
      matchQueries: options?.englishQuery?.trim() ? [query, options.englishQuery.trim()] : [query],
      ...(options?.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
    }
  );

  const pins = collectPinnedL3Nodes(l3Candidates, snapshotNodes, state.added);
  for (const node of pins) {
    if (tryAppendL3Node(node, state, budget) === "budget") break;
  }
  if (budget.truncated) {
    return;
  }

  let l3Added = pins.filter((n) => state.added.has(n.id)).length;
  for (const node of l3Candidates) {
    if (l3Added >= 2 || atAnchorCap(state)) break;
    if (isPinnedL3Node(node)) continue;
    const result = tryAppendL3Node(node, state, budget);
    if (result === "budget") break;
    if (result === "packed") l3Added += 1;
  }
}

/**
 * Presentation order for the SELECTED dialogue lines: sessionId lexicographic,
 * then seq ascending (the in-session clock), so the same selected set always
 * lands in the same order regardless of when each turn was last touched.
 * `updatedAt` is only a fallback tie-break when a stored record has no seq —
 * it moves on edits, so it must never be the primary key (the old hits→
 * updatedAt ordering reshuffled two rounds apart whenever one turn got edited).
 */
interface DialogueTurnOrderKey {
  id: string;
  sessionId?: string;
  seq?: number;
  updatedAt?: number;
}

function compareDialogueTurnOrder(a: DialogueTurnOrderKey, b: DialogueTurnOrderKey): number {
  const bySession = (a.sessionId ?? "").localeCompare(b.sessionId ?? "");
  if (bySession !== 0) return bySession;
  const aHasSeq = typeof a.seq === "number";
  const bHasSeq = typeof b.seq === "number";
  if (aHasSeq && bHasSeq && a.seq !== b.seq) return (a.seq as number) - (b.seq as number);
  if (aHasSeq !== bHasSeq) return aHasSeq ? -1 : 1;
  const byUpdated = (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
  if (byUpdated !== 0) return byUpdated;
  return a.id.localeCompare(b.id);
}

async function collectDialogueContextLines(
  client: GraphClient,
  query: string,
  options?: LayeredPackageOptions
): Promise<DialogueContextLine[]> {
  try {
    const { listDialogueTurns, effectiveTurns, formatSupersessionLine } = await import(
      "../learning/dialogue-thread.js"
    );
    const allTurns = await listDialogueTurns(client, { limit: 60 });
    const turns = effectiveTurns(allTurns);
    if (turns.length === 0) return [];

    const scoreTokens = buildSearchScoreTokens(query, options?.englishQuery);
    if (scoreTokens.length === 0) return [];
    const tokenSet = new Set(scoreTokens.map((t) => t.toLowerCase()));

    const scored = turns
      .map((turn) => {
        const haystack = `${turn.userQuery} ${turn.title ?? ""} ${turn.summary ?? ""}`.toLowerCase();
        let hits = 0;
        for (const token of tokenSet) {
          if (haystack.includes(token)) hits += 1;
        }
        return { turn, hits };
      })
      .filter((s) => s.hits > 0)
      // Selection still by query match quality (hits desc): the score decides
      // WHO enters the package. The tie-breaks stay deterministic for a given
      // store state but never influence the presentation order below.
      .sort(
        (a, b) =>
          b.hits - a.hits ||
          b.turn.updatedAt - a.turn.updatedAt ||
          a.turn.id.localeCompare(b.turn.id)
      )
      .slice(0, DIALOGUE_PACK_MAX_TURNS);
    if (scored.length === 0) return [];
    // Presentation order for the already-selected slice: sessionId → seq, so
    // the packed dialogue lines are byte-stable across rounds and across
    // sessions instead of tracking whichever turn was edited most recently.
    scored.sort((a, b) => compareDialogueTurnOrder(a.turn, b.turn));

    const byId = new Map(allTurns.map((t) => [t.id, t]));
    const lines: DialogueContextLine[] = [];
    for (const { turn } of scored) {
      const correctionTargets = (turn.supersedesTurnIds ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is NonNullable<typeof t> => Boolean(t));
      const correctionLine =
        correctionTargets.length > 0
          ? formatSupersessionLine(correctionTargets[correctionTargets.length - 1]!, turn)
          : undefined;
      lines.push({
        kind: "turn",
        text: turn.title ?? turn.userQuery,
        node: {
          id: turn.id,
          type: "Decision",
          content: `dialogue-turn #${turn.seq} Q: ${turn.userQuery}`,
          metadata: { kind: "dialogue-turn", record: JSON.stringify(turn) },
        },
        ...(correctionLine ? { correctionLine } : {}),
      });
    }
    return lines;
  } catch {
    return [];
  }
}

export async function injectDialogueTurns(
  client: GraphClient,
  query: string,
  options: LayeredPackageOptions | undefined,
  state: PackState,
  budget: PackBudget
): Promise<void> {
  if (budget.truncated) {
    return;
  }
  const dialogueLines = await collectDialogueContextLines(client, query, options);
  for (const line of dialogueLines) {
    if (line.kind === "summary") {
      const estimate = estimateTokens(line.text);
      if (budget.tokens + estimate > state.maxTokens) {
        budget.truncated = true;
        break;
      }
      budget.tokens += estimate;
    } else if (line.kind === "turn" && line.node) {
      if (tryAppendL3Node(line.node, state, budget) === "budget") {
        break;
      }
      if (line.correctionLine) {
        const estimate = estimateTokens(line.correctionLine);
        if (budget.tokens + estimate > state.maxTokens) {
          budget.truncated = true;
          break;
        }
        state.summaryChannel.push(line.correctionLine);
        budget.tokens += estimate;
      }
    }
  }
}

/**
 * NOTE (v1.17): both packers call `injectL3SkillsAndPins` in the L3 slot and then
 * `injectDialogueTurns` LAST, after every code-anchor stage. There is deliberately
 * no combined `injectL3Stage` helper: composing dialogue into the middle of the
 * pack sequence let a recalled conversation turn take an anchor slot ahead of a
 * Symbol/File anchor, which broke the golden retrieval gate
 * (`tests/retrieval-golden.test.ts`, query "cli help flags"). Keeping the two
 * calls separate — with dialogue provably last and still sharing the one
 * `budget` object — is what enforces the documented invariant that dialogue
 * recall is purely additive and never displaces code context.
 */

/**
 * Same-file expansion guard: once one source file already owns this share of
 * the L1 anchor channel (or this many anchors absolutely), adding MORE symbols
 * from it only entrenches the monopoly — cross-file coverage beats same-file
 * completeness once a file dominates. The ratio test requires a non-empty
 * channel, so 0/0 can never read as dominance (failure-safe at pack start).
 */
const SAME_FILE_DOMINANCE_RATIO = 0.5;
const SAME_FILE_DOMINANCE_MAX_ANCHORS = 6;

function normalizeAnchorFilePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Resolve the source file an L1 anchor belongs to, or undefined. */
function fileOwnerOfAnchor(anchor: ContextAnchorItem): string | undefined {
  if (anchor.layer !== "L1") {
    return undefined;
  }
  if (anchor.type === "File" && anchor.id.startsWith("file:")) {
    return normalizeAnchorFilePath(anchor.id.slice("file:".length));
  }
  if (anchor.type === "Symbol") {
    const fp = extractFileFromSymbolId(anchor.id);
    return fp ? normalizeAnchorFilePath(fp) : undefined;
  }
  return undefined;
}

/** Live per-file ownership of the L1 anchor channel (updated as anchors land). */
class AnchorFileOwnership {
  private readonly perFile = new Map<string, number>();
  private total = 0;

  constructor(anchorChannel: ReadonlyArray<ContextAnchorItem>) {
    for (const anchor of anchorChannel) {
      this.add(anchor);
    }
  }

  add(anchor: ContextAnchorItem): void {
    const file = fileOwnerOfAnchor(anchor);
    if (!file) return;
    this.perFile.set(file, (this.perFile.get(file) ?? 0) + 1);
    this.total += 1;
  }

  isDominant(file: string): boolean {
    const count = this.perFile.get(normalizeAnchorFilePath(file)) ?? 0;
    if (count >= SAME_FILE_DOMINANCE_MAX_ANCHORS) {
      return true;
    }
    return this.total > 0 && count / this.total >= SAME_FILE_DOMINANCE_RATIO;
  }
}

export async function injectSameFileAndImportExpansion(
  client: GraphClient,
  snapshotNodes: GraphNode[] | undefined,
  state: PackState,
  budget: PackBudget
): Promise<void> {
  if (budget.truncated || atAnchorCap(state)) {
    return;
  }

  const seedFilePaths: string[] = [];
  for (const anchor of state.anchorChannel) {
    if (anchor.type === "File" && anchor.id.startsWith("file:")) {
      seedFilePaths.push(anchor.id.slice("file:".length));
    } else if (anchor.type === "Symbol") {
      const fp = extractFileFromSymbolId(anchor.id);
      if (fp) seedFilePaths.push(fp);
    }
  }

  // Dominance guard: same-file expansion must not let one file re-flood the
  // channel after the primary pack diversified it. Without this, a hub file
  // re-adds its remaining symbols here and crowds out every other file.
  const ownership = new AnchorFileOwnership(state.anchorChannel);

  if (seedFilePaths.length > 0 && snapshotNodes) {
    for (const node of snapshotNodes) {
      if (state.added.has(node.id) || atAnchorCap(state)) continue;
      if (node.type !== "Symbol") continue;
      const nodeFile = extractFileFromSymbolId(node.id);
      if (!nodeFile) continue;
      const inSeedFile = seedFilePaths.some(
        (sp) =>
          nodeFile.includes(sp.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "")) ||
          sp
            .replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "")
            .includes(nodeFile.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, ""))
      );
      if (!inSeedFile) continue;
      if (ownership.isDominant(nodeFile)) continue;
      const layer = classifyLayer(node);
      const summary = `${node.type}: ${node.content}`;
      const estimate = estimateTokens(summary);
      if (budget.tokens + estimate > state.maxTokens) {
        budget.truncated = true;
        break;
      }
      const anchor: ContextAnchorItem = { id: node.id, type: node.type, layer };
      state.summaryChannel.push(summary);
      state.anchorChannel.push(anchor);
      state.added.add(node.id);
      budget.tokens += estimate;
      markLayerUsed(layer, state.used);
      ownership.add(anchor);
    }
  }

  if (seedFilePaths.length > 0 && !atAnchorCap(state)) {
    const importHits = await collectImportRelatedFiles(client, seedFilePaths, 5);
    for (const node of importHits) {
      if (state.added.has(node.id) || atAnchorCap(state)) continue;
      const nodeFile = fileOwnerOfAnchor({ id: node.id, type: node.type, layer: "L1" });
      if (nodeFile && ownership.isDominant(nodeFile)) continue;
      const layer = classifyLayer(node);
      const summary = `${node.type}: ${node.content}`;
      const estimate = estimateTokens(summary);
      if (budget.tokens + estimate > state.maxTokens) {
        budget.truncated = true;
        break;
      }
      const anchor: ContextAnchorItem = { id: node.id, type: node.type, layer };
      state.summaryChannel.push(summary);
      state.anchorChannel.push(anchor);
      state.added.add(node.id);
      budget.tokens += estimate;
      markLayerUsed(layer, state.used);
      ownership.add(anchor);
    }
  }
}

export async function injectNeighborExpansion(
  client: GraphClient,
  options: LayeredPackageOptions | undefined,
  state: PackState,
  budget: PackBudget
): Promise<void> {
  const enableExpansion = options?.enableEdgeExpansion !== false;
  if (!enableExpansion || budget.truncated || atAnchorCap(state) || typeof client.getNeighbors !== "function") {
    return;
  }
  const seedIds = state.anchorChannel.slice(0, 5).map((a) => a.id);
  if (seedIds.length === 0) {
    return;
  }
  // Default ("bfs") keeps the exact `{ hops: 1 }` call of the legacy walk;
  // "ppr" drops the explicit hop so its documented multi-hop pool default
  // (hops 2) applies and neighbors are admitted by descending PPR mass.
  const expansionOptions =
    options?.expansionStrategy === "ppr"
      ? { expansionStrategy: "ppr" as const }
      : { hops: 1 };
  const expanded = await expandSubgraph(client, seedIds, expansionOptions);
  for (const node of expanded) {
    if (state.added.has(node.id) || atAnchorCap(state)) continue;
    const layer = classifyLayer(node);
    if (!canUseLayer(layer, state.quota, state.used)) continue;
    const summary = `${node.type}: ${node.content}`;
    const estimate = estimateTokens(summary);
    if (budget.tokens + estimate > state.maxTokens) {
      budget.truncated = true;
      break;
    }
    state.summaryChannel.push(summary);
    state.anchorChannel.push({ id: node.id, type: node.type, layer });
    state.added.add(node.id);
    budget.tokens += estimate;
    markLayerUsed(layer, state.used);
  }
}
