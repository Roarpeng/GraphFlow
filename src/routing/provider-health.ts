import type { GraphFlowConfig } from "../config/schema";
import type { ProviderHealthMap, ProviderName } from "./model-router";

const ALL_PROVIDERS: ProviderName[] = ["openai", "anthropic", "bailian", "doubao"];

export function buildProviderHealthMap(config: GraphFlowConfig): ProviderHealthMap {
  const requireApiKey = config.routingPolicy?.requireApiKeyForHealthy ?? false;

  const healthEntries = ALL_PROVIDERS.map((provider) => {
    const details = config.providers[provider];

    if (!details) {
      return [provider, false] as const;
    }

    if (!requireApiKey) {
      return [provider, true] as const;
    }

    return [provider, Boolean(details.apiKey)] as const;
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
