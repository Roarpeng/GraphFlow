import { resolveConfigSecret } from "../config/secrets";
import type { GraphFlowConfig } from "../config/schema";
import type { ProviderHealthMap, ProviderName } from "./model-router";

export const ALL_PROVIDERS: ProviderName[] = [
  "openai",
  "anthropic",
  "bailian",
  "doubao",
  "deepseek",
];

// Runtime consecutive-failure tracker (in-memory only)
const failureCounts = new Map<ProviderName, number>();

export function recordProviderFailure(provider: ProviderName): void {
  failureCounts.set(provider, (failureCounts.get(provider) ?? 0) + 1);
}

export function recordProviderSuccess(provider: ProviderName): void {
  failureCounts.delete(provider);
}

export function resetProviderHealth(): void {
  failureCounts.clear();
}

export function buildProviderHealthMap(config: GraphFlowConfig): ProviderHealthMap {
  const requireApiKey = config.routingPolicy?.requireApiKeyForHealthy ?? false;

  const healthEntries = ALL_PROVIDERS.map((provider) => {
    const details = config.providers[provider];

    if (!details) {
      return [provider, false] as const;
    }

    // Runtime signal: consecutive failures >= 3 -> unhealthy regardless of config
    const consecutiveFailures = failureCounts.get(provider) ?? 0;
    if (consecutiveFailures >= 3) {
      return [provider, false] as const;
    }

    if (!requireApiKey) {
      return [provider, true] as const;
    }

    return [provider, Boolean(resolveConfigSecret(details.apiKey))] as const;
  });

  return Object.fromEntries(healthEntries) as ProviderHealthMap;
}

export function buildFallbackChain(config: GraphFlowConfig): ProviderName[] {
  const priority = config.routingPolicy?.providerPriority ?? ALL_PROVIDERS;
  const unique: ProviderName[] = [];

  for (const provider of priority) {
    if (!unique.includes(provider)) {
      unique.push(provider);
    }
  }

  for (const provider of ALL_PROVIDERS) {
    if (!unique.includes(provider)) {
      unique.push(provider);
    }
  }

  return unique;
}
