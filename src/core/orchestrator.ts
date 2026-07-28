import { planTasks, planTasksLlm } from "../agents/planner.js";
import { brainstormTaskLlm } from "../agents/brainstormer.js";
import { resolveConfig } from "../config/resolve.js";
import { hasUsableLlmProvider } from "../config/llm-availability.js";
import { buildProviderHealthMap } from "../routing/provider-health.js";
import { logger } from "../utils/logger.js";
import { summarizeEpisodeForPrompt } from "../learning/episodic-memory.js";
import { executeRolePrompt } from "../routing/provider-executor.js";
import { executeDag } from "./dag-engine.js";
import {
  summarizeInsightForContext,
  type AgentDelegatedPlanInsight,
} from "./agent-delegation.js";
import { runSimpleTask } from "./state-machine.js";
import { triageTaskExplain, triageTaskLlm } from "./triage.js";
import { recordTriageDecision } from "../learning/triage-telemetry.js";
import { assignAgentsToTasks, buildAgentAssignments } from "./agent-assignment.js";
import type { OrchestrationInput, TaskRunResult, TaskNode, OrchestrateOptions } from "./types.js";

// Re-export OrchestrateOptions from types.ts for backward compatibility
export type { OrchestrateOptions } from "./types.js";

// Context module
import {
  maybeBuildNearLosslessContext,
  buildPromptContext,
  appendContextFeedback,
  maybeBuildSkillHints,
  maybeRunPlanInsightForComplex,
} from "./orchestrator-context.js";

// Episode module
import {
  maybeFindSimilarEpisodes,
  maybeSyncGraph,
  maybeSyncSkillGraph,
  finalizeEpisode,
  maybeSeedInitialSkills,
} from "./orchestrator-episode.js";

// Route module
import {
  buildRouteDecisions,
  decisionToSelection,
  selectionIfHealthy,
  appendRouteFeedback,
} from "./orchestrator-route.js";

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
  const retryOptions = input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {};
  const contextPackage = await maybeBuildNearLosslessContext(input, effectiveOptions);
  const routeDecisions = buildRouteDecisions(
    effectiveOptions?.providerHealth,
    effectiveOptions?.providerFallbackChain,
    effectiveOptions?.configPath
  );
  const skillHints = await maybeBuildSkillHints(input.task, effectiveOptions);
  const similarEpisodes = await maybeFindSimilarEpisodes(input.task, effectiveOptions);
  const episodeSummaries = await Promise.all(
    similarEpisodes.map((ep) => summarizeEpisodeForPrompt(ep, effectiveOptions?.graphClient))
  );
  const promptContext = buildPromptContext(contextPackage, skillHints, episodeSummaries, effectiveOptions);
  const promptContextLines = promptContext?.summaryChannel?.length ?? 0;

  let triageExplanation = triageTaskExplain(input.task);
  let mode = triageExplanation.decision;
  if (effectiveOptions?.enableLlmTriage) {
    const llmDecision = await triageTaskLlm(input.task, decisionToSelection(routeDecisions.planner), promptContext);
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
        input.task,
        mode,
        triageExplanation.reason
      );
    } catch (error) {
      logger.warn({ error }, "Triage telemetry recording failed");
    }
  }
  let currentPlan: TaskNode[] = [];

  if (mode === "simple") {
    const workerSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.worker),
      effectiveOptions?.providerHealth
    );
    const validatorSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.validator),
      effectiveOptions?.providerHealth
    );
    const run = await runSimpleTask({
      task: input.task,
      ...retryOptions,
      ...(workerSelection ? { workerSelection } : {}),
      ...(validatorSelection ? { validatorSelection } : {}),
      ...(promptContext ? { workerContext: promptContext, validatorContext: promptContext } : {}),
      ...(effectiveOptions?.executionMode ? { executionMode: effectiveOptions.executionMode } : {}),
    });
    const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, effectiveOptions);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, effectiveOptions);
    await maybeSyncSkillGraph(input.task, withRoute, effectiveOptions);
    logger.info({ status: withRoute.status, task: input.task }, "Orchestration task finished (simple mode)");
    return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, effectiveOptions, triageId);
  }

  const plannerSelection = decisionToSelection(routeDecisions.planner);

  let brainstormIdeas: string[] | undefined;
  let plan: TaskNode[];
  let planInsightBundle: AgentDelegatedPlanInsight | undefined;

  const autoPlanInsight =
    effectiveOptions?.enablePlanInsight === true ||
    (effectiveOptions?.enablePlanInsight !== false &&
      !hasExternalLlm &&
      effectiveOptions?.enableLlmAgents !== true &&
      effectiveOptions?.executionMode === "bridge");

  if (autoPlanInsight) {
    planInsightBundle = await maybeRunPlanInsightForComplex(input.task, effectiveOptions);
  }

  if (planInsightBundle) {
    if (!planInsightBundle.plan || planInsightBundle.plan.length === 0) {
      logger.warn({ task: input.task }, "Plan insight returned empty or null plan, falling back to heuristic planning");
      plan = planTasks(input.task, skillHints);
    } else {
      plan = planInsightBundle.plan;
    }
  } else if (effectiveOptions?.enableLlmAgents) {
    brainstormIdeas = await brainstormTaskLlm(input.task, plannerSelection, promptContext);
    plan = await planTasksLlm(input.task, {
      selection: plannerSelection,
      skillHints,
      brainstormIdeas,
      ...(promptContext ? { context: promptContext } : {}),
    });
  } else {
    plan = planTasks(input.task, skillHints);
  }
  currentPlan = plan;

  const plannerDraft = planInsightBundle
    ? `[plan-insight:${planInsightBundle.mode}] ${summarizeInsightForContext(planInsightBundle.insight)}`
    : effectiveOptions?.executionMode === "bridge"
      // Bridge mode delegates execution to the external agent; burning a real
      // LLM call here only to decorate the feedback string is pure cost and
      // makes bridge flows hang on machines with slow/unreachable providers.
      ? `[bridge] planned ${plan.length} task(s) for external agent execution`
      : await executeRolePrompt(
          "planner",
          `plan task: ${input.task}`,
          plannerSelection,
          promptContext
        );

  // Bridge mode: package the planned DAG for external agent execution instead of running it
  if (effectiveOptions?.executionMode === "bridge") {
    // 多 Agent 协作编排：为每个任务节点标注建议的 agent 专业领域
    const assignedPlan = assignAgentsToTasks(plan);
    const agentAssignments = buildAgentAssignments(assignedPlan);
    const planProjection = assignedPlan.map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
      ...(node.assignedAgent ? { assignedAgent: node.assignedAgent } : {}),
    }));
    const contextStr = promptContext
      ? Object.entries(promptContext)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("; ")
      : "";
    const insightSummary = planInsightBundle
      ? summarizeInsightForContext(planInsightBundle.insight)
      : undefined;
    const delegatedExtras =
      planInsightBundle?.mode === "agent-delegated" && planInsightBundle.agentWorkItems
        ? {
            agentMode: "delegated-llm" as const,
            agentWorkItems: planInsightBundle.agentWorkItems,
            ...(planInsightBundle.agentInstructions
              ? { agentInstructions: planInsightBundle.agentInstructions }
              : {}),
            ...(insightSummary ? { insightSummary } : {}),
            requiresAgentBridge: true as const,
            status: "awaiting-agent" as const,
          }
        : insightSummary
          ? { insightSummary }
          : {};
    const bridgeRun: TaskRunResult = {
      status: "DELEGATED",
      attempts: 0,
      feedback: planInsightBundle?.mode === "agent-delegated"
        ? `[DELEGATED][AGENT-BRIDGE] No GraphFlow LLM — complete agentWorkItems via graphflow_insight submit/merge before treating the plan as final. provisionalPlan=${plan.length}; plannerDraft=${shorten(plannerDraft)}`
        : `[DELEGATED] Planned ${plan.length} task(s) for external agent execution; plannerDraft=${shorten(plannerDraft)}`,
      ...(brainstormIdeas ? { brainstormIdeas } : {}),
      executionDescriptor: {
        action: "execute",
        task: input.task,
        context: `plan=${JSON.stringify(planProjection)}${insightSummary ? `; insight=${insightSummary}` : ""}${contextStr ? `; ${contextStr}` : ""}`,
        retryHints: [],
        ...(agentAssignments.length > 0 ? { agentAssignments } : {}),
        ...delegatedExtras,
      },
    };
    const finalRun = appendContextFeedback(bridgeRun, contextPackage, promptContextLines, effectiveOptions);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncSkillGraph(input.task, withRoute, effectiveOptions);
    logger.info({ status: withRoute.status, task: input.task }, "Orchestration task delegated (bridge mode)");
    return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, effectiveOptions, triageId);
  }

  const runner = async (node: TaskNode): Promise<boolean> => {
    logger.info({ nodeId: node.id, description: node.description }, "Executing task node");
    const workerSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.worker),
      effectiveOptions?.providerHealth
    );
    const validatorSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.validator),
      effectiveOptions?.providerHealth
    );
    const run = await runSimpleTask({
      task: node.description,
      ...retryOptions,
      ...(workerSelection ? { workerSelection } : {}),
      ...(validatorSelection ? { validatorSelection } : {}),
      ...(promptContext ? { workerContext: promptContext, validatorContext: promptContext } : {}),
      ...(effectiveOptions?.executionMode ? { executionMode: effectiveOptions.executionMode } : {}),
    });
    return run.status === "COMPLETED";
  };

  let result = await executeDag(plan, runner);
  let replanRounds = 0;
  const maxReplanRounds = effectiveOptions?.maxReplanRounds ?? 1;
  const canReplan = effectiveOptions?.enableDriftReplan === true && effectiveOptions.enableLlmAgents === true;

  while (
    canReplan &&
    result.failed.length > 0 &&
    replanRounds < maxReplanRounds
  ) {
    const failureFeedback = result.failed
      .map((id) => {
        const failedNode = plan.find((node) => node.id === id);
        return `${id}: ${failedNode?.description ?? ""}`;
      })
      .join("; ");

    const newPlan = await planTasksLlm(input.task, {
      selection: plannerSelection,
      skillHints,
      previousPlan: plan,
      failureFeedback,
      ...(brainstormIdeas ? { brainstormIdeas } : {}),
      ...(promptContext ? { context: promptContext } : {}),
    });

    if (projectPlan(newPlan) === projectPlan(plan)) {
      break;
    }

    replanRounds += 1;
    plan = newPlan;
    currentPlan = plan;
    result = await executeDag(plan, runner);
  }

  if (result.failed.length > 0) {
    const run: TaskRunResult = {
      status: "HUMAN_REVIEW_REQUIRED",
      attempts: plan.length,
      feedback: `Failed tasks: ${result.failed.join(", ")}; plannerDraft=${shorten(plannerDraft)}`,
      executionRounds: result.rounds,
      replanRounds,
      ...(brainstormIdeas ? { brainstormIdeas } : {}),
    };
    const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, effectiveOptions);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, effectiveOptions);
    await maybeSyncSkillGraph(input.task, withRoute, effectiveOptions);
    logger.error({ status: withRoute.status, failed: result.failed }, "Orchestration task failed or needs human review");
    return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, effectiveOptions);
  }

  const run: TaskRunResult = {
    status: "COMPLETED",
    attempts: plan.length,
    feedback: `Completed tasks: ${result.completed.join(", ")}; plannerDraft=${shorten(plannerDraft)}`,
    executionRounds: result.rounds,
    replanRounds,
    ...(brainstormIdeas ? { brainstormIdeas } : {}),
  };
  const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, effectiveOptions);
  const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
  await maybeSyncGraph(input.task, withRoute, effectiveOptions);
  await maybeSyncSkillGraph(input.task, withRoute, effectiveOptions);
  logger.info({ status: withRoute.status, task: input.task, rounds: result.rounds }, "Orchestration task completed successfully");
  return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, effectiveOptions, triageId);
}

function projectPlan(plan: TaskNode[]): string {
  return JSON.stringify(
    plan.map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
    }))
  );
}

function shorten(text: string): string {
  if (text.length <= 60) {
    return text;
  }

  return `${text.slice(0, 57)}...`;
}