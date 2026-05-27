import type { AgentRole } from "../core/types";

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
};

export function resolveModelForRole(role: AgentRole): ModelSelection {
  const tier = roleTierMap[role];

  if (tier === "smart") {
    return {
      provider: "openai",
      model: "gpt-5.3-codex",
      tier,
      fallbackApplied: false,
    };
  }

  return {
    provider: "openai",
    model: "gpt-4.1-mini",
    tier,
    fallbackApplied: false,
  };
}

export function resolveModelWithFallback(
  role: AgentRole,
  providerHealth: ProviderHealthMap
): ModelSelection {
  const base = resolveModelForRole(role);

  if (providerHealth[base.provider]) {
    return base;
  }

  const fallbackChain: ProviderName[] = ["anthropic", "bailian", "doubao"];
  const available = fallbackChain.find((provider) => providerHealth[provider]);

  if (!available) {
    return {
      ...base,
      fallbackApplied: true,
    };
  }

  const fallbackModel = base.tier === "smart" ? "claude-sonnet" : "claude-haiku";
  return {
    provider: available,
    model: fallbackModel,
    tier: base.tier,
    fallbackApplied: true,
  };
}
