import { brainstormTask } from "../../../agents/brainstormer";
import { planTasks } from "../../../agents/planner";
import { planInsight, type SixHatsInsight } from "../../../agents/insight";
import { hasUsableLlmProvider } from "../../../config/llm-availability";
import {
  buildAgentDelegatedPlanInsight,
  buildAgentDelegatedSimplePlan,
  attachSkillConditionToPlanNodes,
  type AgentDelegationMode,
  type AgentWorkItem,
  type SkillConditionOptions,
} from "../../../core/agent-delegation";
import { resolveConfig } from "../../../config/resolve";
import { resolveLearningPath } from "../../../config/paths";
import { orchestrate, type OrchestrateOptions } from "../../../core/orchestrator";
import type { TaskRunResult } from "../../../core/types";
import { triageTask } from "../../../core/triage";
import { createGraphClient } from "../../../graph/client-factory";
import { indexWorkspaceFiles, hasPendingGraphIndexWork } from "../../../graph/file-indexer";
import { appendFeedbackEvent } from "../../../learning/learning-events";
import { updateEpisodeOutcome, type DeviationKind } from "../../../learning/episodic-memory";
import {
  linkEpisodeToEngineeringNodes,
  type EngineeringLinkHints,
} from "../../../graph/episode-engineering-links.js";
import {
  applySkillLearning,
  cleanupNoiseSkills,
  extractSkillAtoms,
  pruneFailedSkills,
  suggestSkillConditionHints,
} from "../../../learning/skill-flywheel";
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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRuntimeTimelineSummary } from "../../../core/cancellation";
import { bindRuntimeWorkspaceRoot, resolveRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import { getEmbeddingQualitySummary } from "../../../learning/embedding-quality";
import { resolveActiveEmbeddingBackend } from "../../../config/embedding-factory";
import { buildEmbeddingOptions } from "./env.js";
import { extractTokenCost } from "./helpers.js";
import { hasIndexCache } from "../../../graph/file-indexer-cache";
import { getFlywheelReport } from "./graph.js";
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
    const hasExternalLlm = hasUsableLlmProvider(config);
    const orchestrateOptions: OrchestrateOptions = {
      graphClient,
      enableAutoGraphSync: config.graphPolicy.enableAutoBuild,
      maxContextTokens: config.graphPolicy.maxContextTokens,
      enableEpisodicMemory: config.learningPolicy.enableFlywheel,
      enableLlmAgents: hasExternalLlm,
      enableLlmTriage: false,
      executionMode: hasExternalLlm ? "llm" : "bridge",
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
  // P0-1: report the ACTIVE embedding backend — "semantic" when a real model
  // (MiniLM via transformers / OpenAI) is active, "off" for FNV-1a hash or none.
  const embeddingBackend = resolveActiveEmbeddingBackend(config);

  const workspaceRoot = computeWorkspaceRootDiagnosis(config);
  const graphFreshness = computeGraphFreshnessDiagnosis(config);
  const modelCache = computeModelCacheDiagnosis();
  const providerEntries = Object.entries(health).filter(([, v]) => v);
  const connectivitySummary = {
    total: Object.keys(health).length,
    healthy: providerEntries.length,
    unhealthy: Object.keys(health).length - providerEntries.length,
    providerNames: providerEntries.map(([k]) => k),
  };

  const flywheelReport = getFlywheelReport(configPath);
  const flywheel = {
    autoCaptureEnabled: flywheelReport.autoCaptureEnabled,
    episodes: {
      total: flywheelReport.episodes.total,
      pass: flywheelReport.episodes.pass,
      fail: flywheelReport.episodes.fail,
      pending: flywheelReport.episodes.pending,
    },
    skills: {
      total: flywheelReport.skills.total,
      byOutcomeKind: { ...flywheelReport.skills.byOutcomeKind },
    },
    sessionJournal: { ...flywheelReport.sessionJournal },
    experience: { ...flywheelReport.experience },
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
    embeddingBackend,
    embeddingQuality: getEmbeddingQualitySummary(),
    runtimeTimeline: getRuntimeTimelineSummary(),
    workspaceRoot,
    graphFreshness,
    modelCache,
    connectivitySummary,
    flywheel,
  };
}

function computeWorkspaceRootDiagnosis(config: ReturnType<typeof resolveConfig>) {
  const envSet = Boolean(process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim());
  const resolved = resolveRuntimeWorkspaceRoot({
    ...(config.graphPolicy.workspaceRoot ? { projectWorkspaceRoot: config.graphPolicy.workspaceRoot } : {}),
  });
  let discovery: "env" | "config" | "auto" | "cwd" = "cwd";
  if (envSet) {
    discovery = "env";
  } else if (config.graphPolicy.workspaceRoot) {
    discovery = "config";
  } else if (resolved !== process.cwd()) {
    discovery = "auto";
  }
  const exists = existsSync(resolved);
  const hasPackageJson = exists && existsSync(join(resolved, "package.json"));
  const stale = envSet && (!exists || !hasPackageJson);
  return { path: resolved, discovery, exists, hasPackageJson, stale };
}

function computeGraphFreshnessDiagnosis(config: ReturnType<typeof resolveConfig>) {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const cached = hasIndexCache(root);
  let stale = false;
  let cacheFileCount = 0;
  if (cached) {
    stale = hasPendingGraphIndexWork(root);
    try {
      const cachePath = join(root, ".graphflow-cache", "index-state.json");
      const raw = readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      cacheFileCount = parsed?.state ? Object.keys(parsed.state).length : 0;
    } catch {
      cacheFileCount = 0;
    }
  }
  return { hasIndexCache: cached, stale, cacheFileCount };
}

function computeModelCacheDiagnosis() {
  const envDir = process.env.GRAPHFLOW_EMBEDDING_CACHE_DIR?.trim();
  const defaultDir = join(homedir(), ".cache", "huggingface");
  const cacheDir = envDir || defaultDir;
  const resolution: "env" | "default" = envDir ? "env" : "default";
  const exists = existsSync(cacheDir) || existsSync(join(cacheDir, "hub"));
  return { exists, path: cacheDir, resolution };
}

export function diagnoseRouting(configPath?: string): string {
  const result = diagnoseRoutingResult(configPath);
  const experience = result.flywheel?.experience;
  return [
    `dynamicRouting=${result.dynamicRouting ? "on" : "off"}`,
    `health=openai:${result.health.openai},anthropic:${result.health.anthropic},bailian:${result.health.bailian},doubao:${result.health.doubao},deepseek:${result.health.deepseek}`,
    `priority=${result.priority.join(",")}`,
    `planner=${result.planner.provider}/${result.planner.model}${result.planner.fallbackApplied ? ":fallback" : ""}`,
    `worker=${result.worker.provider}/${result.worker.model}${result.worker.fallbackApplied ? ":fallback" : ""}`,
    `validator=${result.validator.provider}/${result.validator.model}${result.validator.fallbackApplied ? ":fallback" : ""}`,
    `compression=${result.compression.backend}:${result.compression.provider}/${result.compression.model}${result.compression.embedded ? ":embedded" : ""}`,
    `embeddings=${result.embeddingBackend}`,
    ...(experience
      ? [
          `experience=conv:${experience.episodeToSkillConversionRate.toFixed(2)},lessons:${experience.lessonsCoverageRate.toFixed(2)},consol:${experience.consolidation?.actionable ?? 0}`,
        ]
      : []),
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
      const ok = cleaned.length > 0 && !/^\[(openai|anthropic|bailian|doubao|deepseek):/i.test(cleaned);
    return {
      role,
      provider: selection.provider,
      model: selection.model,
      ok,
      latencyMs: Date.now() - started,
      sample: cleaned,
      ...(ok
        ? {}
        : {
            error: !process.env[
              selection.provider === "deepseek"
                ? "DEEPSEEK_API_KEY"
                : selection.provider === "anthropic"
                  ? "ANTHROPIC_API_KEY"
                  : selection.provider === "bailian"
                    ? "BAILIAN_API_KEY"
                    : selection.provider === "doubao"
                      ? "DOUBAO_API_KEY"
                      : "OPENAI_API_KEY"
            ]?.trim()
              ? "Missing provider credentials (config not applied or apiKey empty)"
              : "Provider returned placeholder/fallback output",
          }),
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

export async function planAndBrainstormResult(
  task: string,
  configPath?: string
): Promise<PlanPreviewResult> {
  const config = resolveConfig(configPath);

  let skillCondition: SkillConditionOptions | undefined;
  if (config.skillPolicy?.enableSkillFlywheel !== false) {
    try {
      const graphClient = createGraphClient(config);
      const hints = await suggestSkillConditionHints(
        graphClient,
        task,
        config.skillPolicy?.maxSkillHints ?? 3
      );
      if (hints.skillRefs.length > 0 || hints.avoidPatterns.length > 0) {
        skillCondition = hints;
      }
    } catch {
      // Skill conditioning is best-effort; plan packaging must not fail.
    }
  }

  // No GraphFlow LLM → bridge to connected coding agent for task decomposition.
  // Local heuristic DAG is attached as suggestedNodes only.
  if (!hasUsableLlmProvider(config)) {
    return buildAgentDelegatedSimplePlan(task, skillCondition);
  }

  const mode = triageTask(task);
  const ideas = brainstormTask(task);
  const nodes = attachSkillConditionToPlanNodes(
    planTasks(task, skillCondition?.skillRefs).map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
      ...(node.skillRefs && node.skillRefs.length > 0 ? { skillRefs: node.skillRefs } : {}),
    })),
    skillCondition
  );

  return {
    mode,
    ideas,
    nodes,
    nodesStatus: "final",
    complete: true,
    requiresAgentBridge: false,
  };
}

export async function planAndBrainstorm(task: string, configPath?: string): Promise<string> {
  const result = await planAndBrainstormResult(task, configPath);
  const planPart = result.nodes
    .map((node) => `${node.id}[${node.dependencies.join(",") || "-"}]:${node.description}`)
    .join(" | ");
  const bridge =
    result.requiresAgentBridge === true
      ? `; bridge=awaiting-agent; workItems=${result.agentWorkItems?.length ?? 0}`
      : "";
  return [
    `mode=${result.mode}`,
    `ideas=${result.ideas.join(" | ")}`,
    `plan=${planPart}${bridge}`,
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
  status?: "awaiting-agent" | "complete";
  complete?: boolean;
  requiresAgentBridge?: boolean;
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
      status: "awaiting-agent",
      complete: false,
      requiresAgentBridge: true,
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
    status: "complete",
    complete: true,
    requiresAgentBridge: false,
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
 * 2. Applies skill score updates that were skipped during delegation
 *    (failure learning is dampened without quality lessons).
 * 3. Soft-prunes chronically failing atomic skills from insight surfaces.
 */
const MAX_OUTCOME_LESSONS = 4;
const MIN_QUALITY_LESSON_CHARS = 8;

/**
 * Trim, drop empties, cap at 4. Used by reportOutcome before episode update.
 */
export function sanitizeOutcomeLessons(lessons: string[]): string[] {
  return lessons
    .map((lesson) => (typeof lesson === "string" ? lesson.trim() : ""))
    .filter((lesson) => lesson.length > 0)
    .slice(0, MAX_OUTCOME_LESSONS);
}

function countQualityLessons(lessons: string[]): number {
  return lessons.filter((lesson) => lesson.length >= MIN_QUALITY_LESSON_CHARS).length;
}

/**
 * Decide whether bridge outcome should drive skill score updates.
 * Success runs when task+lessons yield atoms; failure requires quality lessons (>=8 chars).
 */
export function shouldApplySkillLearningFromOutcome(
  success: boolean,
  task: string,
  sanitizedLessons: string[]
): boolean {
  if (!success) {
    // Failure without quality lessons: skip penalty spam.
    return countQualityLessons(sanitizedLessons) > 0;
  }
  const corpus = [task, ...sanitizedLessons].filter(Boolean).join(" and ");
  return extractSkillAtoms(corpus).length > 0;
}

export async function reportOutcome(
  episodeId: string,
  success: boolean,
  lessons: string[],
  configPath?: string,
  deviation?: DeviationKind,
  /** Optional episode → Requirement/Concept/code derived_from links (Engineering KG). */
  engineeringHints?: EngineeringLinkHints
): Promise<ReportOutcomeResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);

  // P0-2: prune legacy pure-noise skill nodes (no symbol evidence) at load,
  // before any new learning is applied in this process.
  if (config.skillPolicy?.enableSkillFlywheel) {
    try {
      await cleanupNoiseSkills(graphClient);
    } catch {
      // cleanup failure must not block the outcome report
    }
  }

  const sanitizedLessons = sanitizeOutcomeLessons(lessons ?? []);

  // Always update episode outcome (success/fail), even when skill learning is dampened.
  const updated = await updateEpisodeOutcome(
    graphClient,
    episodeId,
    success ? "pass" : "fail",
    sanitizedLessons,
    deviation
  );
  if (!updated) {
    return { ok: false, reason: `Episode not found: ${episodeId}` };
  }

  // Apply skill score updates that were skipped during bridge delegation.
  // Lessons are folded into skill atom extraction so short/generic tasks still learn.
  let skillsUpdated = 0;
  if (
    config.skillPolicy?.enableSkillFlywheel &&
    shouldApplySkillLearningFromOutcome(success, updated.task, sanitizedLessons)
  ) {
    const syntheticRun: TaskRunResult = {
      status: success ? "COMPLETED" : "FAILED",
      attempts: updated.attempts,
      feedback: updated.runFeedback ?? "",
    };
    skillsUpdated = await applySkillLearning(
      graphClient,
      updated.task,
      syntheticRun,
      sanitizedLessons,
      {
        // Episode-record material (plan descriptions, key decisions) supplies
        // project-symbol evidence for the extraction gate.
        evidence: [
          ...updated.plan.map((p) => p.description),
          ...updated.keyDecisions,
        ],
        // This success is linked to the episode via reportOutcome: counts as a
        // "linked successful outcome" for the proven classification.
        linked: true,
      }
    );
  } else if (config.skillPolicy?.enableSkillFlywheel) {
    // Still soft-prune toxic skills when learning is dampened.
    await pruneFailedSkills(graphClient);
  }

  let engineeringLinks: ReportOutcomeResult["engineeringLinks"];
  const hints = engineeringHints ?? {};
  const hasEngHints =
    (hints.requirementIds?.length ?? 0) > 0 ||
    (hints.conceptIds?.length ?? 0) > 0 ||
    (hints.codeHints?.length ?? 0) > 0;
  if (hasEngHints) {
    try {
      const linked = await linkEpisodeToEngineeringNodes(graphClient, updated.id, hints);
      if (linked.edgeCount > 0) {
        engineeringLinks = {
          edgeCount: linked.edgeCount,
          linkedRequirementIds: linked.linkedRequirementIds,
          linkedConceptIds: linked.linkedConceptIds,
          linkedCodeNodeIds: linked.linkedCodeNodeIds,
        };
      }
    } catch {
      // Engineering link failure must not block outcome reporting.
    }
  }

  return {
    ok: true,
    episodeId: updated.id,
    outcome: success ? "pass" : "fail",
    skillsUpdated,
    ...(updated.deviation !== undefined ? { deviation: updated.deviation } : {}),
    ...(engineeringLinks ? { engineeringLinks } : {}),
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
