import { homedir } from "node:os";
import { join } from "node:path";

/** HostAdapter registry id for Kimi Code CLI. */
export const KIMI_CODE_HOST_ADAPTER_ID = "kimi-code";

/** Test/isolation override. Prefer this over `$KIMI_CODE_HOME` so tests never touch the real home. */
export const KIMI_CODE_HOME_ENV = "GRAPHFLOW_KIMI_CODE_HOME";

export function isolatedKimiCodeHome(override?: string): string | undefined {
  const explicit = override?.trim() || process.env[KIMI_CODE_HOME_ENV]?.trim();
  return explicit || undefined;
}

/** Kimi Code data root: isolated override, else `$KIMI_CODE_HOME`, else `~/.kimi-code`. */
export function resolveKimiCodeHome(override?: string, home = homedir()): string {
  return isolatedKimiCodeHome(override) ?? process.env.KIMI_CODE_HOME?.trim() ?? join(home, ".kimi-code");
}
