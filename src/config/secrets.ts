import { readEnvVar } from "./env-lookup";

const ENV_PLACEHOLDER_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ENV_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `%NAME%` (cmd / Windows UI habit) and `$NAME` / `$env:NAME` (shell habit). */
const ENV_ALT_REFERENCE_PATTERNS = [
  /^%([A-Za-z_][A-Za-z0-9_]*)%$/,
  /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i,
  /^\$([A-Za-z_][A-Za-z0-9_]*)$/,
];

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
 * The env var a user-typed key field refers to, if it is a reference rather
 * than a literal secret: `${NAME}`, `%NAME%`, `$NAME`, `$env:NAME`, an
 * UPPER_SNAKE name, or any identifier that names an env var which exists.
 * A lowercase identifier that does NOT resolve stays a literal (some vendor
 * keys, e.g. `apikey_<hex>`, are valid identifiers).
 */
export function extractEnvReferenceName(input?: string): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  const placeholder = extractEnvPlaceholderName(trimmed);
  if (placeholder) {
    return placeholder;
  }
  for (const pattern of ENV_ALT_REFERENCE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  if (ENV_VAR_NAME_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (ENV_IDENTIFIER_PATTERN.test(trimmed) && readEnvVar(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/**
 * Resolve `${ENV_VAR}` from the environment (process env, then the persisted
 * Windows user/machine environment); return direct secrets/values as-is.
 */
export function resolveConfigSecret(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  const envName = extractEnvPlaceholderName(trimmed);
  if (envName) {
    return readEnvVar(envName);
  }

  return trimmed;
}

/** Persist user input: any env reference → `${NAME}`, else the literal key. */
export function formatApiKeyForConfig(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const envName = extractEnvReferenceName(trimmed);
  if (envName) {
    return `\${${envName}}`;
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

export type ApiKeyInputStatus =
  | { kind: "empty" }
  | { kind: "literal" }
  | { kind: "env"; name: string; resolved: boolean };

/** Describe a key field without ever returning the secret itself. */
export function describeApiKeyInput(input?: string): ApiKeyInputStatus {
  if (!input?.trim()) {
    return { kind: "empty" };
  }
  const envName = extractEnvReferenceName(input);
  if (envName) {
    return { kind: "env", name: envName, resolved: Boolean(readEnvVar(envName)) };
  }
  return { kind: "literal" };
}
