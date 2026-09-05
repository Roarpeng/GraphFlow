import { logger } from "../utils/logger.js";
import {
  extractConnectedSubgraph,
  computePageRank,
  blendWithCentrality,
} from "./graph-compression.js";
import { buildRepoMap, formatRepoMapString } from "./repo-map.js";
import { estimateContextBudget } from "./adaptive-budget.js";
import { extractSymbolCandidates, fetchSymbolCandidates } from "./symbol-extract.js";
import { estimateTokens } from "./context-slicer-utils.js";
import { reciprocalRankFusion } from "../learning/embeddings.js";
import type { GraphClient } from "./client-factory.js";
import type { LayeredContextPackage, LayeredPackageOptions } from "./context-slicer-types.js";
import {
  collectKeywordHits,
  createPackState,
  expandSubgraph,
  fuseVectorRecallIfEnabled,
  injectDialogueTurns,
  injectL2Modules,
  injectL3SkillsAndPins,
  injectNeighborExpansion,
  injectSameFileAndImportExpansion,
  isPinnedL3Node,
  packPrimaryHits,
  preparePackageHits,
  toLayeredPackage,
  vectorRecall,
} from "./context-package-core.js";

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

export { isPinnedL3Node, expandSubgraph, vectorRecall };

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

export async function buildContextSlice(
  client: GraphClient,
  query: string,
  maxTokens: number
): Promise<import("./context-slicer-types.js").ContextSlice> {
  const pkg = await buildLayeredContextPackage(client, query, maxTokens);
  return { items: pkg.summaryChannel, tokenEstimate: pkg.tokenEstimate };
}

export async function buildLayeredContextPackage(
  client: GraphClient,
  query: string,
  maxTokens: number,
  options?: LayeredPackageOptions
): Promise<LayeredContextPackage> {
  const keywordHits = await collectKeywordHits(client, query, options);
  let hits = keywordHits;
  const fused = await fuseVectorRecallIfEnabled(
    client,
    query,
    keywordHits,
    options,
    "buildLayeredContextPackage"
  );
  if (fused) {
    hits = fused;
  }

  const snapshotNodes = client.readSnapshot?.()?.nodes;
  hits = preparePackageHits(hits, query, options, snapshotNodes);

  const state = createPackState(maxTokens, options);
  const budget = { tokens: 0, truncated: false };
  packPrimaryHits(hits, state, budget);
  await injectL2Modules(client, hits, state, budget, "continue");
  await injectL3SkillsAndPins(client, query, options, snapshotNodes, state, budget);
  await injectDialogueTurns(client, query, options, state, budget);
  await injectNeighborExpansion(client, options, state, budget);
  return toLayeredPackage(state, budget);
}

export function createContextRefillManager(
  client: GraphClient,
  maxTokens: number,
  options?: LayeredPackageOptions
): import("./context-slicer-types.js").ContextRefillManager {
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
 *
 * Shared recall/pack steps live in `context-package-core` (same as layered).
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
  const keywordHits = await collectKeywordHits(client, query, options);
  let hits = keywordHits;

  // Step 2b: Symbol-aware boosting — extract camelCase/PascalCase tokens from
  // the task description and fetch matching symbol nodes to improve recall.
  const symbolCandidates = extractSymbolCandidates(task);
  if (symbolCandidates.length > 0) {
    const symbolHits = await fetchSymbolCandidates(client, symbolCandidates, 8);
    if (symbolHits.length > 0) {
      hits = reciprocalRankFusion([hits, symbolHits]);
    }
  }

  const fused = await fuseVectorRecallIfEnabled(
    client,
    query,
    keywordHits,
    options,
    "buildEnhancedContextPackage"
  );
  if (fused) {
    hits = fused;
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
  hits = preparePackageHits(hits, query, options, snapshotNodes);

  const maxAnchors = options?.maxAnchors ?? 15;
  const state = createPackState(maxTokens, options, maxAnchors);
  const budget = { tokens: 0, truncated: false };
  packPrimaryHits(hits, state, budget);
  await injectL2Modules(client, hits, state, budget, "break");
  await injectL3SkillsAndPins(client, query, options, snapshotNodes, state, budget);
  await injectSameFileAndImportExpansion(client, snapshotNodes, state, budget);
  await injectNeighborExpansion(client, options, state, budget);
  return toLayeredPackage(state, budget);
}
