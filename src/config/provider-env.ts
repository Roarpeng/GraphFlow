import type { GraphFlowConfig, ProviderConfig } from "./schema";
import { readEnvVar } from "./env-lookup";
import { resolveConfigSecret } from "./secrets";

const PROVIDER_ENV_MAP = {
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  anthropic: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" },
  bailian: { apiKey: "BAILIAN_API_KEY", baseUrl: "BAILIAN_BASE_URL" },
  doubao: { apiKey: "DOUBAO_API_KEY", baseUrl: "DOUBAO_BASE_URL" },
  deepseek: { apiKey: "DEEPSEEK_API_KEY", baseUrl: "DEEPSEEK_BASE_URL" },
} as const;

export type ProviderEnvName = keyof typeof PROVIDER_ENV_MAP;

/**
 * Check if the url points to a local service (localhost, 127.0.0.1, 0.0.0.0, [::1], etc.).
 * Local services are automatically treated as password-free / key-exempt.
 */
export function isLocalhostEndpoint(url?: string): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }
  const clean = url.trim().toLowerCase();
  if (clean.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(clean.includes("://") ? clean : `http://${clean}`);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    ) {
      return true;
    }
  } catch {
    // fallback to string inclusion check
  }

  return (
    clean.includes("localhost") ||
    clean.includes("127.0.0.1") ||
    clean.includes("0.0.0.0") ||
    clean.includes("[::1]") ||
    clean.includes("::1")
  );
}

/**
 * Detect the environment variable name corresponding to the domain of the endpoint URL.
 */
export function detectApiKeyEnvNameFromEndpoint(url?: string): string | undefined {
  if (!url || typeof url !== "string") {
    return undefined;
  }
  const lower = url.toLowerCase();
  if (lower.includes("deepseek.com")) {
    return "DEEPSEEK_API_KEY";
  }
  if (lower.includes("typesafe") || lower.includes("jev")) {
    return "TYPESAFE_API_KEY";
  }
  if (lower.includes("openai.com")) {
    return "OPENAI_API_KEY";
  }
  if (lower.includes("anthropic.com")) {
    return "ANTHROPIC_API_KEY";
  }
  return undefined;
}

/**
 * Env keys that were EXPORTED from some config by applyProviderEnvFromConfig
 * during this process. Availability sniffing must not feed on its own output:
 * without this marker, config A's credentials leak into every later config's
 * `hasUsableLlmProvider` verdict (live regression: a probe test's throwaway
 * `sk-good` key kept a later no-LLM config "usable"). Genuine shell-provided
 * env vars are never in this set and keep working.
 * 由配置导出过 env 键的记录：可用性嗅探不得自反馈——否则前一个配置的
 * 凭证会泄漏进后续所有配置的可用性判定。真实 shell 环境变量不受影响。
 */
const configExportedEnvKeys = new Set<string>();

/** True when `key` was set into process.env from a config (not the shell). */
export function isConfigExportedEnvKey(key: string): boolean {
  return configExportedEnvKeys.has(key);
}

/**
 * Read an env var for AVAILABILITY purposes: config-exported values read as
 * absent. Credential detection for a given config goes through the config
 * itself; env sniffing is only for genuine shell-provided variables.
 */
function genuineEnvValue(key: string): string | undefined {
  if (configExportedEnvKeys.has(key)) {
    return undefined;
  }
  const value = readEnvVar(key);
  return value && value.length > 0 && !value.startsWith("${") ? value : undefined;
}

/**
 * Sniff API key from environment variables matching endpoint domain characteristics.
 * Returns the resolved API key string if found, or undefined.
 * Config-exported env values are invisible here (no self-feedback).
 */
export function detectApiKeyFromEndpoint(url?: string): string | undefined {
  if (!url || typeof url !== "string") {
    return undefined;
  }

  const candidateKeys: string[] = [];
  const matchedEnv = detectApiKeyEnvNameFromEndpoint(url);
  if (matchedEnv) {
    candidateKeys.push(matchedEnv);
  }

  // Fallback to general LLM keys
  candidateKeys.push("LLM_API_KEY", "API_KEY");

  for (const envKey of candidateKeys) {
    const val = genuineEnvValue(envKey);
    if (val) {
      return val;
    }
  }

  return undefined;
}

/**
 * Apply configured provider credentials into process.env for adapters that
 * read OPENAI_API_KEY / DEEPSEEK_API_KEY (and related base URL vars).
 * Supports generic endpoints and automatic environment binding.
 * Existing env values always win.
 */
export function applyProviderEnvFromConfig(config: GraphFlowConfig): string[] {
  const applied: string[] = [];
  // Every key this call writes is config-derived: record it so availability
  // sniffing (genuineEnvValue) treats it as absent for OTHER configs.
  const remember = (key: string): void => {
    applied.push(key);
    configExportedEnvKeys.add(key);
  };

  for (const [name, envNames] of Object.entries(PROVIDER_ENV_MAP) as Array<
    [ProviderEnvName, (typeof PROVIDER_ENV_MAP)[ProviderEnvName]]
  >) {
    const details = config.providers[name] as ProviderConfig | undefined;
    if (!details) {
      continue;
    }

    const apiKey = resolveConfigSecret(details.apiKey);
    if (apiKey && !process.env[envNames.apiKey]?.trim()) {
      process.env[envNames.apiKey] = apiKey;
      remember(envNames.apiKey);
    }

    const baseUrl = details.baseUrl?.trim();
    if (baseUrl && !process.env[envNames.baseUrl]?.trim()) {
      process.env[envNames.baseUrl] = baseUrl.replace(/\/+$/, "");
      remember(envNames.baseUrl);
    }
  }

  // Convenience & generic endpoints: mirror keys and endpoints based on domain features
  for (const details of Object.values(config.providers)) {
    if (!details) {
      continue;
    }
    const baseUrl = details.baseUrl?.trim();
    const resolvedKey = resolveConfigSecret(details.apiKey);

    if (baseUrl) {
      const cleanBase = baseUrl.replace(/\/+$/, "");
      const lower = cleanBase.toLowerCase();

      let isDomainMatched = false;
      if (lower.includes("deepseek.com")) {
        isDomainMatched = true;
        if (resolvedKey && !process.env.DEEPSEEK_API_KEY?.trim()) {
          process.env.DEEPSEEK_API_KEY = resolvedKey;
          remember("DEEPSEEK_API_KEY");
        }
        if (!process.env.DEEPSEEK_BASE_URL?.trim()) {
          process.env.DEEPSEEK_BASE_URL = cleanBase;
          remember("DEEPSEEK_BASE_URL");
        }
      } else if (lower.includes("openai.com")) {
        isDomainMatched = true;
        if (resolvedKey && !process.env.OPENAI_API_KEY?.trim()) {
          process.env.OPENAI_API_KEY = resolvedKey;
          remember("OPENAI_API_KEY");
        }
        if (!process.env.OPENAI_BASE_URL?.trim()) {
          process.env.OPENAI_BASE_URL = cleanBase;
          remember("OPENAI_BASE_URL");
        }
      } else if (lower.includes("anthropic.com")) {
        isDomainMatched = true;
        if (resolvedKey && !process.env.ANTHROPIC_API_KEY?.trim()) {
          process.env.ANTHROPIC_API_KEY = resolvedKey;
          remember("ANTHROPIC_API_KEY");
        }
        if (!process.env.ANTHROPIC_BASE_URL?.trim()) {
          process.env.ANTHROPIC_BASE_URL = cleanBase;
          remember("ANTHROPIC_BASE_URL");
        }
      } else if (lower.includes("typesafe") || lower.includes("jev")) {
        isDomainMatched = true;
        if (resolvedKey && !process.env.TYPESAFE_API_KEY?.trim()) {
          process.env.TYPESAFE_API_KEY = resolvedKey;
          remember("TYPESAFE_API_KEY");
        }
      }

      // Other custom non-local endpoints bind to generic LLM_BASE_URL and LLM_API_KEY
      if (!isDomainMatched && !isLocalhostEndpoint(cleanBase)) {
        if (resolvedKey && !process.env.LLM_API_KEY?.trim()) {
          process.env.LLM_API_KEY = resolvedKey;
          remember("LLM_API_KEY");
        }
        if (!process.env.LLM_BASE_URL?.trim()) {
          process.env.LLM_BASE_URL = cleanBase;
          remember("LLM_BASE_URL");
        }
      }
    }
  }

  return applied;
}
