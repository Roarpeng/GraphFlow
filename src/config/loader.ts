import { readFileSync } from "node:fs";
import type { GraphFlowConfig } from "./schema";

export function loadConfig(path = "graphflow.config.json"): GraphFlowConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as GraphFlowConfig;
  return validateConfig(parsed);
}

export function validateConfig(input: GraphFlowConfig): GraphFlowConfig {
  if (!input.tiers?.smart?.provider || !input.tiers?.economy?.provider) {
    throw new Error("Invalid config: tiers.smart and tiers.economy are required.");
  }

  if (!input.budgetPolicy || input.budgetPolicy.runTokenCap <= 0) {
    throw new Error("Invalid config: budgetPolicy.runTokenCap must be positive.");
  }

  if (!input.graphPolicy) {
    throw new Error("Invalid config: graphPolicy is required.");
  }

  if (input.graphPolicy.transport === "mcp-http" && !input.graphPolicy.mcpEndpoint) {
    throw new Error("Invalid config: graphPolicy.mcpEndpoint is required for mcp-http.");
  }

  if (!input.learningPolicy) {
    throw new Error("Invalid config: learningPolicy is required.");
  }

  return {
    ...input,
    learningPolicy: {
      ...input.learningPolicy,
      trainingCadence: input.learningPolicy.trainingCadence ?? "nightly",
      canaryRatio: input.learningPolicy.canaryRatio ?? 10,
    },
  };
}
