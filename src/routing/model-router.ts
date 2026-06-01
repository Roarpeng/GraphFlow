import type { AgentRole } from "../core/types";

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
    smart: "minicpm-1b",
    economy: "minicpm-1b",
  },
};

export function resolveModelForRole(role: AgentRole): ModelSelection {
  const tier = roleTierMap[role];
  return {
    provider: "openai",
    model: DEFAULT_MODELS.openai[tier],
    tier,
    fallbackApplied: false,
  };
}

export function resolveModelWithFallback(
  role: AgentRole,
  providerHealth: ProviderHealthMap,
  fallbackChain?: ProviderName[]
): ModelSelection {
  const base = resolveModelForRole(role);

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
