import { logger } from "../utils/logger.js";
import type { GraphNode } from "../core/types.js";
import {
  extractConnectedSubgraph,
  computePageRank,
  blendWithCentrality,
} from "./graph-compression.js";
import { computeAnchorRelevance } from "./graph-search.js";
import { buildRepoMap, formatRepoMapString } from "./repo-map.js";
import { estimateContextBudget } from "./adaptive-budget.js";
import { extractSymbolCandidates, fetchSymbolCandidates } from "./symbol-extract.js";
import { estimateTokens } from "./context-slicer-utils.js";
import { isHashFingerprint, reciprocalRankFusion } from "../learning/embeddings.js";
import type { GraphClient } from "./client-factory.js";
import type {
  ContextRefillManagerOptions,
  ContextRefillManager,
  LayeredContextPackage,
  LayeredPackageOptions,
  RefillCostWeights,
  RefillStageChoice,
} from "./context-slicer-types.js";
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
  injectSymbolBodies,
  isPinnedL3Node,
  packPrimaryHits,
  preparePackageHits,
  toLayeredPackage,
  vectorRecall,
} from "./context-package-core.js";
import { routeLayeredOptions } from "./query-router.js";
import { rerankTopHitsForPackage } from "./rerank.js";

// Re-export all public types and constants from sub-modules
export type {
  ContextSlice,
  ContextLayer,
  ContextAnchorItem,
  LayeredContextPackage,
  LayeredPackageOptions,
  SubgraphExpansionOptions,
  ContextRefillManager,
  ContextRefillManagerOptions,
  RefillCostWeights,
  RefillStageChoice,
  L3PinKind,
} from "./context-slicer-types.js";
export { classifyQueryIntent, routeLayeredOptions, INTENT_ROUTE_CONFIDENCE_THRESHOLD, MODULE_OVERVIEW_L2_QUOTA_FLOOR, boostL2Quota } from "./query-router.js";
export type { QueryIntent, QueryIntentClassification } from "./query-router.js";
export { rerankHitsByEmbedding, rerankTopHitsForPackage, isRerankProviderUsable, RERANK_POOL_LIMIT } from "./rerank.js";
export type { RerankEmbeddingProvider, RerankOptions } from "./rerank.js";
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
  CANDIDATE_MAX_SYMBOLS_PER_FILE,
} from "./hit-diversify.js";

/**
 * Attach normalized query relevance (`computeAnchorRelevance`) to every
 * anchor whose node can be resolved from the ranked hit list or the client
 * snapshot. Pure annotation: never reorders, drops, or re-sizes the channel;
 * anchors that resolve through neither source keep `relevance` undefined
 * and are ignored by the low-relevance trigger.
 */
function annotateAnchorRelevance(
  pkg: LayeredContextPackage,
  query: string,
  englishQuery: string | undefined,
  nodes: readonly GraphNode[]
): LayeredContextPackage {
  if (pkg.anchorChannel.length === 0) {
    return pkg;
  }
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node?.id && !byId.has(node.id)) {
      byId.set(node.id, node);
    }
  }
  if (byId.size === 0) {
    return pkg;
  }
  const anchorChannel = pkg.anchorChannel.map((anchor) => {
    const node = byId.get(anchor.id);
    return node
      ? { ...anchor, relevance: computeAnchorRelevance(node, query, englishQuery) }
      : anchor;
  });
  return { ...pkg, anchorChannel };
}

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
  // Query-intent routing (LightRAG dual-level analog, `src/graph/query-router.ts`):
  // sets retrieval knobs the caller did NOT provide when the classified intent
  // is confident (>= 0.6). Low-confidence / general / symbol queries — and any
  // knob set explicitly by the caller — keep exactly today's options.
  const opts = routeLayeredOptions(query, options?.englishQuery, options);
  const keywordHits = await collectKeywordHits(client, query, opts);
  let hits = keywordHits;
  const fused = await fuseVectorRecallIfEnabled(
    client,
    query,
    keywordHits,
    opts,
    "buildLayeredContextPackage"
  );
  if (fused) {
    hits = fused;
  }

  // Opt-in embedding rerank: AFTER vector fusion, BEFORE hit packaging. The
  // stage self-skips (list unchanged) without a usable non-hash provider, so
  // the default (enableRerank unset) is byte-identical to the legacy pack.
  if (opts?.enableRerank === true) {
    hits = await rerankTopHitsForPackage(hits, query, opts.embeddingProvider);
  }

  const snapshotNodes = client.readSnapshot?.()?.nodes;
  hits = preparePackageHits(hits, query, opts, snapshotNodes);

  const state = createPackState(maxTokens, opts);
  const budget = { tokens: 0, truncated: false };
  packPrimaryHits(hits, state, budget);
  await injectL2Modules(client, hits, state, budget, "continue");
  await injectL3SkillsAndPins(client, query, opts, snapshotNodes, state, budget);
  await injectNeighborExpansion(client, opts, state, budget);
  // Symbol bodies spend only what the anchor stages left behind (see the
  // invariant on the dialogue call below).
  injectSymbolBodies(state, budget);
  // Dialogue is additive-LAST and shares this one budget object: it may only use
  // budget left over after every code-anchor stage, so a recalled conversation
  // turn can never displace a Symbol/File anchor (the documented invariant).
  await injectDialogueTurns(client, query, opts, state, budget);
  return annotateAnchorRelevance(
    toLayeredPackage(state, budget),
    query,
    opts?.englishQuery,
    [...hits, ...(snapshotNodes ?? [])]
  );
}

/** Vector-recall knobs for refill ladder stage 2. */
const REFILL_VECTOR_TOP_K = 5;
const REFILL_VECTOR_MIN_SIMILARITY = 0.05;

/** Default per-stage cost multipliers (see `RefillCostWeights`). */
const DEFAULT_REFILL_COST_WEIGHTS: RefillCostWeights = { lexical: 1, vector: 2, file: 4 };

/**
 * Refill escalation ladder with token costs. Per hint, cheapest stage first:
 *
 *   stage 1 "lexical" — keyword hits via `queryByKeyword` (the legacy behavior,
 *                       first UNSEEN hit per hint; weight 1 = exact legacy cost)
 *   stage 2 "vector"  — embed the hint and vector-recall the snapshot's
 *                       embedded nodes. Skipped when no embeddingProvider was
 *                       supplied or its fingerprint is missing/hash-like.
 *   stage 3 "file"    — the hint resolves to a File node (path match); return
 *                       its `file:` anchor line. Most expensive per token.
 *
 * A stage only escalates when the previous stage found NO unseen hit. The
 * charged cost of a committed line is `estimateTokens(line) * costWeight(stage)`
 * and is tracked cumulatively across `refill()` calls against `maxTokens` —
 * a hint whose candidate does not fit the remaining budget stops the whole
 * refill (the legacy early-return), never exceeding the cap.
 *
 * Deterministic: hints in input order, keyword hits in store order, vector
 * hits in similarity order (id tie-break), file matches by ascending node id.
 * Failure-safe per stage: any stage error skips to the next stage, never throws.
 */
export function createContextRefillManager(
  client: GraphClient,
  maxTokens: number,
  options?: LayeredPackageOptions,
  refillOptions?: ContextRefillManagerOptions
): ContextRefillManager {
  const seenAnchors = new Set<string>();
  const costWeights: RefillCostWeights = {
    lexical: refillOptions?.costWeights?.lexical ?? DEFAULT_REFILL_COST_WEIGHTS.lexical,
    vector: refillOptions?.costWeights?.vector ?? DEFAULT_REFILL_COST_WEIGHTS.vector,
    file: refillOptions?.costWeights?.file ?? DEFAULT_REFILL_COST_WEIGHTS.file,
  };
  // Cumulative refill spend across refill() calls (the legacy loop restarted
  // its counter per call; the ladder makes the cap hold for the manager's life).
  let spentTokens = 0;
  let lastStages: RefillStageChoice[] = [];

  const vectorProvider = refillOptions?.embeddingProvider;
  const vectorProviderUsable = (() => {
    if (!vectorProvider || typeof vectorProvider.embed !== "function") return false;
    const fingerprint = vectorProvider.fingerprint?.();
    return typeof fingerprint === "string" && fingerprint.length > 0 && !isHashFingerprint(fingerprint);
  })();

  /** Stage 2: first unseen vector hit for the hint, or null (skip/failure-safe). */
  const findVectorHit = async (hint: string): Promise<GraphNode | null> => {
    if (!vectorProviderUsable || !vectorProvider) return null;
    let hintEmbedding: number[];
    try {
      hintEmbedding = await vectorProvider.embed(hint);
    } catch {
      return null;
    }
    if (!hintEmbedding || hintEmbedding.length === 0) return null;
    const nodes = client.readSnapshot?.()?.nodes ?? [];
    const ranked = vectorRecall(nodes, hintEmbedding, REFILL_VECTOR_TOP_K, REFILL_VECTOR_MIN_SIMILARITY);
    for (const hit of ranked) {
      if (!seenAnchors.has(hit.id)) return hit;
    }
    return null;
  };

  /**
   * Stage 3: the lowest-id unseen File node whose path contains the (normalized)
   * hint text — e.g. hint "src/graph/bm25.ts" resolves `file:src/graph/bm25.ts`.
   */
  const findFileHit = (hint: string): GraphNode | null => {
    const normalized = hint
      .trim()
      .replace(/^["'`]|["'`]$/g, "")
      .replace(/\\/g, "/")
      .toLowerCase();
    const pathHint = normalized.startsWith("file:") ? normalized.slice("file:".length) : normalized;
    if (pathHint.length < 3) return null;
    const snapshot = client.readSnapshot?.();
    if (!snapshot) return null;
    const candidates = snapshot.nodes
      .filter(
        (node) =>
          node.type === "File" &&
          !seenAnchors.has(node.id) &&
          node.id.replace(/\\/g, "/").toLowerCase().includes(pathHint)
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    return candidates[0] ?? null;
  };

  return {
    async initialPackage(query: string): Promise<LayeredContextPackage> {
      const pkg = await buildLayeredContextPackage(client, query, maxTokens, options);
      for (const anchor of pkg.anchorChannel) {
        seenAnchors.add(anchor.id);
      }
      return pkg;
    },
    seed(anchorIds: Iterable<string>): void {
      for (const id of anchorIds) {
        seenAnchors.add(id);
      }
    },
    async refill(evidenceHints: string[]): Promise<string[]> {
      const items: string[] = [];
      const stages: RefillStageChoice[] = [];

      const commit = (
        hint: string,
        stage: "lexical" | "vector" | "file",
        hit: GraphNode
      ): boolean => {
        const line = `${hit.id} | ${hit.type}: ${hit.content}`;
        const cost = estimateTokens(line) * costWeights[stage];
        if (spentTokens + cost > maxTokens) {
          return false; // budget stop — same early-return semantics as the legacy loop
        }
        seenAnchors.add(hit.id);
        spentTokens += cost;
        items.push(line);
        stages.push({ hint, stage, anchorId: hit.id, tokens: cost });
        return true;
      };

      hintLoop: for (const hint of evidenceHints) {
        // Stage 1 — lexical keyword hits (cheap; legacy behavior). Failure-safe:
        // a throwing keyword backend degrades to "no lexical hit" and the
        // ladder escalates instead of rejecting the whole refill.
        let hits: GraphNode[] = [];
        try {
          hits = await client.queryByKeyword(hint);
        } catch {
          hits = [];
        }
        for (const hit of hits) {
          if (seenAnchors.has(hit.id)) continue;
          if (commit(hint, "lexical", hit)) {
            continue hintLoop; // one unseen hit per hint, as before
          }
          break hintLoop; // budget exhausted
        }

        // Stage 2 — vector recall on the hint (skipped without a usable provider).
        const vectorHit = await findVectorHit(hint);
        if (vectorHit) {
          if (commit(hint, "vector", vectorHit)) continue hintLoop;
          break hintLoop;
        }

        // Stage 3 — File-node anchor for a path-like hint (most expensive).
        const fileHit = findFileHit(hint);
        if (fileHit) {
          if (commit(hint, "file", fileHit)) continue hintLoop;
          break hintLoop;
        }

        stages.push({ hint, stage: "none", tokens: 0 });
      }

      lastStages = stages;
      return items;
    },
    get lastStages(): readonly RefillStageChoice[] {
      return lastStages;
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
 *   4. Layer quotas + token budgeting (L3 = skills/pins AND dialogue turns)
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
  // Query-intent routing (LightRAG dual-level analog): may set retrieval knobs
  // the caller left unset when intent confidence >= 0.6 ("impact" → ppr
  // expansion, "module-overview" → boosted L2 quota); otherwise returns the
  // caller's options untouched. See `src/graph/query-router.ts`.
  const opts = routeLayeredOptions(query, options?.englishQuery, options);

  // Step 0: Adaptive budget estimation.
  if (opts?.taskMode) {
    const estimate = estimateContextBudget(task, opts.taskMode);
    maxTokens = estimate.tokens;
    logger.debug({ estimate }, "Adaptive budget estimated");
  }

  // Step 1: RepoMap fallback for tight budgets.
  if (opts?.enableRepoMapFallback && maxTokens < 1000) {
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
  const keywordHits = await collectKeywordHits(client, query, opts);
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
    opts,
    "buildEnhancedContextPackage"
  );
  if (fused) {
    hits = fused;
  }

  if (opts?.enableGraphCompression && hits.length > 0) {
    try {
      const ranked = await extractConnectedSubgraph(client, hits, opts.graphCompressionOptions);
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

  // Opt-in embedding rerank: AFTER vector fusion / graph compression, BEFORE
  // hit packaging. Self-skips without a usable non-hash provider; the default
  // (enableRerank unset) keeps the legacy pack byte-identical.
  if (opts?.enableRerank === true) {
    hits = await rerankTopHitsForPackage(hits, query, opts.embeddingProvider);
  }

  const snapshotNodes = client.readSnapshot?.()?.nodes;
  hits = preparePackageHits(hits, query, opts, snapshotNodes);

  const maxAnchors = opts?.maxAnchors ?? 15;
  const state = createPackState(maxTokens, opts, maxAnchors);
  const budget = { tokens: 0, truncated: false };
  packPrimaryHits(hits, state, budget);
  await injectL2Modules(client, hits, state, budget, "break");
  await injectL3SkillsAndPins(client, query, opts, snapshotNodes, state, budget);
  await injectSameFileAndImportExpansion(client, snapshotNodes, state, budget);
  await injectNeighborExpansion(client, opts, state, budget);
  injectSymbolBodies(state, budget);
  // Same additive-LAST rule as the layered packer (see above): dialogue turns
  // ride on leftover budget and cannot push a code anchor out of the package.
  await injectDialogueTurns(client, query, opts, state, budget);
  return annotateAnchorRelevance(
    toLayeredPackage(state, budget),
    query,
    opts?.englishQuery,
    [...hits, ...(snapshotNodes ?? [])]
  );
}
