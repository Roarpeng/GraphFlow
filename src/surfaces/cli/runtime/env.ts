import { resolveConfigSecret } from "../../../config/secrets";
import { resolveConfig } from "../../../config/resolve";
import { createEmbeddingProviderFromConfig } from "../../../config/embedding-factory";
import type { GraphFlowConfig } from "../../../config/schema";

export function resolveEnrichmentBackend(
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

export function buildEmbeddingOptions(config: GraphFlowConfig) {
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
