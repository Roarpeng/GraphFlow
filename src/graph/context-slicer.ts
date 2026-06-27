import { logger } from "../utils/logger.js";
import type { GraphNode } from "../core/types.js";
import {
  cosineSimilarity,
  extractEmbedding,
  reciprocalRankFusion,
} from "../learning/embeddings.js";
import type { GraphClient } from "./client-factory.js";
import { rankNodesForContextQuery } from "./graph-utils.js";
import {
  extractConnectedSubgraph,
  computePageRank,
  blendWithCentrality,
} from "./graph-compression.js";
import { buildRepoMap, formatRepoMapString } from "./repo-map.js";
import {
  applySemanticCompression,
} from "./semantic-compression.js";
import { estimateContextBudget } from "./adaptive-budget.js";

// Re-export all public types and constants from sub-modules
export type {
  ContextSlice,
  ContextLayer,
  ContextAnchorItem,
  LayeredContextPackage,
  LayeredPackageOptions,
  SubgraphExpansionOptions,
  ContextRefillManager,
} from "./context-slicer-types.js";
export {
  DEFAULT_EXPANSION_RELATIONS,
  ARCHITECTURE_QUERY,
} from "./context-slicer-types.js";

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

// Import internal helpers (not re-exported)
import {
  estimateTokens,
  classifyLayer,
  canUseLayer,
  markLayerUsed,
  deriveModuleId,
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

export async function buildLayeredContextPackage(
  client: GraphClient,
  query: string,
  maxTokens: number,
  options?: LayeredPackageOptions
): Promise<LayeredContextPackage> {
  const keywordHits = rankNodesForContextQuery(await client.queryByKeyword(query), query);
  let hits: GraphNode[] = keywordHits;

  if (options?.enableVectorRecall === true && options.embeddingProvider) {
    try {
      const queryEmbedding = await options.embeddingProvider.embed(query);
      const topK = options.vectorTopK ?? 8;
      const minSim = options.vectorMinSimilarity ?? 0.05;
      const vectorHits = vectorRecall(keywordHits, queryEmbedding, topK, minSim);
      hits = reciprocalRankFusion([keywordHits, vectorHits]);
    } catch (error) {
    logger.error({ error }, "Caught error");
      hits = keywordHits;
    }
  }

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

  if (!truncated && ARCHITECTURE_QUERY.test(query)) {
    const l3Candidates = rankNodesForContextQuery(
      (await client.queryByKeyword(query)).filter(
        (n) => n.type === "Skill" || n.type === "Decision"
      ),
      query
    );
    let l3Added = 0;
    for (const node of l3Candidates) {
      if (l3Added >= 2) break;
      if (added.has(node.id)) continue;
      if (!canUseLayer("L3", quota, used)) break;

      const summary = `${node.type}: ${node.content}`;
      const estimate = estimateTokens(summary);
      if (tokens + estimate > maxTokens) {
        truncated = true;
        break;
      }

      summaryChannel.push(summary);
      anchorChannel.push({ id: node.id, type: node.type, layer: "L3" });
      added.add(node.id);
      tokens += estimate;
      markLayerUsed("L3", used);
      l3Added += 1;
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
 * Enhanced context packaging with graph-structure compression, semantic
 * compression (minicpm-1b), and adaptive budgeting.
 *
 * Compression pipeline:
 *   1. [Optional] RepoMap fallback for low budgets
 *   2. Keyword + vector retrieval (existing)
 *   3. Graph compression: connected subgraph + PageRank re-ranking
 *   4. Semantic compression: cluster similar nodes, summarize, densify
 *   5. Layer quotas + token budgeting (existing)
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
    logger.info({ estimate }, "Adaptive budget estimated");
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

  // Step 2: Keyword + vector retrieval (existing logic).
  const keywordHits = rankNodesForContextQuery(await client.queryByKeyword(query), query);
  let hits: GraphNode[] = keywordHits;

  if (options?.enableVectorRecall === true && options.embeddingProvider) {
    try {
      const queryEmbedding = await options.embeddingProvider.embed(query);
      const topK = options.vectorTopK ?? 8;
      const minSim = options.vectorMinSimilarity ?? 0.05;

      let vectorHits: GraphNode[];
      // For large candidate sets, use HNSW ANN index (10-100x faster).
      if (options.enableHnsw !== false && keywordHits.length >= 200) {
        const { HnswVectorIndex } = await import("../learning/hnsw-index.js");
        const index = new HnswVectorIndex({ space: "cosine" });
        index.load(keywordHits);
        const results = await index.search(queryEmbedding, topK, minSim);
        vectorHits = results.map((r) => r.node);
        logger.info({ backend: index.backend, candidates: keywordHits.length }, "Vector recall via HNSW");
      } else {
        vectorHits = vectorRecall(keywordHits, queryEmbedding, topK, minSim);
      }
      hits = reciprocalRankFusion([keywordHits, vectorHits]);
    } catch (error) {
      logger.error({ error }, "Vector recall failed");
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

  // Step 4: Semantic compression - cluster + summarize + densify.
  if (options?.enableSemanticCompression) {
    try {
      hits = await applySemanticCompression(hits, {
        ...(options.clusteringOptions ? { clusteringOptions: options.clusteringOptions } : {}),
        ...(options.summarizerOptions ? { summarizerOptions: options.summarizerOptions } : {}),
        ...(options.densifierOptions ? { densifierOptions: options.densifierOptions } : {}),
        ...(options.compressionModel ? { modelHandle: options.compressionModel } : {}),
      });
    } catch (error) {
      logger.warn({ error }, "Semantic compression failed, using uncompressed hits");
    }
  }

  // Step 5: Build layered package (existing logic).
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

  for (const hit of hits) {
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

  // Step 6: Edge expansion (existing logic).
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