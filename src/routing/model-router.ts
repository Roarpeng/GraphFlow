import type { AgentRole } from "../core/types";
import { resolveConfig } from "../config/resolve";

export type ModelTier = "smart" | "economy";
export type ProviderName = "openai" | "anthropic" | "bailian" | "doubao" | "openbmb";

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
  enricher: "economy",
  evolver: "economy",
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
  openbmb: {
    smart: "minicpm5-1b",
    economy: "minicpm5-1b",
  },
};

export function resolveModelForRole(role: AgentRole, configPath?: string): ModelSelection {
  const tier = roleTierMap[role];

  try {
    const config = resolveConfig(configPath ?? "graphflow.config.json");

    if (role === "enricher") {
      const enrichPolicy = config.graphPolicy.semanticEnrichment;
      const backend = enrichPolicy?.backend ?? "inherit";

      if (backend === "local" || enrichPolicy?.provider === "openbmb") {
        return {
          provider: "openbmb",
          model:
            enrichPolicy?.model ??
            config.learningPolicy.skillEvolution?.model ??
            DEFAULT_MODELS.openbmb.economy,
          tier,
          fallbackApplied: false,
        };
      }

      const provider = (
        backend === "network" && enrichPolicy?.provider
          ? enrichPolicy.provider
          : enrichPolicy?.provider ?? config.tiers.economy.provider
      ) as ProviderName;
      return {
        provider,
        model:
          enrichPolicy?.model ??
          config.tiers.economy.model ??
          DEFAULT_MODELS[provider].economy,
        tier,
        fallbackApplied: false,
      };
    }

    if (role === "evolver") {
      const provider = config.tiers.economy.provider as ProviderName;
      return {
        provider,
        model:
          config.learningPolicy.skillEvolution?.model ??
          config.tiers.economy.model ??
          DEFAULT_MODELS[provider].economy,
        tier: "economy",
        fallbackApplied: false,
      };
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

  const chain = fallbackChain ?? ["anthropic", "bailian", "doubao", "openbmb"];
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
