const ENV_PLACEHOLDER_PATTERN = /^\$\{([A-Z0-9_]+)\}$/i;
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function extractEnvPlaceholderName(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const match = value.trim().match(ENV_PLACEHOLDER_PATTERN);
  return match?.[1];
}

export function isEnvPlaceholder(value?: string): boolean {
  return Boolean(extractEnvPlaceholderName(value));
}

/** 
 * Resolve `${ENV_VAR}` from process.env; return direct secrets/values as-is.
 * Supports auto-detection of environment variable placeholders formatted as `${ENV_VAR}`
 * and extracts the corresponding value from process.env. If it's a plaintext key,
 * it returns the value directly.
 */
export function resolveConfigSecret(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  // Auto-detect if the value is an environment variable placeholder like ${MY_KEY}
  const envName = extractEnvPlaceholderName(trimmed);
  if (envName) {
    // Extract corresponding environment variable value from process.env
    const resolved = process.env[envName]?.trim();
    return resolved || undefined;
  }

  // Fallback: return direct plaintext key
  return trimmed;
}

/** Persist user input: env var name → `${NAME}`, already-placeholder → unchanged, else direct key. */
export function formatApiKeyForConfig(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (ENV_PLACEHOLDER_PATTERN.test(trimmed)) {
    return trimmed;
  }

  if (ENV_VAR_NAME_PATTERN.test(trimmed)) {
    return `\${${trimmed}}`;
  }

  return trimmed;
}

/** Settings panel display: show env var name or direct key from stored config. */
export function formatApiKeyForSettings(raw?: string): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const envName = extractEnvPlaceholderName(raw.trim());
  return envName ?? raw.trim();
}
