import { planTasks, planTasksLlm } from "../agents/planner";
import { brainstormTaskLlm } from "../agents/brainstormer";
import type { GraphClient } from "../graph/client-factory";
import {
  buildLayeredContextPackage,
  type LayeredContextPackage,
} from "../graph/context-slicer";
import { syncGraphAfterRun } from "../hooks/post-run-sync";
import { applySkillLearning, suggestSkillHints } from "../learning/skill-flywheel";
import {
  resolveModelForRole,
  resolveModelWithFallback,
  type ProviderName,
  type ProviderHealthMap,
} from "../routing/model-router";
import { executeRolePrompt } from "../routing/provider-executor";
import { executeDag } from "./dag-engine";
import { runSimpleTask } from "./state-machine";
import { triageTask } from "./triage";
import type { OrchestrationInput, RouteDecision, TaskRunResult, TaskNode } from "./types";

export interface OrchestrateOptions {
  graphClient?: GraphClient;
  enableAutoGraphSync?: boolean;
  enableNearLosslessMode?: boolean;
  nearLosslessQuery?: string;
  maxContextTokens?: number;
  layerQuota?: { l1: number; l2: number; l3: number };
  onContextPackage?: (pkg: LayeredContextPackage) => void;
  providerHealth?: ProviderHealthMap;
  providerFallbackChain?: ProviderName[];
  enableSkillFlywheel?: boolean;
  skillHintsLimit?: number;
  enableLlmAgents?: boolean;
  enableDriftReplan?: boolean;
  maxReplanRounds?: number;
}

export async function orchestrate(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<TaskRunResult> {
  const mode = triageTask(input.task);
  const retryOptions = input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {};
  const contextPackage = await maybeBuildNearLosslessContext(input, options);
  const routeDecisions = buildRouteDecisions(options?.providerHealth, options?.providerFallbackChain);
  const skillHints = await maybeBuildSkillHints(input.task, options);

  if (mode === "simple") {
    const run = await runSimpleTask({
      task: input.task,
      ...retryOptions,
      workerSelection: decisionToSelection(routeDecisions.worker),
      validatorSelection: decisionToSelection(routeDecisions.validator),
    });
    const finalRun = appendContextFeedback(run, contextPackage);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, options);
    await maybeSyncSkillGraph(input.task, withRoute, options);
    return withRoute;
  }

  const plannerSelection = decisionToSelection(routeDecisions.planner);
  const plannerDraft = await executeRolePrompt("planner", `plan task: ${input.task}`, plannerSelection);

  let brainstormIdeas: string[] | undefined;
  let plan: TaskNode[];
  if (options?.enableLlmAgents) {
    brainstormIdeas = await brainstormTaskLlm(input.task, plannerSelection);
    plan = await planTasksLlm(input.task, {
      selection: plannerSelection,
      skillHints,
      brainstormIdeas,
    });
  } else {
    plan = planTasks(input.task, skillHints);
  }

  const runner = async (node: TaskNode): Promise<boolean> => {
    const run = await runSimpleTask({
      task: node.description,
      ...retryOptions,
      workerSelection: decisionToSelection(routeDecisions.worker),
      validatorSelection: decisionToSelection(routeDecisions.validator),
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
    const finalRun = appendContextFeedback(run, contextPackage);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, options);
    await maybeSyncSkillGraph(input.task, withRoute, options);
    return withRoute;
  }

  const run: TaskRunResult = {
    status: "COMPLETED",
    attempts: plan.length,
    feedback: `Completed tasks: ${result.completed.join(", ")}; plannerDraft=${shorten(plannerDraft)}`,
    executionRounds: result.rounds,
    replanRounds,
    ...(brainstormIdeas ? { brainstormIdeas } : {}),
  };
  const finalRun = appendContextFeedback(run, contextPackage);
  const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
  await maybeSyncGraph(input.task, withRoute, options);
  await maybeSyncSkillGraph(input.task, withRoute, options);
  return withRoute;
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

async function maybeBuildNearLosslessContext(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<LayeredContextPackage | undefined> {
  if (!options?.enableNearLosslessMode || !options.graphClient) {
    return undefined;
  }

  const query = options.nearLosslessQuery ?? input.task;
  const maxTokens = options.maxContextTokens ?? 1200;
  const packageOptions = options.layerQuota ? { layerQuota: options.layerQuota } : undefined;

  const pkg = await buildLayeredContextPackage(options.graphClient, query, maxTokens, packageOptions);

  options.onContextPackage?.(pkg);
  return pkg;
}

function appendContextFeedback(
  run: TaskRunResult,
  contextPackage?: LayeredContextPackage
): TaskRunResult {
  if (!contextPackage) {
    return run;
  }

  return {
    ...run,
    feedback:
      `${run.feedback}; context(summary=${contextPackage.summaryChannel.length}, ` +
      `anchors=${contextPackage.anchorChannel.length}, tokens=${contextPackage.tokenEstimate})`,
  };
}

function appendRouteFeedback(
  run: TaskRunResult,
  routeDecisions: { planner: RouteDecision; worker: RouteDecision; validator: RouteDecision },
  skillHints: string[]
): TaskRunResult {
  return {
    ...run,
    routeDecisions: [routeDecisions.planner, routeDecisions.worker, routeDecisions.validator],
    feedback:
      `${run.feedback}; routes(planner=${routeDecisions.planner.provider}/${routeDecisions.planner.model}` +
      `,worker=${routeDecisions.worker.provider}/${routeDecisions.worker.model}` +
      `,validator=${routeDecisions.validator.provider}/${routeDecisions.validator.model})` +
      `${skillHints.length > 0 ? `; skills(hints=${skillHints.join("|")})` : ""}`,
  };
}

function buildRouteDecisions(
  providerHealth?: ProviderHealthMap,
  providerFallbackChain?: ProviderName[]
): {
  planner: RouteDecision;
  worker: RouteDecision;
  validator: RouteDecision;
} {
  return {
    planner: selectionToDecision(
      "planner",
      providerHealth
        ? resolveModelWithFallback("planner", providerHealth, providerFallbackChain)
        : resolveModelForRole("planner")
    ),
    worker: selectionToDecision(
      "worker",
      providerHealth
        ? resolveModelWithFallback("worker", providerHealth, providerFallbackChain)
        : resolveModelForRole("worker")
    ),
    validator: selectionToDecision(
      "validator",
      providerHealth
        ? resolveModelWithFallback("validator", providerHealth, providerFallbackChain)
        : resolveModelForRole("validator")
    ),
  };
}

function selectionToDecision(role: "planner" | "worker" | "validator", selection: {
  provider: string;
  model: string;
  tier: "smart" | "economy";
  fallbackApplied: boolean;
}): RouteDecision {
  return {
    role,
    provider: selection.provider,
    model: selection.model,
    tier: selection.tier,
    fallbackApplied: selection.fallbackApplied,
  };
}

function decisionToSelection(decision: RouteDecision): {
  provider: "openai" | "anthropic" | "bailian" | "doubao";
  model: string;
  tier: "smart" | "economy";
  fallbackApplied: boolean;
} {
  return {
    provider: decision.provider as "openai" | "anthropic" | "bailian" | "doubao",
    model: decision.model,
    tier: decision.tier,
    fallbackApplied: decision.fallbackApplied,
  };
}

function shorten(text: string): string {
  if (text.length <= 60) {
    return text;
  }

  return `${text.slice(0, 57)}...`;
}

async function maybeSyncGraph(
  task: string,
  run: TaskRunResult,
  options?: OrchestrateOptions
): Promise<void> {
  if (!options?.graphClient || !options.enableAutoGraphSync) {
    return;
  }

  if (run.status !== "COMPLETED") {
    return;
  }

  await syncGraphAfterRun(options.graphClient, [
    {
      filePath: "runtime:task",
      summary: `Task completed: ${task}`,
    },
  ]);
}

async function maybeBuildSkillHints(task: string, options?: OrchestrateOptions): Promise<string[]> {
  if (!options?.enableSkillFlywheel || !options.graphClient) {
    return [];
  }

  return suggestSkillHints(options.graphClient, task, options.skillHintsLimit ?? 3);
}

async function maybeSyncSkillGraph(
  task: string,
  run: TaskRunResult,
  options?: OrchestrateOptions
): Promise<void> {
  if (!options?.enableSkillFlywheel || !options.graphClient) {
    return;
  }

  await applySkillLearning(options.graphClient, task, run);
}
