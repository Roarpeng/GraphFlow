import { planTasks, planTasksLlm } from "../agents/planner.js";
import { brainstormTaskLlm } from "../agents/brainstormer.js";
import { resolveConfig } from "../config/resolve.js";
import { hasUsableLlmProvider } from "../config/llm-availability.js";
import { logger } from "../utils/logger.js";
import { summarizeEpisodeForPrompt } from "../learning/episodic-memory.js";
import { executeRolePrompt } from "../routing/provider-executor.js";
import { executeDag } from "./dag-engine.js";
import {
  summarizeInsightForContext,
  type AgentDelegatedPlanInsight,
} from "./agent-delegation.js";
import { runSimpleTask } from "./state-machine.js";
import { triageTask, triageTaskLlm } from "./triage.js";
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
  const retryOptions = input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {};
  const contextPackage = await maybeBuildNearLosslessContext(input, options);
  const routeDecisions = buildRouteDecisions(
    options?.providerHealth,
    options?.providerFallbackChain,
    options?.configPath
  );
  const skillHints = await maybeBuildSkillHints(input.task, options);
  const similarEpisodes = await maybeFindSimilarEpisodes(input.task, options);
  const episodeSummaries = similarEpisodes.map((ep) => summarizeEpisodeForPrompt(ep));
  const promptContext = buildPromptContext(contextPackage, skillHints, episodeSummaries, options);
  const promptContextLines = promptContext?.summaryChannel?.length ?? 0;

  let mode = triageTask(input.task);
  if (options?.enableLlmTriage) {
    mode = await triageTaskLlm(input.task, decisionToSelection(routeDecisions.planner), promptContext);
  }
  let currentPlan: TaskNode[] = [];

  if (mode === "simple") {
    const workerSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.worker),
      options?.providerHealth
    );
    const validatorSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.validator),
      options?.providerHealth
    );
    const run = await runSimpleTask({
      task: input.task,
      ...retryOptions,
      ...(workerSelection ? { workerSelection } : {}),
      ...(validatorSelection ? { validatorSelection } : {}),
      ...(promptContext ? { workerContext: promptContext, validatorContext: promptContext } : {}),
      ...(options?.executionMode ? { executionMode: options.executionMode } : {}),
    });
    const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, options);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, options);
    await maybeSyncSkillGraph(input.task, withRoute, options);
    logger.info({ status: withRoute.status, task: input.task }, "Orchestration task finished (simple mode)");
    return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, options);
  }

  const plannerSelection = decisionToSelection(routeDecisions.planner);

  let brainstormIdeas: string[] | undefined;
  let plan: TaskNode[];
  let planInsightBundle: AgentDelegatedPlanInsight | undefined;

  const insightConfig = resolveConfig(options?.configPath);
  const autoPlanInsight =
    options?.enablePlanInsight === true ||
    (options?.enablePlanInsight !== false &&
      !hasUsableLlmProvider(insightConfig) &&
      options?.enableLlmAgents !== true &&
      (options?.executionMode === "bridge" || options?.executionMode === undefined));

  if (autoPlanInsight) {
    planInsightBundle = await maybeRunPlanInsightForComplex(input.task, options);
  }

  if (planInsightBundle) {
    plan = planInsightBundle.plan;
  } else if (options?.enableLlmAgents) {
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
    : await executeRolePrompt(
        "planner",
        `plan task: ${input.task}`,
        plannerSelection,
        promptContext
      );

  // Bridge mode: package the planned DAG for external agent execution instead of running it
  if (options?.executionMode === "bridge") {
    const planProjection = plan.map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
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
            ...(insightSummary ? { insightSummary } : {}),
          }
        : insightSummary
          ? { insightSummary }
          : {};
    const bridgeRun: TaskRunResult = {
      status: "DELEGATED",
      attempts: 0,
      feedback: planInsightBundle?.mode === "agent-delegated"
        ? `[DELEGATED][AGENT-LLM] Planned ${plan.length} task(s); use agentWorkItems prompts with your model (no GraphFlow API). plannerDraft=${shorten(plannerDraft)}`
        : `[DELEGATED] Planned ${plan.length} task(s) for external agent execution; plannerDraft=${shorten(plannerDraft)}`,
      ...(brainstormIdeas ? { brainstormIdeas } : {}),
      executionDescriptor: {
        action: "execute",
        task: input.task,
        context: `plan=${JSON.stringify(planProjection)}${insightSummary ? `; insight=${insightSummary}` : ""}${contextStr ? `; ${contextStr}` : ""}`,
        retryHints: [],
        ...delegatedExtras,
      },
    };
    const finalRun = appendContextFeedback(bridgeRun, contextPackage, promptContextLines, options);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncSkillGraph(input.task, withRoute, options);
    logger.info({ status: withRoute.status, task: input.task }, "Orchestration task delegated (bridge mode)");
    return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, options);
  }

  const runner = async (node: TaskNode): Promise<boolean> => {
    logger.info({ nodeId: node.id, description: node.description }, "Executing task node");
    const workerSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.worker),
      options?.providerHealth
    );
    const validatorSelection = selectionIfHealthy(
      decisionToSelection(routeDecisions.validator),
      options?.providerHealth
    );
    const run = await runSimpleTask({
      task: node.description,
      ...retryOptions,
      ...(workerSelection ? { workerSelection } : {}),
      ...(validatorSelection ? { validatorSelection } : {}),
      ...(promptContext ? { workerContext: promptContext, validatorContext: promptContext } : {}),
    });
    return run.status === "COMPLETED";
  };

  let result = await executeDag(plan, runner);
  let replanRounds = 0;
  const maxReplanRounds = options?.maxReplanRounds ?? 1;
  const canReplan = options?.enableDriftReplan === true && options.enableLlmAgents === true;

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
    const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, options);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, options);
    await maybeSyncSkillGraph(input.task, withRoute, options);
    logger.error({ status: withRoute.status, failed: result.failed }, "Orchestration task failed or needs human review");
    return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, options);
  }

  const run: TaskRunResult = {
    status: "COMPLETED",
    attempts: plan.length,
    feedback: `Completed tasks: ${result.completed.join(", ")}; plannerDraft=${shorten(plannerDraft)}`,
    executionRounds: result.rounds,
    replanRounds,
    ...(brainstormIdeas ? { brainstormIdeas } : {}),
  };
  const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, options);
  const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
  await maybeSyncGraph(input.task, withRoute, options);
  await maybeSyncSkillGraph(input.task, withRoute, options);
  logger.info({ status: withRoute.status, task: input.task, rounds: result.rounds }, "Orchestration task completed successfully");
  return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, options);
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