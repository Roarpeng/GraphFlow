import { planInsight } from "../agents/insight.js";
import { resolveConfig } from "../config/resolve.js";
import { hasUsableLlmProvider } from "../config/llm-availability.js";
import type { LayeredContextPackage } from "../graph/context-slicer.js";
import { suggestSkillHints } from "../learning/skill-flywheel.js";
import { resolveModelForRole } from "../routing/model-router.js";
import type { PromptContext } from "../routing/provider-executor.js";
import { buildAgentDelegatedPlanInsight, type AgentDelegatedPlanInsight } from "./agent-delegation.js";
import { triageTask } from "./triage.js";
import type { OrchestrationInput, TaskRunResult, OrchestrateOptions } from "./types.js";
import { logger } from "../utils/logger.js";

export async function maybeBuildNearLosslessContext(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<LayeredContextPackage | undefined> {
  if (!options?.enableNearLosslessMode || !options.graphClient) {
    return undefined;
  }

  const query = options.nearLosslessQuery ?? input.task;
  const maxTokens = options.maxContextTokens ?? 1200;
  const packageOptions: import("../graph/context-slicer.js").LayeredPackageOptions = {
    ...(options.layerQuota ? { layerQuota: options.layerQuota } : {}),
    // Graph-structure compression is zero-cost; enable by default unless explicitly disabled.
    enableGraphCompression: options.enableGraphCompression !== false,
    // Pass through embedding/vector recall options so HNSW + vector recall are activated.
    ...(options.embeddingProvider
      ? {
          embeddingProvider: options.embeddingProvider,
          enableVectorRecall: true as const,
          ...(options.enableFullGraphVectorRecall === true
            ? { enableFullGraphVectorRecall: true as const }
            : {}),
          ...(options.hnswIndexPath ? { hnswIndexPath: options.hnswIndexPath } : {}),
        }
      : {}),
  };

  // Adaptive budget: derive task complexity from triage and let the package
  // estimator resize the token budget. Auto-enable for complex tasks unless
  // explicitly disabled via enableAdaptiveBudget: false.
  const taskMode = triageTask(input.task);
  const enableAdaptiveBudget =
    options.enableAdaptiveBudget !== false &&
    (options.enableAdaptiveBudget === true || taskMode === "complex");
  if (enableAdaptiveBudget) {
    packageOptions.taskMode = taskMode;
  }

  // RepoMap overview fallback for tight budgets (opt-in).
  if (options.enableRepoMapFallback) {
    packageOptions.enableRepoMapFallback = true;
  }

  const { buildEnhancedContextPackage } = await import("../graph/context-slicer.js");
  const pkg = await buildEnhancedContextPackage(
    options.graphClient,
    query,
    input.task,
    maxTokens,
    packageOptions
  );

  options.onContextPackage?.(pkg);
  return pkg;
}

export function appendContextFeedback(
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

export function buildPromptContext(
  contextPackage: LayeredContextPackage | undefined,
  skillHints: string[],
  episodeSummaries: string[],
  options?: OrchestrateOptions
): PromptContext | undefined {
  const includeGraph = options?.enableGraphContextInPrompt === true && contextPackage !== undefined;
  const includeEpisodes = options?.enableEpisodicMemory === true && episodeSummaries.length > 0;
  // Skill hints should be injected independently of graph context,
  // so that skill flywheel works even without near-lossless context.
  const includeSkillHints = skillHints.length > 0;
  if (!includeGraph && !includeEpisodes && !includeSkillHints) {
    return undefined;
  }
  const ctx: PromptContext = {};
  if (includeGraph && contextPackage && contextPackage.summaryChannel.length > 0) {
    ctx.summaryChannel = contextPackage.summaryChannel;
  }
  if (includeSkillHints) {
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

export async function maybeBuildSkillHints(task: string, options?: OrchestrateOptions): Promise<string[]> {
  if (!options?.enableSkillFlywheel || !options.graphClient) {
    return [];
  }

  return suggestSkillHints(options.graphClient, task, options.skillHintsLimit ?? 3);
}

const COMPLEX_KEYWORDS = [
  "refactor",
  "architecture",
  "redesign",
  "migrate",
  "restructure",
  "orchestration",
  "runtime",
];

export async function maybeRunPlanInsightForComplex(
  task: string,
  options?: OrchestrateOptions
): Promise<AgentDelegatedPlanInsight | undefined> {
  try {
    const config = resolveConfig(options?.configPath);

    if (!hasUsableLlmProvider(config)) {
      return buildAgentDelegatedPlanInsight(task);
    }

    const taskLower = task.toLowerCase();
    const hasComplexKeyword = COMPLEX_KEYWORDS.some((kw) => taskLower.includes(kw));
    if (task.length < 50 && !hasComplexKeyword) {
      logger.info({ task }, "Skipping full ATP for short simple task");
      const result = await planInsight(task, { selection: resolveModelForRole("planner") }, false);
      return {
        mode: "llm",
        insight: result.insight,
        plan: result.plan,
      };
    }

    const selection = resolveModelForRole("planner");
    const result = await planInsight(task, { selection }, true);
    const atp = (result as { atp?: unknown }).atp;
    return {
      mode: "llm",
      insight: result.insight,
      plan: result.plan,
      ...(atp !== undefined ? { atp } : {}),
    };
  } catch (error) {
    logger.warn({ error, task }, "Plan insight failed, using agent-delegated heuristic");
    return buildAgentDelegatedPlanInsight(task);
  }
}