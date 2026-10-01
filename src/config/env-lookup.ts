import { execFileSync } from "node:child_process";

/**
 * Environment variable lookup that survives the Windows "set it after the IDE
 * started" trap: a user env var added via System Properties / `setx` lands in
 * the registry, but already-running processes (Cursor, the extension host,
 * the MCP server they spawn) keep their launch-time environment block. When
 * `process.env` misses, fall back to HKCU\Environment then the machine-wide
 * Session Manager key, and hydrate `process.env` so adapters that read it
 * directly see the same value.
 *
 * Opt out with GRAPHFLOW_NO_REGISTRY_ENV=1 (tests set it for hermeticity).
 */

const REGISTRY_KEYS = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
];

const REGISTRY_TTL_MS = 30_000;

let registryCache: { at: number; values: Map<string, string> } | undefined;

function registryLookupEnabled(): boolean {
  if (process.platform !== "win32") return false;
  const flag = process.env.GRAPHFLOW_NO_REGISTRY_ENV?.trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

function expandWindowsRefs(value: string, values: Map<string, string>): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const hit = process.env[name] ?? values.get(name.toUpperCase());
    return hit ?? whole;
  });
}

function readRegistryEnvironment(): Map<string, string> {
  const now = Date.now();
  if (registryCache && now - registryCache.at < REGISTRY_TTL_MS) {
    return registryCache.values;
  }
  const values = new Map<string, string>();
  let failedReads = 0;
  // Machine first so user-level values override it (Windows semantics).
  for (const key of [...REGISTRY_KEYS].reverse()) {
    let output = "";
    try {
      output = execFileSync("reg", ["query", key], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      failedReads += 1;
      continue;
    }
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s{2,}(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/);
      if (!match) continue;
      const [, name, type, raw] = match;
      if (!name || raw === undefined) continue;
      const value = raw.trim();
      values.set(name.toUpperCase(), type === "REG_EXPAND_SZ" ? `\u0000${value}` : value);
    }
  }
  for (const [name, value] of values) {
    if (value.startsWith("\u0000")) {
      values.set(name, expandWindowsRefs(value.slice(1), values));
    }
  }
  // A timed-out `reg` (busy machine) must not pin an empty snapshot for the TTL.
  if (failedReads === 0) registryCache = { at: now, values };
  return values;
}

/** Test hook: drop the registry snapshot so the next lookup re-reads it. */
export function resetRegistryEnvCache(): void {
  registryCache = undefined;
}

/**
 * Read an env var: `process.env` first, then (Windows only) the persisted
 * user/machine environment. A registry hit is written back into
 * `process.env` so every later consumer in this process agrees.
 */
export function readEnvVar(name: string): string | undefined {
  const trimmedName = name.trim();
  if (!trimmedName) return undefined;
  const direct = process.env[trimmedName]?.trim();
  if (direct) return direct;
  if (!registryLookupEnabled()) return undefined;
  const fromRegistry = readRegistryEnvironment().get(trimmedName.toUpperCase())?.trim();
  if (!fromRegistry) return undefined;
  process.env[trimmedName] = fromRegistry;
  return fromRegistry;
}

/** Well-known credential/endpoint vars the runtime (and its adapters) read. */
export const KNOWN_CREDENTIAL_ENV_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "BAILIAN_API_KEY",
  "BAILIAN_BASE_URL",
  "DOUBAO_API_KEY",
  "DOUBAO_BASE_URL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "LLM_API_KEY",
  "LLM_BASE_URL",
] as const;

/**
 * Pull persisted-but-invisible credential vars into `process.env`. Call once
 * at process start (CLI / MCP server / extension runtime); a no-op off
 * Windows or when every var is already present.
 */
export function hydrateCredentialEnvFromRegistry(names: readonly string[] = KNOWN_CREDENTIAL_ENV_VARS): string[] {
  if (!registryLookupEnabled()) return [];
  const hydrated: string[] = [];
  for (const name of names) {
    if (process.env[name]?.trim()) continue;
    if (readEnvVar(name)) hydrated.push(name);
  }
  return hydrated;
}
