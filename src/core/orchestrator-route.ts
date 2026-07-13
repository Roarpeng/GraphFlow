import {
  resolveModelForRole,
  resolveModelWithFallback,
  type ProviderName,
  type ProviderHealthMap,
} from "../routing/model-router.js";
import type { RouteDecision, TaskRunResult } from "./types.js";

export function buildRouteDecisions(
  providerHealth?: ProviderHealthMap,
  providerFallbackChain?: ProviderName[],
  configPath?: string
): {
  planner: RouteDecision;
  worker: RouteDecision;
  validator: RouteDecision;
} {
  const resolve = (role: "planner" | "worker" | "validator") =>
    providerHealth
      ? resolveModelWithFallback(role, providerHealth, providerFallbackChain, configPath)
      : resolveModelForRole(role, configPath);

  return {
    planner: selectionToDecision("planner", resolve("planner")),
    worker: selectionToDecision("worker", resolve("worker")),
    validator: selectionToDecision("validator", resolve("validator")),
  };
}

function selectionToDecision(role: "planner" | "worker" | "validator", selection: {
  provider: string;
  model: string;
  tier: "smart" | "economy";
  fallbackApplied: boolean;
}): RouteDecision {
  return {
    role,
    provider: selection.provider,
    model: selection.model,
    tier: selection.tier,
    fallbackApplied: selection.fallbackApplied,
  };
}

export function decisionToSelection(decision: RouteDecision): {
  provider: "openai" | "anthropic" | "bailian" | "doubao" | "deepseek";
  model: string;
  tier: "smart" | "economy";
  fallbackApplied: boolean;
} {
  return {
    provider: decision.provider as "openai" | "anthropic" | "bailian" | "doubao" | "deepseek",
    model: decision.model,
    tier: decision.tier,
    fallbackApplied: decision.fallbackApplied,
  };
}

export function selectionIfHealthy(
  selection: ReturnType<typeof decisionToSelection>,
  providerHealth?: ProviderHealthMap
): ReturnType<typeof decisionToSelection> | undefined {
  if (!providerHealth) {
    return selection;
  }
  return providerHealth[selection.provider as ProviderName] ? selection : undefined;
}

export function appendRouteFeedback(
  run: TaskRunResult,
  routeDecisions: { planner: RouteDecision; worker: RouteDecision; validator: RouteDecision },
  skillHints: string[]
): TaskRunResult {
  return {
    ...run,
    routeDecisions: [routeDecisions.planner, routeDecisions.worker, routeDecisions.validator],
    feedback:
      `${run.feedback}; routes(planner=${routeDecisions.planner.provider}/${routeDecisions.planner.model}` +
      `,worker=${routeDecisions.worker.provider}/${routeDecisions.worker.model}` +
      `,validator=${routeDecisions.validator.provider}/${routeDecisions.validator.model})` +
      `${skillHints.length > 0 ? `; skills(hints=${skillHints.join("|")})` : ""}`,
  };
}