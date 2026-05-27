import type { AgentRole } from "../core/types";

export type ModelTier = "smart" | "economy";

export interface ModelSelection {
  provider: string;
  model: string;
  tier: ModelTier;
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
    };
  }

  return {
    provider: "openai",
    model: "gpt-4.1-mini",
    tier,
  };
}
