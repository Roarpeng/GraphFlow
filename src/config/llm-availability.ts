import type { GraphFlowConfig } from "./schema";
import { resolveConfigSecret } from "./secrets";
import type { ProviderName } from "../routing/model-router";

function providerHasCredentials(provider: ProviderName, config: GraphFlowConfig): boolean {
  const details = config.providers[provider];
  if (!details) {
    return false;
  }

  if (provider === "openbmb") {
    const mode = details.mode ?? "embedded";
    if (mode === "ollama" || mode === "openai-compat") {
      return Boolean(details.baseUrl?.trim());
    }
    // Embedded counts only when explicitly configured (not assumed available).
    return Boolean(
      resolveConfigSecret(details.apiKey) || resolveConfigSecret(details.modelPath)
    );
  }

  const apiKey = resolveConfigSecret(details.apiKey);
  return Boolean(apiKey && apiKey.length > 0 && !apiKey.startsWith("${"));
}

/**
 * True when at least one configured tier provider can call an LLM without
 * relying on the connected coding agent's model.
 */
export function hasUsableLlmProvider(config: GraphFlowConfig): boolean {
  const providers = new Set<ProviderName>([
    config.tiers.smart.provider as ProviderName,
    config.tiers.economy.provider as ProviderName,
  ]);

  for (const provider of providers) {
    if (providerHasCredentials(provider, config)) {
      return true;
    }
  }

  return false;
}
