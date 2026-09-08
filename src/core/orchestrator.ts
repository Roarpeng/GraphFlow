import { resolveConfig } from "../config/resolve.js";
import { hasUsableLlmProvider } from "../config/llm-availability.js";
import { buildProviderHealthMap } from "../routing/provider-health.js";
import { logger } from "../utils/logger.js";
import { summarizeEpisodeForPrompt } from "../learning/episodic-memory.js";
import { triageTaskExplain, triageTaskLlm } from "./triage.js";
import { recordTriageDecision } from "../learning/triage-telemetry.js";
import {
  maybeBuildNearLosslessContext,
  buildPromptContext,
  maybeBuildSkillHints,
  maybeBuildGoalAnchors,
} from "./orchestrator-context.js";
import {
  maybeFindSimilarEpisodes,
  maybeCleanupNoiseSkills,
  maybeSeedInitialSkills,
} from "./orchestrator-episode.js";
import {
  buildRouteDecisions,
  decisionToSelection,
} from "./orchestrator-route.js";
import {
  resolvePlanPhase,
  runBridgePhase,
  runLlmDagPhase,
  runSimplePhase,
  type BuiltPromptContext,
  type OrchestrationShared,
  type PlanPhaseResult,
  type RouteDecisionSet,
} from "./orchestrator-phases.js";
import type { OrchestrationInput, TaskRunResult, OrchestrateOptions } from "./types.js";

// Re-export OrchestrateOptions from types.ts for backward compatibility
export type { OrchestrateOptions } from "./types.js";

export async function orchestrate(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<TaskRunResult> {
  try {
    return await runOrchestration(input, options);
  } catch (error) {
    // 顶层错误边界：任何来自上下文构建/DAG 执行/图同步的未捕获异常
    // 都收敛为结构化的 HUMAN_REVIEW_REQUIRED 结果，而不是裸抛给调用方。
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, task: input.task }, "Orchestration failed with unhandled error");
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      attempts: 0,
      feedback: `Orchestration aborted due to unexpected error: ${message}`,
    };
  }
}

/**
 * Coordinator only: resolve mode, assemble the shared context bundle, then hand
 * off to one of the phase handlers in `orchestrator-phases.ts`
 * (`runSimplePhase` / `runBridgePhase` / `runLlmDagPhase`).
 */
async function runOrchestration(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<TaskRunResult> {
  logger.info({ task: input.task }, "Orchestration task started");

  const insightConfig = resolveConfig(options?.configPath);
  const hasExternalLlm = hasUsableLlmProvider(insightConfig);

  const providerHealth = options?.providerHealth ?? buildProviderHealthMap(insightConfig);
  const workerProvider = insightConfig.tiers.smart.provider as import("../routing/model-router").ProviderName;
  const validatorProvider = insightConfig.tiers.economy.provider as import("../routing/model-router").ProviderName;
  const isProviderHealthy = providerHealth[workerProvider] && providerHealth[validatorProvider];

  const effectiveExecutionMode: "bridge" | "llm" = options?.executionMode ?? (
    ((hasExternalLlm && isProviderHealthy) || options?.enableLlmAgents) ? "llm" : "bridge"
  );

  const effectiveOptions: OrchestrateOptions = {
    ...options,
    executionMode: effectiveExecutionMode,
    enableLlmAgents: !!(hasExternalLlm && isProviderHealthy) || (options?.enableLlmAgents ?? false),
  };

  logger.info({ hasExternalLlm, executionMode: effectiveExecutionMode }, "Orchestration execution mode determined");

  // 预置种子技能（幂等）：在技能飞轮启用时为图写入常见工程技能基线，
  // 须在构建技能提示之前执行，确保种子技能可被 suggestSkillHints 命中。
  await maybeSeedInitialSkills(effectiveOptions);
  // P0-2: prune legacy pure-noise skill nodes (no symbol evidence) on load,
  // before hints are built or any new learning is applied.
  await maybeCleanupNoiseSkills(effectiveOptions);

  const retryOptions = input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {};
  const contextPackage = await maybeBuildNearLosslessContext(input, effectiveOptions);
  const routeDecisions = buildRouteDecisions(
    effectiveOptions?.providerHealth,
    effectiveOptions?.providerFallbackChain,
    effectiveOptions?.configPath
  );
  const skillHints = await maybeBuildSkillHints(input.task, effectiveOptions);
  const goalAnchors = await maybeBuildGoalAnchors(input.task, effectiveOptions);
  const similarEpisodes = await maybeFindSimilarEpisodes(input.task, effectiveOptions);
  const episodeSummaries = await Promise.all(
    similarEpisodes.map((ep) => summarizeEpisodeForPrompt(ep, effectiveOptions?.graphClient))
  );
  const promptContext = buildPromptContext(contextPackage, skillHints, episodeSummaries, effectiveOptions, goalAnchors);
  const promptContextLines = promptContext?.summaryChannel?.length ?? 0;

  const { mode, triageId } = await resolveTriage(input.task, effectiveOptions, routeDecisions, promptContext);

  const shared: OrchestrationShared = {
    input,
    effectiveOptions,
    contextPackage,
    routeDecisions,
    skillHints,
    similarEpisodes,
    promptContext,
    promptContextLines,
    retryOptions,
    plannerSelection: decisionToSelection(routeDecisions.planner),
    ...(triageId !== undefined ? { triageId } : {}),
  };

  if (mode === "simple") {
    return runSimplePhase(shared);
  }

  const planPhase = await resolvePlanPhase({
    task: input.task,
    skillHints,
    effectiveOptions,
    hasExternalLlm,
    plannerSelection: shared.plannerSelection,
    promptContext,
  });

  const withPlan: OrchestrationShared & PlanPhaseResult = { ...shared, ...planPhase };

  if (effectiveOptions?.executionMode === "bridge") {
    return runBridgePhase(withPlan);
  }

  return runLlmDagPhase(withPlan);
}

/**
 * Triage: heuristic decision, optional LLM decision, then learning-event
 * telemetry (recorded only when a graph client is available; failures never
 * block the main flow).
 */
async function resolveTriage(
  task: string,
  effectiveOptions: OrchestrateOptions,
  routeDecisions: RouteDecisionSet,
  promptContext: BuiltPromptContext
): Promise<{ mode: ReturnType<typeof triageTaskExplain>["decision"]; triageId?: string }> {
  let triageExplanation = triageTaskExplain(task);
  let mode = triageExplanation.decision;

  if (effectiveOptions?.enableLlmTriage) {
    const llmDecision = await triageTaskLlm(task, decisionToSelection(routeDecisions.planner), promptContext);
    mode = llmDecision;
    // LLM triage 路径：保留启发式原因，并标记为 llmBased，用于准确率数据收集
    triageExplanation = { decision: llmDecision, reason: { ...triageExplanation.reason, llmBased: true } };
  }

  // 记录 triage 决策 learning event（任务描述、决策、原因、时间戳），用于后续准确率分析。
  // 仅在图客户端可用时记录；失败不阻断主流程。
  let triageId: string | undefined;
  if (effectiveOptions?.graphClient) {
    try {
      triageId = await recordTriageDecision(
        effectiveOptions.graphClient,
        task,
        mode,
        triageExplanation.reason
      );
    } catch (error) {
      logger.warn({ error }, "Triage telemetry recording failed");
    }
  }

  return { mode, ...(triageId !== undefined ? { triageId } : {}) };
}
