import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { brainstormTask } from "../../agents/brainstormer";
import { planTasks } from "../../agents/planner";
import { validateConfig } from "../../config/loader";
import { formatApiKeyForConfig, formatApiKeyForSettings, resolveConfigSecret } from "../../config/secrets";
import { listConfigOverlayKeys } from "../../config/merge";
import { resolveConfig, resolveConfigPath } from "../../config/resolve";
import { createEmbeddingProviderFromConfig } from "../../config/embedding-factory";
import { resolveGraphStorePath, resolveLearningPath } from "../../config/paths";
import { triageTask } from "../../core/triage";
import type { GraphEdge, GraphNode } from "../../core/types";
import type { GraphFlowConfig } from "../../config/schema";
import { orchestrate, type OrchestrateOptions } from "../../core/orchestrator";
import { createGraphClient, type GraphClient } from "../../graph/client-factory";
import { enrichGraphSemanticsSilent } from "../../graph/semantic-enricher";
import { GraphifySqliteClient } from "../../graph/sqlite-client";
import { indexWorkspaceFiles, clearGraphIndexArtifacts } from "../../graph/file-indexer";
import {
  buildLayeredContextPackage,
  createContextRefillManager,
} from "../../graph/context-slicer";
import { runNightlyLearning } from "../../learning/nightly-trainer";
import { appendFeedbackEvent } from "../../learning/learning-events";
import { resolveModelForRole, resolveModelWithFallback } from "../../routing/model-router";
import { buildFallbackChain, buildProviderHealthMap } from "../../routing/provider-health";
import type { TaskStatus } from "../../core/types";
import type { EnricherOptions } from "../../graph/semantic-enricher";
import { withFileLock } from "../../utils/file-lock";
import { logger } from "../../utils/logger";

export { getDefaultConfig } from "../../config/defaults";
export {
  ensureGlobalGraphFlowConfig,
  ensureWorkspaceGraphFlowConfig,
  resolveGlobalConfigPath,
  type ConfigScaffoldResult,
} from "../../config/scaffold";
export { resolveConfig, resolveConfigPath } from "../../config/resolve";

function buildEmbeddingOptions(config: GraphFlowConfig) {
  const embeddingProvider = createEmbeddingProviderFromConfig(config);
  if (!embeddingProvider) {
    return {};
  }
  return {
    embeddingProvider,
    enableVectorRecall: true as const,
    ...(config.embeddingPolicy?.topK !== undefined ? { vectorTopK: config.embeddingPolicy.topK } : {}),
    ...(config.embeddingPolicy?.minSimilarity !== undefined
      ? { vectorMinSimilarity: config.embeddingPolicy.minSimilarity }
      : {}),
  };
}

function resolveEnrichmentBackend(
  policy: GraphFlowConfig["graphPolicy"]["semanticEnrichment"]
): "network" | "local" | "inherit" {
  if (policy?.backend === "network" || policy?.backend === "local" || policy?.backend === "inherit") {
    return policy.backend;
  }
  if (policy?.provider === "openbmb") {
    return "local";
  }
  if (policy?.model || policy?.provider || policy?.apiKey || policy?.baseUrl) {
    return "network";
  }
  return "inherit";
}

/** Apply enrichment-specific cloud credentials over generic provider env (network backend only). */
export function prepareSemanticEnrichmentRuntime(configPath?: string): void {
  if (!configPath) {
    return;
  }
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  applyEnrichmentProviderEnv(config);
}

export function applyEnrichmentProviderEnv(config: GraphFlowConfig): void {
  const policy = config.graphPolicy.semanticEnrichment;
  const backend = resolveEnrichmentBackend(policy);
  if (backend === "local") {
    return;
  }

  const providerName = (policy?.provider ?? config.tiers.economy.provider).toUpperCase();
  const providerCfg = config.providers[providerName.toLowerCase()] ?? {};
  const apiKey = resolveConfigSecret(policy?.apiKey) ?? resolveConfigSecret(providerCfg.apiKey);
  const baseUrl = policy?.baseUrl ?? providerCfg.baseUrl;
  if (apiKey) {
    process.env[`${providerName}_API_KEY`] = apiKey;
  }
  if (baseUrl) {
    process.env[`${providerName}_BASE_URL`] = baseUrl;
  }
}

export function applyOpenBmbRuntimeEnv(config: GraphFlowConfig): void {
  const genericProviders = ["openai", "anthropic", "bailian", "doubao"] as const;
  for (const name of genericProviders) {
    const cfg = config.providers[name];
    if (!cfg) {
      continue;
    }
    const envPrefix = name.toUpperCase();
    const apiKey = resolveConfigSecret(cfg.apiKey);
    if (apiKey) {
      process.env[`${envPrefix}_API_KEY`] = apiKey;
    }
    if (cfg.baseUrl) {
      process.env[`${envPrefix}_BASE_URL`] = cfg.baseUrl;
    }
  }

  const openbmb = config.providers.openbmb;
  if (!openbmb) {
    return;
  }
  if (openbmb.mode) {
    process.env.GRAPHFLOW_OPENBMB_MODE = openbmb.mode;
  }
  if (openbmb.baseUrl) {
    process.env.GRAPHFLOW_OPENBMB_BASE_URL = openbmb.baseUrl;
  }
  const openbmbApiKey = resolveConfigSecret(openbmb.apiKey);
  if (openbmbApiKey) {
    process.env.GRAPHFLOW_OPENBMB_API_KEY = openbmbApiKey;
  }
  const modelPath = resolveConfigSecret(openbmb.modelPath);
  if (modelPath) {
    process.env.GRAPHFLOW_OPENBMB_MODEL_PATH = modelPath;
  }
  const commandPath = resolveConfigSecret(openbmb.commandPath);
  if (commandPath) {
    process.env.GRAPHFLOW_MINICPM_COMMAND = commandPath;
  }
  if (openbmb.modelUrl) {
    process.env.GRAPHFLOW_MINICPM_MODEL_URL = openbmb.modelUrl;
  }
  if (openbmb.modelSha256) {
    process.env.GRAPHFLOW_MINICPM_MODEL_SHA256 = openbmb.modelSha256;
  }
  if (openbmb.autoDownloadModel !== undefined) {
    process.env.GRAPHFLOW_OPENBMB_AUTO_DOWNLOAD = openbmb.autoDownloadModel ? "1" : "0";
  }
  if (openbmb.engine) {
    process.env.GRAPHFLOW_MINICPM_ENGINE = openbmb.engine;
  }
  if (openbmb.timeoutMs !== undefined) {
    process.env.GRAPHFLOW_OPENBMB_TIMEOUT_MS = String(openbmb.timeoutMs);
  }
  if (openbmb.maxTokens !== undefined) {
    process.env.GRAPHFLOW_OPENBMB_MAX_TOKENS = String(openbmb.maxTokens);
  }
  if (openbmb.temperature !== undefined) {
    process.env.GRAPHFLOW_OPENBMB_TEMPERATURE = String(openbmb.temperature);
  }

  const evolution = config.learningPolicy.skillEvolution;
  if (evolution?.model) {
    process.env.GRAPHFLOW_SKILL_EVOLVE_MODEL = evolution.model;
  }
  if (evolution?.minCoOccur !== undefined) {
    process.env.GRAPHFLOW_SKILL_EVOLVE_MIN_COOCCUR = String(evolution.minCoOccur);
  }
  if (evolution?.minSuccess !== undefined) {
    process.env.GRAPHFLOW_SKILL_EVOLVE_MIN_SUCCESS = String(evolution.minSuccess);
  }
  process.env.GRAPHFLOW_SKILL_TRIPLE_FUSION = evolution?.enableTripleFusion === false ? "0" : "1";
}

export interface ContextPreviewResult {
  query: string;
  summaryCount: number;
  anchorCount: number;
  tokenEstimate: number;
  truncated: boolean;
  anchorsByLayer: {
    l1: number;
    l2: number;
    l3: number;
  };
  refillPreview: string[];
  summary: string[];
  anchors: Array<{ id: string; type: GraphNode["type"]; layer: "L1" | "L2" | "L3" }>;
  tokenBudget: {
    maxContextTokens: number;
    estimatedRawTokens: number;
    compressedTokens: number;
    estimatedSavingsPercent: number;
    budgetUsedPercent: number;
  };
}

export interface GraphFlowSettings {
  configPath: string;
  provider: string;
  smartModel: string;
  economyModel: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  maxContextTokens: number;
  layerQuota: { l1: number; l2: number; l3: number };
  enableNearLosslessMode: boolean;
  autoIndexOnPreview: boolean;
  autoIndexOnRun: boolean;
  autoIndexOnSave: boolean;
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  graphStorePath: string;
  enrichmentBackend: "network" | "local" | "inherit";
  enrichmentProvider: string;
  enrichmentModel: string;
  enrichmentApiKey?: string;
  enrichmentBaseUrl?: string;
  openbmbMode: "embedded" | "ollama" | "openai-compat";
  openbmbEngine: "command" | "node-llama-cpp";
  openbmbModel: string;
  openbmbBaseUrl?: string;
  openbmbModelPath?: string;
  openbmbCommandPath?: string;
  openbmbAutoDownload: boolean;
  openbmbModelUrl?: string;
  openbmbModelSha256?: string;
}

export type GraphFlowSettingsInput = Omit<GraphFlowSettings, "configPath">;

export function getGraphFlowSettings(configPath = "graphflow.config.json"): GraphFlowSettings {
  const actualPath = resolveConfigPath(configPath);
  const config = resolveConfig(actualPath);
  const provider = config.tiers.smart.provider;
  const rawConfig = readRawConfig(actualPath);
  const providerConfig = config.providers[provider] ?? {};
  const rawProviderConfig = rawConfig?.providers?.[provider] ?? {};
  const rawOpenBmbConfig = rawConfig?.providers?.openbmb ?? {};
  const openbmbConfig = config.providers.openbmb ?? {};
  const apiKeyEnvVar = formatApiKeyForSettings(rawProviderConfig.apiKey ?? providerConfig.apiKey);
  const openbmbModelUrl = rawOpenBmbConfig.modelUrl ?? openbmbConfig.modelUrl ?? process.env.GRAPHFLOW_MINICPM_MODEL_URL;
  const openbmbModelSha256 =
    rawOpenBmbConfig.modelSha256 ?? openbmbConfig.modelSha256 ?? process.env.GRAPHFLOW_MINICPM_MODEL_SHA256;
  const openbmbAutoDownloadRaw = rawOpenBmbConfig.autoDownloadModel ?? openbmbConfig.autoDownloadModel;
  const openbmbAutoDownload =
    typeof openbmbAutoDownloadRaw === "boolean"
      ? openbmbAutoDownloadRaw
      : String(process.env.GRAPHFLOW_OPENBMB_AUTO_DOWNLOAD ?? "0") === "1";

  return {
    configPath: actualPath,
    provider,
    smartModel: config.tiers.smart.model ?? "",
    economyModel: config.tiers.economy.model ?? "",
    ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
    ...(rawProviderConfig.baseUrl || providerConfig.baseUrl
      ? { baseUrl: rawProviderConfig.baseUrl ?? providerConfig.baseUrl }
      : {}),
    maxContextTokens: config.graphPolicy.maxContextTokens,
    layerQuota: config.graphPolicy.layerQuota ?? { l1: 6, l2: 4, l3: 3 },
    enableNearLosslessMode: config.graphPolicy.enableNearLosslessMode ?? false,
    autoIndexOnPreview: config.graphPolicy.autoIndexOnPreview ?? true,
    autoIndexOnRun: config.graphPolicy.autoIndexOnRun ?? true,
    autoIndexOnSave: config.graphPolicy.autoIndexOnSave ?? false,
    transport: config.graphPolicy.transport,
    graphStorePath: config.graphPolicy.graphStorePath ?? "tmp/graphflow-graph.json",
    enrichmentBackend: resolveEnrichmentBackend(config.graphPolicy.semanticEnrichment),
    enrichmentProvider: config.graphPolicy.semanticEnrichment?.provider ?? "",
    enrichmentModel: config.graphPolicy.semanticEnrichment?.model ?? "",
    ...((): Record<string, string> => {
      const enrichPolicy = config.graphPolicy.semanticEnrichment;
      const enrichProvider = enrichPolicy?.provider ?? config.tiers.economy.provider;
      const rawEnrichPolicy = rawConfig?.graphPolicy?.semanticEnrichment ?? {};
      const rawEnrichProvider = rawConfig?.providers?.[enrichProvider] ?? {};
      const apiKey = formatApiKeyForSettings(rawEnrichPolicy.apiKey ?? rawEnrichProvider.apiKey);
      const baseUrl = rawEnrichPolicy.baseUrl ?? rawEnrichProvider.baseUrl;
      return {
        ...(apiKey ? { enrichmentApiKey: apiKey } : {}),
        ...(typeof baseUrl === "string" && baseUrl.trim() ? { enrichmentBaseUrl: baseUrl.trim() } : {}),
      };
    })(),
    openbmbMode: (openbmbConfig.mode ?? "embedded") as "embedded" | "ollama" | "openai-compat",
    openbmbEngine: (openbmbConfig.engine ?? "command") as "command" | "node-llama-cpp",
    openbmbModel:
      config.learningPolicy.skillEvolution?.model ??
      (provider === "openbmb" ? config.tiers.economy.model ?? config.tiers.smart.model ?? "" : ""),
    ...(rawOpenBmbConfig.baseUrl || openbmbConfig.baseUrl
      ? { openbmbBaseUrl: rawOpenBmbConfig.baseUrl ?? openbmbConfig.baseUrl }
      : {}),
    ...(rawOpenBmbConfig.modelPath || openbmbConfig.modelPath
      ? { openbmbModelPath: rawOpenBmbConfig.modelPath ?? openbmbConfig.modelPath }
      : {}),
    ...(rawOpenBmbConfig.commandPath || openbmbConfig.commandPath
      ? { openbmbCommandPath: rawOpenBmbConfig.commandPath ?? openbmbConfig.commandPath }
      : {}),
    openbmbAutoDownload,
    ...(typeof openbmbModelUrl === "string" && openbmbModelUrl.trim().length > 0
      ? { openbmbModelUrl }
      : {}),
    ...(typeof openbmbModelSha256 === "string" && openbmbModelSha256.trim().length > 0
      ? { openbmbModelSha256 }
      : {}),
  };
}

export function saveGraphFlowSettings(
  settings: GraphFlowSettingsInput,
  configPath = "graphflow.config.json"
): GraphFlowSettings {
  const actualPath = resolveConfigPath(configPath);
  const current = resolveConfig(actualPath);
  const providerConfig = {
    ...(settings.apiKeyEnvVar?.trim() ? { apiKey: formatApiKeyForConfig(settings.apiKeyEnvVar) } : {}),
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
  };

  const openbmbProviderConfig = {
    ...(settings.openbmbBaseUrl ? { baseUrl: settings.openbmbBaseUrl } : {}),
    ...(settings.openbmbModelPath ? { modelPath: settings.openbmbModelPath } : {}),
    ...(settings.openbmbCommandPath ? { commandPath: settings.openbmbCommandPath } : {}),
    ...(settings.openbmbModelUrl ? { modelUrl: settings.openbmbModelUrl } : {}),
    ...(settings.openbmbModelSha256 ? { modelSha256: settings.openbmbModelSha256 } : {}),
    mode: settings.openbmbMode,
    engine: settings.openbmbEngine,
    autoDownloadModel: settings.openbmbAutoDownload,
  };

  const nextSmartModel = settings.provider === "openbmb" ? settings.openbmbModel : settings.smartModel;
  const nextEconomyModel = settings.provider === "openbmb" ? settings.openbmbModel : settings.economyModel;

  const updated = validateConfig({
    ...current,
    providers: {
      ...current.providers,
      [settings.provider]: providerConfig,
      openbmb: {
        ...(current.providers.openbmb ?? {}),
        ...openbmbProviderConfig,
      } as GraphFlowConfig["providers"][string],
    },
    tiers: {
      smart: {
        provider: settings.provider,
        ...(nextSmartModel?.trim()
          ? { model: nextSmartModel.trim() }
          : current.tiers.smart.model
            ? { model: current.tiers.smart.model }
            : {}),
      },
      economy: {
        provider: settings.provider,
        ...(nextEconomyModel?.trim()
          ? { model: nextEconomyModel.trim() }
          : current.tiers.economy.model
            ? { model: current.tiers.economy.model }
            : {}),
      },
    },
    graphPolicy: {
      ...current.graphPolicy,
      enableNearLosslessMode: settings.enableNearLosslessMode,
      autoIndexOnPreview: settings.autoIndexOnPreview,
      autoIndexOnRun: settings.autoIndexOnRun,
      autoIndexOnSave: settings.autoIndexOnSave,
      transport: settings.transport,
      graphStorePath: settings.graphStorePath,
      maxContextTokens: Math.max(1, Math.floor(settings.maxContextTokens)),
      layerQuota: {
        l1: Math.max(0, Math.floor(settings.layerQuota.l1)),
        l2: Math.max(0, Math.floor(settings.layerQuota.l2)),
        l3: Math.max(0, Math.floor(settings.layerQuota.l3)),
      },
      semanticEnrichment: {
        ...(current.graphPolicy.semanticEnrichment ?? {}),
        backend: settings.enrichmentBackend,
        ...(settings.enrichmentBackend === "local"
          ? { provider: "openbmb" }
          : settings.enrichmentProvider?.trim()
            ? { provider: settings.enrichmentProvider.trim() }
            : settings.enrichmentBackend === "inherit"
              ? {}
              : current.graphPolicy.semanticEnrichment?.provider
                ? { provider: current.graphPolicy.semanticEnrichment.provider }
                : {}),
        ...(settings.enrichmentModel?.trim()
          ? { model: settings.enrichmentModel.trim() }
          : current.graphPolicy.semanticEnrichment?.model
            ? { model: current.graphPolicy.semanticEnrichment.model }
            : {}),
        ...(settings.enrichmentBackend !== "local" && settings.enrichmentApiKey?.trim()
          ? { apiKey: formatApiKeyForConfig(settings.enrichmentApiKey) }
          : {}),
        ...(settings.enrichmentBackend !== "local" && settings.enrichmentBaseUrl?.trim()
          ? { baseUrl: settings.enrichmentBaseUrl.trim() }
          : {}),
      },
    },
    learningPolicy: {
      ...current.learningPolicy,
      skillEvolution: {
        ...(current.learningPolicy.skillEvolution ?? {}),
        ...(settings.openbmbModel?.trim() ? { model: settings.openbmbModel.trim() } : {}),
      },
    },
  });

  if (settings.openbmbModelUrl) {
    process.env.GRAPHFLOW_MINICPM_MODEL_URL = settings.openbmbModelUrl;
  }
  if (settings.openbmbModelSha256) {
    process.env.GRAPHFLOW_MINICPM_MODEL_SHA256 = settings.openbmbModelSha256;
  }
  process.env.GRAPHFLOW_OPENBMB_AUTO_DOWNLOAD = settings.openbmbAutoDownload ? "1" : "0";

  const dir = dirname(actualPath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(actualPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return getGraphFlowSettings(actualPath);
}

export async function previewContext(query: string, configPath?: string): Promise<ContextPreviewResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);

  if (config.graphPolicy.autoIndexOnPreview) {
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
  }

  const packageOptions: import("../../graph/context-slicer").LayeredPackageOptions = {
    ...(config.graphPolicy.layerQuota ? { layerQuota: config.graphPolicy.layerQuota } : {}),
    ...buildEmbeddingOptions(config),
  };

  const pkg = await buildLayeredContextPackage(
    graphClient,
    query,
    config.graphPolicy.maxContextTokens,
    packageOptions
  );

  const refill = createContextRefillManager(
    graphClient,
    config.graphPolicy.maxContextTokens,
    packageOptions
  );
  await refill.initialPackage(query);
  const refillPreview = await refill.refill([query]);
  const rawTokenEstimate = estimateRawContextTokens(
    await resolveGraphStoreAfterIndex(config, graphClient),
    query,
    pkg.tokenEstimate
  );

  return {
    query,
    summaryCount: pkg.summaryChannel.length,
    anchorCount: pkg.anchorChannel.length,
    tokenEstimate: pkg.tokenEstimate,
    truncated: pkg.truncated,
    anchorsByLayer: {
      l1: pkg.anchorChannel.filter((item) => item.layer === "L1").length,
      l2: pkg.anchorChannel.filter((item) => item.layer === "L2").length,
      l3: pkg.anchorChannel.filter((item) => item.layer === "L3").length,
    },
    refillPreview,
    summary: pkg.summaryChannel,
    anchors: pkg.anchorChannel,
    tokenBudget: {
      maxContextTokens: config.graphPolicy.maxContextTokens,
      estimatedRawTokens: rawTokenEstimate,
      compressedTokens: pkg.tokenEstimate,
      estimatedSavingsPercent: calculateSavingsPercent(rawTokenEstimate, pkg.tokenEstimate),
      budgetUsedPercent: calculateBudgetUsedPercent(pkg.tokenEstimate, config.graphPolicy.maxContextTokens),
    },
  };
}

export interface GraphIndexResult {
  indexedFiles: number;
  indexedSymbols: number;
  indexedReferences: number;
}

export interface GraphRebuildResult extends GraphIndexResult {
  cleared: boolean;
  storePath: string;
}

export interface GraphSnapshotResult {
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  storePath?: string;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCount: Record<GraphNode["type"], number>;
  topRelations: Array<{ relation: GraphEdge["relation"]; count: number }>;
  sampleNodes: Array<{ id: string; type: GraphNode["type"]; contentPreview: string }>;
  sampleEdges: Array<{ from: string; relation: GraphEdge["relation"]; to: string }>;
}

export interface SkillInsightItem {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
}

export interface SkillInsightsResult {
  source: "graph-store" | "unavailable";
  transport: GraphFlowConfig["graphPolicy"]["transport"];
  storePath?: string;
  skills: SkillInsightItem[];
}

export interface RunTaskSummary {
  status: TaskStatus;
  attempts: number;
  feedback: string;
}

export interface RoutingDiagnosisResult {
  dynamicRouting: boolean;
  health: Record<"openai" | "anthropic" | "bailian" | "doubao" | "openbmb", boolean>;
  priority: string[];
  planner: {
    provider: string;
    model: string;
    fallbackApplied: boolean;
  };
  worker: {
    provider: string;
    model: string;
    fallbackApplied: boolean;
  };
  validator: {
    provider: string;
    model: string;
    fallbackApplied: boolean;
  };
}

export interface LearningNightlyResult {
  events: number;
  passRate: number;
  avgTokens: number;
  canary: "allow" | "block";
  reason: string;
  dataset: string;
}

export interface ModelDownloadResult {
  model: string;
  targetPath: string;
  bytes: number;
  skipped: boolean;
  verified: boolean;
  resumed?: boolean;
}

export interface ModelDownloadProgress {
  model: string;
  targetPath: string;
  downloadedBytes: number;
  totalBytes?: number;
  resumed: boolean;
  percent?: number;
  stage: "starting" | "downloading" | "verifying" | "completed" | "skipped";
}

export async function indexGraph(rootDir?: string, configPath?: string): Promise<GraphIndexResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);
  const targetDir = rootDir || config.graphPolicy.workspaceRoot || process.cwd();

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
  });

  await maybeRunSemanticEnrichment(config, graphClient);

  return indexed;
}

export async function rebuildGraph(rootDir?: string, configPath?: string): Promise<GraphRebuildResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const graphClient = createGraphClient(config);
  const targetDir = rootDir || config.graphPolicy.workspaceRoot || process.cwd();
  const storePath = resolveGraphStorePath(config);

  clearGraphIndexArtifacts(targetDir, storePath);

  const indexOptions = config.graphPolicy.includeExtensions
    ? { includeExtensions: config.graphPolicy.includeExtensions }
    : undefined;

  const indexed = await indexWorkspaceFiles(graphClient, targetDir, {
    ...indexOptions,
    forceReindex: true,
  });

  await maybeRunSemanticEnrichment(config, graphClient);

  return {
    ...indexed,
    cleared: true,
    storePath,
  };
}

async function maybeRunSemanticEnrichment(
  config: GraphFlowConfig,
  graphClient: GraphClient
): Promise<void> {
  const enrichPolicy = config.graphPolicy.semanticEnrichment;
  if (!enrichPolicy?.enabled || !enrichPolicy.autoRunOnIndex || enrichPolicy.mode === "off") {
    return;
  }

  const selection = resolveModelForRole("enricher");
  const health = buildProviderHealthMap(config);
  if (!health[selection.provider]) {
    logger.warn(
      `Skipping semantic enrichment: ${selection.provider} provider is not configured or healthy`
    );
    return;
  }

  applyEnrichmentProviderEnv(config);

  try {
    await enrichGraphSemanticsSilent(graphClient, {
      ...(enrichPolicy.batchSize !== undefined ? { batchSize: enrichPolicy.batchSize } : {}),
      ...(enrichPolicy.sleepMs !== undefined ? { sleepMs: enrichPolicy.sleepMs } : {}),
      ...(enrichPolicy.model ? { model: enrichPolicy.model } : {}),
      ...(enrichPolicy.timeoutMs !== undefined ? { timeoutMs: enrichPolicy.timeoutMs } : {}),
    });
  } catch (error) {
    logger.warn({ error }, "Semantic enrichment skipped after provider failure");
  }
}

export async function enrichSemanticsSilent(
  configPath?: string,
  options?: { batchSize?: number; sleepMs?: number; timeoutMs?: number }
): Promise<{ enrichedCount: number }> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  applyEnrichmentProviderEnv(config);
  const graphClient = createGraphClient(config);
  const enrichPolicy = config.graphPolicy.semanticEnrichment;
  const enricherOptions: EnricherOptions = {};
  const batchSize = options?.batchSize ?? enrichPolicy?.batchSize;
  if (batchSize !== undefined) {
    enricherOptions.batchSize = batchSize;
  }
  const sleepMs = options?.sleepMs ?? enrichPolicy?.sleepMs;
  if (sleepMs !== undefined) {
    enricherOptions.sleepMs = sleepMs;
  }
  const timeoutMs = options?.timeoutMs ?? enrichPolicy?.timeoutMs;
  if (timeoutMs !== undefined) {
    enricherOptions.timeoutMs = timeoutMs;
  }
  if (enrichPolicy?.model) {
    enricherOptions.model = enrichPolicy.model;
  }

  return enrichGraphSemanticsSilent(graphClient, enricherOptions);
}

export async function downloadOpenBmbModel(
  configPath?: string,
  options?: {
    model?: string;
    url?: string;
    sha256?: string;
    targetPath?: string;
    force?: boolean;
    onProgress?: (progress: ModelDownloadProgress) => void;
  }
): Promise<ModelDownloadResult> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);

  const model = options?.model ?? "minicpm5-1b";
  const defaultUrl = process.env.GRAPHFLOW_MINICPM_MODEL_URL;
  const url = options?.url ?? defaultUrl;

  const configuredPath = options?.targetPath ?? config.providers.openbmb?.modelPath;
  const fallbackPath = join(tmpdir(), "graphflow-models", `${model}.gguf`);
  const targetPath = configuredPath ?? fallbackPath;
  const force = options?.force ?? false;
  const expectedSha = options?.sha256 ?? process.env.GRAPHFLOW_MINICPM_MODEL_SHA256;
  const partialPath = `${targetPath}.part`;
  const lockPath = `${targetPath}.lock`;

  return withFileLock(lockPath, async () => {
    if (existsSync(targetPath) && !force) {
    const bytes = getFileSize(targetPath);
    const verified = expectedSha ? (await sha256File(targetPath)) === expectedSha.toLowerCase() : true;
    options?.onProgress?.({
      model,
      targetPath,
      downloadedBytes: bytes,
      totalBytes: bytes,
      resumed: false,
      percent: 100,
      stage: "skipped",
    });
    return {
      model,
      targetPath,
      bytes,
      skipped: true,
      verified,
    };
  }

  if (!url) {
    throw new Error("Model download URL is required. Set GRAPHFLOW_MINICPM_MODEL_URL or pass --url.");
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  let partialSize = 0;
  if (existsSync(partialPath) && !force) {
    try {
      partialSize = statSync(partialPath).size;
    } catch {
      partialSize = 0;
    }
  }

  if (force) {
    rmSync(partialPath, { force: true });
    partialSize = 0;
  }

  options?.onProgress?.({
    model,
    targetPath,
    downloadedBytes: partialSize,
    resumed: partialSize > 0,
    stage: "starting",
  });

  const fetchInit: RequestInit = {};
  if (partialSize > 0) {
    fetchInit.headers = { range: `bytes=${partialSize}-` };
  }
  const response = await fetch(url, fetchInit);
  if (!response.ok) {
    throw new Error(`Model download failed: ${response.status} ${response.statusText}`);
  }

  const acceptsRange = response.status === 206;
  if (!acceptsRange && partialSize > 0) {
    rmSync(partialPath, { force: true });
    partialSize = 0;
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0
    ? partialSize + contentLength
    : undefined;

  const stream = response.body;
  if (!stream) {
    throw new Error("Model download failed: empty response body");
  }

  const reader = stream.getReader();
  const resumed = partialSize > 0 && acceptsRange;
  const writer = createWriteStream(partialPath, { flags: resumed ? "a" : "w" });
  let downloadedBytes = partialSize;
  let lastReportedBytes = -1;

  const emitProgress = (stage: ModelDownloadProgress["stage"]) => {
    if (downloadedBytes === lastReportedBytes && stage === "downloading") {
      return;
    }
    lastReportedBytes = downloadedBytes;
    const percent = totalBytes && totalBytes > 0
      ? Math.min(100, Number(((downloadedBytes / totalBytes) * 100).toFixed(1)))
      : undefined;
    options?.onProgress?.({
      model,
      targetPath,
      downloadedBytes,
      ...(totalBytes ? { totalBytes } : {}),
      resumed,
      ...(percent !== undefined ? { percent } : {}),
      stage,
    });
  };

  emitProgress("downloading");
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      const chunk = Buffer.from(value);
      await new Promise<void>((resolve, reject) => {
        writer.write(chunk, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      downloadedBytes += chunk.length;
      emitProgress("downloading");
    }
  }

  await new Promise<void>((resolve, reject) => {
    writer.end((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  renameSync(partialPath, targetPath);

  if (expectedSha) {
    options?.onProgress?.({
      model,
      targetPath,
      downloadedBytes,
      ...(totalBytes ? { totalBytes } : {}),
      resumed,
      percent: 100,
      stage: "verifying",
    });
    const actual = await sha256File(targetPath);
    if (actual !== expectedSha.toLowerCase()) {
      rmSync(targetPath, { force: true });
      throw new Error(`Model sha256 mismatch. expected=${expectedSha.toLowerCase()} actual=${actual}`);
    }
  }

  const finalBytes = getFileSize(targetPath);
  options?.onProgress?.({
    model,
    targetPath,
    downloadedBytes: finalBytes,
    totalBytes: finalBytes,
    resumed,
    percent: 100,
    stage: "completed",
  });
    return {
      model,
      targetPath,
      bytes: finalBytes,
      skipped: false,
      verified: Boolean(expectedSha),
      ...(resumed ? { resumed: true } : {}),
    };
  });
}


export async function inspectGraph(
  configPath?: string,
  options?: { nodeLimit?: number; edgeLimit?: number }
): Promise<GraphSnapshotResult> {
  const config = resolveConfig(configPath);
  const nodeLimit = Math.max(1, options?.nodeLimit ?? 24);
  const edgeLimit = Math.max(1, options?.edgeLimit ?? 36);
  const emptyTypeCount: Record<GraphNode["type"], number> = {
    File: 0,
    Symbol: 0,
    Module: 0,
    TaskRun: 0,
    Decision: 0,
    Skill: 0,
  };

  if (config.graphPolicy.transport === "mcp-http") {
    return {
      transport: config.graphPolicy.transport,
      storePath: resolveGraphStorePath(config),
      nodeCount: 0,
      edgeCount: 0,
      nodeTypeCount: emptyTypeCount,
      topRelations: [],
      sampleNodes: [],
      sampleEdges: [],
    };
  }

  let store = loadGraphStore(config);
  if (store.nodes.length === 0) {
    const graphClient = createGraphClient(config);
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
    store = await resolveGraphStoreAfterIndex(config, graphClient);
  }

  const relationCounts = new Map<GraphEdge["relation"], number>();
  for (const edge of store.edges) {
    relationCounts.set(edge.relation, (relationCounts.get(edge.relation) ?? 0) + 1);
  }

  const nodeTypeCount = { ...emptyTypeCount };
  for (const node of store.nodes) {
    nodeTypeCount[node.type] += 1;
  }

  return {
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    nodeCount: store.nodes.length,
    edgeCount: store.edges.length,
    nodeTypeCount,
    topRelations: Array.from(relationCounts.entries())
      .map(([relation, count]) => ({ relation, count }))
      .sort((a, b) => b.count - a.count || a.relation.localeCompare(b.relation))
      .slice(0, 8),
    ...(() => {
      const isMetaFile = (id: string) => {
        const lower = id.toLowerCase();
        return lower.includes(".md") || lower.includes(".json") || lower.includes(".yml") || lower.includes(".yaml") || lower.includes(".github") || lower.includes(".claude") || lower.includes(".codex");
      };

      const adj = new Map<string, string[]>();
      for (const e of store.edges) {
        if (!adj.has(e.from)) adj.set(e.from, []);
        if (!adj.has(e.to)) adj.set(e.to, []);
        adj.get(e.from)!.push(e.to);
        adj.get(e.to)!.push(e.from);
      }

      const nodeMap = new Map(store.nodes.map(n => [n.id, n]));
      
      const degree = (id: string) => adj.get(id)?.length || 0;
      
      const sortedCandidates = store.nodes
        .filter(n => n.type === "File" && !isMetaFile(n.id))
        .sort((a, b) => degree(b.id) - degree(a.id));
      
      if (sortedCandidates.length === 0) {
        return { sampleNodes: [], sampleEdges: [] };
      }

      const visited = new Set<string>();
      const selected = [];
      let candidateIndex = 0;

      while (selected.length < nodeLimit && candidateIndex < sortedCandidates.length) {
        let root = sortedCandidates[candidateIndex++];
        while (root && visited.has(root.id) && candidateIndex < sortedCandidates.length) {
          root = sortedCandidates[candidateIndex++];
        }
        if (!root || visited.has(root.id)) break;

        const queue = [root.id];
        while (queue.length > 0 && selected.length < nodeLimit) {
          const id = queue.shift()!;
          if (visited.has(id)) continue;
          visited.add(id);
          const node = nodeMap.get(id);
          if (node) {
            selected.push(node);
            const neighbors = adj.get(id) || [];
            queue.push(...neighbors);
          }
        }
      }

      const sampleNodeIds = new Set(selected.map(n => n.id));

      return {
        sampleNodes: selected.map(node => ({
          id: node.id,
          type: node.type,
          contentPreview: compactPreview(node.content, 96),
        })),
        sampleEdges: store.edges
          .filter(edge => sampleNodeIds.has(edge.from) && sampleNodeIds.has(edge.to))
          .slice(0, edgeLimit)
          .map(edge => ({
            from: edge.from,
            relation: edge.relation,
            to: edge.to,
          }))
      };
    })(),
  };
}

export async function getSkillInsights(configPath?: string, limit = 12): Promise<SkillInsightsResult> {
  const config = resolveConfig(configPath);
  const boundedLimit = Math.max(1, limit);

  if (config.graphPolicy.transport === "mcp-http") {
    return {
      source: "unavailable",
      transport: config.graphPolicy.transport,
      storePath: resolveGraphStorePath(config),
      skills: [],
    };
  }

  let store = loadGraphStore(config);
  if (store.nodes.length === 0) {
    const graphClient = createGraphClient(config);
    const indexOptions = config.graphPolicy.includeExtensions
      ? { includeExtensions: config.graphPolicy.includeExtensions }
      : undefined;
    await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
      ...indexOptions,
    });
    store = await resolveGraphStoreAfterIndex(config, graphClient);
  }

  const skills = store.nodes
    .filter((node) => node.type === "Skill")
    .map((node) => parseSkillInsight(node))
    .filter((state): state is SkillInsightItem => Boolean(state))
    .sort((a, b) => b.score - a.score || b.uses - a.uses || b.updatedAt - a.updatedAt)
    .slice(0, boundedLimit);

  return {
    source: "graph-store",
    transport: config.graphPolicy.transport,
    storePath: resolveGraphStorePath(config),
    skills,
  };
}

export async function runTaskResult(task: string, configPath?: string): Promise<RunTaskSummary> {
  const config = resolveConfig(configPath);
  applyOpenBmbRuntimeEnv(config);
  const eventsPath = resolveLearningPath(config, "eventsPath");

  try {
    const graphClient = createGraphClient(config);
    if (config.graphPolicy.autoIndexOnRun) {
      const indexOptions = config.graphPolicy.includeExtensions
        ? { includeExtensions: config.graphPolicy.includeExtensions }
        : undefined;
      await indexWorkspaceFiles(graphClient, config.graphPolicy.workspaceRoot ?? process.cwd(), {
        ...indexOptions,
      });
    }

    const embeddingOptions = buildEmbeddingOptions(config);
    const orchestrateOptions: OrchestrateOptions = {
      graphClient,
      enableAutoGraphSync: config.graphPolicy.enableAutoBuild,
      maxContextTokens: config.graphPolicy.maxContextTokens,
      enableEpisodicMemory: config.learningPolicy.enableFlywheel,
      enableLlmAgents: config.tiers.smart.provider === "openbmb" || config.tiers.economy.provider === "openbmb",
      enableLlmTriage: config.tiers.smart.provider === "openbmb" || config.tiers.economy.provider === "openbmb",
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
    };
  } catch (error) {
    appendFeedbackEvent(eventsPath, {
      query: task,
      passed: false,
      tokenCost: 0,
      retries: 0,
    });
    throw error;
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
  };
}

export function diagnoseRouting(configPath?: string): string {
  const result = diagnoseRoutingResult(configPath);
  return [
    `dynamicRouting=${result.dynamicRouting ? "on" : "off"}`,
    `health=openai:${result.health.openai},anthropic:${result.health.anthropic},bailian:${result.health.bailian},doubao:${result.health.doubao},openbmb:${result.health.openbmb}`,
    `priority=${result.priority.join(",")}`,
    `planner=${result.planner.provider}/${result.planner.model}${result.planner.fallbackApplied ? ":fallback" : ""}`,
    `worker=${result.worker.provider}/${result.worker.model}${result.worker.fallbackApplied ? ":fallback" : ""}`,
    `validator=${result.validator.provider}/${result.validator.model}${result.validator.fallbackApplied ? ":fallback" : ""}`,
  ].join("; ");
}

export interface SettingsPanelStatusData {
  graphNodeCount: number;
  graphEdgeCount: number;
  graphLastModified: string | null;
  diagnoseSummary: string;
  overlayKeys: string[];
  baseConfigPath: string;
}

export async function getSettingsPanelStatus(configPath?: string): Promise<SettingsPanelStatusData> {
  const config = resolveConfig(configPath);
  const snapshot = await inspectGraph(configPath, { nodeLimit: 1, edgeLimit: 1 });
  const storePath = resolveGraphStorePath(config);
  let graphLastModified: string | null = null;
  if (existsSync(storePath)) {
    graphLastModified = new Date(statSync(storePath).mtimeMs).toISOString();
  }

  return {
    graphNodeCount: snapshot.nodeCount,
    graphEdgeCount: snapshot.edgeCount,
    graphLastModified,
    diagnoseSummary: diagnoseRouting(configPath),
    overlayKeys: listConfigOverlayKeys(),
    baseConfigPath: existsSync("graphflow.config.json") ? "graphflow.config.json" : "（未创建）",
  };
}

export function runLearningNightlyResult(configPath?: string): LearningNightlyResult {
  const config = resolveConfig(configPath);
  const summary = runNightlyLearning(config);

  return {
    events: summary.totalEvents,
    passRate: summary.passRate,
    avgTokens: summary.averageTokenCost,
    canary: summary.canaryAllowed ? "allow" : "block",
    reason: summary.canaryReason,
    dataset: summary.exportedPath,
  };
}

export function runLearningNightly(configPath?: string): string {
  const result = runLearningNightlyResult(configPath);
  return [
    `events=${result.events}`,
    `passRate=${result.passRate.toFixed(3)}`,
    `avgTokens=${result.avgTokens.toFixed(1)}`,
    `canary=${result.canary}`,
    `reason=${result.reason}`,
    `dataset=${result.dataset}`,
  ].join("; ");
}

export interface PlanPreviewResult {
  mode: "simple" | "complex";
  ideas: string[];
  nodes: Array<{ id: string; description: string; dependencies: string[] }>;
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

export {
  buildMcpServerNode,
  detectInstalledAgents,
  formatModelConfigGuide,
  installMcpToDetectedAgents,
  type DetectedAgent,
  type McpInstallOptions,
  type McpInstallResult,
  type McpInstallStrategy,
} from "../../integrations/agent-mcp-installer";

function extractTokenCost(feedback: string): number {
  const match = feedback.match(/tokens=(\d+)/);
  if (match && match[1]) {
    return Number(match[1]);
  }

  return Math.max(1, Math.ceil(feedback.length / 4));
}

function loadGraphStore(config: GraphFlowConfig): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const transport = config.graphPolicy.transport;

  if (transport === "memory") {
    return { nodes: [], edges: [] };
  }

  if (transport === "sqlite") {
    const dbPath = resolveGraphStorePath(config);
    try {
      const client = new GraphifySqliteClient(dbPath);
      const snapshot = client.readSnapshot();
      client.close();
      return snapshot;
    } catch {
      const fallbackPath = dbPath.replace(/\.sqlite$/i, ".json");
      return readFileGraphStore(fallbackPath);
    }
  }

  return readFileGraphStore(resolveGraphStorePath(config));
}

async function resolveGraphStoreAfterIndex(
  config: GraphFlowConfig,
  graphClient: GraphClient
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (config.graphPolicy.transport === "memory" && graphClient.readSnapshot) {
    return graphClient.readSnapshot();
  }

  return loadGraphStore(config);
}

function readFileGraphStore(storePath: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!storePath || !existsSync(storePath)) {
    return { nodes: [], edges: [] };
  }

  try {
    const raw = readFileSync(storePath, "utf8");
    if (!raw.trim()) {
      return { nodes: [], edges: [] };
    }

    const parsed = JSON.parse(raw) as Partial<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
    return {
      nodes: parsed.nodes ?? [],
      edges: parsed.edges ?? [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function readRawConfig(configPath: string): Partial<GraphFlowConfig> | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Partial<GraphFlowConfig>;
  } catch {
    return undefined;
  }
}

function estimateRawContextTokens(
  store: { nodes: GraphNode[]; edges: GraphEdge[] },
  query: string,
  compressedTokens: number
): number {
  const matching = store.nodes.filter((node) => {
    const haystack = `${node.id} ${node.type} ${node.content}`.toLowerCase();
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((item) => item.length >= 2);
    return terms.length === 0 || terms.some((term) => haystack.includes(term));
  });
  const nodes = matching.length > 0 ? matching : store.nodes;
  const rawTokens = nodes.reduce(
    (sum, node) => sum + estimateTokenCount(`${node.id}\n${node.type}\n${node.content}`),
    0
  );

  return Math.max(compressedTokens, rawTokens, estimateTokenCount(query));
}

function calculateSavingsPercent(rawTokens: number, compressedTokens: number): number {
  if (rawTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(((rawTokens - compressedTokens) / rawTokens) * 100)));
}

function calculateBudgetUsedPercent(compressedTokens: number, maxContextTokens: number): number {
  if (maxContextTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.round((compressedTokens / maxContextTokens) * 100));
}

function estimateTokenCount(text: string): number {
  try {
    const { encode } = require("gpt-tokenizer/model/gpt-4o") as { encode: (t: string) => number[] };
    return Math.max(1, encode(text).length);
  } catch {
    return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
  }
}

function compactPreview(content: string, maxLength: number): string {
  const compacted = content.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function parseSkillInsight(node: GraphNode): SkillInsightItem | undefined {
  try {
    const parsed = JSON.parse(node.content) as Partial<SkillInsightItem>;
    if (!parsed.id || !parsed.name) {
      return undefined;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return undefined;
  }
}
