import { execFileSync } from "node:child_process";

/**
 * Credential env lookup that survives the Windows "set it after the IDE
 * started" trap: a user env var added via System Properties / `setx` lands in
 * the registry, but already-running processes keep their launch-time
 * environment block. `process.env` first; on win32 then
 * `reg query HKCU\Environment /v NAME`, then the machine-wide Session Manager
 * key. Registry answers are cached for ~30 s. Never throws, never logs a
 * value, never writes `process.env`.
 *
 * Opt out with GRAPHFLOW_NO_REGISTRY_ENV=1 (tests set it for hermeticity).
 */

const REGISTRY_KEYS = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
] as const;

export const CREDENTIAL_ENV_CACHE_TTL_MS = 30_000;

/**
 * Runs `reg` and returns its stdout; returns undefined when the value
 * definitively does not exist; throws on transient failures (not cached).
 */
export type RegistryExec = (file: string, args: string[]) => string | undefined;

export interface CredentialEnvOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test seam for the `reg` invocation. */
  exec?: RegistryExec;
  now?: () => number;
  ttlMs?: number;
}

const defaultExec: RegistryExec = (file, args) => {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `reg query` exits 1 when the key or value does not exist.
    if ((error as { status?: number | null }).status === 1) return undefined;
    throw error;
  }
};

const cache = new Map<string, { at: number; value: string | undefined }>();

/** Test hook: forget cached registry answers. */
export function resetCredentialEnvCache(): void {
  cache.clear();
}

function optedOut(env: NodeJS.ProcessEnv): boolean {
  const flag = env.GRAPHFLOW_NO_REGISTRY_ENV?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function expandRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, ref: string) => env[ref] ?? whole);
}

function parseRegValue(output: string, name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (!match || match[1]?.toUpperCase() !== name.toUpperCase()) continue;
    const raw = (match[3] ?? "").trim();
    const value = match[2] === "REG_EXPAND_SZ" ? expandRefs(raw, env).trim() : raw;
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** Read a credential env var: `process.env`, then (Windows) the persisted user/machine environment. */
export function readCredentialEnv(name: string, opts: CredentialEnvOptions = {}): string | undefined {
  try {
    const env = opts.env ?? process.env;
    const trimmed = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return undefined;
    const direct = env[trimmed]?.trim();
    if (direct) return direct;
    if ((opts.platform ?? process.platform) !== "win32" || optedOut(env)) return undefined;

    const now = (opts.now ?? Date.now)();
    const key = trimmed.toUpperCase();
    const cached = cache.get(key);
    if (cached && now - cached.at < (opts.ttlMs ?? CREDENTIAL_ENV_CACHE_TTL_MS)) return cached.value;

    const exec = opts.exec ?? defaultExec;
    let value: string | undefined;
    let transientFailure = false;
    for (const regKey of REGISTRY_KEYS) {
      let output: string | undefined;
      try {
        output = exec("reg", ["query", regKey, "/v", trimmed]);
      } catch {
        transientFailure = true;
        continue;
      }
      if (output === undefined) continue;
      value = parseRegValue(output, trimmed, env);
      if (value !== undefined) break;
    }
    // A timed-out `reg` (busy machine) must not pin a miss for the TTL.
    if (value !== undefined || !transientFailure) cache.set(key, { at: now, value });
    return value;
  } catch {
    return undefined;
  }
}
