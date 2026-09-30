import type { GraphFlowConfig, ProviderConfig } from "./schema";
import { resolveConfigSecret } from "./secrets";
import type { ProviderName } from "../routing/model-router";
import { isLocalhostEndpoint, detectApiKeyFromEndpoint, isConfigExportedEnvKey } from "./provider-env";

const PROVIDER_ENV_KEYS: Record<ProviderName, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  bailian: ["BAILIAN_API_KEY"],
  doubao: ["DOUBAO_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY", "TYPESAFE_API_KEY"],
};

export function providerHasCredentials(provider: string, config: GraphFlowConfig): boolean {
  const details = config.providers[provider] as (ProviderConfig & { enabled?: boolean }) | undefined;

  // Explicitly disabled via config
  if (details && details.enabled === false) {
    return false;
  }

  // 1. Explicitly configured apiKey in config
  if (details && details.apiKey !== undefined) {
    const rawKey = details.apiKey.trim();
    // Explicitly closed or cleared by user
    if (rawKey === "" || rawKey.toLowerCase() === "disabled" || rawKey.toLowerCase() === "none") {
      return false;
    }
    const resolved = resolveConfigSecret(details.apiKey);
    if (resolved && resolved.length > 0 && !resolved.startsWith("${")) {
      return true;
    }
  }

  // Determine effective baseUrl for this provider (from config or process.env)
  const envBaseUrlKey =
    provider === "openai"
      ? "OPENAI_BASE_URL"
      : provider === "anthropic"
        ? "ANTHROPIC_BASE_URL"
        : provider === "deepseek"
          ? "DEEPSEEK_BASE_URL"
          : provider === "bailian"
            ? "BAILIAN_BASE_URL"
            : provider === "doubao"
              ? "DOUBAO_BASE_URL"
              : "LLM_BASE_URL";
  // Env baseUrl counts only when the SHELL provided it — a value exported
  // from another config's applyProviderEnvFromConfig is that config's
  // endpoint, not this one's (availability must not feed on its own output).
  const envBaseUrl = isConfigExportedEnvKey(envBaseUrlKey)
    ? undefined
    : process.env[envBaseUrlKey]?.trim();
  const baseUrl = details?.baseUrl?.trim() || envBaseUrl;

  // 2. Localhost / local endpoint: password-free / key-exempt service
  if (baseUrl && isLocalhostEndpoint(baseUrl)) {
    return true;
  }

  // 3. Auto-detect API key from endpoint domain characteristics
  if (baseUrl) {
    const detectedKey = detectApiKeyFromEndpoint(baseUrl);
    if (detectedKey && detectedKey.length > 0 && !detectedKey.startsWith("${")) {
      return true;
    }
  }

  // 4. Sniff provider-specific or fallback environment variables
  const isTierProvider =
    config.tiers.smart.provider === provider || config.tiers.economy.provider === provider;
  const isExplicitTier = isTierProvider && (provider !== "openai" || Object.keys(config.providers).length > 0);

  if (details !== undefined || isExplicitTier) {
    const envKeys = [
      ...(PROVIDER_ENV_KEYS[provider as ProviderName] ?? []),
      "LLM_API_KEY",
      "API_KEY",
    ];
    for (const envKey of envKeys) {
      if (isConfigExportedEnvKey(envKey)) {
        continue;
      }
      const envVal = process.env[envKey]?.trim();
      if (envVal && envVal.length > 0 && !envVal.startsWith("${")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * True when at least one configured tier provider or configured provider
 * can call an LLM without relying on the connected coding agent's model.
 */
export function hasUsableLlmProvider(config: GraphFlowConfig): boolean {
  const candidateProviders = new Set<string>([
    config.tiers.smart.provider,
    config.tiers.economy.provider,
    ...Object.keys(config.providers),
  ]);

  for (const provider of candidateProviders) {
    if (providerHasCredentials(provider, config)) {
      return true;
    }
  }

  return false;
}
