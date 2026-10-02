import type { GraphFlowConfig, ProviderConfig } from "./schema";
import { readEnvVar } from "./env-lookup";
import { extractEnvPlaceholderName } from "./secrets";

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
const configExportedEnv = new Map<string, string>();

/**
 * True when process.env[key] still holds the value a config exported. Once
 * anything else overwrites it (a shell, a test, the registry hydration), the
 * value is genuine again.
 */
export function isConfigExportedEnvKey(key: string): boolean {
  const exported = configExportedEnv.get(key);
  return exported !== undefined && process.env[key] === exported;
}

/**
 * Read an env var for AVAILABILITY purposes: config-exported values read as
 * absent. Credential detection for a given config goes through the config
 * itself; env sniffing is only for genuine shell-provided variables.
 */
function genuineEnvValue(key: string): string | undefined {
  if (isConfigExportedEnvKey(key)) {
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

export type ProviderKeySource = "env" | "config-env-ref" | "config-literal";

export interface ProviderKeyResolution {
  key?: string;
  source?: ProviderKeySource;
  /** Env var consulted first: the endpoint vendor's key, else the provider's own. */
  envVar?: string;
  /** A config literal exists but a genuine env key took precedence over it. */
  literalShadowed?: boolean;
  /** Why a config literal was refused (never contains the secret). */
  literalRejected?: string;
}

const CLEARED_KEY_VALUES = new Set(["", "disabled", "none"]);
const PLACEHOLDER_KEY_PATTERN =
  /^(<.*>|\[.*\]|your[-_ ]?(api[-_ ]?)?key.*|sk-x{4,}|x{6,}|changeme|placeholder|todo|example|test|dummy|null|undefined)$/i;

/** Reason a literal config key is unusable, or undefined when it looks valid. */
export function literalApiKeyProblem(value: string): string | undefined {
  const key = value.trim();
  if (/\s/.test(key)) return "contains whitespace";
  if (key.startsWith("${")) return "unresolved env reference";
  if (PLACEHOLDER_KEY_PATTERN.test(key)) return "placeholder value";
  return undefined;
}

/**
 * Pick the credential for one provider entry. Order: genuine env key of the
 * endpoint's vendor (process env, then the persisted Windows environment) >
 * config `${NAME}` reference > config literal that passes
 * `literalApiKeyProblem`. A stale literal can therefore never shadow a key the
 * user exported, and a literal is only used when no env key exists.
 */
export function resolveProviderApiKey(
  providerName: string,
  details: ProviderConfig | undefined
): ProviderKeyResolution {
  if (!details) {
    return {};
  }
  const raw = details.apiKey?.trim();
  if (raw !== undefined && CLEARED_KEY_VALUES.has(raw.toLowerCase())) {
    return {};
  }
  const baseUrl = details.baseUrl?.trim();
  const envVar = isLocalhostEndpoint(baseUrl)
    ? undefined
    : (detectApiKeyEnvNameFromEndpoint(baseUrl) ??
      PROVIDER_ENV_MAP[providerName as ProviderEnvName]?.apiKey);
  const refName = raw ? extractEnvPlaceholderName(raw) : undefined;
  const isLiteral = Boolean(raw) && !refName;

  const envValue = envVar ? genuineEnvValue(envVar) : undefined;
  if (envVar && envValue) {
    return { key: envValue, source: "env", envVar, ...(isLiteral ? { literalShadowed: true } : {}) };
  }
  if (refName) {
    const value = readEnvVar(refName);
    return value ? { key: value, source: "config-env-ref", envVar: refName } : { envVar: refName };
  }
  if (raw && isLiteral) {
    const problem = literalApiKeyProblem(raw);
    if (problem) {
      return { ...(envVar ? { envVar } : {}), literalRejected: problem };
    }
    return { key: raw, source: "config-literal", ...(envVar ? { envVar } : {}) };
  }
  return envVar ? { envVar } : {};
}

/**
 * Apply configured provider credentials into process.env for adapters that
 * read OPENAI_API_KEY / DEEPSEEK_API_KEY (and related base URL vars).
 * Supports generic endpoints and automatic environment binding.
 * Shell-provided env values win; values this module exported earlier are
 * refreshed so the latest config (and env-first key choice) takes effect.
 */
export function applyProviderEnvFromConfig(config: GraphFlowConfig): string[] {
  const applied: string[] = [];
  // Every key this call writes is config-derived: record it so availability
  // sniffing (genuineEnvValue) treats it as absent for OTHER configs.
  const remember = (key: string): void => {
    applied.push(key);
    configExportedEnv.set(key, process.env[key] ?? "");
  };
  const writable = (key: string): boolean =>
    !process.env[key]?.trim() || (isConfigExportedEnvKey(key) && !applied.includes(key));

  for (const [name, envNames] of Object.entries(PROVIDER_ENV_MAP) as Array<
    [ProviderEnvName, (typeof PROVIDER_ENV_MAP)[ProviderEnvName]]
  >) {
    const details = config.providers[name] as ProviderConfig | undefined;
    if (!details) {
      continue;
    }

    const resolution = resolveProviderApiKey(name, details);
    const apiKey = resolution.key;
    // A genuine key for ANOTHER vendor (e.g. a real OPENAI_API_KEY while this
    // entry targets api.deepseek.com) must not be sent to this endpoint.
    const foreignGenuine =
      resolution.source === "env" &&
      resolution.envVar !== envNames.apiKey &&
      !isConfigExportedEnvKey(envNames.apiKey) &&
      Boolean(process.env[envNames.apiKey]?.trim()) &&
      !genuineEnvValue(envNames.baseUrl);
    if (apiKey && (writable(envNames.apiKey) || foreignGenuine)) {
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
  const mirror = (keyVar: string, key: string | undefined, baseVar: string | undefined, base: string): void => {
    if (key && writable(keyVar)) {
      process.env[keyVar] = key;
      remember(keyVar);
    }
    if (baseVar && !process.env[baseVar]?.trim()) {
      process.env[baseVar] = base;
      remember(baseVar);
    }
  };

  for (const [name, details] of Object.entries(config.providers)) {
    if (!details) {
      continue;
    }
    const baseUrl = details.baseUrl?.trim();
    if (!baseUrl) {
      continue;
    }
    const resolvedKey = resolveProviderApiKey(name, details).key;
    const cleanBase = baseUrl.replace(/\/+$/, "");
    const lower = cleanBase.toLowerCase();

    if (lower.includes("deepseek.com")) {
      mirror("DEEPSEEK_API_KEY", resolvedKey, "DEEPSEEK_BASE_URL", cleanBase);
    } else if (lower.includes("openai.com")) {
      mirror("OPENAI_API_KEY", resolvedKey, "OPENAI_BASE_URL", cleanBase);
    } else if (lower.includes("anthropic.com")) {
      mirror("ANTHROPIC_API_KEY", resolvedKey, "ANTHROPIC_BASE_URL", cleanBase);
    } else if (lower.includes("typesafe") || lower.includes("jev")) {
      mirror("TYPESAFE_API_KEY", resolvedKey, undefined, cleanBase);
    } else if (!isLocalhostEndpoint(cleanBase)) {
      // Other custom non-local endpoints bind to generic LLM_BASE_URL and LLM_API_KEY
      mirror("LLM_API_KEY", resolvedKey, "LLM_BASE_URL", cleanBase);
    }
  }

  return applied;
}
