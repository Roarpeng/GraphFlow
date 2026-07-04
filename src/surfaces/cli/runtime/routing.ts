import { brainstormTask } from "../../../agents/brainstormer";
import { planTasks } from "../../../agents/planner";
import { planInsight, type SixHatsInsight } from "../../../agents/insight";
import { hasUsableLlmProvider } from "../../../config/llm-availability";
import {
  buildAgentDelegatedPlanInsight,
  type AgentDelegationMode,
  type AgentWorkItem,
} from "../../../core/agent-delegation";
import { resolveConfig } from "../../../config/resolve";
import { resolveLearningPath } from "../../../config/paths";
import { orchestrate, type OrchestrateOptions } from "../../../core/orchestrator";
import type { TaskRunResult } from "../../../core/types";
import { triageTask } from "../../../core/triage";
import { createGraphClient } from "../../../graph/client-factory";
import { indexWorkspaceFiles, hasPendingGraphIndexWork } from "../../../graph/file-indexer";
import { appendFeedbackEvent } from "../../../learning/learning-events";
import { updateEpisodeOutcome } from "../../../learning/episodic-memory";
import { applySkillLearning } from "../../../learning/skill-flywheel";
import {
  resolveModelForRole,
  resolveModelWithFallback,
  type ModelSelection,
  type ProviderName,
} from "../../../routing/model-router";
import { buildFallbackChain, buildProviderHealthMap } from "../../../routing/provider-health";
import { executeRolePrompt } from "../../../routing/provider-executor";
import {
  mergeAgentInsightsFromGraph,
  type MergeAgentInsightsResult,
} from "../../../core/merge-agent-insight";
import {
  submitAgentInsight,
  type SubmitAgentInsightResult,
} from "../../../core/submit-agent-insight";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import { buildEmbeddingOptions } from "./env.js";
import { extractTokenCost } from "./helpers.js";
import type {
  PlanPreviewResult,
  ReportOutcomeResult,
  RoutingConnectivityProbe,
  RoutingDiagnosisResult,
  RunTaskSummary,
} from "./types.js";

export async function runTaskResult(task: string, configPath?: string): Promise<RunTaskSummary> {
  const config = resolveConfig(configPath);
  const eventsPath = resolveLearningPath(config, "eventsPath");

  try {
    const graphClient = createGraphClient(config);
    if (config.graphPolicy.autoIndexOnRun) {
      const root = config.graphPolicy.workspaceRoot ?? process.cwd();
      const indexOptions = config.graphPolicy.includeExtensions
        ? { includeExtensions: config.graphPolicy.includeExtensions }
        : undefined;
      if (hasPendingGraphIndexWork(root, indexOptions)) {
        await indexWorkspaceFiles(graphClient, root, {
          ...indexOptions,
        });
      }
    }

    const embeddingOptions = buildEmbeddingOptions(config);
    const taskComplexity = triageTask(task);
    const enableAdaptiveBudget =
      config.graphPolicy.compression?.enableAdaptiveBudget !== false &&
      (config.graphPolicy.compression?.enableAdaptiveBudget === true ||
        taskComplexity === "complex");
    const orchestrateOptions: OrchestrateOptions = {
      graphClient,
      enableAutoGraphSync: config.graphPolicy.enableAutoBuild,
      maxContextTokens: config.graphPolicy.maxContextTokens,
      enableEpisodicMemory: config.learningPolicy.enableFlywheel,
      enableLlmAgents: false,
      enableLlmTriage: false,
      executionMode: "bridge", // Default to bridge mode: delegate execution to external agents
      ...(configPath ? { configPath } : {}),
      ...embeddingOptions,
      ...(config.skillPolicy?.enableSkillFlywheel
        ? {
            enableSkillFlywheel: true,
            ...(config.skillPolicy.maxSkillHints !== undefined
              ? { skillHintsLimit: config.skillPolicy.maxSkillHints }
              : {}),
          }
        : { enableSkillFlywheel: false }),
      providerHealth: buildProviderHealthMap(config),
      ...(config.routingPolicy?.enableDynamicRouting
        ? { providerFallbackChain: buildFallbackChain(config) }
        : {}),
      ...(config.graphPolicy.enableNearLosslessMode !== undefined
        ? { enableNearLosslessMode: config.graphPolicy.enableNearLosslessMode }
        : {}),
      ...(config.graphPolicy.layerQuota ? { layerQuota: config.graphPolicy.layerQuota } : {}),
      ...(config.graphPolicy.compression?.enableGraphCompression !== undefined
        ? { enableGraphCompression: config.graphPolicy.compression.enableGraphCompression }
        : {}),
      ...(enableAdaptiveBudget ? { enableAdaptiveBudget: true } : {}),
      ...(config.graphPolicy.compression?.enableRepoMapFallback
        ? { enableRepoMapFallback: true }
        : {}),
    };

    const result = await orchestrate({ task }, orchestrateOptions);

    appendFeedbackEvent(eventsPath, {
      query: task,
      passed: result.status === "COMPLETED",
      tokenCost: extractTokenCost(result.feedback),
      retries: Math.max(0, result.attempts - 1),
    });

    return {
      status: result.status,
      attempts: result.attempts,
      feedback: result.feedback,
      ...(result.episodeId ? { episodeId: result.episodeId } : {}),
      ...(result.executionDescriptor ? { executionDescriptor: result.executionDescriptor } : {}),
    };
  } catch (error) {
    appendFeedbackEvent(eventsPath, {
      query: task,
      passed: false,
      tokenCost: 0,
      retries: 0,
    });
    // 与 orchestrator 顶层错误边界一致：将未捕获异常收敛为 HUMAN_REVIEW_REQUIRED 结构化结果，
    // 不再裸抛给调用方（包括索引失败、图存储不可达等场景）
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "HUMAN_REVIEW_REQUIRED" as const,
      attempts: 0,
      feedback: `Orchestration aborted due to unexpected error: ${message}`,
    };
  }
}

export async function runTask(task: string, configPath?: string): Promise<string> {
  const result = await runTaskResult(task, configPath);
  return `status=${result.status}; attempts=${result.attempts}; feedback=${result.feedback}`;
}

export function diagnoseRoutingResult(configPath?: string): RoutingDiagnosisResult {
  const config = resolveConfig(configPath);
  const health = buildProviderHealthMap(config);
  const chain = buildFallbackChain(config);

  const resolve = (role: "planner" | "worker" | "validator") => {
    if (!config.routingPolicy?.enableDynamicRouting) {
      return resolveModelForRole(role);
    }

    return resolveModelWithFallback(role, health, chain);
  };

  const planner = resolve("planner");
  const worker = resolve("worker");
  const validator = resolve("validator");

  const compression = {
    backend: "off" as const,
    provider: "none",
    model: "none",
    embedded: false,
  };

  return {
    dynamicRouting: config.routingPolicy?.enableDynamicRouting ?? false,
    health,
    priority: chain,
    planner: {
      provider: planner.provider,
      model: planner.model,
      fallbackApplied: planner.fallbackApplied,
    },
    worker: {
      provider: worker.provider,
      model: worker.model,
      fallbackApplied: worker.fallbackApplied,
    },
    validator: {
      provider: validator.provider,
      model: validator.model,
      fallbackApplied: validator.fallbackApplied,
    },
    compression,
  };
}

export function diagnoseRouting(configPath?: string): string {
  const result = diagnoseRoutingResult(configPath);
  return [
    `dynamicRouting=${result.dynamicRouting ? "on" : "off"}`,
    `health=openai:${result.health.openai},anthropic:${result.health.anthropic},bailian:${result.health.bailian},doubao:${result.health.doubao}`,
    `priority=${result.priority.join(",")}`,
    `planner=${result.planner.provider}/${result.planner.model}${result.planner.fallbackApplied ? ":fallback" : ""}`,
    `worker=${result.worker.provider}/${result.worker.model}${result.worker.fallbackApplied ? ":fallback" : ""}`,
    `validator=${result.validator.provider}/${result.validator.model}${result.validator.fallbackApplied ? ":fallback" : ""}`,
    `compression=${result.compression.backend}:${result.compression.provider}/${result.compression.model}${result.compression.embedded ? ":embedded" : ""}`,
  ].join("; ");
}

function diagnosisRoleToSelection(
  role: "planner" | "worker",
  diagnosis: RoutingDiagnosisResult
): ModelSelection {
  const entry = diagnosis[role];
  return {
    provider: entry.provider as ProviderName,
    model: entry.model,
    tier: role === "planner" ? "smart" : "economy",
    fallbackApplied: entry.fallbackApplied,
  };
}

async function probeRoleConnectivity(
  role: "planner" | "worker",
  selection: ModelSelection
): Promise<RoutingConnectivityProbe> {
  const started = Date.now();
  try {
    const sample = await executeRolePrompt(role, "Reply with exactly: ok", selection);
    const cleaned = sample.trim().slice(0, 120);
    const ok = cleaned.length > 0 && !/^\[(openai|anthropic|bailian|doubao):/i.test(cleaned);
    return {
      role,
      provider: selection.provider,
      model: selection.model,
      ok,
      latencyMs: Date.now() - started,
      sample: cleaned,
      ...(ok ? {} : { error: "Provider returned placeholder/fallback output" }),
    };
  } catch (error) {
    return {
      role,
      provider: selection.provider,
      model: selection.model,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeRoutingConnectivity(
  configPath?: string
): Promise<RoutingConnectivityProbe[]> {
  const diagnosis = diagnoseRoutingResult(configPath);
  return Promise.all([
    probeRoleConnectivity("planner", diagnosisRoleToSelection("planner", diagnosis)),
    probeRoleConnectivity("worker", diagnosisRoleToSelection("worker", diagnosis)),
  ]);
}

export function planAndBrainstormResult(task: string): PlanPreviewResult {
  const mode = triageTask(task);
  const ideas = brainstormTask(task);
  const nodes = planTasks(task).map((node) => ({
    id: node.id,
    description: node.description,
    dependencies: node.dependencies,
  }));

  return {
    mode,
    ideas,
    nodes,
  };
}

export function planAndBrainstorm(task: string): string {
  const result = planAndBrainstormResult(task);
  return [
    `mode=${result.mode}`,
    `ideas=${result.ideas.join(" | ")}`,
    `plan=${result.nodes
      .map((node) => `${node.id}[${node.dependencies.join(",") || "-"}]:${node.description}`)
      .join(" | ")}`,
  ].join("; ");
}

export interface PlanInsightResult {
  mode: AgentDelegationMode;
  insight: SixHatsInsight;
  plan: Array<{
    id: string;
    description: string;
    dependencies: string[];
  }>;
  agentWorkItems?: AgentWorkItem[];
  agentInstructions?: string;
}

export async function planInsightResult(task: string, configPath?: string): Promise<PlanInsightResult> {
  const config = resolveConfig(configPath);

  if (!hasUsableLlmProvider(config)) {
    const delegated = buildAgentDelegatedPlanInsight(task);
    return {
      mode: delegated.mode,
      insight: delegated.insight,
      plan: (delegated.plan ?? []).map((node) => ({
        id: node.id,
        description: node.description,
        dependencies: node.dependencies,
      })),
      ...(delegated.agentWorkItems ? { agentWorkItems: delegated.agentWorkItems } : {}),
      ...(delegated.agentInstructions ? { agentInstructions: delegated.agentInstructions } : {}),
    };
  }

  const selection = resolveModelForRole("planner");

  const { insight, plan } = await planInsight(task, { selection });

  return {
    mode: "llm",
    insight,
    plan: (plan ?? []).map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
    })),
  };
}

// Re-export planInsight so it can be imported from runtime.ts
export { planInsight } from "../../../agents/insight";

/**
 * Report the real execution outcome of a bridge-mode task back to GraphFlow.
 *
 * In bridge mode, `graphflow_run` delegates execution to an external coding
 * agent and records the episode as "pending". The external agent calls this
 * function (via the `graphflow_report_outcome` MCP tool) after it finishes
 * executing the `executionDescriptor`. This closes the learning loop:
 *
 * 1. Updates the episode record from "pending" → "pass"/"fail".
 * 2. Applies skill score updates that were skipped during delegation.
 */
export async function reportOutcome(
  episodeId: string,
  success: boolean,
  lessons: string[],
  configPath?: string
): Promise<ReportOutcomeResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);

  const updated = await updateEpisodeOutcome(
    graphClient,
    episodeId,
    success ? "pass" : "fail",
    lessons
  );
  if (!updated) {
    return { ok: false, reason: `Episode not found: ${episodeId}` };
  }

  // Apply skill score updates that were skipped during bridge delegation.
  if (config.skillPolicy?.enableSkillFlywheel) {
    const syntheticRun: TaskRunResult = {
      status: success ? "COMPLETED" : "FAILED",
      attempts: updated.attempts,
      feedback: updated.runFeedback ?? "",
    };
    await applySkillLearning(graphClient, updated.task, syntheticRun);
  }

  return {
    ok: true,
    episodeId: updated.id,
    outcome: success ? "pass" : "fail",
  };
}

export async function submitAgentInsightResult(
  task: string,
  workItemId: string,
  response: string,
  configPath?: string,
  episodeId?: string,
  rootDir?: string
): Promise<SubmitAgentInsightResult> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath),
    rootDir ? { rootDir } : undefined
  );
  const graphClient = createGraphClient(config);

  return submitAgentInsight(graphClient, {
    task,
    workItemId,
    response,
    ...(episodeId ? { episodeId } : {}),
  });
}

export async function mergeAgentInsightResult(
  task: string,
  configPath?: string,
  rootDir?: string
): Promise<MergeAgentInsightsResult> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath),
    rootDir ? { rootDir } : undefined
  );
  const graphClient = createGraphClient(config);
  return mergeAgentInsightsFromGraph(graphClient, task);
}

export type { SubmitAgentInsightResult } from "../../../core/submit-agent-insight";
export type { MergeAgentInsightsResult } from "../../../core/merge-agent-insight";
