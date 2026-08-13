import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateConfig } from "../../../config/loader";
import { DEFAULT_OUTPUT_DIR } from "../../../config/defaults";
import {
  applyDocumentIndexScope,
  hasMarkdownIndex,
  hasOfficeIndex,
} from "../../../config/include-extensions.js";
import { formatApiKeyForConfig, formatApiKeyForSettings, resolveConfigSecret } from "../../../config/secrets";
import { resolveConfig, resolveConfigPath, resolveWritableConfigPath } from "../../../config/resolve";
import { resolveGlobalConfigPath } from "../../../config/scaffold";
import { stripWorkspaceRootForGlobalPersist } from "../../../config/workspace-root";
import type { GraphFlowConfig } from "../../../config/schema";
import { readRawConfig } from "./helpers.js";
import type { GraphFlowSettings, GraphFlowSettingsInput, SettingsValidationIssue } from "./types.js";

type TierName = "smart" | "economy";

interface ResolvedTier {
  provider: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

function resolveTier(settings: GraphFlowSettingsInput, tier: TierName): ResolvedTier {
  const isSmart = tier === "smart";
  const provider = (
    isSmart ? settings.smartProvider : settings.economyProvider
  )?.trim() || settings.provider?.trim() || "";
  const apiKey = isSmart
    ? settings.smartApiKey ?? settings.apiKeyEnvVar
    : settings.economyApiKey ?? settings.apiKeyEnvVar;
  const model = isSmart ? settings.smartModel : settings.economyModel;
  const baseUrl = isSmart
    ? settings.smartBaseUrl ?? settings.baseUrl
    : settings.economyBaseUrl ?? settings.baseUrl;

  return {
    provider,
    ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
    model: model ?? "",
    ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}),
  };
}

function readTierFromConfig(
  config: GraphFlowConfig,
  rawConfig: Partial<GraphFlowConfig> | undefined,
  tier: TierName
): ResolvedTier {
  const tierConfig = tier === "smart" ? config.tiers.smart : config.tiers.economy;
  const provider = tierConfig.provider;
  const rawProvider = rawConfig?.providers?.[provider] ?? {};
  const resolvedProvider = config.providers[provider] ?? {};
  const apiKey = formatApiKeyForSettings(rawProvider.apiKey ?? resolvedProvider.apiKey);
  const baseUrl = rawProvider.baseUrl ?? resolvedProvider.baseUrl;

  return {
    provider,
    model: tierConfig.model ?? "",
    ...(apiKey ? { apiKey } : {}),
    ...(typeof baseUrl === "string" && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
  };
}

function mergeProviderConfig(
  providers: GraphFlowConfig["providers"],
  provider: string,
  patch: { apiKey?: string; baseUrl?: string }
): void {
  if (!provider) {
    return;
  }
  const current = providers[provider] ?? {};
  providers[provider] = {
    ...current,
    ...(patch.apiKey?.trim() ? { apiKey: formatApiKeyForConfig(patch.apiKey) } : {}),
    ...(patch.baseUrl?.trim() ? { baseUrl: patch.baseUrl.trim() } : {}),
  } as GraphFlowConfig["providers"][string];
}

export function getGraphFlowSettings(configPath = "graphflow.config.json"): GraphFlowSettings {
  const actualPath = resolveConfigPath(configPath);
  const config = resolveConfig(actualPath);
  const rawConfig = readRawConfig(actualPath);
  const smart = readTierFromConfig(config, rawConfig, "smart");
  const economy = readTierFromConfig(config, rawConfig, "economy");

  return {
    configPath: actualPath,
    smartProvider: smart.provider,
    ...(smart.apiKey ? { smartApiKey: smart.apiKey } : {}),
    smartModel: smart.model,
    ...(smart.baseUrl ? { smartBaseUrl: smart.baseUrl } : {}),
    economyProvider: economy.provider,
    ...(economy.apiKey ? { economyApiKey: economy.apiKey } : {}),
    economyModel: economy.model,
    ...(economy.baseUrl ? { economyBaseUrl: economy.baseUrl } : {}),
    provider: smart.provider,
    ...(smart.apiKey ? { apiKeyEnvVar: smart.apiKey } : {}),
    ...(smart.baseUrl ? { baseUrl: smart.baseUrl } : {}),
    maxContextTokens: config.graphPolicy.maxContextTokens,
    layerQuota: config.graphPolicy.layerQuota ?? { l1: 6, l2: 4, l3: 3 },
    enableNearLosslessMode: config.graphPolicy.enableNearLosslessMode ?? false,
    autoIndexOnPreview: config.graphPolicy.autoIndexOnPreview ?? true,
    autoIndexOnRun: config.graphPolicy.autoIndexOnRun ?? true,
    autoIndexOnSave: config.graphPolicy.autoIndexOnSave ?? true,
    transport: config.graphPolicy.transport,
    graphStorePath: config.graphPolicy.graphStorePath ?? `${DEFAULT_OUTPUT_DIR}/graphflow-graph.json`,
    autoRunOnIndex: true,
    indexMarkdown: hasMarkdownIndex(config.graphPolicy.includeExtensions),
    indexOfficeDocs: hasOfficeIndex(config.graphPolicy.includeExtensions),
    embeddingProvider: config.graphPolicy.embeddingProvider ?? "fnv",
  };
}

export function saveGraphFlowSettings(
  settings: GraphFlowSettingsInput,
  configPath = "graphflow.config.json"
): GraphFlowSettings {
  const actualPath = resolveWritableConfigPath(configPath);
  const current = resolveConfig(configPath);
  const smart = resolveTier(settings, "smart");
  const economy = resolveTier(settings, "economy");

  const providers: GraphFlowConfig["providers"] = {
    ...current.providers,
  };

  mergeProviderConfig(providers, smart.provider, smart);
  if (economy.provider && economy.provider !== smart.provider) {
    mergeProviderConfig(providers, economy.provider, economy);
  }

  const updated = validateConfig({
    ...current,
    providers,
    tiers: {
      smart: {
        provider: smart.provider || current.tiers.smart.provider,
        ...(smart.model?.trim()
          ? { model: smart.model.trim() }
          : current.tiers.smart.model
            ? { model: current.tiers.smart.model }
            : {}),
      },
      economy: {
        provider: economy.provider || current.tiers.economy.provider,
        ...(economy.model?.trim()
          ? { model: economy.model.trim() }
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
      ...(settings.indexMarkdown !== undefined || settings.indexOfficeDocs !== undefined
        ? {
            includeExtensions: applyDocumentIndexScope(current.graphPolicy.includeExtensions, {
              markdown: settings.indexMarkdown ?? hasMarkdownIndex(current.graphPolicy.includeExtensions),
              office: settings.indexOfficeDocs ?? hasOfficeIndex(current.graphPolicy.includeExtensions),
            }),
          }
        : {}),
      ...(settings.embeddingProvider ? { embeddingProvider: settings.embeddingProvider } : {}),
    },
    learningPolicy: {
      ...current.learningPolicy,
    },
  });

  const dir = dirname(actualPath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  const persisted =
    actualPath === resolveGlobalConfigPath() ? stripWorkspaceRootForGlobalPersist(updated) : updated;
  writeFileSync(actualPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  return getGraphFlowSettings(actualPath);
}

function hasResolvableApiKey(apiKeyEnvVar?: string): boolean {
  if (!apiKeyEnvVar?.trim()) {
    return false;
  }
  return Boolean(resolveConfigSecret(formatApiKeyForConfig(apiKeyEnvVar)));
}

function tierIsConfigured(tier: ResolvedTier): boolean {
  return Boolean(tier.provider?.trim() && tier.model?.trim());
}

function validateTierRouting(
  tierName: TierName,
  tier: ResolvedTier,
  _settings: GraphFlowSettingsInput
): SettingsValidationIssue[] {
  const issues: SettingsValidationIssue[] = [];
  const prefix = tierName === "smart" ? "smart" : "economy";
  const label = tierName === "smart" ? "Smart" : "Economy";

  if (!tier.provider?.trim()) {
    if (tier.apiKey || tier.model?.trim()) {
      issues.push({ field: `${prefix}Provider`, message: `请为 ${label} 层选择 Provider` });
    }
    return issues;
  }

  if (!tierIsConfigured(tier) && (tier.apiKey || tier.provider)) {
    if (!tier.model?.trim()) {
      issues.push({ field: `${prefix}Model`, message: `请填写 ${label} 层模型` });
    }
  }

  if (!tierIsConfigured(tier)) {
    return issues;
  }

  if (!hasResolvableApiKey(tier.apiKey)) {
    issues.push({
      field: `${prefix}ApiKey`,
      message: `请为 ${label} 层填写可用的 API Key 或环境变量名`,
    });
  }

  if (tier.provider === "openai" && !tier.baseUrl?.trim()) {
    issues.push({
      field: `${prefix}BaseUrl`,
      message: `${label} 层 OpenAI 兼容接口需填写 Base URL（可在高级选项中覆盖）`,
    });
  }

  return issues;
}

export function validateSettingsForGraphIndex(settings: GraphFlowSettingsInput): SettingsValidationIssue[] {
  const issues: SettingsValidationIssue[] = [];
  if (!settings.graphStorePath?.trim()) {
    issues.push({ field: "graphStorePath", message: "请填写图谱存储路径" });
  }
  return issues;
}

export function validateSettingsForRouting(settings: GraphFlowSettingsInput): SettingsValidationIssue[] {
  const smart = resolveTier(settings, "smart");
  const economy = resolveTier(settings, "economy");
  const issues: SettingsValidationIssue[] = [
    ...validateTierRouting("smart", smart, settings),
    ...validateTierRouting("economy", economy, settings),
  ];

  if (!tierIsConfigured(smart) && !tierIsConfigured(economy)) {
    issues.push({
      field: "smartProvider",
      message: "请至少完整配置 Smart 或 Economy 一层（Provider、API Key、Model）",
    });
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
  if (!settings.autoIndexOnSave) {
    issues.push({ field: "autoIndexOnSave", message: "请开启 Auto index on file save" });
  }

  return issues;
}
