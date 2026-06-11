import { planTasks, planTasksLlm } from "../agents/planner";
import { brainstormTaskLlm } from "../agents/brainstormer";
import type { GraphClient } from "../graph/client-factory";
import { logger } from "../utils/logger";
import {
  buildLayeredContextPackage,
  type LayeredContextPackage,
} from "../graph/context-slicer";
import { syncGraphAfterRun } from "../hooks/post-run-sync";
import {
  findSimilarEpisodes,
  recordEpisode,
  summarizeEpisodeForPrompt,
  type EpisodeRecord,
} from "../learning/episodic-memory";
import { applySkillLearning, suggestSkillHints } from "../learning/skill-flywheel";
import {
  resolveModelForRole,
  resolveModelWithFallback,
  type ProviderName,
  type ProviderHealthMap,
} from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";
import { executeDag } from "./dag-engine";
import { runSimpleTask } from "./state-machine";
import { triageTask, triageTaskLlm } from "./triage";
import type { OrchestrationInput, RouteDecision, TaskRunResult, TaskNode, TaskStatus } from "./types";

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
  enableGraphContextInPrompt?: boolean;
  enableEpisodicMemory?: boolean;
  enableLlmTriage?: boolean;
  embeddingProvider?: import("../learning/embeddings").EmbeddingProvider;
  configPath?: string;
}

export async function orchestrate(
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
    });
    const finalRun = appendContextFeedback(run, contextPackage, promptContextLines, options);
    const withRoute = appendRouteFeedback(finalRun, routeDecisions, skillHints);
    await maybeSyncGraph(input.task, withRoute, options);
    await maybeSyncSkillGraph(input.task, withRoute, options);
    logger.info({ status: withRoute.status, task: input.task }, "Orchestration task finished (simple mode)");
    return finalizeEpisode(input.task, currentPlan, withRoute, similarEpisodes, skillHints, options);
  }

  const plannerSelection = decisionToSelection(routeDecisions.planner);
  const plannerDraft = await executeRolePrompt(
    "planner",
    `plan task: ${input.task}`,
    plannerSelection,
    promptContext
  );

  let brainstormIdeas: string[] | undefined;
  let plan: TaskNode[];
  if (options?.enableLlmAgents) {
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

async function maybeBuildNearLosslessContext(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<LayeredContextPackage | undefined> {
  if (!options?.enableNearLosslessMode || !options.graphClient) {
    return undefined;
  }

  const query = options.nearLosslessQuery ?? input.task;
  const maxTokens = options.maxContextTokens ?? 1200;
  const packageOptions: import("../graph/context-slicer").LayeredPackageOptions = {
    ...(options.layerQuota ? { layerQuota: options.layerQuota } : {}),
    ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider, enableVectorRecall: true } : {})
  };
  const pkg = await buildLayeredContextPackage(options.graphClient, query, maxTokens, packageOptions);

  options.onContextPackage?.(pkg);
  return pkg;
}

function appendContextFeedback(
  run: TaskRunResult,
  contextPackage?: LayeredContextPackage,
  promptContextLines = 0,
  options?: OrchestrateOptions
): TaskRunResult {
  let next = run;
  if (contextPackage) {
    next = {
      ...next,
      feedback:
        `${next.feedback}; context(summary=${contextPackage.summaryChannel.length}, ` +
        `anchors=${contextPackage.anchorChannel.length}, tokens=${contextPackage.tokenEstimate})`,
    };
  }
  if (options?.enableGraphContextInPrompt) {
    next = {
      ...next,
      feedback: `${next.feedback}; promptCtx(lines=${promptContextLines})`,
      promptContextLines,
    };
  }
  return next;
}

function buildPromptContext(
  contextPackage: LayeredContextPackage | undefined,
  skillHints: string[],
  episodeSummaries: string[],
  options?: OrchestrateOptions
): PromptContext | undefined {
  const includeGraph = options?.enableGraphContextInPrompt === true && contextPackage !== undefined;
  const includeEpisodes = options?.enableEpisodicMemory === true && episodeSummaries.length > 0;
  if (!includeGraph && !includeEpisodes) {
    return undefined;
  }
  const ctx: PromptContext = {};
  if (includeGraph && contextPackage && contextPackage.summaryChannel.length > 0) {
    ctx.summaryChannel = contextPackage.summaryChannel;
  }
  if (includeGraph && skillHints.length > 0) {
    ctx.skillHints = skillHints;
  }
  if (includeEpisodes) {
    ctx.extraInstructions = [...episodeSummaries];
  }
  if (!ctx.summaryChannel && !ctx.skillHints && !ctx.extraInstructions) {
    return undefined;
  }
  return ctx;
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

function selectionIfHealthy(
  selection: ReturnType<typeof decisionToSelection>,
  providerHealth?: ProviderHealthMap
): ReturnType<typeof decisionToSelection> | undefined {
  if (!providerHealth) {
    return selection;
  }
  return providerHealth[selection.provider as ProviderName] ? selection : undefined;
}

function buildRouteDecisions(
  providerHealth?: ProviderHealthMap,
  providerFallbackChain?: ProviderName[],
  configPath?: string
): {
  planner: RouteDecision;
  worker: RouteDecision;
  validator: RouteDecision;
} {
  const resolve = (role: "planner" | "worker" | "validator") =>
    providerHealth
      ? resolveModelWithFallback(role, providerHealth, providerFallbackChain, configPath)
      : resolveModelForRole(role, configPath);

  return {
    planner: selectionToDecision("planner", resolve("planner")),
    worker: selectionToDecision("worker", resolve("worker")),
    validator: selectionToDecision("validator", resolve("validator")),
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

  await syncGraphAfterRun(
    options.graphClient,
    [
      {
        filePath: "runtime:task",
        summary: `Task completed: ${task}`,
      },
    ],
    options.configPath
  );
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

async function maybeFindSimilarEpisodes(
  task: string,
  options?: OrchestrateOptions
): Promise<EpisodeRecord[]> {
  if (!options?.enableEpisodicMemory || !options.graphClient) {
    return [];
  }
  return findSimilarEpisodes(options.graphClient, task, 3);
}

function statusToOutcome(status: TaskStatus): "pass" | "fail" | "human_review" {
  if (status === "COMPLETED") return "pass";
  if (status === "HUMAN_REVIEW_REQUIRED") return "human_review";
  return "fail";
}

async function finalizeEpisode(
  task: string,
  plan: TaskNode[],
  run: TaskRunResult,
  similar: EpisodeRecord[],
  skillHints: string[],
  options?: OrchestrateOptions
): Promise<TaskRunResult> {
  if (!options?.enableEpisodicMemory || !options.graphClient) {
    return run;
  }

  const decisions: string[] = [];
  for (const rd of run.routeDecisions ?? []) {
    decisions.push(`route ${rd.role}: ${rd.provider}/${rd.model}`);
  }
  for (const hint of skillHints.slice(0, 3)) {
    decisions.push(`skill: ${hint}`);
  }
  const dedupedDecisions = Array.from(new Set(decisions)).slice(0, 6);

  const planProjection = plan.map((node) => ({ id: node.id, description: node.description }));
  const recordInput: Parameters<typeof recordEpisode>[1] = {
    task,
    plan: planProjection,
    outcome: statusToOutcome(run.status),
    keyDecisions: dedupedDecisions,
    lessons: [],
    attempts: run.attempts,
    ...(run.executionRounds ? { executionRounds: run.executionRounds } : {}),
    ...(run.feedback !== undefined ? { runFeedback: run.feedback } : {}),
  };

  const episode = await recordEpisode(options.graphClient, recordInput);

  const similarSummaries = similar.map((ep) => ({
    id: ep.id,
    task: ep.task,
    score: ep.outcome === "pass" ? 1 : ep.outcome === "fail" ? -1 : 0,
  }));

  return {
    ...run,
    episodeId: episode.id,
    similarEpisodes: similarSummaries,
  };
}
