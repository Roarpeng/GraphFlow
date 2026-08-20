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
import {
  extractConnectedSubgraph,
  computePageRank,
  blendWithCentrality,
} from "./graph-compression.js";
import { buildRepoMap, formatRepoMapString } from "./repo-map.js";
import { estimateContextBudget } from "./adaptive-budget.js";
import { extractSymbolCandidates, fetchSymbolCandidates, collectImportRelatedFiles } from "./symbol-extract.js";

// Re-export all public types and constants from sub-modules
export type {
  ContextSlice,
  ContextLayer,
  ContextAnchorItem,
  LayeredContextPackage,
  LayeredPackageOptions,
  SubgraphExpansionOptions,
  ContextRefillManager,
  L3PinKind,
} from "./context-slicer-types.js";
export {
  DEFAULT_EXPANSION_RELATIONS,
  ARCHITECTURE_QUERY,
} from "./context-slicer-types.js";

const L3_PIN_HINT = /alignment|deviation|goal/i;

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

function tryAppendL3Node(
  node: GraphNode,
  ctx: {
    summaryChannel: string[];
    anchorChannel: ContextAnchorItem[];
    added: Set<string>;
    quota: { l1: number; l2: number; l3: number };
    used: { l1: number; l2: number; l3: number };
    maxTokens: number;
    maxAnchors?: number;
  },
  acc: { tokens: number; truncated: boolean }
): "packed" | "budget" | "skip" {
  if (ctx.maxAnchors !== undefined && ctx.anchorChannel.length >= ctx.maxAnchors) {
    return "skip";
  }
  if (ctx.added.has(node.id)) {
    return "skip";
  }
  if (!canUseLayer("L3", ctx.quota, ctx.used)) {
    return "skip";
  }
  const summary = `${node.type}: ${node.content}`;
  const estimate = estimateTokens(summary);
  if (acc.tokens + estimate > ctx.maxTokens) {
    acc.truncated = true;
    return "budget";
  }
  ctx.summaryChannel.push(summary);
  ctx.anchorChannel.push({ id: node.id, type: node.type, layer: "L3" });
  ctx.added.add(node.id);
  acc.tokens += estimate;
  markLayerUsed("L3", ctx.used);
  return "packed";
}

// Re-export utility functions that were previously exported
export {
  getEncoder,
  estimateTokens,
  summarizeNodes,
  classifyLayer,
  canUseLayer,
  markLayerUsed,
  modulePathKey,
  deriveModuleId,
  extractFileFromSymbolId,
} from "./context-slicer-utils.js";

export {
  diversifyHitsBySourceFile,
  expandSiblingDirectoryHits,
  hasModuleFamilyIntent,
  prepareHitsForPackaging,
  DEFAULT_MAX_SYMBOLS_PER_FILE,
  DEFAULT_MAX_SIBLING_FILES,
} from "./hit-diversify.js";

// Import internal helpers (not re-exported)
import {
  estimateTokens,
  classifyLayer,
  canUseLayer,
  markLayerUsed,
  deriveModuleId,
  extractFileFromSymbolId,
} from "./context-slicer-utils.js";

// Import types for internal use
import type {
  ContextSlice,
  ContextAnchorItem,
  LayeredContextPackage,
  LayeredPackageOptions,
  SubgraphExpansionOptions,
  ContextRefillManager,
} from "./context-slicer-types.js";
import { DEFAULT_EXPANSION_RELATIONS, ARCHITECTURE_QUERY } from "./context-slicer-types.js";

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

export async function buildContextSlice(
  client: GraphClient,
  query: string,
  maxTokens: number
): Promise<ContextSlice> {
  const pkg = await buildLayeredContextPackage(client, query, maxTokens);
  return { items: pkg.summaryChannel, tokenEstimate: pkg.tokenEstimate };
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
  // Memoized per-process + optional disk-persisted index: avoids re-extracting
  // embeddings for every query and speeds up MCP server restarts.
  const { getSharedVectorIndex } = await import("../learning/hnsw-index.js");
  const { index } = getSharedVectorIndex(nodes, hnswIndexPath);
  const results = await index.search(queryEmbedding, topK, minSimilarity);
  return results.map((result) => result.node);
}

export async function buildLayeredContextPackage(
  client: GraphClient,
  query: string,
  maxTokens: number,
  options?: LayeredPackageOptions
): Promise<LayeredContextPackage> {
  const keywordHits = await collectExpandedKeywordHits(
    client,
    query,
    options?.workspaceRoot,
    options?.englishQuery
  );
  let hits: GraphNode[] = keywordHits;

  if (options?.enableVectorRecall === true && options.embeddingProvider) {
    try {
      const queryEmbedding = await options.embeddingProvider.embed(query);
      const topK = options.vectorTopK ?? 8;
      const minSim = options.vectorMinSimilarity ?? 0.05;
      const vectorCandidates = collectVectorRecallCandidates(
        client,
        keywordHits,
        options.enableFullGraphVectorRecall === true
      );
      const vectorHits = await hnswVectorRecall(vectorCandidates, queryEmbedding, topK, minSim, options?.hnswIndexPath);
      hits = reciprocalRankFusion([keywordHits, vectorHits]);
    } catch (error) {
      logger.warn({ error }, "Vector recall failed in buildLayeredContextPackage");
      hits = keywordHits;
    }
  }

  const snapshotNodes = client.readSnapshot?.()?.nodes;
  hits = prepareHitsForPackaging(hits, {
    query,
    ...(options?.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
    ...(snapshotNodes !== undefined ? { allNodes: snapshotNodes } : {}),
  });

  const summaryChannel: string[] = [];
  const anchorChannel: ContextAnchorItem[] = [];
  let tokens = 0;
  let truncated = false;

  const quota = {
    l1: options?.layerQuota?.l1 ?? Number.POSITIVE_INFINITY,
    l2: options?.layerQuota?.l2 ?? Number.POSITIVE_INFINITY,
    l3: options?.layerQuota?.l3 ?? Number.POSITIVE_INFINITY,
  };
  const used = { l1: 0, l2: 0, l3: 0 };
  const added = new Set<string>();
  const hitById = new Map<string, GraphNode>();

  for (const hit of hits) {
    hitById.set(hit.id, hit);
    const layer = classifyLayer(hit);
    if (!canUseLayer(layer, quota, used)) {
      continue;
    }

    const summary = `${hit.type}: ${hit.content}`;
    const estimate = estimateTokens(summary);
    if (tokens + estimate > maxTokens) {
      truncated = true;
      break;
    }

    summaryChannel.push(summary);
    anchorChannel.push({ id: hit.id, type: hit.type, layer });
    added.add(hit.id);
    tokens += estimate;
    markLayerUsed(layer, used);
  }

  if (!truncated) {
    const moduleIds = new Set<string>();
    for (const anchor of anchorChannel) {
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
      if (added.has(moduleId)) continue;
      if (!canUseLayer("L2", quota, used)) break;

      const node =
        moduleNodes.find((n) => n.id === moduleId) ??
        ({ id: moduleId, type: "Module" as const, content: moduleId.slice("module:".length) });

      const summary = `${node.type}: ${node.content}`;
      const estimate = estimateTokens(summary);
      if (tokens + estimate > maxTokens) {
        truncated = true;
        break;
      }

      summaryChannel.push(summary);
      anchorChannel.push({ id: node.id, type: node.type, layer: "L2" });
      added.add(node.id);
      tokens += estimate;
      markLayerUsed("L2", used);
    }
  }

  const archIntent = ARCHITECTURE_QUERY.test(composeContextQuery(query, options?.englishQuery));
  if (options?.enableAlwaysOnLayers || archIntent) {
    const l3Candidates = rankNodesForContextQuery(
      (await client.queryByKeyword(query)).filter(
        (n) => n.type === "Skill" || n.type === "Decision"
      ),
      query,
      {
        scoreTokens: buildSearchScoreTokens(query, options?.englishQuery),
        matchQueries: options?.englishQuery?.trim()
          ? [query, options.englishQuery.trim()]
          : [query],
        ...(options?.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
      }
    );
    const snapshotForPins = client.readSnapshot?.()?.nodes;
    const acc = { tokens, truncated };
    const packCtx = { summaryChannel, anchorChannel, added, quota, used, maxTokens };
    const pins = collectPinnedL3Nodes(l3Candidates, snapshotForPins, added);
    for (const node of pins) {
      if (tryAppendL3Node(node, packCtx, acc) === "budget") break;
    }
    tokens = acc.tokens;
    truncated = acc.truncated;
    if (!truncated) {
      let l3Added = pins.filter((n) => added.has(n.id)).length;
      for (const node of l3Candidates) {
        if (l3Added >= 2) break;
        if (isPinnedL3Node(node)) continue;
        const result = tryAppendL3Node(node, packCtx, acc);
        if (result === "budget") break;
        if (result === "packed") l3Added += 1;
      }
      tokens = acc.tokens;
      truncated = acc.truncated;
    }
  }

  const enableExpansion = options?.enableEdgeExpansion !== false;
  if (enableExpansion && !truncated && typeof client.getNeighbors === "function") {
    const seedIds = anchorChannel.slice(0, 5).map((a) => a.id);
    if (seedIds.length > 0) {
      const expanded = await expandSubgraph(client, seedIds, { hops: 1 });
      for (const node of expanded) {
        if (added.has(node.id)) continue;
        const layer = classifyLayer(node);
        if (!canUseLayer(layer, quota, used)) continue;

        const summary = `${node.type}: ${node.content}`;
        const estimate = estimateTokens(summary);
        if (tokens + estimate > maxTokens) {
          truncated = true;
          break;
        }

        summaryChannel.push(summary);
        anchorChannel.push({ id: node.id, type: node.type, layer });
        added.add(node.id);
        tokens += estimate;
        markLayerUsed(layer, used);
      }
    }
  }

  return { summaryChannel, anchorChannel, tokenEstimate: tokens, truncated };
}

export function createContextRefillManager(
  client: GraphClient,
  maxTokens: number,
  options?: LayeredPackageOptions
): ContextRefillManager {
  const seenAnchors = new Set<string>();

  return {
    async initialPackage(query: string): Promise<LayeredContextPackage> {
      const pkg = await buildLayeredContextPackage(client, query, maxTokens, options);
      for (const anchor of pkg.anchorChannel) {
        seenAnchors.add(anchor.id);
      }
      return pkg;
    },
    async refill(evidenceHints: string[]): Promise<string[]> {
      const items: string[] = [];
      let tokens = 0;

      for (const hint of evidenceHints) {
        const hits = await client.queryByKeyword(hint);
        for (const hit of hits) {
          if (seenAnchors.has(hit.id)) {
            continue;
          }

          const line = `${hit.id} | ${hit.type}: ${hit.content}`;
          const estimate = estimateTokens(line);
          if (tokens + estimate > maxTokens) {
            return items;
          }

          seenAnchors.add(hit.id);
          tokens += estimate;
          items.push(line);
          break;
        }
      }

      return items;
    },
  };
}

/**
 * Enhanced context packaging with graph-structure compression and adaptive budgeting.
 *
 * Compression pipeline:
 *   1. [Optional] RepoMap fallback for low budgets
 *   2. Keyword retrieval
 *   3. Graph compression: connected subgraph + PageRank re-ranking
 *   4. Layer quotas + token budgeting
 *   5. Edge expansion
 */
export async function buildEnhancedContextPackage(
  client: GraphClient,
  query: string,
  task: string,
  maxTokens: number,
  options?: LayeredPackageOptions
): Promise<LayeredContextPackage> {
  // Step 0: Adaptive budget estimation.
  if (options?.taskMode) {
    const estimate = estimateContextBudget(task, options.taskMode);
    maxTokens = estimate.tokens;
    logger.debug({ estimate }, "Adaptive budget estimated");
  }

  // Step 1: RepoMap fallback for tight budgets.
  if (options?.enableRepoMapFallback && maxTokens < 1000) {
    try {
      const repoMap = await buildRepoMap(client);
      const mapStr = formatRepoMapString(repoMap);
      const tokens = estimateTokens(mapStr);
      if (tokens < maxTokens) {
        return {
          summaryChannel: [mapStr],
          anchorChannel: [],
          tokenEstimate: tokens,
          truncated: false,
        };
      }
    } catch (error) {
      logger.warn({ error }, "RepoMap fallback failed, proceeding with normal retrieval");
    }
  }

  // Step 2: Keyword retrieval (CJK-aware multi-query RRF when workspaceRoot is set).
  const keywordHits = await collectExpandedKeywordHits(
    client,
    query,
    options?.workspaceRoot,
    options?.englishQuery
  );
  let hits: GraphNode[] = keywordHits;

  // Step 2b: Symbol-aware boosting — extract camelCase/PascalCase tokens from
  // the task description and fetch matching symbol nodes to improve recall.
  const symbolCandidates = extractSymbolCandidates(task);
  if (symbolCandidates.length > 0) {
    const symbolHits = await fetchSymbolCandidates(client, symbolCandidates, 8);
    if (symbolHits.length > 0) {
      hits = reciprocalRankFusion([hits, symbolHits]);
    }
  }

  if (options?.enableVectorRecall === true && options.embeddingProvider) {
    try {
      const queryEmbedding = await options.embeddingProvider.embed(query);
      const topK = options.vectorTopK ?? 8;
      const minSim = options.vectorMinSimilarity ?? 0.05;
      const vectorCandidates = collectVectorRecallCandidates(
        client,
        keywordHits,
        options.enableFullGraphVectorRecall === true
      );
      const vectorHits = await hnswVectorRecall(vectorCandidates, queryEmbedding, topK, minSim, options?.hnswIndexPath);
      hits = reciprocalRankFusion([keywordHits, vectorHits]);
    } catch (error) {
      logger.warn({ error }, "Vector recall failed in buildEnhancedContextPackage");
      hits = keywordHits;
    }
  }

  if (options?.enableGraphCompression && hits.length > 0) {
    try {
      const ranked = await extractConnectedSubgraph(client, hits, options.graphCompressionOptions);
      const snapshot = client.readSnapshot?.();
      if (snapshot) {
        const pageRank = computePageRank(
          ranked.map((r) => r.node),
          snapshot.edges
        );
        hits = blendWithCentrality(
          ranked.map((r) => r.node),
          pageRank,
          0.3
        );
      } else {
        hits = ranked.map((r) => r.node);
      }
    } catch (error) {
      logger.warn({ error }, "Graph compression failed, using uncompressed hits");
    }
  }

  const snapshotNodes = client.readSnapshot?.()?.nodes;
  hits = prepareHitsForPackaging(hits, {
    query,
    ...(options?.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
    ...(snapshotNodes !== undefined ? { allNodes: snapshotNodes } : {}),
  });

  // Step 4: Build layered package with anchor cap.
  const maxAnchors = options?.maxAnchors ?? 15;
  const summaryChannel: string[] = [];
  const anchorChannel: ContextAnchorItem[] = [];
  let tokens = 0;
  let truncated = false;

  const quota = {
    l1: options?.layerQuota?.l1 ?? Number.POSITIVE_INFINITY,
    l2: options?.layerQuota?.l2 ?? Number.POSITIVE_INFINITY,
    l3: options?.layerQuota?.l3 ?? Number.POSITIVE_INFINITY,
  };
  const used = { l1: 0, l2: 0, l3: 0 };
  const added = new Set<string>();
  const hitById = new Map<string, GraphNode>();
  for (const hit of hits) hitById.set(hit.id, hit);

  for (const hit of hits) {
    if (anchorChannel.length >= maxAnchors) { truncated = true; break; }
    const layer = classifyLayer(hit);
    if (!canUseLayer(layer, quota, used)) continue;

    const summary = `${hit.type}: ${hit.content}`;
    const estimate = estimateTokens(summary);
    if (tokens + estimate > maxTokens) { truncated = true; break; }

    summaryChannel.push(summary);
    anchorChannel.push({ id: hit.id, type: hit.type, layer });
    added.add(hit.id);
    tokens += estimate;
    markLayerUsed(layer, used);
  }

  // Step 4b: L2 module injection — aggregate file/symbol hits into module overviews.
  if (!truncated && anchorChannel.length < maxAnchors) {
    const moduleIds = new Set<string>();
    for (const anchor of anchorChannel) {
      if (anchor.layer !== "L1" || (anchor.type !== "File" && anchor.type !== "Symbol")) continue;
      const moduleId = deriveModuleId(anchor, hitById.get(anchor.id));
      if (moduleId) moduleIds.add(moduleId);
    }
    let moduleNodes: GraphNode[] = [];
    if (moduleIds.size > 0 && typeof client.getNodesByIds === "function") {
      moduleNodes = await client.getNodesByIds(Array.from(moduleIds));
    }
    for (const moduleId of moduleIds) {
      if (added.has(moduleId) || anchorChannel.length >= maxAnchors) break;
      if (!canUseLayer("L2", quota, used)) break;
      const node = moduleNodes.find((n) => n.id === moduleId) ??
        ({ id: moduleId, type: "Module" as const, content: moduleId.slice("module:".length) });
      const summary = `${node.type}: ${node.content}`;
      const estimate = estimateTokens(summary);
      if (tokens + estimate > maxTokens) { truncated = true; break; }
      summaryChannel.push(summary);
      anchorChannel.push({ id: node.id, type: node.type, layer: "L2" });
      added.add(node.id);
      tokens += estimate;
      markLayerUsed("L2", used);
    }
  }

  // Step 4c: L3 skill/decision injection — always-on when enableAlwaysOnLayers,
  // otherwise only for architecture queries. Pin goal/alignment/deviation
  // Decision nodes first so budget truncation cannot drop them.
  const archIntent = ARCHITECTURE_QUERY.test(composeContextQuery(query, options?.englishQuery));
  if (anchorChannel.length < maxAnchors && (options?.enableAlwaysOnLayers || archIntent)) {
    const l3Candidates = rankNodesForContextQuery(
      (await client.queryByKeyword(query)).filter(
        (n) => n.type === "Skill" || n.type === "Decision"
      ),
      query,
      {
        scoreTokens: buildSearchScoreTokens(query, options?.englishQuery),
        matchQueries: options?.englishQuery?.trim()
          ? [query, options.englishQuery.trim()]
          : [query],
        ...(options?.englishQuery !== undefined ? { englishQuery: options.englishQuery } : {}),
      }
    );
    const acc = { tokens, truncated };
    const packCtx = {
      summaryChannel,
      anchorChannel,
      added,
      quota,
      used,
      maxTokens,
      maxAnchors,
    };
    const pins = collectPinnedL3Nodes(l3Candidates, snapshotNodes, added);
    for (const node of pins) {
      if (tryAppendL3Node(node, packCtx, acc) === "budget") break;
    }
    tokens = acc.tokens;
    truncated = acc.truncated;
    if (!truncated) {
      let l3Added = pins.filter((n) => added.has(n.id)).length;
      for (const node of l3Candidates) {
        if (l3Added >= 2 || anchorChannel.length >= maxAnchors) break;
        if (isPinnedL3Node(node)) continue;
        const result = tryAppendL3Node(node, packCtx, acc);
        if (result === "budget") break;
        if (result === "packed") l3Added += 1;
      }
      tokens = acc.tokens;
      truncated = acc.truncated;
    }
  }

  // Step 5: Import-based multi-hop expansion + same-file symbol boosting.
  // Find files that import the anchored files, AND add symbols from anchored
  // files to improve symbol-level recall.
  if (!truncated && anchorChannel.length < maxAnchors) {
    const seedFilePaths: string[] = [];
    for (const anchor of anchorChannel) {
      if (anchor.type === "File" && anchor.id.startsWith("file:")) {
        seedFilePaths.push(anchor.id.slice("file:".length));
      } else if (anchor.type === "Symbol") {
        const fp = extractFileFromSymbolId(anchor.id);
        if (fp) seedFilePaths.push(fp);
      }
    }

    // 5a: Same-file symbol boosting — add symbols from anchored files
    if (seedFilePaths.length > 0 && snapshotNodes) {
      for (const node of snapshotNodes) {
        if (added.has(node.id) || anchorChannel.length >= maxAnchors) continue;
        if (node.type !== "Symbol") continue;
        const nodeFile = extractFileFromSymbolId(node.id);
        if (!nodeFile) continue;
        const inSeedFile = seedFilePaths.some(sp =>
          nodeFile.includes(sp.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "")) ||
          sp.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, "").includes(nodeFile.replace(/\.(ts|tsx|js|jsx|py|go|rs)$/, ""))
        );
        if (!inSeedFile) continue;
        const layer = classifyLayer(node);
        const summary = `${node.type}: ${node.content}`;
        const estimate = estimateTokens(summary);
        if (tokens + estimate > maxTokens) { truncated = true; break; }
        summaryChannel.push(summary);
        anchorChannel.push({ id: node.id, type: node.type, layer });
        added.add(node.id);
        tokens += estimate;
        markLayerUsed(layer, used);
      }
    }

    // 5b: Import-based expansion
    if (seedFilePaths.length > 0 && anchorChannel.length < maxAnchors) {
      const importHits = await collectImportRelatedFiles(client, seedFilePaths, 5);
      for (const node of importHits) {
        if (added.has(node.id) || anchorChannel.length >= maxAnchors) continue;
        const layer = classifyLayer(node);
        const summary = `${node.type}: ${node.content}`;
        const estimate = estimateTokens(summary);
        if (tokens + estimate > maxTokens) { truncated = true; break; }
        summaryChannel.push(summary);
        anchorChannel.push({ id: node.id, type: node.type, layer });
        added.add(node.id);
        tokens += estimate;
        markLayerUsed(layer, used);
      }
    }
  }

  // Step 6: Edge expansion (respects anchor cap).
  const enableExpansion = options?.enableEdgeExpansion !== false;
  if (enableExpansion && !truncated && anchorChannel.length < maxAnchors && typeof client.getNeighbors === "function") {
    const seedIds = anchorChannel.slice(0, 5).map((a) => a.id);
    if (seedIds.length > 0) {
      const expanded = await expandSubgraph(client, seedIds, { hops: 1 });
      for (const node of expanded) {
        if (added.has(node.id) || anchorChannel.length >= maxAnchors) continue;
        const layer = classifyLayer(node);
        if (!canUseLayer(layer, quota, used)) continue;
        const summary = `${node.type}: ${node.content}`;
        const estimate = estimateTokens(summary);
        if (tokens + estimate > maxTokens) { truncated = true; break; }
        summaryChannel.push(summary);
        anchorChannel.push({ id: node.id, type: node.type, layer });
        added.add(node.id);
        tokens += estimate;
        markLayerUsed(layer, used);
      }
    }
  }

  return { summaryChannel, anchorChannel, tokenEstimate: tokens, truncated };
}