import { tryBrainstormTaskLlm } from "../../../agents/brainstormer";
import { tryPlanTasksLlm } from "../../../agents/planner";
import { planInsight, type SixHatsInsight } from "../../../agents/insight";
import { hasUsableLlmProvider } from "../../../config/llm-availability";
import {
  buildAgentDelegatedPlanInsight,
  buildAgentDelegatedSimplePlan,
  buildLlmDegradedSimplePlan,
  attachSkillConditionToPlanNodes,
  type AgentDelegationMode,
  type AgentWorkItem,
  type SkillConditionOptions,
} from "../../../core/agent-delegation";
import { resolveConfig, resolveEfficiencyPolicy } from "../../../config/resolve";
import { resolveGraphStorePath, resolveLearningPath } from "../../../config/paths";
import { buildEfficiencyAdvisory, extractInlinedAnchorIds } from "../../../core/efficiency-advisory";
import { projectValidationGates } from "../../../core/project-validation";
import {
  appendDecisionLedgerRecord,
  loadEfficiencyPolicy,
} from "../../../learning/decision-ledger";
import { resolveEmbeddingDtype } from "../../../config/embedding-model";
import { getSqliteModuleSource } from "../../../graph/sqlite-client";
import { MERGE_MARKER_SUFFIX } from "../../../graph/store-migration";
import { inspectRuntimeDeps } from "../../../integrations/ensure-runtime-deps";
import { orchestrate, type OrchestrateOptions } from "../../../core/orchestrator";
import type { TaskRunResult } from "../../../core/types";
import { triageTask } from "../../../core/triage";
import { createGraphClient, getLastGraphStoreBackend, resolveIndexManifestName } from "../../../graph/client-factory";
import { indexWorkspaceFiles, hasPendingGraphIndexWork, indexedStoreIsIncomplete } from "../../../graph/file-indexer";
import { appendFeedbackEvent } from "../../../learning/learning-events";
import {
  restoreRecentEpisode,
  updateEpisodeOutcome,
  type DeviationKind,
} from "../../../learning/episodic-memory";
import {
  verifyOutcomeEvidence,
  type OutcomeEvidenceInput,
} from "../../../learning/evidence";
import {
  linkEpisodeToEngineeringNodes,
  type EngineeringLinkHints,
} from "../../../graph/episode-engineering-links.js";
import {
  applySkillLearning,
  cleanupNoiseSkills,
  extractSkillAtoms,
  pruneFailedSkills,
  pruneLegacyNoiseSkills,
  suggestSkillConditionHints,
} from "../../../learning/skill-flywheel";
import {
  resolveModelForRole,
  resolveModelWithFallback,
  type ModelSelection,
  type ProviderName,
} from "../../../routing/model-router";
import { buildFallbackChain, buildProviderHealthMap } from "../../../routing/provider-health";
import { getLastProviderError } from "../../../routing/provider-errors";
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
import { execFileSync } from "node:child_process";
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
import { diagnoseTeamConfig } from "../../team/diagnose.js";
import { buildWorkbenchOutlines, seedWorkbenchFromPlan } from "../../../learning/workbench-topic.js";
import type {
  PlanPreviewResult,
  ReportOutcomeResult,
  RoutingConnectivityProbe,
  RoutingDiagnosisResult,
  RunTaskSummary,
} from "./types.js";

/** In-process gitHead cache keyed by workspace root (see advisory wiring). */
const gitHeadCache = new Map<string, string | undefined>();

export interface LlmCheckProviderReport {
  provider: string;
  usable: boolean;
  source: string;
  baseUrl?: string;
  model?: string;
  envVarsChecked: string[];
  detail: string;
}

export interface LlmCheckReport {
  usable: boolean;
  tiers: { role: string; provider: string; model: string }[];
  providers: LlmCheckProviderReport[];
  typesafe: {
    configured: boolean;
    baseUrl: string;
    model: string;
    envVarsChecked: string[];
    note: string;
  };
  resolutionOrder: string;
}

/**
 * `graphflow llm-check` — why is (or isn't) my LLM usable? Reports the
 * winning credential SOURCE per provider (config key / env var NAME /
 * localhost / none), the env var names consulted (typos become visible),
 * and the TypeSafe System One (Jev) endpoint state. Read-only by design;
 * --probe adds a real round-trip on the tier worker role.
 */
export async function llmCheckResult(configPath?: string): Promise<LlmCheckReport> {
  // Read-only diagnostic: must answer from ANY working directory — a
  // diagnostic that itself refuses to run from home helps nobody (live
  // report from an Ubuntu user's home shell).
  const config = resolveConfig(configPath, undefined, { allowUnsafeWorkspace: true });
  const { explainProviderCredentials } = await import("../../../config/llm-availability.js");
  const candidates = Array.from(
    new Set<string>([
      config.tiers.smart.provider,
      config.tiers.economy.provider,
      ...Object.keys(config.providers),
    ])
  );
  const providers = candidates.map((provider) => {
    const explanation = explainProviderCredentials(provider, config);
    const model =
      provider === config.tiers.smart.provider
        ? config.tiers.smart.model
        : provider === config.tiers.economy.provider
          ? config.tiers.economy.model
          : undefined;
    return { provider, ...explanation, ...(model ? { model } : {}) };
  });
  const { resolveTypesafeCredentials, typesafeClientOptionsFromConfig, TYPESAFE_DEFAULT_MODEL } = await import(
    "../../../routing/typesafe-systemone.js"
  );
  const workerOptions = typesafeClientOptionsFromConfig(config);
  const ts = resolveTypesafeCredentials(workerOptions);
  return {
    usable: providers.some((p) => p.usable),
    tiers: [
      { role: "smart", provider: String(config.tiers.smart.provider), model: String(config.tiers.smart.model) },
      { role: "economy", provider: String(config.tiers.economy.provider), model: String(config.tiers.economy.model) },
    ],
    providers,
    typesafe: {
      configured: ts.apiKey !== undefined,
      baseUrl: ts.baseUrl,
      model: workerOptions.model ?? TYPESAFE_DEFAULT_MODEL,
      envVarsChecked: ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"],
      note: "System One (Jev) answers typed judgments on POST {base}/v1/systemone; it does not author commands or text. An exported TYPESAFE_API_KEY wins; a typesafe-jev worker's configured apiKey (env reference, or a literal that passes the placeholder check) is the fallback.",
    },
    resolutionOrder: "genuine env key of the endpoint vendor (process env, then Windows registry) > config ${ENV} reference > config literal (placeholder/whitespace literals rejected) > localhost endpoint > provider env keys; config-exported env values are invisible to sniffing (no self-feedback)",
  };
}

export async function runTaskResult(
  task: string,
  configPath?: string,
  rootDir?: string
): Promise<RunTaskSummary> {
  const config = resolveConfig(configPath, rootDir ? { rootDir } : undefined);
  const eventsPath = resolveLearningPath(config, "eventsPath");

  try {
    const graphClient = createGraphClient(config);
    if (config.graphPolicy.autoIndexOnRun) {
      const root = config.graphPolicy.workspaceRoot ?? process.cwd();
      const indexOptions = {
        ...(config.graphPolicy.includeExtensions ? { includeExtensions: config.graphPolicy.includeExtensions } : {}),
        ...(config.graphPolicy.excludeGlobs?.length ? { excludeGlobs: config.graphPolicy.excludeGlobs } : {}),
        ...(typeof config.graphPolicy.maxFileSizeBytes === "number"
          ? { maxFileSizeBytes: config.graphPolicy.maxFileSizeBytes }
          : {}),
      };
      const storeIncomplete = indexedStoreIsIncomplete(
        root,
        graphClient.indexManifestName,
        graphClient.readSnapshot?.().nodes
      );
      if (
        storeIncomplete ||
        hasPendingGraphIndexWork(root, { ...indexOptions, manifestName: graphClient.indexManifestName })
      ) {
        await indexWorkspaceFiles(graphClient, root, {
          ...indexOptions,
          ...(storeIncomplete ? { forceReindex: true } : {}),
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
    // Pre-flight worker round-trip: an unreachable/mis-credentialed provider
    // must behave EXACTLY like no provider at all. Without this, a revoked
    // key burned the full retry budget on adapter echo placeholders (3 ×
    // HUMAN_REVIEW_REQUIRED) instead of handing the task to the connected
    // agent via bridge mode (live finding on a 401'd key).
    let executionMode: "llm" | "bridge" = hasExternalLlm ? "llm" : "bridge";
    let bridgeReason: string | undefined;
    if (hasExternalLlm) {
      const rawProbeMs = Number.parseInt(process.env.GRAPHFLOW_RUN_PROBE_TIMEOUT_MS ?? "", 10);
      const probeMs = Number.isFinite(rawProbeMs) && rawProbeMs > 0 ? rawProbeMs : 5_000;
      const selection = resolveModelForRole("worker", configPath);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), probeMs);
      try {
        const probe = await probeRoleConnectivity("worker", selection, controller.signal, configPath);
        if (!probe.ok) {
          executionMode = "bridge";
          bridgeReason =
            `worker connectivity probe failed: ${probe.error ?? "no usable reply"} ` +
            `(latency ${probe.latencyMs}ms, provider ${selection.provider}/${selection.model}) — ` +
            `treating the LLM as unavailable and bridging to the connected agent`;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    const orchestrateOptions: OrchestrateOptions = {
      graphClient,
      workspaceRoot: config.graphPolicy.workspaceRoot ?? rootDir ?? process.cwd(),
      enableAutoGraphSync: config.graphPolicy.enableAutoBuild,
      maxContextTokens: config.graphPolicy.maxContextTokens,
      enableEpisodicMemory: config.learningPolicy.enableFlywheel,
      enableLlmAgents: executionMode === "llm",
      enableLlmTriage: false,
      executionMode,
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
      ...(resolveEfficiencyPolicy(config).actionFusion.enabled ? { enableActionFusion: true } : {}),
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

    // 2.x groundwork: deterministic (Layer A) Shadow advisory — the Execution
    // Contract embryo riding the run summary — plus its own cost record in
    // the decision ledger. Failure-isolated: advising must never break a run.
    let advisory: RunTaskSummary["advisory"];
    try {
      const advisoryStart = Date.now();
      // §5 contract inputs: project identity (gitHead best-effort, ~10ms) and
      // the context-cache hit signal for this exact task text.
      const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
      let gitHead: string | undefined;
      // One subprocess per workspace root per process — a benchmark looping
      // 50 tasks over one root must not pay 50 × ~60ms for identity lookup
      // (measured regression before this cache: avgDecisionMs 0 → 65).
      if (!gitHeadCache.has(workspaceRoot)) {
        try {
          gitHeadCache.set(
            workspaceRoot,
            execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, timeout: 2_000 })
              .toString()
              .trim()
          );
        } catch {
          gitHeadCache.set(workspaceRoot, undefined); // not a repo / git missing — degrades honestly
        }
      }
      gitHead = gitHeadCache.get(workspaceRoot);
      let contextCacheHit: boolean | undefined;
      try {
        const { getCachedContext } = await import("../../../graph/context-cache.js");
        contextCacheHit = getCachedContext(task, workspaceRoot) !== undefined;
      } catch {
        contextCacheHit = undefined;
      }
      // Layer B: gray-zone similarity (0.3..0.7) goes to the REAL TypeSafe
      // System One API (choice over REUSE/ADAPT/FRESH + confidence score)
      // when TYPESAFE_API_KEY is present; every failure path falls back to
      // deterministic Layer A. The old worker guessed a chat-completions
      // endpoint on a fabricated domain — Jev answers typed questions.
      const { evaluateMetaAdvisory } = await import("../../../core/meta-advisory.js");
      const { createJevMetaReflector, createSystemOneClient, typesafeClientOptionsFromConfig } = await import(
        "../../../routing/typesafe-systemone.js"
      );
      const built = await evaluateMetaAdvisory(
        {
          task,
          taskComplexity,
          executionMode,
          fusedSteps: result.executionDescriptor?.steps ?? [],
          ...(result.similarEpisodes ? { similarEpisodes: result.similarEpisodes } : {}),
          requiredAnchors: extractInlinedAnchorIds(result.executionDescriptor?.context),
          projectValidation: projectValidationGates(workspaceRoot),
          maxContextTokens: config.graphPolicy.maxContextTokens,
          ...(contextCacheHit !== undefined ? { contextCacheHit } : {}),
          project: { root: workspaceRoot, ...(gitHead ? { gitHead } : {}) },
          durationMs: 0,
        },
        { metaReflector: createJevMetaReflector(createSystemOneClient(typesafeClientOptionsFromConfig(config))) }
      );
      advisory = {
        ...built,
        decision: { ...built.decision, durationMs: Math.max(0, Date.now() - advisoryStart) },
      };
      // §21 closed loop: a learned policy (eff-agent policy learn over the
      // decision ledger) overrides the deterministic worker hints and is
      // stamped on the advisory so the override stays auditable.
      const policy = loadEfficiencyPolicy(config);
      if (policy) {
        const tier = policy.modelTierByCategory[taskComplexity];
        if (tier === "economy" || tier === "standard" || tier === "heavy") {
          advisory = { ...advisory, worker: { ...advisory.worker, modelTier: tier } };
        }
        const execMode = policy.executionModeByCategory[taskComplexity];
        if (execMode === "one-shot") {
          advisory = { ...advisory, worker: { ...advisory.worker, executionMode: "one-shot", maxRounds: 1 } };
        } else if (execMode === "loop") {
          advisory = { ...advisory, worker: { ...advisory.worker, executionMode: "loop", maxRounds: 2 } };
        }
        advisory = { ...advisory, policyApplied: { version: policy.version } };
      }
      appendDecisionLedgerRecord(config, {
        kind: "decision",
        at: new Date().toISOString(),
        taskId: advisory.taskId,
        taskCategory: taskComplexity,
        tool: "graphflow_run",
        mode: "shadow",
        reuseMode: advisory.reuseMode,
        modelTier: advisory.worker.modelTier,
        durationMs: advisory.decision.durationMs,
        llmCalls: advisory.decision.llmCalls,
        tokenCost: 0,
        provenance: advisory.decision.provenance,
      });
    } catch {
      advisory = undefined;
    }

    // 当无 LLM 时，严格保障平滑走 bridge 模式，状态统一返回 DELEGATED，保留完整 AST 上下文与 Layer A Advisory
    // U1 cost ledger: every LLM call this run made (provider usage captured in
    // provider-executor) is drained and persisted here — the run's own cost
    // trail, cache hits included. Failures never break the run.
    try {
      const { drainProviderUsageEvents } = await import("../../../routing/provider-executor.js");
      const { appendCostEvent } = await import("../../../learning/cost-ledger.js");
      for (const event of drainProviderUsageEvents()) {
        appendCostEvent(config, {
          ts: event.ts,
          kind: "llm",
          role: event.role,
          tier: event.tier,
          provider: event.provider,
          model: event.model,
          ...(event.usage.promptTokens !== undefined ? { promptTokens: event.usage.promptTokens } : {}),
          ...(event.usage.completionTokens !== undefined ? { completionTokens: event.usage.completionTokens } : {}),
          ...(event.usage.promptCacheHitTokens !== undefined ? { cacheHitTokens: event.usage.promptCacheHitTokens } : {}),
          ...(event.usage.promptCacheMissTokens !== undefined ? { cacheMissTokens: event.usage.promptCacheMissTokens } : {}),
          ...(event.usage.promptCacheWriteTokens !== undefined ? { cacheWriteTokens: event.usage.promptCacheWriteTokens } : {}),
          ...(result.episodeId ? { sessionId: result.episodeId } : {}),
        });
      }
    } catch {
      // Cost accounting is best-effort observability.
    }

    if (!hasExternalLlm && result.status !== "DELEGATED") {
      return {
        status: "DELEGATED" as const,
        attempts: 0,
        feedback: `[DELEGATED] No LLM configured; task packaged for external agent bridge execution`,
        ...(result.episodeId ? { episodeId: result.episodeId } : {}),
        executionDescriptor: result.executionDescriptor ?? {
          action: "execute",
          task,
          context: `task=${task}`,
          retryHints: [],
        },
        ...(advisory ? { advisory } : {}),
      };
    }

    return {
      status: result.status,
      attempts: result.attempts,
      feedback: result.feedback,
      ...(bridgeReason ? { bridgeReason } : {}),
      ...(result.result ? { result: result.result } : {}),
      ...(result.episodeId ? { episodeId: result.episodeId } : {}),
      ...(result.executionDescriptor ? { executionDescriptor: result.executionDescriptor } : {}),
      ...(advisory ? { advisory } : {}),
    };
  } catch (error) {
    appendFeedbackEvent(eventsPath, {
      query: task,
      passed: false,
      tokenCost: 0,
      retries: 0,
    });
    const message = error instanceof Error ? error.message : String(error);
    if (!hasUsableLlmProvider(config)) {
      let fallbackAdvisory: RunTaskSummary["advisory"];
      try {
        const built = buildEfficiencyAdvisory({
          task,
          taskComplexity: triageTask(task),
          executionMode: "bridge",
          fusedSteps: [],
          maxContextTokens: config.graphPolicy.maxContextTokens,
          durationMs: 0,
        });
        fallbackAdvisory = {
          ...built,
          decision: { ...built.decision, durationMs: 0 },
        };
      } catch {
        fallbackAdvisory = undefined;
      }
      return {
        status: "DELEGATED" as const,
        attempts: 0,
        feedback: `[DELEGATED] No LLM configured; operating in bridge mode (recovered from: ${message})`,
        executionDescriptor: {
          action: "execute",
          task,
          context: `task=${task}`,
          retryHints: [],
        },
        ...(fallbackAdvisory ? { advisory: fallbackAdvisory } : {}),
      };
    }
    // 与 orchestrator 顶层错误边界一致：将未捕获异常收敛为 HUMAN_REVIEW_REQUIRED 结构化结果，
    // 不再裸抛给调用方（包括索引失败、图存储不可达等场景）
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
  // Read-only diagnostic (doctor-class): tolerate any working directory.
  const config = resolveConfig(configPath, undefined, { allowUnsafeWorkspace: true });
  const health = buildProviderHealthMap(config);
  const chain = buildFallbackChain(config);

  const resolve = (role: "planner" | "worker" | "validator") => {
    if (!config.routingPolicy?.enableDynamicRouting) {
      return resolveModelForRole(role, configPath);
    }

    return resolveModelWithFallback(role, health, chain, configPath);
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
    embeddingQuality: { ...getEmbeddingQualitySummary(), dtype: resolveEmbeddingDtype(config.embeddingPolicy?.dtype) },
    graphStore: computeGraphStoreDiagnosis(config),
    runtimeTimeline: getRuntimeTimelineSummary(),
    workspaceRoot,
    graphFreshness,
    modelCache,
    connectivitySummary,
    flywheel,
    team: diagnoseTeamConfig(config),
  };
}

function computeGraphStoreDiagnosis(config: ReturnType<typeof resolveConfig>) {
  const transport = config.graphPolicy.transport;
  const last = getLastGraphStoreBackend();
  const configuredPath = resolveGraphStorePath(config);
  const sqlitePath =
    last?.backend === "sqlite" && last.path ? last.path : configuredPath.replace(/\.json$/i, ".sqlite");
  const jsonPath = sqlitePath.replace(/\.sqlite$/i, ".json");
  let lastMerge: { mergedAt: string; stats: Record<string, number> } | undefined;
  try {
    const log = JSON.parse(readFileSync(`${sqlitePath}${MERGE_MARKER_SUFFIX}`, "utf8")) as {
      mergedAt?: string;
      stats?: Record<string, number>;
    };
    if (log.mergedAt && log.stats) lastMerge = { mergedAt: log.mergedAt, stats: log.stats };
  } catch {
    // no merge happened for this store
  }
  const sqliteModuleSource = getSqliteModuleSource();
  return {
    transport,
    ...(last?.backend ? { backend: last.backend } : {}),
    ...(last?.path ?? configuredPath ? { path: last?.path ?? configuredPath } : {}),
    ...(last?.fallbackReason ? { fallbackReason: last.fallbackReason } : {}),
    ...(sqliteModuleSource ? { sqliteModuleSource } : {}),
    unmergedJsonStore: (transport === "sqlite" || transport === "auto") && existsSync(sqlitePath) && existsSync(jsonPath),
    ...(lastMerge ? { lastMerge } : {}),
    runtimeDeps: inspectRuntimeDeps().map((dep) => ({
      name: dep.name,
      source: dep.source,
      ...(dep.version ? { version: dep.version } : {}),
      ...(dep.loadError ? { loadError: dep.loadError } : {}),
    })),
  };
}

function computeWorkspaceRootDiagnosis(config: ReturnType<typeof resolveConfig>) {
  const envSet = Boolean(process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim());
  // A DIAGNOSIS must never be killed by the thing it diagnoses: resolving
  // from an unsafe cwd (home) legitimately refuses — report the refusal as
  // the finding instead of throwing out of `graphflow diagnose`.
  let resolved: string;
  let refused: string | undefined;
  try {
    resolved = resolveRuntimeWorkspaceRoot({
      ...(config.graphPolicy.workspaceRoot ? { projectWorkspaceRoot: config.graphPolicy.workspaceRoot } : {}),
    });
  } catch (error) {
    refused = error instanceof Error ? error.message.split("\n")[0] : String(error);
    resolved = config.graphPolicy.workspaceRoot ?? process.cwd();
  }
  let discovery: "env" | "config" | "auto" | "cwd" | "refused" = "cwd";
  if (refused !== undefined) {
    discovery = "refused";
  } else if (envSet) {
    discovery = "env";
  } else if (config.graphPolicy.workspaceRoot) {
    discovery = "config";
  } else if (resolved !== process.cwd()) {
    discovery = "auto";
  }
  const exists = existsSync(resolved);
  const hasPackageJson = exists && existsSync(join(resolved, "package.json"));
  const stale = envSet && (!exists || !hasPackageJson);
  return {
    path: resolved,
    discovery,
    exists,
    hasPackageJson,
    stale,
    ...(refused !== undefined ? { refused } : {}),
  };
}

function computeGraphFreshnessDiagnosis(config: ReturnType<typeof resolveConfig>) {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const manifestName = resolveIndexManifestName(config);
  const cached = hasIndexCache(root, manifestName);
  let stale = false;
  let cacheFileCount = 0;
  if (cached) {
    stale = hasPendingGraphIndexWork(root, { manifestName });
    try {
      const cachePath = join(root, ".graphflow-cache", manifestName);
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

export function diagnoseRouting(
  configPath?: string,
  result = diagnoseRoutingResult(configPath),
  probes?: RoutingConnectivityProbe[]
): string {
  const experience = result.flywheel?.experience;
  const probeSegment =
    probes && probes.length > 0
      ? `probe=` +
        probes
          .map(
            (p) =>
              `${p.role}:${p.ok ? `ok(${p.latencyMs ?? "?"}ms)` : `FAIL(${p.error ?? "no reply"})`}`
          )
          .join("|")
      : "";
  return [
    `dynamicRouting=${result.dynamicRouting ? "on" : "off"}`,
    `health(configured)=openai:${result.health.openai},anthropic:${result.health.anthropic},bailian:${result.health.bailian},doubao:${result.health.doubao},deepseek:${result.health.deepseek}`,
    ...(probeSegment ? [probeSegment] : []),
    `priority=${result.priority.join(",")}`,
    `planner=${result.planner.provider}/${result.planner.model}${result.planner.fallbackApplied ? ":fallback" : ""}`,
    `worker=${result.worker.provider}/${result.worker.model}${result.worker.fallbackApplied ? ":fallback" : ""}`,
    `validator=${result.validator.provider}/${result.validator.model}${result.validator.fallbackApplied ? ":fallback" : ""}`,
    `compression=${result.compression.backend}:${result.compression.provider}/${result.compression.model}${result.compression.embedded ? ":embedded" : ""}`,
    `embeddings=${result.embeddingBackend}${result.embeddingQuality?.dtype ? `:${result.embeddingQuality.dtype}` : ""}`,
    ...(result.graphStore
      ? [
          `store=${result.graphStore.backend ?? result.graphStore.transport}` +
            `${result.graphStore.unmergedJsonStore ? ":unmerged-json" : ""}` +
            `;deps=${result.graphStore.runtimeDeps.map((d) => `${d.name}:${d.loadError ? "broken" : d.source}`).join(",")}`,
        ]
      : []),
    ...(experience
      ? [
          `experience=conv:${experience.episodeToSkillConversionRate.toFixed(2)},lessons:${experience.lessonsCoverageRate.toFixed(2)},consol:${experience.consolidation?.actionable ?? 0}`,
        ]
      : []),
    result.team
      ? `team=${result.team.enabled ? "on" : "off"}:${result.team.transport}` +
        `${result.team.endpoint ? `:${result.team.endpoint}` : ""}` +
        `;tenant=${result.team.tenant ?? "default"}` +
        `;auth=${result.team.authMode}` +
        `;rbac=${result.team.rbacExpected ? "expected" : "local"}` +
        `${result.team.reachable === undefined ? "" : `;reachable=${result.team.reachable}`}` +
        `${result.team.degradedToLocal ? ";degraded=local" : ""}`
      : "team=off",
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
  selection: ModelSelection,
  signal?: AbortSignal,
  configPath?: string
): Promise<RoutingConnectivityProbe> {
  const started = Date.now();
  // A genuine probe reply is a SHORT model answer to the greeting. Non-strict
  // provider adapters mask failures by returning the PROMPT back as a fake
  // completion (e.g. deepseek's `[deepseek:model] <prompt>` fallback on a
  // missing key, 401, or network error) — so any reply that still contains
  // the probe instruction, or a bracketed placeholder, is a masked failure,
  // not connectivity. Reachability of baseUrl is NOT connectivity: only a
  // full apikey+baseUrl+model round-trip that returns a real answer is.
  const PROBE_INSTRUCTION = "Reply with exactly: ok";
  try {
    const sample = await executeRolePrompt(role, PROBE_INSTRUCTION, selection, undefined, signal, {
      configPath,
    });
    const cleaned = sample.trim().slice(0, 120);
    const masked =
      /^\[(openai|anthropic|bailian|doubao|deepseek):/i.test(cleaned) ||
      cleaned.includes("Reply with exactly");
    const ok = cleaned.length > 0 && cleaned.length <= 200 && !masked;
    // Read AFTER the call: a masked echo means the adapter swallowed the real
    // error into the side channel during this very probe (or a prior call in
    // the same process).
    const lastAdapterError = ok ? undefined : getLastProviderError(selection.provider);
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
              : `Provider returned placeholder/echo fallback output (masked failure), not a real completion` +
                (lastAdapterError
                  ? `; last adapter error: ${lastAdapterError.message}`
                  : "; no adapter error recorded"),
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
  configPath?: string,
  timeoutMs = 5_000
): Promise<RoutingConnectivityProbe[]> {
  const diagnosis = diagnoseRoutingResult(configPath);
  const withTimeout = (role: "planner" | "worker", selection: ModelSelection) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return probeRoleConnectivity(role, selection, controller.signal, configPath).finally(() =>
      clearTimeout(timer)
    );
  };
  return Promise.all([
    withTimeout("planner", diagnosisRoleToSelection("planner", diagnosis)),
    withTimeout("worker", diagnosisRoleToSelection("worker", diagnosis)),
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
    const delegated = buildAgentDelegatedSimplePlan(task, skillCondition);
    const steps = delegated.suggestedNodes ?? delegated.nodes;
    const workbench = await maybeSeedWorkbench(task, steps, configPath);
    const withSource = {
      ...delegated,
      planSource: "no-llm-bridge" as const,
      degradeReason: "No usable GraphFlow LLM provider is configured (missing api key); the connected agent must decompose this task.",
    };
    return workbench ? { ...withSource, workbench } : withSource;
  }

  // LLM credentials exist → prefer real model-driven decomposition over the
  // local template. Both calls are strictly bounded (never reject, resolve to
  // null on failure); any failure/timeout degrades honestly to the heuristic
  // template + agent bridge instead of posing as a final plan.
  const withPlanLlmTimeout = <T>(promise: Promise<T | null>, ms: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  };
  const rawTimeoutMs = Number.parseInt(process.env.GRAPHFLOW_PLAN_LLM_TIMEOUT_MS ?? "", 10);
  const planLlmTimeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 15_000;
  const selection = resolveModelForRole("planner", configPath);

  // Pre-flight connectivity probe: a full apikey+baseUrl+model greeting
  // round-trip. An unreachable/mis-credentialed/masked-failure provider would
  // otherwise burn the full plan timeout on EVERY call before degrading.
  // The probe is cancelled for real (AbortSignal into the provider fetch) so
  // a slow provider leaves no zombie request behind.
  const rawProbeMs = Number.parseInt(process.env.GRAPHFLOW_PLAN_PROBE_TIMEOUT_MS ?? "", 10);
  const probeTimeoutMs = Number.isFinite(rawProbeMs) && rawProbeMs > 0 ? rawProbeMs : 5_000;
  const probeController = new AbortController();
  const probeTimer = setTimeout(() => probeController.abort(), probeTimeoutMs);
  let probe: RoutingConnectivityProbe;
  try {
    probe = await probeRoleConnectivity("planner", selection, probeController.signal, configPath);
  } finally {
    clearTimeout(probeTimer);
  }
  if (!probe.ok) {
    const probeFailedReason =
      `planner connectivity probe failed: ${probe.error ?? "no usable reply"} ` +
      `(latency ${probe.latencyMs}ms); bridging to the connected agent ` +
      `without attempting the LLM plan (provider ${selection.provider}/${selection.model})`;
    const bridged = buildLlmDegradedSimplePlan(task, skillCondition, probeFailedReason);
    const workbench = await maybeSeedWorkbench(task, bridged.nodes, configPath);
    const withSource = {
      ...bridged,
      planSource: "probe-failed-bridge" as const,
      probe,
      degradeReason: probeFailedReason,
    };
    return workbench ? { ...withSource, workbench } : withSource;
  }

  const [llmIdeas, llmNodes] = await Promise.all([
    withPlanLlmTimeout(tryBrainstormTaskLlm(task, selection), planLlmTimeoutMs),
    withPlanLlmTimeout(
      tryPlanTasksLlm(task, {
        selection,
        ...(skillCondition?.skillRefs ? { skillHints: skillCondition.skillRefs } : {}),
      }),
      planLlmTimeoutMs
    ),
  ]);

  if (llmIdeas !== null && llmNodes !== null) {
    const mode = triageTask(task);
    const nodes = attachSkillConditionToPlanNodes(
      llmNodes.map((node) => ({
        id: node.id,
        description: node.description,
        dependencies: node.dependencies,
        ...(node.skillRefs && node.skillRefs.length > 0 ? { skillRefs: node.skillRefs } : {}),
      })),
      skillCondition
    );

    const result = {
      mode,
      ideas: llmIdeas,
      nodes,
      nodesStatus: "final" as const,
      complete: true,
      requiresAgentBridge: false,
      planSource: "llm" as const,
      probe,
    };
    // U3 plan challenge gate (rules version — zero LLM): graph facts question
    // the model-produced plan (external callers / deleted symbols). Advisory
    // by default; GRAPHFLOW_PLAN_GATE=enforce downgrades to suggested.
    let challenges: string[] | undefined;
    try {
      const { extractTouchedFromPlan, buildChallengeList } = await import("../../../graph/diff-challenge.js");
      const touched = extractTouchedFromPlan(nodes);
      if (touched.files.length > 0 || touched.symbols.length > 0) {
        const challengeClient = createGraphClient(config);
        try {
          const list = await buildChallengeList(challengeClient, {
            touchedFiles: touched.files,
            planNodes: nodes,
            maxChallenges: 10,
          });
          const found = list.challenges.map((challenge) => challenge.question);
          if (found.length > 0) challenges = found;
        } finally {
          challengeClient.close?.();
        }
      }
    } catch {
      // Challenge gate is fail-open; planning never depends on it.
    }
    const gated =
      challenges && challenges.length > 0
        ? process.env.GRAPHFLOW_PLAN_GATE === "enforce"
          ? {
              ...result,
              nodesStatus: "suggested" as const,
              complete: false,
              requiresAgentBridge: true,
              challenges,
              challengeNote:
                "Plan downgraded by GRAPHFLOW_PLAN_GATE=enforce: graph-fact challenges unanswered — address them before executing.",
            }
          : { ...result, challenges, challengeNote: "Graph-fact challenges to answer before executing (advisory)." }
        : result;
    const workbench = await maybeSeedWorkbench(task, nodes, configPath);
    return workbench ? { ...gated, workbench } : gated;
  }

  // LLM attempted but failed/timed out → keep template content, but mark it
  // honestly as a non-final heuristic suggestion and attach the agent bridge.
  const failedStages = [
    llmIdeas === null ? "brainstorm" : null,
    llmNodes === null ? "plan decomposition" : null,
  ].filter((stage): stage is string => stage !== null);
  const degradedReason =
    `LLM ${failedStages.join(" + ")} failed or timed out after ${planLlmTimeoutMs}ms ` +
    `(provider ${selection.provider}/${selection.model})`;
  const degraded = buildLlmDegradedSimplePlan(task, skillCondition, degradedReason);
  const workbench = await maybeSeedWorkbench(task, degraded.nodes, configPath);
  const withSource = {
    ...degraded,
    planSource: "llm-failed-bridge" as const,
    probe,
    degradeReason: degradedReason,
  };
  return workbench ? { ...withSource, workbench } : withSource;
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
  // Plan provenance is part of the answer, not a footnote: a bridged plan
  // must never read the same as a model-produced final DAG.
  const source =
    result.planSource !== undefined
      ? `; source=${result.planSource}` +
        (result.degradeReason ? `; reason=${result.degradeReason}` : "")
      : "";
  return [
    `mode=${result.mode}`,
    `ideas=${result.ideas.join(" | ")}`,
    `plan=${planPart}${bridge}${source}`,
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
 *    (pass and fail both skip learning without quality lessons).
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
 * Pass and fail both require quality lessons (>=8 chars). Pass without lessons
 * still records the episode as pass; it just skips skill learning. Failure
 * without quality lessons skips penalty spam. Success additionally needs
 * task+lessons to yield skill atoms.
 */
export function shouldApplySkillLearningFromOutcome(
  success: boolean,
  task: string,
  sanitizedLessons: string[]
): boolean {
  if (countQualityLessons(sanitizedLessons) === 0) {
    return false;
  }
  if (!success) {
    return true;
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
  engineeringHints?: EngineeringLinkHints,
  /** Optional commit/diff/test evidence package. */
  evidenceInput?: OutcomeEvidenceInput,
  /** Workspace the episode's run was bound to (same binding as runTaskResult). */
  rootDir?: string
): Promise<ReportOutcomeResult> {
  const config = resolveConfig(configPath, rootDir ? { rootDir } : undefined);
  const graphClient = createGraphClient(config);

  // P0-2: prune legacy pure-noise skill nodes (no symbol evidence) at load,
  // before any new learning is applied in this process. Legacy task-clause /
  // bare-symbol skills that predate the per-atom quality gates go too.
  if (config.skillPolicy?.enableSkillFlywheel) {
    try {
      await cleanupNoiseSkills(graphClient);
      await pruneLegacyNoiseSkills(graphClient);
    } catch {
      // cleanup failure must not block the outcome report
    }
  }

  const sanitizedLessons = sanitizeOutcomeLessons(lessons ?? []);

  // U1: attach this task's own LLM cost trail (drained from provider-executor)
  // to the closing episode — the per-task cost snapshot for the flywheel.
  let costSummary: import("../../../learning/episodic-memory").EpisodeCostSummary | undefined;
  try {
    const { drainProviderUsageEvents } = await import("../../../routing/provider-executor.js");
    const events = drainProviderUsageEvents();
    if (events.length > 0) {
      let promptTokens = 0;
      let completionTokens = 0;
      let cacheHitTokens = 0;
      for (const event of events) {
        promptTokens += event.usage.promptTokens ?? 0;
        completionTokens += event.usage.completionTokens ?? 0;
        cacheHitTokens += event.usage.promptCacheHitTokens ?? 0;
      }
      costSummary = { promptTokens, completionTokens, ...(cacheHitTokens > 0 ? { cacheHitTokens } : {}), calls: events.length };
    }
  } catch {
    // Cost snapshot is best-effort.
  }

  // Always update episode outcome (success/fail), even when skill learning is dampened.
  const applyOutcome = () =>
    updateEpisodeOutcome(
      graphClient,
      episodeId,
      success ? "pass" : "fail",
      sanitizedLessons,
      deviation,
      evidenceInput,
      costSummary
    );
  let updated = await applyOutcome();
  // A JSON-fallback host (no better-sqlite3) loses its store file whenever a
  // SQLite host merges it away; an episode this process ran is re-inserted.
  if (!updated && (await restoreRecentEpisode(graphClient, episodeId))) {
    updated = await applyOutcome();
  }
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
        episodeId: updated.id,
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

  // R9 closing audit: before a success report stands, reconcile observable
  // follow-through obligations (deps installed? files wired? configs
  // referencing new artifacts? docs updated?). Default is advisory — findings
  // ride on the result and enter the promise ledger for the next session's
  // opening reminder. GRAPHFLOW_AUDIT_STRICT=1 refuses success while findings
  // remain (ok=false). A clean audit resolves open ledger entries.
  let closingAudit: ReportOutcomeResult["closingAudit"];
  if (success) {
    try {
      const { runAudit } = await import("../../../audit/audit.js");
      const audit = await runAudit(
        {},
        config.graphPolicy.workspaceRoot ?? process.cwd(),
        config
      );
      const { recordPromiseLedger, resolvePromisesIfClean } = await import(
        "../../../audit/promise-ledger.js"
      );
      if (audit.findings.length > 0) {
        await recordPromiseLedger(graphClient, {
          sessionId: updated.id,
          recordedAt: new Date().toISOString(),
          findingIds: audit.findings.map((finding) => finding.id),
          messages: audit.findings.map((finding) => `[${finding.kind}] ${finding.message}`),
          status: "open",
        });
        const reminder =
          `收尾审计未清零：${audit.summary.errors} 项错误 / ${audit.summary.warnings} 项警告` +
          `（已登记承诺账本，下次会话开局提醒；graphflow audit 查看明细）`;
        if (audit.strict && !audit.ok) {
          return { ok: false, reason: `strict 模式拒绝上报成功：${reminder}` };
        }
        closingAudit = { errors: audit.summary.errors, warnings: audit.summary.warnings, reminder };
      } else {
        await resolvePromisesIfClean(graphClient, []);
      }
    } catch {
      // Audit failure never blocks outcome reporting (fail-open).
    }
  }

  return {
    ok: true,
    episodeId: updated.id,
    outcome: success ? "pass" : "fail",
    skillsUpdated,
    ...(updated.deviation !== undefined ? { deviation: updated.deviation } : {}),
    ...(evidenceInput ? { evidence: verifyOutcomeEvidence(updated.evidence) } : {}),
    ...(engineeringLinks ? { engineeringLinks } : {}),
    ...(closingAudit ? { closingAudit } : {}),
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
    resolveConfig(configPath, rootDir ? { rootDir } : undefined),
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
    resolveConfig(configPath, rootDir ? { rootDir } : undefined),
    rootDir ? { rootDir } : undefined
  );
  const graphClient = createGraphClient(config);
  const merged = await mergeAgentInsightsFromGraph(graphClient, task);
  if (merged.complete && merged.plan.length > 0) {
    await maybeSeedWorkbench(task, merged.plan, configPath, rootDir);
  }
  return merged;
}

async function maybeSeedWorkbench(
  task: string,
  steps: Array<{ id: string; description: string; dependencies: string[] }>,
  configPath?: string,
  rootDir?: string
): Promise<PlanPreviewResult["workbench"] | undefined> {
  if (steps.length === 0) return undefined;
  try {
    const config = bindRuntimeWorkspaceRoot(
      resolveConfig(configPath, rootDir ? { rootDir } : undefined),
      rootDir ? { rootDir } : undefined
    );
    const client = createGraphClient(config);
    const seeded = await seedWorkbenchFromPlan(client, {
      task,
      steps,
      ...(config.graphPolicy.workspaceRoot ? { workspaceRoot: config.graphPolicy.workspaceRoot } : {}),
    });
    const snapshot = client.readSnapshot?.();
    const outline = snapshot
      ? buildWorkbenchOutlines(snapshot.nodes, snapshot.edges).find((item) => item.rootId === seeded.root.id)
      : undefined;
    return {
      rootId: seeded.root.id,
      activeTopicId: seeded.root.activeTopicId,
      topics: seeded.topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        mainline: topic.mainline,
        isolated: topic.isolated,
      })),
      ...(outline ? { outline } : {}),
    };
  } catch {
    return undefined;
  }
}

export type { SubmitAgentInsightResult } from "../../../core/submit-agent-insight";
export type { MergeAgentInsightsResult } from "../../../core/merge-agent-insight";
