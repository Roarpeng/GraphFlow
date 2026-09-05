/**
 * Shared context-packaging core.
 *
 * `buildLayeredContextPackage` and `buildEnhancedContextPackage` used to
 * duplicate retrieval + L1/L2/L3 quota packing (~60% overlap). Both public
 * functions keep their signatures and extras; this module owns the common
 * recall/pack steps so behavior stays identical.
 */

import { logger } from "../utils/logger.js";
import type { GraphNode } from "../core/types.js";
import {
  cosineSimilarity,
  extractEmbedding,
  reciprocalRankFusion,
} from "../learning/embeddings.js";
import type { GraphClient } from "./client-factory.js";
import { rankNodesForContextQuery, composeContextQuery, buildSearchScoreTokens } from "./graph-utils.js";
import { collectExpandedKeywordHits } from "./query-expand.js";
import { prepareHitsForPackaging } from "./hit-diversify.js";
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

const L3_PIN_HINT = /alignment|deviation|goal/i;

/** Max matched dialogue turns packed per preview (after effective-turns filter). */
const DIALOGUE_PACK_MAX_TURNS = 3;

export type DuplicateModulePolicy = "continue" | "break";

export interface PackState {
  summaryChannel: string[];
  anchorChannel: ContextAnchorItem[];
  added: Set<string>;
  quota: { l1: number; l2: number; l3: number };
  used: { l1: number; l2: number; l3: number };
  maxTokens: number;
  maxAnchors?: number;
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
  return state;
}

export function toLayeredPackage(state: PackState, budget: PackBudget): LayeredContextPackage {
  return {
    summaryChannel: state.summaryChannel,
    anchorChannel: state.anchorChannel,
    tokenEstimate: budget.tokens,
    truncated: budget.truncated,
  };
}

export async function expandSubgraph(
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
    if (!emb) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= minSimilarity) scored.push({ node, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
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

async function hnswVectorRecall(
  nodes: GraphNode[],
  queryEmbedding: number[],
  topK: number,
  minSimilarity: number,
  hnswIndexPath?: string
): Promise<GraphNode[]> {
  const { getSharedVectorIndex } = await import("../learning/hnsw-index.js");
  const { index } = getSharedVectorIndex(nodes, hnswIndexPath);
  const results = await index.search(queryEmbedding, topK, minSimilarity);
  return results.map((result) => result.node);
}

export async function collectKeywordHits(
  client: GraphClient,
  query: string,
  options?: LayeredPackageOptions
): Promise<GraphNode[]> {
  return collectExpandedKeywordHits(client, query, options?.workspaceRoot, options?.englishQuery);
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
    const vectorCandidates = collectVectorRecallCandidates(
      client,
      keywordHits,
      options.enableFullGraphVectorRecall === true
    );
    const vectorHits = await hnswVectorRecall(
      vectorCandidates,
      queryEmbedding,
      topK,
      minSim,
      options.hnswIndexPath
    );
    return reciprocalRankFusion([keywordHits, vectorHits]);
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
  return prepareHitsForPackaging(hits, {
    query,
    ...(options?.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
    ...(snapshotNodes !== undefined ? { allNodes: snapshotNodes } : {}),
  });
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
      .sort((a, b) => b.hits - a.hits || b.turn.updatedAt - a.turn.updatedAt)
      .slice(0, DIALOGUE_PACK_MAX_TURNS);
    if (scored.length === 0) return [];

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
      const layer = classifyLayer(node);
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

  if (seedFilePaths.length > 0 && !atAnchorCap(state)) {
    const importHits = await collectImportRelatedFiles(client, seedFilePaths, 5);
    for (const node of importHits) {
      if (state.added.has(node.id) || atAnchorCap(state)) continue;
      const layer = classifyLayer(node);
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
  const expanded = await expandSubgraph(client, seedIds, { hops: 1 });
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
