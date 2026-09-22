import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isUnsafeWorkspaceFallback } from "../../../config/discover-workspace.js";
import { resolveConfig } from "../../../config/resolve";
import { resolveGraphStorePath } from "../../../config/paths";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import type { GraphEdge, GraphNode } from "../../../core/types";
import { createGraphClient, type GraphClient } from "../../../graph/client-factory";
import { GraphifyMcpClient } from "../../../graph/graphify-mcp-client";
import {
  createContextRefillManager,
} from "../../../graph/context-slicer";
import { indexWorkspaceFiles, clearGraphIndexArtifacts, hasPendingGraphIndexWork, indexSingleFile } from "../../../graph/file-indexer";
import { GraphFileWatcher } from "../../../graph/file-watcher.js";
import { extractNodeSourcePath } from "../../../graph/graph-utils";
import { searchDialogueTurns } from "../../../graph/graph-search";
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
import {
  buildCompetenceMap,
  computeCapabilityMetrics,
  computeSkillUseStats,
  deriveTaskDomain,
  describeCapabilityMetrics,
  type CapabilityEpisode,
  type CapabilityMetricDescriptor,
  type CapabilityMetrics,
  type DomainCompetence,
  type SkillUseStats,
} from "../../../learning/capability-metrics.js";
import { isRetracted, readWriteGate, summarizeGateStats } from "../../../learning/memory-gate.js";
import {
  isSkillRecallable,
  revalidateSkills,
  symbolLookupFromSet,
} from "../../../learning/skill-staleness.js";
import { logger } from "../../../utils/logger.js";
import {
  formatDialogueThreadLines,
  isDialogueTurnNode,
  loadDialogueThread,
  parseDialogueTurn,
  recordDialogueTurn,
  scoreTopicOverlap,
} from "../../../learning/dialogue-thread.js";
import {
  appendTopicMessage,
  buildWorkbenchOutlines,
  formatWorkbenchOutlineLines,
  isWorkbenchTopicNode,
  loadWorkbenchContext,
  loadWorkbenchOutlines,
  parseWorkbenchTopic,
  topicPendingReply,
} from "../../../learning/workbench-topic.js";
import { buildEmbeddingOptions,
} from "./env.js";
import {
  calculateBudgetUsedPercent,
  calculateSavingsPercent,
  estimateRawContextTokens,
  estimateTokenCount,
  loadGraphStore,
  parseSkillInsight,
  resolveGraphStoreAfterIndex,
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
  buildQueryTranslateInstructions,
  buildQueryTranslateWorkItem,
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
        const parsed = JSON.parse(readFileSync(fallbackPath, "utf8")) as { nodes?: unknown[] };
        return !Array.isArray(parsed.nodes) || parsed.nodes.length === 0;
      } catch {
        return true;
      }
    }
    return true;
  }
  if (!existsSync(storePath)) {
    return true;
  }
  if (config.graphPolicy.transport === "sqlite" || config.graphPolicy.transport === "auto") {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { nodes?: unknown[] };
    return !Array.isArray(parsed.nodes) || parsed.nodes.length === 0;
  } catch {
    return true;
  }
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

export async function previewContext(
  query: string,
  configPath?: string,
  rootDir?: string,
  englishQuery?: string,
  dialogue?: PreviewDialogueOptions
): Promise<ContextPreviewResult> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath, rootDir ? { rootDir } : undefined), rootDir ? { rootDir } : undefined);
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();

  const { getCachedContext, cacheContextResult } = await import("../../../graph/context-cache.js");
  const cached = getCachedContext(query, workspaceRoot);
  const graphClient = createGraphClient(config);
  if (cached) {
    return attachWorkbenchThenDialogue(cached, graphClient, config, query, dialogue);
  }

  if (config.graphPolicy.autoIndexOnPreview) {
    const root = config.graphPolicy.workspaceRoot ?? process.cwd();
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
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
  if (enableAdaptiveBudget) {
    packageOptions.taskMode = taskMode;
  }

  // Semantic compression (minicpm/economy LLM) is opt-in via config.
  // Note: compression-model module removed; semantic compression disabled.

  const { buildEnhancedContextPackage } = await import("../../../graph/context-slicer.js");
  const pkg = await buildEnhancedContextPackage(
    graphClient,
    query,
    query,
    config.graphPolicy.maxContextTokens,
    packageOptions
  );

  const refill = createContextRefillManager(
    graphClient,
    config.graphPolicy.maxContextTokens,
    packageOptions
  );
  await refill.initialPackage(query);
  const refillPreview = await refill.refill([query]);
  const rawTokenEstimate = estimateRawContextTokens(
    await resolveGraphStoreAfterIndex(config, graphClient),
    query,
    pkg.tokenEstimate
  );

  // Record cumulative token savings for ROI tracking — deferred until AFTER
  // the post-packaging attach (see the end of this function) so the persisted
  // ROI covers the true accounted payload, not just the layered package.

  const anchorCount = pkg.anchorChannel.length;
  const queryTranslationDelegation = shouldDelegateQueryTranslation(query, anchorCount, englishQuery)
    ? {
        agentWorkItems: [buildQueryTranslateWorkItem(query, workspaceRoot)],
        agentInstructions: buildQueryTranslateInstructions(query),
        agentMode: "delegated-llm" as const,
      }
    : undefined;

  const result: ContextPreviewResult = {
    query,
    ...(englishQuery?.trim() ? { englishQuery: englishQuery.trim() } : {}),
    summaryCount: pkg.summaryChannel.length,
    anchorCount,
    tokenEstimate: pkg.tokenEstimate,
    truncated: pkg.truncated,
    anchorsByLayer: {
      l1: pkg.anchorChannel.filter((item) => item.layer === "L1").length,
      l2: pkg.anchorChannel.filter((item) => item.layer === "L2").length,
      l3: pkg.anchorChannel.filter((item) => item.layer === "L3").length,
    },
    refillPreview,
    summary: pkg.summaryChannel,
    anchors: pkg.anchorChannel,
    tokenBudget: {
      maxContextTokens: config.graphPolicy.maxContextTokens,
      estimatedRawTokens: rawTokenEstimate,
      compressedTokens: pkg.tokenEstimate,
      estimatedSavingsPercent: calculateSavingsPercent(rawTokenEstimate, pkg.tokenEstimate),
      budgetUsedPercent: calculateBudgetUsedPercent(pkg.tokenEstimate, config.graphPolicy.maxContextTokens),
    },
    ...(queryTranslationDelegation ?? {}),
  };

  cacheContextResult(query, workspaceRoot, result);

  const attached = await attachWorkbenchThenDialogue(result, graphClient, config, query, dialogue);

  // ROI 记账延后到 attach 之后：持久化的节省统计必须覆盖真实下发总量
  // （budgeted + unbudgeted），否则 dialogue recall / workbench 行触发时
  // token-savings.json 会系统性乐观。/ Record cumulative token savings AFTER
  // the post-packaging attach so the persisted ROI uses the accounted total.
  try {
    const accountedTokens = attached.accountedTokens ?? attached.tokenBudget.compressedTokens;
    recordSavings(config, {
      timestamp: new Date().toISOString(),
      query,
      rawTokens: attached.tokenBudget.estimatedRawTokens,
      compressedTokens: accountedTokens,
      savingsPercent: attached.tokenBudget.estimatedSavingsPercent,
      source: "preview_context",
    });
  } catch {
    // Savings tracking is best-effort; don't fail the preview if it errors
  }

  return attached;
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
  if (dialogue?.recordDialogue === false) {
    return withHits;
  }
  const withWorkbench = await attachWorkbenchTopic(withHits, client, config, query, dialogue);
  if (withWorkbench.workbench) {
    return withWorkbench;
  }
  return attachDialogueThread(withHits, client, config, query, dialogue);
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
    // dialogueHits 在分层包之外附加下发 → 记为 unbudgeted；召回行进入
    // summary → 与其他打包后追加行一样计入预算。/ The hits ride outside the
    // layered package (unbudgeted); the recall line joins summary (budgeted).
    return {
      ...withPostPackageAccounting(result, recallLines, estimateUnbudgetedPayloadTokens(hits)),
      dialogueHits: hits,
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
    return {
      // Workbench promptLines 前置进 summary → 计入预算（含 Forked 提示行）。
      ...withPostPackageAccounting(result, promptLines, 0),
      workbench: { ...view, promptLines },
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
    return result;
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
      return result;
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
    // Spine 注入 summary → 计入预算内；未注入时 promptLines 仅随
    // dialogueThread 视图下发 → 记为 unbudgeted，保证真实负载对调用方可见。
    // Spine lines injected into summary are budgeted; when the spine is not
    // injected the same lines still ride in the dialogueThread view, so they
    // are reported as unbudgeted instead of staying invisible.
    const accounted = withPostPackageAccounting(
      result,
      injectSpine ? promptLines : [],
      injectSpine ? 0 : estimateSummaryLinesTokens(promptLines)
    );
    return {
      ...accounted,
      dialogueThread: { ...thread, jumped, overlap, promptLines },
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
    return result;
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

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  });

  // M4（growth-plan §2.1）：索引重建后做一次确定性的技能失效校验。技能引用的符号
  // 若已无法解析，立即软退役（不可召回），而不是等时间衰减把分数慢慢降下来——
  // 确定性版本/时间戳判定优于时间衰减与 LLM 时效判断（arXiv:2606.01435）。
  //
  // 两点刻意的设计：
  // 1. 符号全集取宽松（Symbol 的 metadata.name + File/Module 路径 + 全部节点 id）。
  //    宽松方向是安全方向：多算符号只会让退役更少，绝不会误退役。
  // 2. 治理失败绝不影响索引结果——索引是主路径，退役是附加动作。
  try {
    const snapshot =
      typeof graphClient.readSnapshot === "function" ? graphClient.readSnapshot() : undefined;
    const universe = new Set<string>();
    for (const node of snapshot?.nodes ?? []) {
      const name = typeof node.metadata?.name === "string" ? node.metadata.name.trim() : "";
      if (node.type === "Symbol" && name) universe.add(name);
      if (node.type === "Symbol" || node.type === "File" || node.type === "Module") {
        const content = typeof node.content === "string" ? node.content.trim() : "";
        if (content && content.length <= 200) {
          universe.add(content);
          const base = content.split("/").pop();
          if (base) universe.add(base);
        }
      }
      if (node.id) universe.add(node.id);
    }
    await revalidateSkills(graphClient, { lookup: symbolLookupFromSet(universe) });
  } catch (error) {
    logger.warn({ error }, "Skill staleness revalidation failed");
  }

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

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

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

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

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
  options?: { nodeLimit?: number; edgeLimit?: number; rootDir?: string }
): Promise<GraphSnapshotResult> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath, options?.rootDir ? { rootDir: options.rootDir } : undefined),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const nodeLimit = Math.max(1, options?.nodeLimit ?? 96);
  const edgeLimit = Math.max(1, options?.edgeLimit ?? 160);
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
        workbenchOutline: [],
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
      workbenchOutline: buildWorkbenchOutlines(remote.nodes, remote.edges),
    };
  }

  let store = loadGraphStore(config);
  if (store.nodes.length === 0) {
    const graphClient = createGraphClient(config);
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
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
    workbenchOutline: buildWorkbenchOutlines(store.nodes, store.edges),
  };
}

export async function listWorkbenchOutline(
  configPath?: string,
  rootDir?: string
): Promise<{
  outlines: import("../../../learning/workbench-topic").WorkbenchOutline[];
  lines: string[];
}> {
  const config = bindRuntimeWorkspaceRoot(resolveConfig(configPath, rootDir ? { rootDir } : undefined), rootDir ? { rootDir } : undefined);
  const client = createGraphClient(config);
  const outlines = await loadWorkbenchOutlines(client);
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
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
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
   * growth-plan M1 — 能力指标取代 token 节省率成为对外主指标。
   *
   * 口径来自 SWE-Bench-CL（arXiv:2507.00014）的持续学习维度套件，不自创。token 节省率
   * 被刻意排除在 compositeScore 之外：削减 38.4% 工具输出 token 反而使计费成本 +6.8%，
   * 且激进压缩把 SWE-bench Go 子集 patch 成功率从 27/40 打到 15/40（arXiv:2607.12161）。
   * 节省率降为成本约束项，仍在 `fidelity` 里报告，但不参与能力分。
   *
   * 注意：这里的样本口径**排除已被撤回（retracted）或软隐藏（pruned）的 episode**——
   * 一条被撤回的记忆不构成能力证据。因此 `capability.sampleCount` 可能小于
   * `episodes.total`，这不是 bug，是两个口径回答不同问题。
   */
  capability: CapabilityMetrics;
  /**
   * growth-plan M5 — 按任务域的能力地图，阈值由 harness 外部强制计算，
   * 不采用模型自报置信度（growth-plan §1.5：校准不等于行动，须外部强制阈值）。
   * domain 由 deriveTaskDomain 从 task 文本确定性推导。
   */
  competence: DomainCompetence[];
  /**
   * growth-plan M3 — 技能选择精度（有效使用精度 / shadowing 率）。
   *
   * 这是本领域最缺的指标：技能池 5→100 时有效使用精度从 29.6% 掉到 3.3%，202 技能库
   * 使 pass rate 掉 21% 且最多 68% 由"选错技能"解释（arXiv:2605.24050、arXiv:2608.14036）。
   * 仓库当前没有召回的 per-run 遥测，所以此项在接线前恒为 insufficientData —
   * 这是诚实状态，不是 0 分（绝不把"未测量"写成 0%）。
   */
  skillUse: SkillUseStats;
  /**
   * growth-plan M11 — 每个能力指标的定义、文献依据与局限固化在代码里，
   * 使对外数字可解释、可复现，而不是无法追溯的营销数字。
   */
  metricDefinitions: CapabilityMetricDescriptor[];
  /**
   * growth-plan M2/M4 — 记忆写入治理的可观测面：
   * 写入门控裁决分布 + 被撤回的记忆数 + 因符号消失而被确定性退役的技能数。
   * 社区最痛的实际事故是记忆污染（临时决策被固化并跨会话传染），这三项是它的入口指标。
   */
  memoryGate: {
    admitted: number;
    reviewed: number;
    rejected: number;
    rejectReasons: Record<string, number>;
    /** 被 memory-gate 软撤回的记忆数（节点仍在，仅从召回路径隐藏）。 */
    retracted: number;
    /** M4：引用符号已无法解析、被确定性退役（不可召回）的技能数。 */
    symbolRetiredSkills: number;
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
    /** M1 能力指标用：返工率与工具使用效率的分母。 */
    attempts: number;
    /** M1 能力指标用：时间序与域内遗忘判定的排序键。 */
    createdAt: number;
    /** M2 记忆治理用：被撤回或软隐藏的 episode 不构成能力证据。 */
    retracted: boolean;
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
        createdAt?: number;
        attempts?: number;
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
        attempts: typeof record.attempts === "number" ? record.attempts : 0,
        createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
        // 软撤回（memory-gate）与软隐藏（forgetEpisode 的 pruned）都使该 episode
        // 不再构成能力证据；节点本身仍留在图里（证据永不物理删除）。
        retracted: isRetracted(node) || node.metadata?.pruned === true,
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

  // ── growth-plan M1 / M2 / M3 / M4 / M5 / M11 ───────────────────────────────
  // 能力指标取代 token 节省率成为对外主指标。样本口径排除已撤回/软隐藏的 episode：
  // 被撤回的记忆不构成能力证据（节点仍在图里，只是不再计数）。
  const capabilityEpisodes: CapabilityEpisode[] = episodes
    .filter((episode) => !episode.retracted)
    .map((episode) => ({
      id: episode.id,
      // 断言仅为满足类型：normalizeOutcome 会对未知取值做保守兜底（归入未定论）。
      outcome: episode.outcome as CapabilityEpisode["outcome"],
      attempts: episode.attempts,
      createdAt: episode.createdAt,
      updatedAt: episode.updatedAt,
      // 领域切分是确定性的（deriveTaskDomain），不交给模型判断。
      domain: deriveTaskDomain(episode.task),
    }));
  const capability = computeCapabilityMetrics(capabilityEpisodes);
  const competence = buildCompetenceMap(capabilityEpisodes);
  // M3：仓库尚无「召回了哪些 / 实际用了哪个 / 是否有帮助」的 per-run 遥测，
  // 因此显式传入 undefined，让指标诚实报告 insufficientData，而不是填 0。
  const skillUse = computeSkillUseStats(undefined);
  const metricDefinitions = describeCapabilityMetrics();
  const gateStats = summarizeGateStats(
    store.nodes
      .map((node) => readWriteGate(node))
      .filter((gate): gate is NonNullable<ReturnType<typeof readWriteGate>> => gate !== undefined)
  );
  const retractedMemories = store.nodes.filter((node) => isRetracted(node)).length;
  // M4：只统计「带确定性退役标记且召回层确实会排除」的技能，避免把 quarantine 的
  // 软隐藏误算成符号失效。
  const symbolRetiredSkills = store.nodes.filter(
    (node) =>
      node.type === "Skill" && node.metadata?.unrecallable === true && !isSkillRecallable(node)
  ).length;

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
    capability,
    competence,
    skillUse,
    metricDefinitions,
    memoryGate: {
      admitted: gateStats.admitted,
      reviewed: gateStats.reviewed,
      rejected: gateStats.rejected,
      rejectReasons: gateStats.rejectReasons,
      retracted: retractedMemories,
      symbolRetiredSkills,
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
        workbench: view,
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
      expanded.dialogueThread = thread;
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
