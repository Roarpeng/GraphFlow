import type { AgentRole } from "../core/types";
import type { GraphFlowConfig } from "../config/schema";
import { resolveConfig } from "../config/resolve";

export type ModelTier = "smart" | "economy";
export type ProviderName = "openai" | "anthropic" | "bailian" | "doubao";

export type ProviderHealthMap = Record<ProviderName, boolean>;

export interface ModelSelection {
  provider: ProviderName;
  model: string;
  tier: ModelTier;
  fallbackApplied: boolean;
}

const roleTierMap: Record<AgentRole, ModelTier> = {
  planner: "smart",
  validator: "smart",
  worker: "economy",
  compressor: "economy",
};

const DEFAULT_MODELS: Record<ProviderName, Record<ModelTier, string>> = {
  openai: {
    smart: "gpt-4.1",
    economy: "gpt-4.1-mini",
  },
  anthropic: {
    smart: "claude-3-5-sonnet-latest",
    economy: "claude-3-5-haiku-latest",
  },
  bailian: {
    smart: "qwen-max",
    economy: "qwen-plus",
  },
  doubao: {
    smart: "doubao-pro-32k",
    economy: "doubao-lite-32k",
  },
};

/**
 * Resolves the compression model selection from an in-memory config object
 * (no disk re-read). Shared by resolveModelForRole and describeCompressionBackend
 * so config and selection always come from the same source.
 */
export function resolveCompressorSelection(config: GraphFlowConfig): ModelSelection {
  const tier: ModelTier = "economy";
  const compressionPolicy = config.graphPolicy.compression;
  const backend = compressionPolicy?.backend ?? "inherit";

  // network backend with explicit provider override, else inherit economy tier
  const provider = (
    backend === "network" && compressionPolicy?.provider
      ? compressionPolicy.provider
      : compressionPolicy?.provider ?? config.tiers.economy.provider
  ) as ProviderName;
  return {
    provider,
    model:
      compressionPolicy?.model ??
      config.tiers.economy.model ??
      DEFAULT_MODELS[provider].economy,
    tier,
    fallbackApplied: false,
  };
}

export function resolveModelForRole(role: AgentRole, configPath?: string): ModelSelection {
  const tier = roleTierMap[role];

  try {
    const config = resolveConfig(configPath ?? "graphflow.config.json");

    if (role === "compressor") {
      return resolveCompressorSelection(config);
    }

    const tierConfig = config.tiers[tier];
    const provider = tierConfig.provider as ProviderName;
    return {
      provider,
      model: tierConfig.model || DEFAULT_MODELS[provider][tier],
      tier,
      fallbackApplied: false,
    };
  } catch {
    return {
      provider: "openai",
      model: DEFAULT_MODELS.openai[tier],
      tier,
      fallbackApplied: false,
    };
  }
}

export function resolveModelWithFallback(
  role: AgentRole,
  providerHealth: ProviderHealthMap,
  fallbackChain?: ProviderName[],
  configPath?: string
): ModelSelection {
  const base = resolveModelForRole(role, configPath);

  if (providerHealth[base.provider]) {
    return base;
  }

  const chain = fallbackChain ?? ["anthropic", "bailian", "doubao"];
  const available = chain.find((provider) => provider !== base.provider && providerHealth[provider]);

  if (!available) {
    return {
      ...base,
      fallbackApplied: true,
    };
  }

  return {
    provider: available,
    model: DEFAULT_MODELS[available][base.tier],
    tier: base.tier,
    fallbackApplied: true,
  };
}
