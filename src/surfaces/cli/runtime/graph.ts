import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isUnsafeWorkspaceFallback } from "../../../config/discover-workspace.js";
import { resolveConfig, resolveEfficiencyPolicy, type ResolvedContextPressurePolicy } from "../../../config/resolve";
import { resolveGraphStorePath } from "../../../config/paths";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import type { GraphEdge, GraphNode } from "../../../core/types";
import { createGraphClient, type GraphClient } from "../../../graph/client-factory";
import { GraphifyMcpClient } from "../../../graph/graphify-mcp-client";
import {
  createContextRefillManager,
} from "../../../graph/context-slicer";
import {
  buildCompactionSignal,
  deriveAdaptiveBudget,
  toContextPressure,
  type ContextPressure,
  type ObservedContextUsage,
} from "../../../graph/context-pressure";
import { indexWorkspaceFiles, clearGraphIndexArtifacts, hasPendingGraphIndexWork, indexSingleFile } from "../../../graph/file-indexer";
import { GraphFileWatcher } from "../../../graph/file-watcher.js";
import { extractNodeSourcePath } from "../../../graph/graph-utils";
import { searchDialogueTurns, type DialogueHitPreview, type DialogueSearchHit } from "../../../graph/graph-search";
import { sampleGraphForSnapshot } from "../../../graph/snapshot-view.js";
import {
  explainSavings,
  getContextFidelityStats,
  getSavingsStats,
  recordSavings,
  resetSavingsStats,
  SAVINGS_NOT_FIDELITY_NOTE,
  type SavingsStats,
} from "../../../graph/token-savings.js";
import {
  isAutoCaptureEnabled,
  readJournalEntries,
  resolveSessionJournalPath,
} from "../../../hooks/auto-capture.js";
import type { SkillOutcomeKind } from "../../../learning/skill-types.js";
import {
  planSkillConsolidation,
  toConsolidateResult,
  type ConsolidateSkillInput,
} from "../../../learning/skill-consolidate.js";
import { parseSkillState } from "../../../learning/skill-store.js";
import { logger } from "../../../utils/logger.js";
import {
  clip,
  formatDialogueThreadLines,
  isDialogueTurnNode,
  loadDialogueThread,
  MAX_ECHO_TURN_CHARS,
  normalizedLength,
  parseDialogueTurn,
  recordDialogueTurn,
  scoreTopicOverlap,
  toDialogueThreadEchoView,
} from "../../../learning/dialogue-thread.js";
import {
  appendTopicMessage,
  buildWorkbenchOutlines,
  formatWorkbenchOutlineLines,
  isWorkbenchTopicNode,
  loadWorkbenchContext,
  loadWorkbenchOutlines,
  parseWorkbenchTopic,
  toWorkbenchEchoView,
  topicPendingReply,
  workbenchRootIdFor,
} from "../../../learning/workbench-topic.js";
import { buildEmbeddingOptions } from "./env.js";
import { applyResponseBudget } from "./response-budget.js";
import { graphStoreDeltaPath } from "../../../graph/graphify-file-client.js";
import {
  calculateBudgetUsedPercent,
  calculateSavingsPercent,
  estimateRawContextTokens,
  estimateTokenCount,
  loadGraphStore,
  parseSkillInsight,
  resolveGraphStoreAfterIndex,
  withGrepBaselineBudget,
} from "./helpers.js";
import type {
  CaptureAssistantReplyResult,
  ContextFidelityMetrics,
  ContextPreviewResult,
  ExpandAnchorResult,
  GraphIndexResult,
  GraphRebuildResult,
  GraphSnapshotResult,
  PreviewDialogueOptions,
  SkillInsightItem,
  SkillInsightsResult,
} from "./types.js";
import type { GraphFlowConfig } from "../../../config/schema";
import {
  anchorRelevanceQuality,
  buildQueryTranslateInstructions,
  buildQueryTranslateWorkItem,
  QUERY_TRANSLATE_HIT_THRESHOLD,
  QUERY_TRANSLATE_LOW_RELEVANCE_THRESHOLD,
  QUERY_TRANSLATE_RELEVANCE_TOP_K_DELIVERED,
  shouldDelegateQueryTranslation,
} from "../../../graph/query-translate.js";

function emptySkillOutcomeKindCounts(): Record<SkillOutcomeKind, number> {
  return { proven: 0, correctable: 0, "anti-pattern": 0, noise: 0 };
}

/** Read outcomeKind from a Skill node content blob (atomic or composite). */
function readSkillOutcomeKind(content: string): SkillOutcomeKind | undefined {
  try {
    const parsed = JSON.parse(content) as { outcomeKind?: unknown };
    if (
      parsed.outcomeKind === "proven" ||
      parsed.outcomeKind === "correctable" ||
      parsed.outcomeKind === "anti-pattern" ||
      parsed.outcomeKind === "noise"
    ) {
      return parsed.outcomeKind;
    }
  } catch {
    // ignore malformed skill payloads
  }
  return undefined;
}

function graphStoreNeedsIndexing(config: GraphFlowConfig): boolean {
  const storePath = resolveGraphStorePath(config);
  if (config.graphPolicy.transport === "auto" && !existsSync(storePath)) {
    // Auto transport may have fallen back to the JSON store on this machine.
    const fallbackPath = storePath.replace(/\.sqlite$/i, ".json");
    if (existsSync(fallbackPath)) {
      try {
        const parsed = JSON.parse(readFileSync(fallbackPath, "utf8")) as { nodes?: Array<{ type?: string }> };
        return !Array.isArray(parsed.nodes) || !storeHasCodeNodes(parsed.nodes);
      } catch {
        return true;
      }
    }
    return true;
  }
  const deltaPath = graphStoreDeltaPath(storePath);
  if (!existsSync(storePath)) {
    // A delta-only state still means there is graph data to read.
    return !existsSync(deltaPath);
  }
  if (config.graphPolicy.transport === "sqlite" || config.graphPolicy.transport === "auto") {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { nodes?: Array<{ type?: string }> };
    return !Array.isArray(parsed.nodes) || !storeHasCodeNodes(parsed.nodes);
  } catch {
    return true;
  }
}

/**
 * A store whose only nodes are dialogue turns / episodes / skills is NOT an
 * indexed workspace: auto-index previously saw a non-empty node list and
 * skipped indexing forever, so code anchors never appeared while conversation
 * nodes kept the store alive (live finding: preview returned dialogue-only
 * anchors because the file store had one recorded turn).
 */
function storeHasCodeNodes(nodes: Array<{ type?: string }>): boolean {
  return nodes.some((node) => node?.type === "File" || node?.type === "Symbol" || node?.type === "Module");
}

/**
 * 打包后追加负载的 token 记账 / Post-packaging token accounting.
 *
 * The layered package computes its token budget BEFORE dialogue recall lines,
 * workbench prompt lines, or the dialogue-thread spine are prepended to
 * `summary`, and BEFORE `dialogueHits` ride alongside the package. Without
 * this accounting the reported budget systematically under-reports the real
 * payload sent to the agent, and the persisted ROI stats in
 * `graphflow-out/token-savings.json` stay optimistically wrong. The helpers
 * below are pure so the shared context cache (which stores pre-attach
 * results and re-attaches on every call) is never mutated.
 */

/** Token cost of summary lines prepended after the package budget was computed. */
export function estimateSummaryLinesTokens(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + estimateTokenCount(line), 0);
}

/**
 * Token cost of additive payloads that ride OUTSIDE the layered L1-L3 package
 * (currently `dialogueHits`). Each payload is measured as the JSON the MCP
 * transport actually sends, using the same estimator as the layered package.
 */
export function estimateUnbudgetedPayloadTokens(payloads: readonly unknown[]): number {
  return payloads.reduce<number>(
    (total, payload) => total + estimateTokenCount(JSON.stringify(payload)),
    0
  );
}

/**
 * Fold one post-packaging addition into the preview result's token accounting:
 *
 * - `prependedLines` join `summary` (as dialogue recall / workbench / spine
 *   lines do): budgeted — added to `tokenEstimate` and
 *   `tokenBudget.compressedTokens`, reflected in `budgetUsedPercent`.
 * - `unbudgetedTokens` is additive payload the layer quota does not govern
 *   (e.g. `dialogueHits`): reported in `unbudgetedTokens`, never silently
 *   folded into the L1-L3 budget.
 * - `estimatedSavingsPercent` is recomputed against the TRUE accounted total
 *   (budgeted + unbudgeted), `estimatedRawTokens` keeps its floor semantics
 *   (raw is never below what is actually sent), and `accountedTokens` exposes
 *   the true total. New fields stay omitted (exactOptionalPropertyTypes)
 *   until an addition is actually accounted.
 *
 * Pure: returns a new result; the input is returned unchanged when there is
 * nothing to account.
 * 纯函数：不修改入参（上下文缓存保存的是 attach 前的结果，每次调用重新记账）。
 */
export function withPostPackageAccounting(
  result: ContextPreviewResult,
  prependedLines: readonly string[],
  unbudgetedTokens: number
): ContextPreviewResult {
  const lineTokens = estimateSummaryLinesTokens(prependedLines);
  const addedUnbudgeted = Math.max(0, unbudgetedTokens);
  if (lineTokens === 0 && addedUnbudgeted === 0) {
    return result;
  }
  const compressedTokens = result.tokenBudget.compressedTokens + lineTokens;
  const unbudgeted = (result.unbudgetedTokens ?? 0) + addedUnbudgeted;
  const accountedTokens = compressedTokens + unbudgeted;
  // 真实下发量不会低于 raw 估算：沿用 estimateRawContextTokens 的下限语义。
  const estimatedRawTokens = Math.max(result.tokenBudget.estimatedRawTokens, accountedTokens);
  return {
    ...result,
    ...(prependedLines.length > 0
      ? {
          summary: [...prependedLines, ...result.summary],
          summaryCount: result.summaryCount + prependedLines.length,
        }
      : {}),
    tokenEstimate: compressedTokens,
    tokenBudget: {
      ...result.tokenBudget,
      estimatedRawTokens,
      compressedTokens,
      estimatedSavingsPercent: calculateSavingsPercent(estimatedRawTokens, accountedTokens),
      budgetUsedPercent: calculateBudgetUsedPercent(
        compressedTokens,
        result.tokenBudget.maxContextTokens
      ),
    },
    ...(unbudgeted > 0 ? { unbudgetedTokens: unbudgeted } : {}),
    accountedTokens,
  };
}

/**
 * Build the context-pressure block (SoL-Pi "Online Context Compact" analog).
 * Enabled by default via efficiencyPolicy.contextPressure (explicit `false`
 * opts out), so every preview carries it. GraphFlow cannot call the host's
 * compaction API, so this is an advisory signal plus the effective budget
 * actually used for packaging. `compaction` is emitted only when the caller
 * supplies prefix tokens and a remaining-turn estimate — GraphFlow never
 * fabricates either.
 */
function buildContextPressureBlock(params: {
  policy: ResolvedContextPressurePolicy;
  usage?: ObservedContextUsage;
  pressure?: ContextPressure;
  effectiveMaxTokens: number;
  query: string;
}): NonNullable<ContextPreviewResult["contextPressure"]> {
  const { policy, usage, pressure, effectiveMaxTokens, query } = params;
  const block: NonNullable<ContextPreviewResult["contextPressure"]> = {
    enabled: true,
    budgetMode: policy.maxContextTokens === "auto" ? "auto" : "fixed",
    effectiveMaxContextTokens: effectiveMaxTokens,
  };
  if (!pressure) return block;

  block.usedTokens = pressure.usedTokens;
  block.maxTokens = pressure.maxTokens;
  block.pressureRatio = pressure.pressureRatio;

  const remaining = usage?.remainingTurnsEstimate;
  if (pressure.usedTokens > 0 && typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0) {
    block.compaction = buildCompactionSignal({
      boundaryLabel: `context preview: ${query.slice(0, 120)}`,
      continuationContext: query,
      prefixTokens: pressure.usedTokens,
      remainingTurnsEstimate: remaining,
      cacheWriteReadRatio: policy.cacheWriteReadRatio,
      windowPressure: pressure.pressureRatio,
      minSavingRatio: policy.minSavingRatio,
    });
  }
  return block;
}

/**
 * Index options derived from the resolved config. Kept in one place so every
 * indexing entry point (preview, index, single file, watcher) scans the same
 * file set and applies the same reference-edge budget.
 */
function buildIndexOptions(config: GraphFlowConfig): {
  includeExtensions?: string[];
  respectGitIgnore?: boolean;
  referenceEdgeMaxDefinitionFiles?: number;
  referenceEdgeMaxPerFile?: number;
  indexWorkers?: number;
} {
  const graphPolicy = config.graphPolicy;
  return {
    ...(graphPolicy.includeExtensions ? { includeExtensions: graphPolicy.includeExtensions } : {}),
    ...(graphPolicy.respectGitIgnore === false ? { respectGitIgnore: false } : {}),
    ...(typeof graphPolicy.referenceEdgeMaxDefinitionFiles === "number"
      ? { referenceEdgeMaxDefinitionFiles: graphPolicy.referenceEdgeMaxDefinitionFiles }
      : {}),
    ...(typeof graphPolicy.referenceEdgeMaxPerFile === "number"
      ? { referenceEdgeMaxPerFile: graphPolicy.referenceEdgeMaxPerFile }
      : {}),
    ...(typeof graphPolicy.indexWorkers === "number"
      ? { indexWorkers: graphPolicy.indexWorkers }
      : {}),
  };
}

export async function previewContext(
  query: string,
  configPath?: string,
  rootDir?: string,
  englishQuery?: string,
  dialogue?: PreviewDialogueOptions,
  contextPressure?: ObservedContextUsage
): Promise<ContextPreviewResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath, rootDir ? { rootDir } : undefined), rootDir ? { rootDir } : undefined);
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();

  // GF-3 / Online Context Compact: observed-pressure budget + compaction signal.
  // Enabled by default (efficiencyPolicy.contextPressure.enabled); an explicit
  // `false` disables it. When enabled, observed pressure overrides the global cap.
  const pressurePolicy = resolveEfficiencyPolicy(config).contextPressure;
  const observedPressure = pressurePolicy.enabled ? toContextPressure(contextPressure) : undefined;
  const effectiveMaxTokens = pressurePolicy.enabled
    ? deriveAdaptiveBudget({
        configuredMax: pressurePolicy.maxContextTokens,
        defaultMax: config.graphPolicy.maxContextTokens,
        ...(observedPressure ? { observed: observedPressure } : {}),
      })
    : config.graphPolicy.maxContextTokens;
  const pressureBlock = pressurePolicy.enabled
    ? buildContextPressureBlock({
        policy: pressurePolicy,
        ...(contextPressure ? { usage: contextPressure } : {}),
        ...(observedPressure ? { pressure: observedPressure } : {}),
        effectiveMaxTokens,
        query,
      })
    : undefined;

  const { getCachedContext, cacheContextResult } = await import("../../../graph/context-cache.js");
  // Observed pressure is per-call, so a cached package under a different budget
  // would be stale. Bypass the cache only when an observation actually changes
  // the budget; without one the effective budget is the configured default.
  const bypassCache = pressurePolicy.enabled && observedPressure !== undefined;
  const cached = bypassCache ? undefined : getCachedContext(query, workspaceRoot);
  const graphClient = createGraphClient(config);
  if (cached) {
    const attached = await attachWorkbenchThenDialogue(cached, graphClient, config, query, dialogue);
    // 响应硬预算：超限按序降级并重算记账，避免宿主在自身传输上限处截断。
    // Hard response budget: degrade in order so the host never truncates.
    const budgeted = applyResponseBudget(attached);
    return pressureBlock ? { ...budgeted, contextPressure: pressureBlock } : budgeted;
  }

  if (config.graphPolicy.autoIndexOnPreview) {
    const root = config.graphPolicy.workspaceRoot ?? process.cwd();
    const indexOptions = buildIndexOptions(config);
    if (hasPendingGraphIndexWork(root, indexOptions) || graphStoreNeedsIndexing(config)) {
      await indexWorkspaceFiles(graphClient, root, {
        ...indexOptions,
      });
    }
  }

  const packageOptions: import("../../../graph/context-slicer").LayeredPackageOptions = {
    ...(config.graphPolicy.layerQuota ? { layerQuota: config.graphPolicy.layerQuota } : {}),
    ...buildEmbeddingOptions(config),
    workspaceRoot: config.graphPolicy.workspaceRoot ?? process.cwd(),
    ...(englishQuery?.trim() ? { englishQuery: englishQuery.trim() } : {}),
    // Persist HNSW index to disk for faster startup on large repos.
    ...(config.embeddingPolicy?.vectorStorePath
      ? { hnswIndexPath: config.embeddingPolicy.vectorStorePath.replace(/\.\w+$/, ".hnsw") }
      : {}),
  };

  const compressionPolicy = config.graphPolicy.compression;

  // Graph-structure compression is zero-cost; enabled by default unless explicitly disabled.
  packageOptions.enableGraphCompression = compressionPolicy?.enableGraphCompression !== false;

  // RepoMap overview fallback for tight budgets (opt-in).
  if (compressionPolicy?.enableRepoMapFallback === true) {
    packageOptions.enableRepoMapFallback = true;
  }

  // Adaptive budget: auto-enable for complex tasks unless explicitly disabled.
  const { triageTask } = await import("../../../core/triage.js");
  const taskMode = triageTask(query);
  const enableAdaptiveBudget =
    compressionPolicy?.enableAdaptiveBudget !== false &&
    (compressionPolicy?.enableAdaptiveBudget === true || taskMode === "complex");
  // Observed-pressure budgeting (GF-3) owns the budget when enabled, so the
  // complexity-based taskMode estimate must not overwrite it.
  if (enableAdaptiveBudget && !pressurePolicy.enabled) {
    packageOptions.taskMode = taskMode;
  }

  // Semantic compression (minicpm/economy LLM) is opt-in via config.
  // Note: compression-model module removed; semantic compression disabled.

  const { buildEnhancedContextPackage } = await import("../../../graph/context-slicer.js");
  const pkg = await buildEnhancedContextPackage(
    graphClient,
    query,
    query,
    effectiveMaxTokens,
    packageOptions
  );

  const refill = createContextRefillManager(
    graphClient,
    effectiveMaxTokens,
    packageOptions
  );
  await refill.initialPackage(query);
  const refillPreview = await refill.refill([query]);

  const packedAnchorCount = pkg.anchorChannel.length;
  // anchorChannel carries per-anchor relevance; a CJK query whose anchor head
  // scores below QUERY_TRANSLATE_LOW_RELEVANCE_THRESHOLD delegates translation
  // even when the anchor count alone would have cleared the threshold.
  const queryTranslationDelegation = shouldDelegateQueryTranslation(
    query,
    packedAnchorCount,
    englishQuery,
    pkg.anchorChannel
  )
    ? {
        agentWorkItems: [buildQueryTranslateWorkItem(query, workspaceRoot)],
        agentInstructions: buildQueryTranslateInstructions(query),
        agentMode: "delegated-llm" as const,
      }
    : undefined;

  // CJK 低命中处置 / CJK low-hit handling: when translation delegation fired
  // via the LOW-RELEVANCE dimension (the count cleared the legacy threshold
  // but the anchor head shares almost no wording with the query), the packed
  // channel is dominated by zero-relevance filler from workspace-path
  // expansion. Delivering ~15 unrelated anchors as if they were results
  // wastes the caller's attention — trim the payload to anchors that actually
  // matched (relevance > 0, capped), align summary + accounting with what is
  // delivered, and say so on a spine line.
  let deliveredAnchors: ContextPreviewResult["anchors"] = pkg.anchorChannel;
  let deliveredSummary: string[] = pkg.summaryChannel;
  const packedQuality = anchorRelevanceQuality(pkg.anchorChannel);
  const lowRelevanceDelegation =
    queryTranslationDelegation !== undefined &&
    packedAnchorCount >= QUERY_TRANSLATE_HIT_THRESHOLD &&
    packedQuality !== undefined &&
    packedQuality < QUERY_TRANSLATE_LOW_RELEVANCE_THRESHOLD;
  if (lowRelevanceDelegation) {
    deliveredAnchors = pkg.anchorChannel
      .filter((item) => typeof item.relevance === "number" && item.relevance > 0)
      .slice(0, QUERY_TRANSLATE_RELEVANCE_TOP_K_DELIVERED);
    const keptPaths = new Set(
      deliveredAnchors.map((item) => {
        const stem = item.id.replace(/^(file|symbol|module):/, "").replace(/:[0-9a-f]{6,}$/, "");
        return stem.includes(":") ? stem.split(":")[0]! : stem;
      })
    );
    const keptDecision = deliveredAnchors.some((item) => item.type === "Decision");
    deliveredSummary = pkg.summaryChannel.filter(
      (line) =>
        (keptDecision && line.startsWith("Decision:")) ||
        Array.from(keptPaths).some((path) => path.length > 0 && line.includes(path))
    );
    deliveredSummary = [
      `[低相关中文命中] 仅 ${deliveredAnchors.length}/${packedAnchorCount} 个 anchor 与查询共享词元；其余已裁剪。请回答 query-translate-en 工作项并用 englishQuery 重试。`,
      ...deliveredSummary,
    ];
  }
  const deliveredTokenEstimate = estimateSummaryLinesTokens(deliveredSummary);

  // Raw baseline over the DELIVERED anchor set — see estimateRawContextTokens.
  const rawTokenEstimate = estimateRawContextTokens({
    store: await resolveGraphStoreAfterIndex(config, graphClient),
    query,
    compressedTokens: deliveredTokenEstimate,
    anchors: deliveredAnchors,
  });

  // Record cumulative token savings for ROI tracking — deferred until AFTER
  // the post-packaging attach (see the end of this function) so the persisted
  // ROI covers the true accounted payload, not just the layered package.

  const result: ContextPreviewResult = {
    query,
    ...(englishQuery?.trim() ? { englishQuery: englishQuery.trim() } : {}),
    summaryCount: deliveredSummary.length,
    anchorCount: deliveredAnchors.length,
    tokenEstimate: deliveredTokenEstimate,
    truncated: pkg.truncated,
    anchorsByLayer: {
      l1: deliveredAnchors.filter((item) => item.layer === "L1").length,
      l2: deliveredAnchors.filter((item) => item.layer === "L2").length,
      l3: deliveredAnchors.filter((item) => item.layer === "L3").length,
    },
    refillPreview,
    summary: deliveredSummary,
    anchors: deliveredAnchors,
    tokenBudget: {
      maxContextTokens: effectiveMaxTokens,
      estimatedRawTokens: rawTokenEstimate,
      compressedTokens: deliveredTokenEstimate,
      estimatedSavingsPercent: calculateSavingsPercent(rawTokenEstimate, deliveredTokenEstimate),
      budgetUsedPercent: calculateBudgetUsedPercent(deliveredTokenEstimate, effectiveMaxTokens),
    },
    ...(queryTranslationDelegation ?? {}),
  };

  if (!bypassCache) {
    cacheContextResult(query, workspaceRoot, result);
  }

  const attached = await attachWorkbenchThenDialogue(result, graphClient, config, query, dialogue);
  // 响应硬预算：超限按序降级并重算记账；ROI 也按降级后的真实下发量入账。
  // Hard response budget applies before ROI recording so the persisted savings
  // cover what was actually sent (the degraded payload), not the pre-cap one.
  const budgeted = applyResponseBudget(attached);

  // ROI 记账延后到 attach 之后：持久化的节省统计必须覆盖真实下发总量
  // （budgeted + unbudgeted），否则 dialogue recall / workbench 行触发时
  // token-savings.json 会系统性乐观。/ Record cumulative token savings AFTER
  // the post-packaging attach so the persisted ROI uses the accounted total.
  try {
    const accountedTokens = budgeted.accountedTokens ?? budgeted.tokenBudget.compressedTokens;
    recordSavings(config, {
      timestamp: new Date().toISOString(),
      query,
      rawTokens: budgeted.tokenBudget.estimatedRawTokens,
      compressedTokens: accountedTokens,
      savingsPercent: budgeted.tokenBudget.estimatedSavingsPercent,
      source: "preview_context",
    });
  } catch {
    // Savings tracking is best-effort; don't fail the preview if it errors
  }

  return pressureBlock ? { ...budgeted, contextPressure: pressureBlock } : budgeted;
}

async function attachWorkbenchThenDialogue(
  result: ContextPreviewResult,
  client: GraphClient,
  config: GraphFlowConfig,
  query: string,
  dialogue?: PreviewDialogueOptions
): Promise<ContextPreviewResult> {
  // Historical recall (Conversation Graph W2b) is read-only, so it runs even
  // when this preview must not record a dialogue turn.
  const withHits = await attachDialogueHits(result, client, query);
  // R9 promise ledger: surface unresolved obligations from earlier sessions
  // on the FIRST context of a session — "干着干着就忘了" heals at open.
  const withReminders = await attachPromiseReminder(withHits, client);
  if (dialogue?.recordDialogue === false) {
    return withReminders;
  }
  const withWorkbench = await attachWorkbenchTopic(withReminders, client, config, query, dialogue);
  if (withWorkbench.workbench) {
    return withWorkbench;
  }
  return attachDialogueThread(withReminders, client, config, query, dialogue);
}

/** Attach the open promise-ledger reminder when previous sessions left work dangling. */
async function attachPromiseReminder(
  result: ContextPreviewResult,
  client: GraphClient
): Promise<ContextPreviewResult> {
  try {
    const { listOpenPromises, formatOpenPromiseReminder } = await import(
      "../../../audit/promise-ledger.js"
    );
    const open = await listOpenPromises(client);
    const reminder = formatOpenPromiseReminder(open);
    if (reminder === undefined) return result;
    return { ...result, pendingFollowThroughs: reminder };
  } catch {
    return result; // ledger failure never blocks context packaging
  }
}

/**
 * Slim one recall hit to its echo preview (same pattern as the thread /
 * workbench echo views): ids and structural marks verbatim, `userQuery`
 * clipped to `MAX_ECHO_TURN_CHARS` with `truncated` set when cut.
 * 纯函数：只裁剪文本，不读写图谱；结构与 id 原样，userQuery 裁成预览。
 */
function toDialogueHitPreview(hit: DialogueSearchHit): DialogueHitPreview {
  // clip() collapses whitespace first, so "was anything cut" is judged on the
  // normalized length — same convention as toEchoTurn.
  const truncated = normalizedLength(hit.userQuery) > MAX_ECHO_TURN_CHARS;
  return {
    id: hit.id,
    seq: hit.seq,
    sessionId: hit.sessionId,
    ...(hit.title ? { title: hit.title } : {}),
    ...(hit.summary ? { summary: hit.summary } : {}),
    userQuery: clip(hit.userQuery, MAX_ECHO_TURN_CHARS),
    updatedAt: hit.updatedAt,
    ...(hit.correctionLine ? { correctionLine: hit.correctionLine } : {}),
    superseded: hit.superseded,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Recall historical dialogue turns matching the query (Conversation Graph
 * W2b). Additive-only: hits ride in `dialogueHits` and never displace code
 * anchors; a correction-chain hit surfaces as one summary line so a
 * previously corrected conclusion is visible before the agent re-derives it.
 */
async function attachDialogueHits(
  result: ContextPreviewResult,
  client: GraphClient,
  query: string
): Promise<ContextPreviewResult> {
  try {
    const hits = await searchDialogueTurns(client, query, { limit: 3 });
    if (hits.length === 0) {
      return result;
    }
    const corrected = hits.find((hit) => hit.correctionLine);
    const recallLines = corrected?.correctionLine
      ? [`Dialogue recall: ${corrected.correctionLine}`]
      : [];
    // 回显瘦身：userQuery 裁成预览并标记 truncated；全文留在图谱，anchorId
    // 展开走 store 直读，不经过这个附带视图。/ Echo slim previews: userQuery
    // rides clipped with a truncated marker; full text stays in the graph
    // store — anchor expansion reads the store, never this attached view.
    const previews = hits.map(toDialogueHitPreview);
    // dialogueHits 在分层包之外附加下发 → 按裁剪后的实际下发负载记为
    // unbudgeted；召回行进入 summary → 与其他打包后追加行一样计入预算。
    // / The slim hits ride outside the layered package and are measured as
    // sent (unbudgeted); the recall line joins summary (budgeted).
    return {
      ...withPostPackageAccounting(
        result,
        recallLines,
        estimateUnbudgetedPayloadTokens(previews)
      ),
      dialogueHits: previews,
    };
  } catch (error) {
    logger.warn({ error }, "Dialogue recall attach failed");
    return result;
  }
}

async function attachWorkbenchTopic(
  result: ContextPreviewResult,
  client: GraphClient,
  config: GraphFlowConfig,
  query: string,
  dialogue?: PreviewDialogueOptions
): Promise<ContextPreviewResult> {
  try {
    const appended = await appendTopicMessage(client, {
      query,
      ...(config.graphPolicy.workspaceRoot ? { workspaceRoot: config.graphPolicy.workspaceRoot } : {}),
      ...(dialogue?.topicId ? { topicId: dialogue.topicId } : {}),
      ...(dialogue?.assistantReply ? { assistantReply: dialogue.assistantReply } : {}),
      allowAutoFork: !dialogue?.topicId,
    });
    if (!appended) {
      return result;
    }
    const view = await loadWorkbenchContext(client, appended.topic.id);
    if (!view) {
      return result;
    }
    const promptLines = [...view.promptLines];
    if (appended.forked) {
      promptLines.splice(
        1,
        0,
        `Forked: 当前问法偏离主线，已挂到孤立旁支。点回主线 topicId 可恢复主干。`
      );
    }
    // 回显瘦身：active 主题的完整 messages（40×4000 字符上限）不下发，
    // 消息裁成 160 字符预览并标记 truncated；全文留在图谱，走
    // loadWorkbenchContext 直读。/ Echo the slim view: full topic messages
    // never ride back — previews only; full text stays in the graph store.
    const echoView = toWorkbenchEchoView({ ...view, promptLines });
    return {
      // promptLines 前置进 summary → 计入预算（含 Forked 提示行）；瘦身视图
      // 本身是包外附加负载 → 实测入账。promptLines 已按行计过预算，实测时
      // 必须排除以免双算。/ promptLines are budgeted as prepended summary
      // lines; the echo view rides outside the package and is measured as-is,
      // with the already-budgeted promptLines excluded to avoid double count.
      // 双基线字段（grep 基线）在此出口装饰：tokenBudget 字面量位于
      // previewContext 组装区，由附件链出口统一补挂。/ Dual-baseline (grep)
      // fields are decorated at the attach-chain exits because the tokenBudget
      // literal itself lives in the previewContext assembly region.
      ...withGrepBaselineBudget(
        withPostPackageAccounting(
          result,
          promptLines,
          estimateUnbudgetedPayloadTokens([{ ...echoView, promptLines: [] }])
        ),
        config
      ),
      workbench: echoView,
      dialogueCapture: {
        kind: "workbench",
        id: appended.topic.id,
        pendingReply: topicPendingReply(appended.topic),
        forked: appended.forked,
        filled: appended.filled,
      },
    };
  } catch (error) {
    logger.warn({ error }, "Workbench topic attach failed");
    return result;
  }
}

async function attachDialogueThread(
  result: ContextPreviewResult,
  client: GraphClient,
  config: GraphFlowConfig,
  query: string,
  dialogue?: PreviewDialogueOptions
): Promise<ContextPreviewResult> {
  if (config.graphPolicy.enableDialogueThread === false) {
    // 附件链出口统一补挂 grep 双基线字段（tokenBudget 字面量在组装区内）。
    // Attach-chain exits carry the grep dual-baseline decoration.
    return withGrepBaselineBudget(result, config);
  }
  try {
    const workspaceRoot = config.graphPolicy.workspaceRoot;
    const recorded = dialogue?.recordDialogue !== false
      ? await recordDialogueTurn(client, {
          userQuery: query,
          ...(workspaceRoot ? { workspaceRoot } : {}),
          ...(dialogue?.sessionId ? { sessionName: dialogue.sessionId } : {}),
          ...(dialogue?.resumeFromTurnId ? { resumeFromTurnId: dialogue.resumeFromTurnId } : {}),
          ...(dialogue?.assistantReply ? { assistantReply: dialogue.assistantReply } : {}),
          relatedNodeIds: result.anchors
            .filter((anchor) => anchor.layer === "L1")
            .slice(0, 6)
            .map((anchor) => anchor.id),
        })
      : undefined;
    const thread = await loadDialogueThread(client, {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(dialogue?.sessionId ? { sessionName: dialogue.sessionId } : {}),
    });
    if (!thread) {
      return withGrepBaselineBudget(result, config);
    }
    const priorTokens = thread.turns
      .slice(0, -1)
      .flatMap((turn) => turn.userQuery.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/))
      .filter((token) => token.length >= 2);
    const overlap = scoreTopicOverlap(priorTokens, query);
    const jumped = thread.jumped || (thread.turns.length > 1 && overlap < 0.2);
    const promptLines = formatDialogueThreadLines({ ...thread, jumped, overlap });
    if (jumped && thread.turns.length > 1) {
      promptLines.splice(
        1,
        0,
        `Alignment: overlap=${Math.round(overlap * 100)}% — 已链入图谱，问法偏离主线。传入 resumeFromTurnId 可从某次对话继续深挖。`
      );
    }
    const injectSpine = thread.turns.length >= 2;
    const tip = thread.turns[thread.turns.length - 1];
    // 回显瘦身：turns 的 id/seq/jumped 原样保留（resumeFromTurnId 交互依赖），
    // Q/A 文本各裁成 200 字符预览；全文留在图谱直读。
    const echoThread = toDialogueThreadEchoView({ ...thread, jumped, overlap, promptLines });
    // Spine 注入 summary → 计入预算内；无论是否注入，瘦身视图本身都是包外
    // 附加负载 → 实测入账。已按行计入预算的 promptLines 从实测负载中排除，
    // 未注入时它们随视图下发 → 连同视图一起实测，保证不双算也不漏算。
    // Spine lines injected into summary are budgeted; the echo view always
    // rides outside the package and is measured as sent — minus the lines
    // already counted as budgeted (injected spine), so nothing is double
    // counted and nothing stays invisible.
    const unbudgeted = injectSpine
      ? estimateUnbudgetedPayloadTokens([{ ...echoThread, promptLines: [] }])
      : estimateUnbudgetedPayloadTokens([echoThread]);
    const accounted = withGrepBaselineBudget(
      withPostPackageAccounting(result, injectSpine ? promptLines : [], unbudgeted),
      config
    );
    return {
      ...accounted,
      dialogueThread: echoThread,
      ...(tip
        ? {
            dialogueCapture: {
              kind: "turn" as const,
              id: tip.id,
              pendingReply: !tip.assistantReply.trim(),
              filled: recorded?.reused === true && Boolean(dialogue?.assistantReply?.trim()),
            },
          }
        : {}),
    };
  } catch (error) {
    logger.warn({ error }, "Dialogue thread attach failed");
    return withGrepBaselineBudget(result, config);
  }
}

/**
 * Write the original assistant answer onto the pending user turn/topic.
 * Does not run context packaging and does not invent an LLM summary node.
 */
export async function captureAssistantReply(
  assistantReply: string,
  configPath?: string,
  rootDir?: string,
  dialogue?: PreviewDialogueOptions
): Promise<CaptureAssistantReplyResult> {
  const reply = assistantReply.trim();
  if (reply.length < 1) {
    return { ok: false, filled: false, reason: "reply-empty" };
  }
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath, rootDir ? { rootDir } : undefined), rootDir ? { rootDir } : undefined);
  const client = createGraphClient(config);
  const workspaceRoot = config.graphPolicy.workspaceRoot;

  try {
    const appended = await appendTopicMessage(client, {
      query: "",
      assistantReply: reply,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(dialogue?.topicId ? { topicId: dialogue.topicId } : {}),
      allowAutoFork: false,
    });
    if (appended) {
      return {
        ok: true,
        filled: appended.filled,
        capture: {
          kind: "workbench",
          id: appended.topic.id,
          pendingReply: topicPendingReply(appended.topic),
          filled: appended.filled,
        },
      };
    }
  } catch (error) {
    logger.warn({ error }, "Workbench reply capture failed");
  }

  if (config.graphPolicy.enableDialogueThread === false) {
    return { ok: false, filled: false, reason: "no-pending-turn" };
  }
  try {
    const recorded = await recordDialogueTurn(client, {
      userQuery: "",
      assistantReply: reply,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(dialogue?.sessionId ? { sessionName: dialogue.sessionId } : {}),
    });
    if (recorded.recorded && recorded.turn) {
      return {
        ok: true,
        filled: recorded.reused,
        capture: {
          kind: "turn",
          id: recorded.turn.id,
          pendingReply: !recorded.turn.assistantReply.trim(),
          filled: recorded.reused,
        },
      };
    }
    return { ok: false, filled: false, reason: recorded.skipped ?? "no-pending-turn" };
  } catch (error) {
    logger.warn({ error }, "Dialogue reply capture failed");
    return { ok: false, filled: false, reason: "capture-failed" };
  }
}

export async function indexGraph(
  rootDir?: string,
  configPath?: string,
  options?: { onProgress?: (processed: number, total: number) => void }
): Promise<GraphIndexResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath, rootDir ? { rootDir } : undefined), rootDir ? { rootDir } : undefined);
  const graphClient = createGraphClient(config);
  const targetDir = config.graphPolicy.workspaceRoot ?? process.cwd();

  const { invalidateContextCache } = await import("../../../graph/context-cache.js");
  invalidateContextCache(targetDir);

  const indexOptions = buildIndexOptions(config);

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  });

  return indexed;
}

/**
 * Incremental single-file indexing — for file-watcher / onSave hooks.
 *
 * @param filePath Absolute or relative path to the file to index
 * @param configPath Optional config path
 */
export async function indexFile(
  filePath: string,
  configPath?: string
): Promise<{
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
  skipped: boolean;
  reason?: string;
  path: string;
}> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();

  const absPath = filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)
    ? filePath
    : join(root, filePath);

  const indexOptions = buildIndexOptions(config);

  const result = await indexSingleFile(graphClient, root, absPath, indexOptions);
  return { ...result, path: absPath };
}

export async function rebuildGraph(
  rootDir?: string,
  configPath?: string,
  options?: { onProgress?: (processed: number, total: number) => void }
): Promise<GraphRebuildResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath, rootDir ? { rootDir } : undefined), rootDir ? { rootDir } : undefined);
  const graphClient = createGraphClient(config);
  const targetDir = config.graphPolicy.workspaceRoot ?? process.cwd();
  const storePath = resolveGraphStorePath(config);

  clearGraphIndexArtifacts(targetDir, storePath);

  const indexOptions = buildIndexOptions(config);

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
    forceReindex: true,
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  });

  return {
    ...indexed,
    cleared: true,
    storePath,
  };
}

export async function inspectGraph(
  configPath?: string,
  options?: {
    nodeLimit?: number;
    edgeLimit?: number;
    rootDir?: string;
    /**
     * Index the workspace when the store is empty (default true — `graphflow
     * inspect` and the CLI expect a populated graph).
     *
     * Status/panel callers MUST pass false: the VS Code extension's MCP
     * auto-install calls `getSettingsPanelStatus()`, and silently indexing a
     * whole repository there is both an unbounded side effect and, on large
     * workspaces, the write that used to die with "Invalid string length".
     */
    autoIndex?: boolean;
    /**
     * Include the workspace-filtered workbench outline in the snapshot
     * (default false — diagnose responses stay small; the slim
     * `workbenchResume` pointer is always kept). The full tree stays
     * viewable via CLI `graphflow workbench tree`.
     * 默认不带全量 outline，仅保留续聊指针；true 时按工作区过滤后回显。
     */
    includeOutline?: boolean;
  }
): Promise<GraphSnapshotResult> {
  // 裸 bindRuntimeWorkspaceRoot(resolved) 会从 cwd 重新发现并覆盖 config 已绑
  // 定的 workspaceRoot——跨工作区 outline 过滤依赖正确的 root，必须保留
  // resolveConfig 的显式绑定（与 getFlywheelReport 同口径）。/ A bare bind
  // re-discovers from cwd and drops the config's explicit workspaceRoot; the
  // cross-workspace outline filter needs the resolved root to survive.
  const resolvedInspectConfig = resolveConfig(
    configPath,
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const config = bindRuntimeWorkspaceRoot(
    resolvedInspectConfig,
    options?.rootDir
      ? { rootDir: options.rootDir }
      : resolvedInspectConfig.graphPolicy.workspaceRoot
        ? { projectWorkspaceRoot: resolvedInspectConfig.graphPolicy.workspaceRoot }
        : undefined
  );
  const nodeLimit = Math.max(1, options?.nodeLimit ?? 96);
  const edgeLimit = Math.max(1, options?.edgeLimit ?? 160);
  const includeOutline = options?.includeOutline === true;
  const emptyTypeCount: Record<GraphNode["type"], number> = {
    File: 0,
    Symbol: 0,
    Module: 0,
    Concept: 0,
    Requirement: 0,
    TaskRun: 0,
    Decision: 0,
    Skill: 0,
    ADR: 0,
    Invariant: 0,
    APIContract: 0,
    Test: 0,
  };

  if (config.graphPolicy.transport === "mcp-http") {
    const graphClient = createGraphClient(config);
    const remote = graphClient instanceof GraphifyMcpClient
      ? await graphClient.fetchSnapshot()
      : { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    if (remote.nodes.length === 0 && remote.edges.length === 0) {
      return {
        transport: config.graphPolicy.transport,
        storePath: resolveGraphStorePath(config),
        nodeCount: 0,
        edgeCount: 0,
        nodeTypeCount: emptyTypeCount,
        topRelations: [],
        sampleNodes: [],
        sampleEdges: [],
        ...workbenchOutlineEchoFields([], config.graphPolicy.workspaceRoot, includeOutline),
      };
    }
    const relationCounts = new Map<GraphEdge["relation"], number>();
    for (const edge of remote.edges) {
      relationCounts.set(edge.relation, (relationCounts.get(edge.relation) ?? 0) + 1);
    }
    const nodeTypeCount = { ...emptyTypeCount };
    for (const node of remote.nodes) {
      nodeTypeCount[node.type] += 1;
    }
    return {
      transport: config.graphPolicy.transport,
      storePath: resolveGraphStorePath(config),
      nodeCount: remote.nodes.length,
      edgeCount: remote.edges.length,
      nodeTypeCount,
      topRelations: Array.from(relationCounts.entries())
        .map(([relation, count]) => ({ relation, count }))
        .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation))
        .slice(0, 8),
      ...sampleGraphForSnapshot(
        remote.nodes,
        remote.edges,
        nodeLimit,
        edgeLimit,
        config.graphPolicy.workspaceRoot ?? process.cwd()
      ),
      ...workbenchOutlineEchoFields(
        buildWorkbenchOutlines(remote.nodes, remote.edges),
        config.graphPolicy.workspaceRoot,
        includeOutline
      ),
    };
  }

  let store = loadGraphStore(config);
  if (store.nodes.length === 0 && options?.autoIndex !== false) {
    const graphClient = createGraphClient(config);
    const indexOptions = buildIndexOptions(config);
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
    store = await resolveGraphStoreAfterIndex(config, graphClient);
  }

  const relationCounts = new Map<GraphEdge["relation"], number>();
  for (const edge of store.edges) {
    relationCounts.set(edge.relation, (relationCounts.get(edge.relation) ?? 0) + 1);
  }

  const nodeTypeCount = { ...emptyTypeCount };
  for (const node of store.nodes) {
    nodeTypeCount[node.type] += 1;
  }

  return {
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    nodeCount: store.nodes.length,
    edgeCount: store.edges.length,
    nodeTypeCount,
    topRelations: Array.from(relationCounts.entries())
      .map(([relation, count]) => ({ relation, count }))
      .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation))
      .slice(0, 8),
    ...sampleGraphForSnapshot(
      store.nodes,
      store.edges,
      nodeLimit,
      edgeLimit,
      config.graphPolicy.workspaceRoot ?? process.cwd()
    ),
    ...workbenchOutlineEchoFields(
      buildWorkbenchOutlines(store.nodes, store.edges),
      config.graphPolicy.workspaceRoot,
      includeOutline
    ),
  };
}

/**
 * 跨工作区 outline 过滤 / Cross-workspace outline filter.
 *
 * workbench root/topic 节点不逐字存 workspaceRoot——创建时它被单向 hash 进
 * rootId（workbenchRootIdFor(task, workspaceRoot)）。归属判定不是猜测：用存储
 * 的 task + 当前 workspaceRoot 重算同一 hash 与 rootId 比对，一致 ⇒ 本工作区
 * 创建的容器；不一致 ⇒ 其他工作区（或创建时未传 root），不回显。
 * Root/topic nodes never store workspaceRoot verbatim — it is hashed into the
 * rootId at creation. Ownership is verified, not guessed: recompute the same
 * hash from the stored task plus the CURRENT workspaceRoot and compare with
 * the rootId; non-matching outlines belong to another workspace (or were
 * seeded without a root) and are not echoed.
 */
function filterWorkbenchOutlinesToWorkspace(
  outlines: import("../../../learning/workbench-topic").WorkbenchOutline[],
  workspaceRoot: string | undefined
): import("../../../learning/workbench-topic").WorkbenchOutline[] {
  return outlines.filter(
    (outline) => workbenchRootIdFor(outline.task, workspaceRoot) === outline.rootId
  );
}

/**
 * diagnose/inspect 快照的 outline 回显装配 / Outline echo assembly for snapshots.
 *
 * 默认（includeOutline=false）：不带全量 outline——响应保持小巧，仅保留本工作
 * 区最近活跃容器的续聊指针（workbenchResume.activeTopicId），graphflow_context
 * ({ topicId }) 续聊不受影响。includeOutline=true 时按工作区过滤后回显全量
 * outline（维持原字段语义）。两种模式下都先做跨工作区过滤。
 * By default only a slim resume pointer survives; with includeOutline the
 * workspace-filtered outline rides as before.
 */
function workbenchOutlineEchoFields(
  outlines: import("../../../learning/workbench-topic").WorkbenchOutline[],
  workspaceRoot: string | undefined,
  includeOutline: boolean
): Pick<GraphSnapshotResult, "workbenchOutline" | "workbenchResume"> {
  // buildWorkbenchOutlines 按 root.updatedAt 倒序排列，owned[0] 即最近活跃。
  // buildWorkbenchOutlines sorts roots by updatedAt desc — owned[0] is latest.
  const owned = filterWorkbenchOutlinesToWorkspace(outlines, workspaceRoot);
  const latest = owned[0];
  return {
    ...(includeOutline ? { workbenchOutline: owned } : {}),
    ...(latest
      ? { workbenchResume: { rootId: latest.rootId, activeTopicId: latest.activeTopicId } }
      : {}),
  };
}

export async function listWorkbenchOutline(
  configPath?: string,
  rootDir?: string
): Promise<{
  outlines: import("../../../learning/workbench-topic").WorkbenchOutline[];
  lines: string[];
}> {
  // 与 inspectGraph 同口径：保留 resolveConfig 的显式 workspaceRoot，避免裸
  // bind 从 cwd 重新发现导致本工作区过滤误杀。/ Same bind discipline as
  // inspectGraph: keep the resolved workspaceRoot for the workspace filter.
  const resolvedOutlineConfig = resolveConfig(configPath, rootDir ? { rootDir } : undefined);
  const config = bindRuntimeWorkspaceRoot(
    resolvedOutlineConfig,
    rootDir
      ? { rootDir }
      : resolvedOutlineConfig.graphPolicy.workspaceRoot
        ? { projectWorkspaceRoot: resolvedOutlineConfig.graphPolicy.workspaceRoot }
        : undefined
  );
  const client = createGraphClient(config);
  // CLI `workbench tree` 是 outline 的常驻视图：全量返回，但仅限本工作区。
  // The CLI tree is the standing outline view: full, but workspace-scoped.
  const outlines = filterWorkbenchOutlinesToWorkspace(
    await loadWorkbenchOutlines(client),
    config.graphPolicy.workspaceRoot
  );
  return { outlines, lines: formatWorkbenchOutlineLines(outlines) };
}

export async function getSkillInsights(
  configPath?: string,
  limit = 12,
  rootDir?: string
): Promise<SkillInsightsResult> {  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath, rootDir ? { rootDir } : undefined), rootDir ? { rootDir } : undefined);
  const boundedLimit = Math.max(1, limit);

  if (config.graphPolicy.transport === "mcp-http") {
    const graphClient = createGraphClient(config);
    const remote = graphClient instanceof GraphifyMcpClient
      ? await graphClient.fetchSnapshot()
      : { nodes: [] as GraphNode[] };
    const skills = remote.nodes
      .filter((node) => node.type === "Skill")
      .map((node) => parseSkillInsight(node))
      .filter((state): state is SkillInsightItem => Boolean(state))
      .sort((a, b) => b.score - a.score || b.uses - a.uses || b.updatedAt - a.updatedAt)
      .slice(0, boundedLimit);
    return {
      source: skills.length > 0 ? "graph-store" : "unavailable",
      transport: config.graphPolicy.transport,
      storePath: resolveGraphStorePath(config),
      skills,
    };
  }

  let store = loadGraphStore(config);
  if (store.nodes.length === 0) {
    const graphClient = createGraphClient(config);
    const indexOptions = buildIndexOptions(config);
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
    store = await resolveGraphStoreAfterIndex(config, graphClient);
  }

  const skills = store.nodes
    .filter((node) => node.type === "Skill")
    .map((node) => parseSkillInsight(node))
    .filter((state): state is SkillInsightItem => Boolean(state))
    .sort((a, b) => b.score - a.score || b.uses - a.uses || b.updatedAt - a.updatedAt)
    .slice(0, boundedLimit);

  return {
    source: "graph-store",
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    skills,
  };
}

export interface FlywheelReport {
  transport: string;
  storePath: string;
  /**
   * P0 flywheel auto-capture health — whether pending episodes are written
   * automatically on run/context completion (`GRAPHFLOW_AUTO_CAPTURE`).
   */
  autoCaptureEnabled: boolean;
  /** Session journal used by hooks/backfill to resolve pending episodeIds. */
  sessionJournal: {
    path: string;
    exists: boolean;
    /** Count of pending-episode journal entries awaiting outcome backfill. */
    pendingCount: number;
  };
  skills: {
    total: number;
    positive: number;
    neutral: number;
    negative: number;
    /** P0-2 four-class skill lifecycle distribution (hidden skills excluded). */
    byOutcomeKind: Record<SkillOutcomeKind, number>;
    /** Most-used skills — what the flywheel actually injects most often. */
    topUsed: Array<{ name: string; score: number; uses: number }>;
  };
  episodes: {
    total: number;
    pass: number;
    fail: number;
    pending: number;
    /** Episodes carrying extracted lessons (flywheel raw material). */
    withLessons: number;
    /** P1 — drift classification counts across episodes that reported deviation. */
    deviations: {
      misreadRequirement: number;
      scopeCreep: number;
      techDrift: number;
      none: number;
    };
  };
  /** Decision nodes that are not episodes (Six Hats / plan insights). */
  insightDecisions: number;
  /** P0/P4 — goal anchors: active requirement anchors + superseded versions. */
  goals: {
    active: number;
    supersededVersions: number;
  };
  /**
   * MEMORY ATTRIBUTION — makes episodic memory observable: how much stored
   * memory could contribute to task rescue, how confident the outcome
   * distribution is, the freshest evidence chain, and why work deviated.
   * Additive-only: existing consumers (VS Code panel, MCP diagnose) keep
   * reading the fields above unchanged.
   */
  memoryAttribution: {
    /**
     * Total episode recall hits across recent runs. Episode records do not
     * yet persist per-run recall telemetry, so this falls back to episodes
     * carrying lessons — the rescue material the v1.9 A/B benchmark proved
     * is what saves tasks.
     */
    memoryHits: number;
    /** Episodes flagged staleGoal by goal versioning (the requirement moved
     *  under them, so their plan context must not be trusted as-is). */
    staleEpisodes: number;
    /** Pass/fail/pending distribution as percentages of all episodes. */
    confidence: {
      passPercent: number;
      failPercent: number;
      pendingPercent: number;
    };
    /** Top 3 most-recent episodes — the evidence chain: what memory holds
     *  that could inform the next run (task truncated, outcome, lesson count). */
    topContributingMemories: Array<{
      id: string;
      task: string;
      outcome: string;
      lessonsCount: number;
      updatedAt: number;
    }>;
    /** Counts per deviation category across stored episode records. */
    deviationBreakdown: {
      none: number;
      misreadRequirement: number;
      scopeCreep: number;
      techDrift: number;
    };
  };
  /**
   * P0 Experience-layer evidence — conversion / coverage rates, a short
   * consolidation tip, and a dry-run consolidation action summary.
   * Additive-only for diagnose / skill report consumers.
   */
  experience: {
    /**
     * Skills per resolved episode: `skills.total / max(pass + fail, 1)`,
     * capped at 1.0 so the metric reads as a 0–1 conversion rate (many skills
     * per episode still count as “converted”). Denominator is pass+fail
     * (not withLessons) because only resolved outcomes feed the flywheel.
     */
    episodeToSkillConversionRate: number;
    /** `withLessons / max(episodes.total, 1)` — how often episodes carry extractable lessons. */
    lessonsCoverageRate: number;
    antiPatternCount: number;
    provenSkillCount: number;
    /** Short human tip when conversion is low or pending share is high. */
    consolidationHint: string;
    /**
     * Dry-run QM consolidation plan counts (UPDATE/DELETE/ADD) over current skills.
     * Never mutates the graph — use `graphflow skill consolidate --apply` to execute.
     */
    consolidation: {
      updates: number;
      deletes: number;
      adds: number;
      /** updates + deletes + adds (excludes NONE). */
      actionable: number;
    };
  };
  /**
   * Split metrics: `estimatedSavingsPercent` is packaging ROI, not body
   * fidelity. Pending/unknown outcomes are ratios, not Hit@k.
   */
  fidelity?: ContextFidelityMetrics;
}

/**
 * Flywheel contribution report: makes the learning loop observable — how many
 * skills exist, their health distribution, which get used, and how episodes
 * (pass/fail/pending + lessons) accumulate. Read-only; never triggers indexing.
 */
export function getFlywheelReport(configPath?: string, rootDir?: string): FlywheelReport {
  const resolved = resolveConfig(configPath, rootDir ? { rootDir } : undefined);
  // Preserve config/project workspaceRoot when rootDir is omitted; a bare
  // bindRuntimeWorkspaceRoot(resolved) re-discovers from cwd and drops the
  // explicit graphPolicy.workspaceRoot that resolveConfig already bound.
  const config = bindRuntimeWorkspaceRoot(
    resolved,
    rootDir
      ? { rootDir }
      : resolved.graphPolicy.workspaceRoot
        ? { projectWorkspaceRoot: resolved.graphPolicy.workspaceRoot }
        : undefined
  );
  const store = loadGraphStore(config);
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
  const journalPath = resolveSessionJournalPath(workspaceRoot);
  const journalExists = existsSync(journalPath);
  const journalPendingCount = journalExists ? readJournalEntries(journalPath).length : 0;

  const byOutcomeKind = emptySkillOutcomeKindCounts();
  const skillItems: Array<NonNullable<ReturnType<typeof parseSkillInsight>>> = [];
  const consolidateInputs: ConsolidateSkillInput[] = [];
  for (const node of store.nodes) {
    if (node.type !== "Skill") continue;
    const item = parseSkillInsight(node);
    if (!item) continue;
    skillItems.push(item);
    const kind = readSkillOutcomeKind(node.content);
    if (kind) {
      byOutcomeKind[kind] += 1;
    }
    const state = parseSkillState(node.content);
    if (state && state.hidden !== true) {
      consolidateInputs.push({
        id: state.id,
        name: state.name,
        score: state.score,
        uses: state.uses,
        ...(state.outcomeKind ? { outcomeKind: state.outcomeKind } : {}),
        ...(state.guidance ? { guidance: state.guidance } : {}),
      });
    }
  }

  const topUsed = [...skillItems]
    .sort((a, b) => b.uses - a.uses || b.score - a.score)
    .slice(0, 5)
    .map((item) => ({ name: item.name, score: item.score, uses: item.uses }));

  let pass = 0;
  let fail = 0;
  let pending = 0;
  let withLessons = 0;
  let episodeCount = 0;
  let insightDecisions = 0;
  const deviations = { misreadRequirement: 0, scopeCreep: 0, techDrift: 0, none: 0 };
  let goalsActive = 0;
  let goalsSuperseded = 0;
  const episodes: Array<{
    id: string;
    task: string;
    outcome: string;
    lessonsCount: number;
    updatedAt: number;
    stale: boolean;
    deviation?: string;
  }> = [];
  for (const node of store.nodes) {
    if (node.type !== "Decision") continue;
    const kind = typeof node.metadata?.kind === "string" ? node.metadata.kind : undefined;
    if (kind === "goal") {
      if (node.metadata?.status === "superseded") goalsSuperseded += 1;
      else goalsActive += 1;
      continue;
    }
    if (kind !== "episode") {
      insightDecisions += 1;
      continue;
    }
    episodeCount += 1;
    try {
      const record = JSON.parse(
        typeof node.metadata?.record === "string" ? node.metadata.record : "{}"
      ) as {
        outcome?: string;
        lessons?: unknown[];
        deviation?: string;
        task?: string;
        updatedAt?: number;
        id?: string;
      };
      if (record.outcome === "pass") pass += 1;
      else if (record.outcome === "fail") fail += 1;
      else pending += 1;
      if (Array.isArray(record.lessons) && record.lessons.length > 0) {
        withLessons += 1;
      }
      if (record.deviation === "misread-requirement") deviations.misreadRequirement += 1;
      else if (record.deviation === "scope-creep") deviations.scopeCreep += 1;
      else if (record.deviation === "tech-drift") deviations.techDrift += 1;
      else if (record.deviation === "none") deviations.none += 1;
      episodes.push({
        id: typeof record.id === "string" ? record.id : node.id,
        task: typeof record.task === "string" ? record.task : node.content,
        outcome: typeof record.outcome === "string" ? record.outcome : "pending",
        lessonsCount: Array.isArray(record.lessons) ? record.lessons.length : 0,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
        stale: node.metadata?.staleGoal !== undefined,
        ...(typeof record.deviation === "string" ? { deviation: record.deviation } : {}),
      });
    } catch {
      pending += 1;
    }
  }

  const memoryHits = episodes.filter((e) => e.lessonsCount > 0).length;
  const staleEpisodes = episodes.filter((e) => e.stale).length;
  const topContributingMemories = [...episodes]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map((e) => ({
      id: e.id,
      task: e.task.length > 60 ? `${e.task.slice(0, 57)}...` : e.task,
      outcome: e.outcome,
      lessonsCount: e.lessonsCount,
      updatedAt: e.updatedAt,
    }));

  const resolvedEpisodes = Math.max(pass + fail, 1);
  const episodeToSkillConversionRate = Math.min(1, skillItems.length / resolvedEpisodes);
  const lessonsCoverageRate = withLessons / Math.max(episodeCount, 1);
  const pendingShare = episodeCount === 0 ? 0 : pending / episodeCount;
  const consolidationSummary = toConsolidateResult(planSkillConsolidation(consolidateInputs)).summary;
  const consolidationActionable =
    consolidationSummary.updates + consolidationSummary.deletes + consolidationSummary.adds;
  let consolidationHint = "Experience flywheel looks healthy.";
  if (episodeToSkillConversionRate < 0.2 && pass + fail > 0) {
    consolidationHint =
      "Low skill conversion — report outcomes with lessons so episodes crystallize into skills.";
  } else if (pendingShare >= 0.5 && episodeCount > 0) {
    consolidationHint =
      "High pending episode share — call graphflow_report_outcome to close the flywheel loop.";
  } else if (byOutcomeKind["anti-pattern"] > byOutcomeKind.proven && skillItems.length > 0) {
    consolidationHint =
      "Anti-patterns outnumber proven skills — review consolidation / prune noise before trusting hints.";
  } else if (lessonsCoverageRate < 0.25 && episodeCount > 0) {
    consolidationHint =
      "Few episodes carry lessons — attach lessons on outcome report to grow Experience.";
  } else if (consolidationActionable > 0) {
    consolidationHint = `Consolidation suggested (${consolidationSummary.updates} UPDATE / ${consolidationSummary.deletes} DELETE / ${consolidationSummary.adds} ADD) — dry-run: graphflow skill consolidate; apply: --apply.`;
  }
  const contextFidelityStats = getContextFidelityStats(config);

  return {
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    autoCaptureEnabled: isAutoCaptureEnabled(),
    sessionJournal: {
      path: journalPath,
      exists: journalExists,
      pendingCount: journalPendingCount,
    },
    skills: {
      total: skillItems.length,
      positive: skillItems.filter((s) => s.score > 0).length,
      neutral: skillItems.filter((s) => s.score === 0).length,
      negative: skillItems.filter((s) => s.score < 0).length,
      byOutcomeKind,
      topUsed,
    },
    episodes: {
      total: episodeCount,
      pass,
      fail,
      pending,
      withLessons,
      deviations,
    },
    insightDecisions,
    goals: {
      active: goalsActive,
      supersededVersions: goalsSuperseded,
    },
    memoryAttribution: {
      memoryHits,
      staleEpisodes,
      confidence: {
        passPercent: episodeCount === 0 ? 0 : Math.round((pass / episodeCount) * 100),
        failPercent: episodeCount === 0 ? 0 : Math.round((fail / episodeCount) * 100),
        pendingPercent: episodeCount === 0 ? 0 : Math.round((pending / episodeCount) * 100),
      },
      topContributingMemories,
      deviationBreakdown: {
        none: deviations.none,
        misreadRequirement: deviations.misreadRequirement,
        scopeCreep: deviations.scopeCreep,
        techDrift: deviations.techDrift,
      },
    },
    experience: {
      episodeToSkillConversionRate,
      lessonsCoverageRate,
      antiPatternCount: byOutcomeKind["anti-pattern"],
      provenSkillCount: byOutcomeKind.proven,
      consolidationHint,
      consolidation: {
        updates: consolidationSummary.updates,
        deletes: consolidationSummary.deletes,
        adds: consolidationSummary.adds,
        actionable: consolidationActionable,
      },
    },
    fidelity: {
      estimatedSavingsPercent: getSavingsStats(config).averageSavingsPercent,
      pendingRatio: pendingShare,
      unknownOutcomeRatio: pendingShare,
      sampleCount: contextFidelityStats.sampleCount,
      averageAnchorRecallPercent: contextFidelityStats.averageAnchorRecallPercent,
      averageBodyCoveragePercent: contextFidelityStats.averageBodyCoveragePercent,
      note: SAVINGS_NOT_FIDELITY_NOTE,
    },
  };
}

export async function exportArtifact(
  configPath?: string,
  outputPath?: string,
  client?: GraphClient,
  options?: { compression?: "gzip" | "none"; includeEpisodes?: boolean }
): Promise<{
  path: string;
  nodeCount: number;
  edgeCount: number;
  bytes: number;
  uncompressedBytes: number;
  sha256: string;
  compression: "none" | "gzip";
}> {
  const config = resolveConfig(configPath);
  const graphClient = client ?? createGraphClient(config);
  const { exportGraphArtifact } = await import("../../../graph/artifact-manager.js");
  return exportGraphArtifact(config, outputPath, graphClient, options);
}

/** Export a human-readable Markdown experience-memory pack (skills + episodes). */
export async function exportExperienceMemory(
  configPath?: string,
  outputDir?: string
): Promise<{
  path: string;
  files: string[];
  skillCount: number;
  episodeCount: number;
}> {
  const config = resolveConfig(configPath);
  const { exportExperienceMemoryPack } = await import("../../../graph/memory-pack.js");
  return exportExperienceMemoryPack(config, outputDir);
}

export async function importArtifact(
  configPath?: string,
  inputPath?: string
): Promise<{ path: string; nodeCount: number; edgeCount: number; imported: boolean; skipped: boolean; reason?: string }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { importGraphArtifact } = await import("../../../graph/artifact-manager.js");
  return importGraphArtifact(config, graphClient, inputPath);
}

/**
 * 导出所有 Skill 类型节点为 JSON 技能包。
 *
 * @param configPath 可选配置路径
 * @param outputPath 输出文件路径（默认 graphflow-out/skills.json）
 */
export async function exportSkillPackageRuntime(
  configPath?: string,
  outputPath?: string,
  opts?: { goldenQueries?: string[] }
): Promise<{ path: string; skillCount: number; bytes: number; goldenQueries?: number }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { exportSkillPackage } = await import("../../../learning/skill-package.js");
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const targetPath = outputPath
    ? (outputPath.startsWith("/") || /^[A-Za-z]:/.test(outputPath)
      ? outputPath
      : join(root, outputPath))
    : join(root, "graphflow-out", "skills.json");
  return exportSkillPackage(graphClient, targetPath, opts?.goldenQueries ? { goldenQueries: opts.goldenQueries } : undefined);
}

/**
 * 导入技能包（双向 MERGE：per-skill-id union，updatedAt 较新者胜，
 * 并列保留本地，仅本地技能保留；opts.force 恢复覆盖语义）。
 * 技能包携带 goldenQueries 时合并进本地集合并写入
 * `.graphflow/team-golden.json` 旁车文件。
 *
 * @param configPath 可选配置路径
 * @param inputPath 输入文件路径（默认 graphflow-out/skills.json）
 * @param opts 导入选项（force / goldenPath）
 */
export async function importSkillPackageRuntime(
  configPath?: string,
  inputPath?: string,
  opts?: { force?: boolean; goldenPath?: string }
): Promise<{
  path: string;
  imported: number;
  skipped: number;
  updated: number;
  total: number;
  goldenPath?: string;
  goldenQueries?: number;
}> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const { importSkillPackage } = await import("../../../learning/skill-package.js");
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const sourcePath = inputPath
    ? (inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)
      ? inputPath
      : join(root, inputPath))
    : join(root, "graphflow-out", "skills.json");
  const goldenPath = opts?.goldenPath ?? join(root, ".graphflow", "team-golden.json");
  return importSkillPackage(graphClient, sourcePath, { force: opts?.force ?? false, goldenPath });
}

/**
 * 加载团队 golden 检索基准查询：
 * 优先从仓库内的 retrieval-golden 测试导出（开发环境），
 * 失败（如安装包环境无 tests/ 目录）时回退到本地 `.graphflow/team-golden.json` 旁车文件。
 */
async function loadCanonicalGoldenQueries(root: string): Promise<string[]> {
  try {
    // 动态 import 避免生产构建解析 tests/（tsconfig exclude）；非字面量说明符
    const testFile = "retrieval-golden.test";
    const specifier = `../../../../tests/${testFile}.ts`;
    const mod = (await import(specifier)) as {
      GOLDEN_SET?: ReadonlyArray<{ query: string }>;
    };
    const queries =
      mod.GOLDEN_SET?.map((entry) => entry.query).filter(
        (q): q is string => typeof q === "string"
      ) ?? [];
    if (queries.length > 0) {
      return queries;
    }
  } catch {
    // 非仓库环境：tests/ 不存在 → 回退旁车文件
  }
  try {
    const sidecar = join(root, ".graphflow", "team-golden.json");
    if (existsSync(sidecar)) {
      const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((q): q is string => typeof q === "string");
      }
    }
  } catch {
    // 旁车文件缺失/损坏 → 无 golden 查询
  }
  return [];
}

/**
 * Git-based team skill sharing.
 *
 * Exports/imports the skill package at a canonical, committable location:
 * `<workspace>/.graphflow/skills/team-skills.json`. Teams commit this file so
 * every member's agents share the same accumulated project experience.
 *
 * 冲突策略（import）：双向 MERGE —— per-skill-id union；同 id 冲突时
 * `updatedAt` 较新者胜、并列保留本地；仅本地/仅包中技能均保留；
 * `--force` 恢复覆盖语义。golden 查询随包往返，导入时合并（本地优先、
 * 按文本去重）写入 `.graphflow/team-golden.json` 旁车文件。
 *
 * @param configPath 可选配置路径
 * @param direction "export"（本地图 → 团队文件）或 "import"（团队文件 → 本地图）
 * @param customPath 覆盖默认团队技能包路径
 * @param opts 同步选项（force：import 时恢复覆盖语义）
 */
export async function syncSkillPackageRuntime(
  configPath: string | undefined,
  direction: "export" | "import",
  customPath?: string,
  opts?: { force?: boolean }
): Promise<
  | { direction: "export"; path: string; skillCount: number; bytes: number; goldenQueries?: number }
  | {
      direction: "import";
      path: string;
      imported: number;
      skipped: number;
      updated: number;
      total: number;
      goldenPath?: string;
      goldenQueries?: number;
    }
> {
  const config = resolveConfig(configPath);
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const teamPath = customPath
    ? (customPath.startsWith("/") || /^[A-Za-z]:/.test(customPath)
      ? customPath
      : join(root, customPath))
    : join(root, ".graphflow", "skills", "team-skills.json");

  if (direction === "export") {
    // 导出时打包团队 golden 检索基准（canonical 查询列表）
    const goldenQueries = await loadCanonicalGoldenQueries(root);
    const result = await exportSkillPackageRuntime(configPath, teamPath, { goldenQueries });
    return { direction: "export", ...result };
  }
  const result = await importSkillPackageRuntime(configPath, teamPath, {
    force: opts?.force ?? false,
  });
  return { direction: "import", ...result };
}

export async function syncSkillPackageRemote(
  configPath: string | undefined,
  direction: "push" | "pull",
  opts?: { force?: boolean }
): Promise<{
  direction: "push" | "pull";
  path: string;
  revision?: number | null;
  skillCount?: number;
  imported?: number;
  skipped?: number;
  updated?: number;
  total?: number;
  goldenQueries?: number;
}> {
  const config = resolveConfig(configPath);
  if (config.graphPolicy.transport !== "mcp-http" || !config.graphPolicy.mcpEndpoint) {
    throw new Error(
      "skill sync push/pull requires graphPolicy.transport=mcp-http and graphPolicy.mcpEndpoint"
    );
  }
  const client = createGraphClient(config);
  if (!(client instanceof GraphifyMcpClient)) {
    throw new Error("skill sync push/pull requires a live mcp-http team client");
  }
  if (direction === "push") {
    const exported = await syncSkillPackageRuntime(configPath, "export");
    if (exported.direction !== "export") {
      throw new Error("skill sync push failed to export a local pack");
    }
    const pack = JSON.parse(readFileSync(exported.path, "utf8")) as unknown;
    const pushed = await client.pushSkillPack(pack);
    return {
      direction: "push",
      path: exported.path,
      revision: pushed.revision ?? null,
      skillCount: exported.skillCount,
      ...(exported.goldenQueries !== undefined ? { goldenQueries: exported.goldenQueries } : {}),
    };
  }
  const pulled = await client.pullSkillPack();
  if (!pulled.pack || typeof pulled.pack !== "object") {
    throw new Error("team skill pack is empty; nothing to pull");
  }
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const teamPath = join(root, ".graphflow", "skills", "team-skills.json");
  mkdirSync(join(root, ".graphflow", "skills"), { recursive: true });
  writeFileSync(teamPath, `${JSON.stringify(pulled.pack, null, 2)}\n`, "utf8");
  const imported = await syncSkillPackageRuntime(configPath, "import", teamPath, {
    force: opts?.force ?? false,
  });
  if (imported.direction !== "import") {
    throw new Error("skill sync pull failed to import the team pack");
  }
  return {
    direction: "pull",
    path: teamPath,
    revision: pulled.revision ?? null,
    imported: imported.imported,
    skipped: imported.skipped,
    updated: imported.updated,
    total: imported.total,
    ...(imported.goldenQueries !== undefined ? { goldenQueries: imported.goldenQueries } : {}),
  };
}

export function getTokenSavingsStats(configPath?: string, rootDir?: string): SavingsStats & {
  explanation: string;
} {
  const resolved = resolveConfig(configPath, rootDir ? { rootDir } : undefined);
  const config = bindRuntimeWorkspaceRoot(
    resolved,
    rootDir
      ? { rootDir }
      : resolved.graphPolicy.workspaceRoot
        ? { projectWorkspaceRoot: resolved.graphPolicy.workspaceRoot }
        : undefined
  );
  return { ...getSavingsStats(config), explanation: explainSavings() };
}

export function resetTokenSavingsStats(configPath?: string): { path: string; reset: boolean } {
  const config = resolveConfig(configPath);
  return resetSavingsStats(config);
}

const MAX_EXPAND_FILE_CHARS = 200_000;

function isFileAnchor(node: GraphNode): boolean {
  return node.type === "File" || node.id.startsWith("file:");
}

function readExpandWindowEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function readWorkspaceSource(workspaceRoot: string, sourcePath: string): string | undefined {
  const absPath = join(workspaceRoot, sourcePath);
  if (!existsSync(absPath)) {
    return undefined;
  }
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Expand a context anchor to its full content.
 *
 * Preview anchors are lightweight pointers. File anchors return the entire
 * source file (capped). Symbol anchors return a configurable line window
 * (`GRAPHFLOW_EXPAND_SYMBOL_BEFORE` default 3, `GRAPHFLOW_EXPAND_SYMBOL_AFTER`
 * default 20 — about 24 lines). Exact edits still require this expand or a
 * full-file Read — preview summaries are not the source body.
 *
 * @param anchorId  The anchor id (e.g. "symbol:src/foo.ts:abc123")
 * @param configPath Optional config path
 * @param rootDir    Optional workspace root override
 */
export async function expandAnchor(
  anchorId: string,
  configPath?: string,
  rootDir?: string
): Promise<ExpandAnchorResult | undefined> {
  const baseConfig = resolveConfig(configPath, rootDir ? { rootDir } : undefined);
  // Respect explicit rootDir override; otherwise keep the config's workspaceRoot
  const config = rootDir
    ? bindRuntimeWorkspaceRoot(baseConfig, { rootDir })
    : baseConfig;
  const graphClient = createGraphClient(config);

  if (!graphClient.getNodesByIds) {
    return undefined;
  }

  const nodes = await graphClient.getNodesByIds([anchorId]);
  const node = nodes.find((n) => n.id === anchorId);
  if (!node) {
    return undefined;
  }

  const sourcePath = extractNodeSourcePath(node);
  const sourceLine = typeof node.metadata?.line === "number" ? node.metadata.line : undefined;
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();

  let sourceSnippet: string | undefined;
  if (sourcePath) {
    const fileContent = readWorkspaceSource(workspaceRoot, sourcePath);
    if (fileContent !== undefined) {
      if (isFileAnchor(node)) {
        sourceSnippet =
          fileContent.length > MAX_EXPAND_FILE_CHARS
            ? fileContent.slice(0, MAX_EXPAND_FILE_CHARS)
            : fileContent;
      } else if (sourceLine !== undefined) {
        const before = readExpandWindowEnv("GRAPHFLOW_EXPAND_SYMBOL_BEFORE", 3);
        const after = readExpandWindowEnv("GRAPHFLOW_EXPAND_SYMBOL_AFTER", 20);
        const lines = fileContent.split(/\r?\n/);
        const startLine = Math.max(0, sourceLine - 1 - before);
        const endLine = Math.min(lines.length, sourceLine + after);
        sourceSnippet = lines.slice(startLine, endLine).join("\n");
      }
    }
  }

  const expanded: ExpandAnchorResult = {
    anchorId: node.id,
    type: node.type,
    content: node.content,
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceLine !== undefined ? { sourceLine } : {}),
    ...(sourceSnippet ? { sourceSnippet } : {}),
    ...(node.metadata ? { metadata: node.metadata } : {}),
  };

  if (isWorkbenchTopicNode(node)) {
    const topic = parseWorkbenchTopic(node);
    const view = topic ? await loadWorkbenchContext(graphClient, topic.id) : undefined;
    if (view) {
      expanded.content = view.promptLines.join("\n");
      expanded.metadata = {
        ...(expanded.metadata ?? {}),
        // 瘦身回显：metadata.workbench 只带消息预览；需要全文时走
        // loadWorkbenchContext 直读。/ Echo the slim view only; full message
        // text is read on demand via loadWorkbenchContext.
        workbench: toWorkbenchEchoView(view),
        topicId: view.active.id,
      };
    }
  } else if (isDialogueTurnNode(node)) {
    const turn = parseDialogueTurn(node);
    const thread = await loadDialogueThread(graphClient, {
      ...(turn?.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(config.graphPolicy.workspaceRoot ? { workspaceRoot: config.graphPolicy.workspaceRoot } : {}),
    });
    if (thread) {
      // 瘦身回显：turn id/seq/jumped 原样，Q/A 裁成预览；全文留在图谱直读。
      expanded.dialogueThread = toDialogueThreadEchoView(thread);
      expanded.content = [
        `Dialogue turn #${turn?.seq ?? "?"} (${turn?.jumped ? "jump" : "mainline"})`,
        `Q: ${turn?.userQuery ?? node.content}`,
        `A: ${turn?.assistantReply?.trim() ? turn.assistantReply : "(pending)"}`,
        `resumeFromTurnId: ${node.id}`,
        ...thread.promptLines,
      ].join("\n");
    }
  }

  return expanded;
}

/**
 * Start a file watcher for auto-indexing on save when `autoIndexOnSave` is enabled.
 *
 * @param config Resolved GraphFlow configuration
 * @param configPath Optional config path to pass through to incremental indexing
 * @returns The started watcher instance, or `null` if disabled
 */
export function startFileWatcherIfEnabled(
  config: GraphFlowConfig,
  configPath?: string
): GraphFileWatcher | null {
  if (!config.graphPolicy.autoIndexOnSave) {
    return null;
  }

  const rootDir = config.graphPolicy.workspaceRoot ?? process.cwd();
  // MCP/IDE often spawn with cwd=home; never watch the whole user profile.
  if (isUnsafeWorkspaceFallback(rootDir)) {
    logger.warn(
      { rootDir },
      "Skipping file watcher: workspace root is unsafe (home/AppData). Pass rootDir or set GRAPHFLOW_WORKSPACE_ROOT."
    );
    return null;
  }

  const watcher = new GraphFileWatcher(rootDir, configPath);

  watcher.onChange((files) => {
    for (const file of files) {
      void indexFile(file, configPath).catch(() => {
        // Incremental index failures are best-effort; don’t crash the watcher
      });
    }
  });

  watcher.start();
  return watcher;
}
