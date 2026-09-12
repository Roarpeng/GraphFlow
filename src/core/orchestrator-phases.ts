/**
 * Orchestration phase handlers (R4 decomposition of `runOrchestration`).
 *
 * `orchestrator.ts` used to hold one ~360-line function with five interleaved
 * concerns: mode resolution, triage, planning, bridge packaging, and local DAG
 * execution. Each concern now lives here as a named phase that receives an
 * explicit parameter bundle and returns a finalized `TaskRunResult`, so the
 * coordinator in `orchestrator.ts` only wires the phases together.
 *
 * Behaviour is intentionally unchanged: the same logging, the same graph /
 * skill sync calls in the same order, and the same `triageId` propagation
 * (including the LLM-failure path that intentionally omits it).
 */
import { planTasks, planTasksLlm } from "../agents/planner.js";
import { brainstormTaskLlm } from "../agents/brainstormer.js";
import { logger } from "../utils/logger.js";
import { executeRolePrompt } from "../routing/provider-executor.js";
import { executeDag } from "./dag-engine.js";
import {
  summarizeInsightForContext,
  type AgentDelegatedPlanInsight,
} from "./agent-delegation.js";
import { runSimpleTask } from "./state-machine.js";
import { assignAgentsToTasks, buildAgentAssignments } from "./agent-assignment.js";
import { buildFusedSteps, enrichExecutionDescriptor } from "./fused-descriptor.js";
import {
  appendContextFeedback,
  maybeRunPlanInsightForComplex,
} from "./orchestrator-context.js";
import type {
  buildPromptContext,
  maybeBuildNearLosslessContext,
  maybeBuildSkillHints,
} from "./orchestrator-context.js";
import {
  finalizeEpisode,
  maybeSyncGraph,
  maybeSyncSkillGraph,
} from "./orchestrator-episode.js";
import type { maybeFindSimilarEpisodes } from "./orchestrator-episode.js";
import {
  appendRouteFeedback,
  decisionToSelection,
  selectionIfHealthy,
} from "./orchestrator-route.js";
import type { buildRouteDecisions } from "./orchestrator-route.js";
import type {
  OrchestrateOptions,
  OrchestrationInput,
  TaskNode,
  TaskRunResult,
} from "./types.js";

export type RouteDecisionSet = ReturnType<typeof buildRouteDecisions>;
export type SkillHintSet = Awaited<ReturnType<typeof maybeBuildSkillHints>>;
export type BuiltPromptContext = ReturnType<typeof buildPromptContext>;
export type NearLosslessContext = Awaited<ReturnType<typeof maybeBuildNearLosslessContext>>;
export type SimilarEpisodeSet = Awaited<ReturnType<typeof maybeFindSimilarEpisodes>>;
export type PlannerSelection = ReturnType<typeof decisionToSelection>;

export interface OrchestrationShared {
  input: OrchestrationInput;
  effectiveOptions: OrchestrateOptions;
  contextPackage: NearLosslessContext;
  routeDecisions: RouteDecisionSet;
  skillHints: SkillHintSet;
  similarEpisodes: SimilarEpisodeSet;
  promptContext: BuiltPromptContext;
  promptContextLines: number;
  retryOptions: { maxRetries?: number };
  plannerSelection: PlannerSelection;
  triageId?: string;
}

export interface PlanPhaseResult {
  plan: TaskNode[];
  plannerDraft: string;
  brainstormIdeas?: string[];
  planInsightBundle?: AgentDelegatedPlanInsight;
}

function promptContextSpread(
  promptContext: BuiltPromptContext
): { workerContext?: NonNullable<BuiltPromptContext>; validatorContext?: NonNullable<BuiltPromptContext> } {
  if (!promptContext) return {};
  return { workerContext: promptContext, validatorContext: promptContext };
}

/**
 * Build the per-node runner used by both the local LLM DAG and the bridge+DAG
 * hybrid. `forceLlm` pins `executionMode: "llm"` for hybrid runs, matching the
 * previous inline closure.
 */
export function makeDagNodeRunner(params: {
  routeDecisions: RouteDecisionSet;
  providerHealth: OrchestrateOptions["providerHealth"];
  retryOptions: { maxRetries?: number };
  promptContext: BuiltPromptContext;
  executionMode?: OrchestrateOptions["executionMode"];
  forceLlm?: boolean;
  logMessage: string;
}): (node: TaskNode) => Promise<boolean> {
  return async (node: TaskNode): Promise<boolean> => {
    logger.info({ nodeId: node.id, description: node.description }, params.logMessage);
    const workerSelection = selectionIfHealthy(
      decisionToSelection(params.routeDecisions.worker),
      params.providerHealth
    );
    const validatorSelection = selectionIfHealthy(
      decisionToSelection(params.routeDecisions.validator),
      params.providerHealth
    );
    const executionModeSpread = params.forceLlm
      ? { executionMode: "llm" as const }
      : params.executionMode
        ? { executionMode: params.executionMode }
        : {};
    const run = await runSimpleTask({
      task: node.description,
      ...params.retryOptions,
      ...(workerSelection ? { workerSelection } : {}),
      ...(validatorSelection ? { validatorSelection } : {}),
      ...promptContextSpread(params.promptContext),
      ...executionModeSpread,
    });
    return run.status === "COMPLETED";
  };
}

/** Simple-mode phase: one worker/validator round, then feedback + graph sync. */
export async function runSimplePhase(shared: OrchestrationShared): Promise<TaskRunResult> {
  const { input, effectiveOptions, contextPackage, routeDecisions, skillHints, similarEpisodes } = shared;
  const { promptContext, promptContextLines, retryOptions, triageId } = shared;

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
    ...promptContextSpread(promptContext),
    ...(effectiveOptions?.executionMode ? { executionMode: effectiveOptions.executionMode } : {}),
  });
  const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, effectiveOptions);
  const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
  await maybeSyncGraph(input.task, withRoute, effectiveOptions);
  await maybeSyncSkillGraph(input.task, withRoute, effectiveOptions);
  logger.info({ status: withRoute.status, task: input.task }, "Orchestration task finished (simple mode)");
  return finalizeEpisode(input.task, [], withRoute, similarEpisodes, skillHints, effectiveOptions, triageId);
}

/** Planning phase: plan-insight bridge, LLM planner, or heuristic planner. */
export async function resolvePlanPhase(params: {
  task: string;
  skillHints: SkillHintSet;
  effectiveOptions: OrchestrateOptions;
  hasExternalLlm: boolean;
  plannerSelection: PlannerSelection;
  promptContext: BuiltPromptContext;
}): Promise<PlanPhaseResult> {
  const { task, skillHints, effectiveOptions, hasExternalLlm, plannerSelection, promptContext } = params;

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
    planInsightBundle = await maybeRunPlanInsightForComplex(task, effectiveOptions);
  }

  if (planInsightBundle) {
    if (!planInsightBundle.plan || planInsightBundle.plan.length === 0) {
      logger.warn({ task }, "Plan insight returned empty or null plan, falling back to heuristic planning");
      plan = planTasks(task, skillHints);
    } else {
      plan = planInsightBundle.plan;
    }
  } else if (effectiveOptions?.enableLlmAgents) {
    brainstormIdeas = await brainstormTaskLlm(task, plannerSelection, promptContext);
    plan = await planTasksLlm(task, {
      selection: plannerSelection,
      skillHints,
      brainstormIdeas,
      ...(promptContext ? { context: promptContext } : {}),
    });
  } else {
    plan = planTasks(task, skillHints);
  }

  const plannerDraft = planInsightBundle
    ? `[plan-insight:${planInsightBundle.mode}] ${summarizeInsightForContext(planInsightBundle.insight)}`
    : effectiveOptions?.executionMode === "bridge"
      // Bridge mode delegates execution to the external agent; burning a real
      // LLM call here only to decorate the feedback string is pure cost and
      // makes bridge flows hang on machines with slow/unreachable providers.
      ? `[bridge] planned ${plan.length} task(s) for external agent execution`
      : await executeRolePrompt("planner", `plan task: ${task}`, plannerSelection, promptContext);

  return {
    plan,
    plannerDraft,
    ...(brainstormIdeas ? { brainstormIdeas } : {}),
    ...(planInsightBundle ? { planInsightBundle } : {}),
  };
}

export function buildExecutionDescriptor(params: {
  task: string;
  planProjection: Array<{ id: string; description: string; dependencies: string[]; assignedAgent?: string }>;
  agentAssignments: ReturnType<typeof buildAgentAssignments>;
  contextStr: string;
  insightSummary?: string;
  retryHints: string[];
  delegatedExtras: Record<string, unknown>;
  /** GF-4 / Action Fusion: attach fused edit+validate steps. Default false. */
  enableActionFusion?: boolean;
}): NonNullable<TaskRunResult["executionDescriptor"]> {
  const { task, planProjection, agentAssignments, contextStr, insightSummary, retryHints, delegatedExtras, enableActionFusion } = params;
  const descriptor = {
    action: "execute",
    task,
    context: `plan=${JSON.stringify(planProjection)}${insightSummary ? `; insight=${insightSummary}` : ""}${contextStr ? `; ${contextStr}` : ""}`,
    retryHints,
    ...(agentAssignments.length > 0 ? { agentAssignments } : {}),
    ...delegatedExtras,
  } as NonNullable<TaskRunResult["executionDescriptor"]>;

  // GF-4 / Action Fusion: an edit immediately followed by its validation command
  // is one intent. Attach the fused steps so the external agent can execute them
  // in a single action; no steps means no behavioural claim, so leave it unchanged.
  if (!enableActionFusion) return descriptor;
  const steps = buildFusedSteps({
    task,
    planNodes: planProjection.map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
    })),
  });
  if (steps.length === 0) return descriptor;
  return enrichExecutionDescriptor(descriptor, steps);
}

/**
 * Bridge phase: package the plan for the external agent. `enableBridgeDagExecution`
 * additionally runs the DAG locally (hybrid) before returning the descriptor.
 */
export async function runBridgePhase(
  shared: OrchestrationShared & PlanPhaseResult
): Promise<TaskRunResult> {
  const { input, effectiveOptions, contextPackage, routeDecisions, skillHints, similarEpisodes } = shared;
  const { promptContext, promptContextLines, retryOptions, triageId, plan, plannerDraft } = shared;
  const brainstormIdeas = shared.brainstormIdeas;
  const planInsightBundle = shared.planInsightBundle;

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
  const delegatedExtras: Record<string, unknown> =
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

  // ── Bridge + DAG 混合模式：同时本地执行 DAG ──
  if (effectiveOptions?.enableBridgeDagExecution) {
    const runner = makeDagNodeRunner({
      routeDecisions,
      providerHealth: effectiveOptions?.providerHealth,
      retryOptions,
      promptContext,
      forceLlm: true,
      logMessage: "Executing task node (bridge+DAG)",
    });

    const dagResult = await executeDag(plan, runner);
    const allSucceeded = dagResult.failed.length === 0 && dagResult.blocked.length === 0;

    const bridgeRun: TaskRunResult = {
      status: allSucceeded ? "DELEGATED" : "HUMAN_REVIEW_REQUIRED",
      attempts: plan.length,
      feedback: allSucceeded
        ? `[DELEGATED+LOCAL-DAG] Planned ${plan.length} task(s); local DAG completed ${dagResult.completed.length}/${plan.length} tasks`
        : `[DELEGATED+LOCAL-DAG] Planned ${plan.length} task(s); local DAG failed ${dagResult.failed.length}, blocked ${dagResult.blocked.length}; external agent retry recommended`,
      ...(brainstormIdeas ? { brainstormIdeas } : {}),
      executionDescriptor: buildExecutionDescriptor({
        task: input.task,
        planProjection,
        agentAssignments,
        contextStr,
        ...(insightSummary ? { insightSummary } : {}),
        retryHints: dagResult.failed.length > 0 ? dagResult.failed.map((id) => `local-exec-failed:${id}`) : [],
        delegatedExtras,
        enableActionFusion: effectiveOptions?.enableActionFusion === true,
      }),
      localExecution: {
        completed: dagResult.completed,
        failed: dagResult.failed,
        blocked: dagResult.blocked,
        rounds: dagResult.rounds,
      },
    };
    const finalRun = appendContextFeedback(bridgeRun, contextPackage, promptContextLines, effectiveOptions);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, effectiveOptions);
    await maybeSyncSkillGraph(input.task, withRoute, effectiveOptions);
    logger.info(
      {
        status: withRoute.status,
        task: input.task,
        localCompleted: dagResult.completed.length,
        localFailed: dagResult.failed.length,
      },
      "Orchestration task delegated with local DAG execution (bridge+DAG mode)"
    );
    return finalizeEpisode(input.task, plan, withRoute, similarEpisodes, skillHints, effectiveOptions, triageId);
  }

  // ── 纯 Bridge 模式（无本地 DAG 执行）──
  const bridgeRun: TaskRunResult = {
    status: "DELEGATED",
    attempts: 0,
    feedback: planInsightBundle?.mode === "agent-delegated"
      ? `[DELEGATED][AGENT-BRIDGE] No GraphFlow LLM — complete agentWorkItems via graphflow_insight submit/merge before treating the plan as final. provisionalPlan=${plan.length}; plannerDraft=${shorten(plannerDraft)}`
      : `[DELEGATED] Planned ${plan.length} task(s) for external agent execution; plannerDraft=${shorten(plannerDraft)}`,
    ...(brainstormIdeas ? { brainstormIdeas } : {}),
    executionDescriptor: buildExecutionDescriptor({
      task: input.task,
      planProjection,
      agentAssignments,
      contextStr,
      ...(insightSummary ? { insightSummary } : {}),
      retryHints: [],
      delegatedExtras,
      enableActionFusion: effectiveOptions?.enableActionFusion === true,
    }),
  };
  const finalRun = appendContextFeedback(bridgeRun, contextPackage, promptContextLines, effectiveOptions);
  const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
  await maybeSyncSkillGraph(input.task, withRoute, effectiveOptions);
  logger.info({ status: withRoute.status, task: input.task }, "Orchestration task delegated (bridge mode)");
  return finalizeEpisode(input.task, plan, withRoute, similarEpisodes, skillHints, effectiveOptions, triageId);
}

/** Local LLM DAG phase: execute, optionally drift-replan, then report. */
export async function runLlmDagPhase(
  shared: OrchestrationShared & PlanPhaseResult
): Promise<TaskRunResult> {
  const { input, effectiveOptions, contextPackage, routeDecisions, skillHints, similarEpisodes } = shared;
  const { promptContext, promptContextLines, retryOptions, plannerSelection, triageId } = shared;
  const brainstormIdeas = shared.brainstormIdeas;
  let plan = shared.plan;
  const plannerDraft = shared.plannerDraft;

  const runner = makeDagNodeRunner({
    routeDecisions,
    providerHealth: effectiveOptions?.providerHealth,
    retryOptions,
    promptContext,
    ...(effectiveOptions?.executionMode ? { executionMode: effectiveOptions.executionMode } : {}),
    logMessage: "Executing task node",
  });

  let result = await executeDag(plan, runner);
  let replanRounds = 0;
  const maxReplanRounds = effectiveOptions?.maxReplanRounds ?? 1;
  const canReplan = effectiveOptions?.enableDriftReplan === true && effectiveOptions.enableLlmAgents === true;

  while (canReplan && result.failed.length > 0 && replanRounds < maxReplanRounds) {
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
    // Intentional: the failure path has never carried triageId.
    return finalizeEpisode(input.task, plan, withRoute, similarEpisodes, skillHints, effectiveOptions);
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
  logger.info(
    { status: withRoute.status, task: input.task, rounds: result.rounds },
    "Orchestration task completed successfully"
  );
  return finalizeEpisode(input.task, plan, withRoute, similarEpisodes, skillHints, effectiveOptions, triageId);
}

export function projectPlan(plan: TaskNode[]): string {
  return JSON.stringify(
    plan.map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
    }))
  );
}

export function shorten(text: string): string {
  if (text.length <= 60) {
    return text;
  }

  return `${text.slice(0, 57)}...`;
}
