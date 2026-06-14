import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateConfig } from "../../../config/loader";
import { formatApiKeyForConfig, formatApiKeyForSettings, resolveConfigSecret } from "../../../config/secrets";
import { resolveConfig, resolveConfigPath, resolveWritableConfigPath } from "../../../config/resolve";
import type { GraphFlowConfig } from "../../../config/schema";
import { resolveEnrichmentBackend } from "./env.js";
import { readRawConfig } from "./helpers.js";
import type { GraphFlowSettings, GraphFlowSettingsInput, SettingsValidationIssue } from "./types.js";

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
  const actualPath = resolveWritableConfigPath(configPath);
  const current = resolveConfig(configPath);
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

function hasResolvableApiKey(apiKeyEnvVar?: string): boolean {
  if (!apiKeyEnvVar?.trim()) {
    return false;
  }
  return Boolean(resolveConfigSecret(formatApiKeyForConfig(apiKeyEnvVar)));
}

export function validateSettingsForGraphIndex(settings: GraphFlowSettingsInput): SettingsValidationIssue[] {
  const issues: SettingsValidationIssue[] = [];
  if (!settings.graphStorePath?.trim()) {
    issues.push({ field: "graphStorePath", message: "请填写图谱存储路径" });
  }
  return issues;
}

export function validateSettingsForRouting(settings: GraphFlowSettingsInput): SettingsValidationIssue[] {
  const issues: SettingsValidationIssue[] = [];
  const provider = settings.provider?.trim();

  if (!provider) {
    issues.push({ field: "provider", message: "请选择 LLM Provider" });
  }

  if (provider === "openbmb") {
    if (settings.openbmbMode === "embedded" && !settings.openbmbModelPath?.trim() && !settings.openbmbAutoDownload) {
      issues.push({ field: "openbmbModelPath", message: "本地 OpenBMB 需填写模型路径或勾选自动下载" });
    }
    if (
      (settings.openbmbMode === "ollama" || settings.openbmbMode === "openai-compat") &&
      !settings.openbmbBaseUrl?.trim()
    ) {
      issues.push({ field: "openbmbBaseUrl", message: "OpenBMB 手动模式需填写 Base URL" });
    }
  } else if (!hasResolvableApiKey(settings.apiKeyEnvVar)) {
    issues.push({ field: "apiKeyEnvVar", message: "请填写可用的 API Key 或已配置的环境变量名" });
  }

  if (provider === "openai" && !settings.baseUrl?.trim()) {
    issues.push({ field: "baseUrl", message: "OpenAI 兼容接口需填写 Base URL（如 DeepSeek）" });
  }

  if (!settings.graphStorePath?.trim()) {
    issues.push({ field: "graphStorePath", message: "请填写图谱存储路径" });
  }
  if (!settings.enableNearLosslessMode) {
    issues.push({ field: "enableNearLosslessMode", message: "请开启 near-lossless 上下文压缩" });
  }
  if (!settings.autoIndexOnPreview) {
    issues.push({ field: "autoIndexOnPreview", message: "请开启 Auto index on preview" });
  }
  if (!settings.autoIndexOnRun) {
    issues.push({ field: "autoIndexOnRun", message: "请开启 Auto index on run" });
  }

  return issues;
}
