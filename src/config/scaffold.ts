import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, getDefaultOverlayConfig } from "./defaults";
import { isLegacyWebOnlyExtensions, resolveIncludeExtensions } from "./include-extensions.js";
import type { GraphFlowConfig } from "./schema";
import { logger } from "../utils/logger";

export interface ConfigScaffoldResult {
  path: string;
  status: "created" | "skipped" | "error";
  message?: string;
}

export function resolveGlobalConfigPath(): string {
  const configHome = process.env.GRAPHFLOW_CONFIG_HOME?.trim();
  if (configHome) {
    return join(configHome, ".graphflow.config.json");
  }
  return join(homedir(), ".graphflow.config.json");
}

export function resolveWorkspaceOverlayPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".graphflow", "config.json");
}

export interface ConfigMigrationResult {
  path: string;
  status: "migrated" | "skipped";
  message?: string;
}

/** Upgrade legacy web-only includeExtensions in an existing global config file. */
export function migrateGlobalGraphFlowConfig(options?: { configPath?: string }): ConfigMigrationResult {
  const path = options?.configPath ?? resolveGlobalConfigPath();
  if (!existsSync(path)) {
    return { path, status: "skipped", message: "config not found" };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GraphFlowConfig;
    const current = parsed.graphPolicy?.includeExtensions;
    if (!current || !isLegacyWebOnlyExtensions(current)) {
      return { path, status: "skipped", message: "no migration needed" };
    }

    const upgraded = resolveIncludeExtensions(current);
    parsed.graphPolicy = {
      ...parsed.graphPolicy,
      includeExtensions: upgraded,
    };
    writeConfigSecure(path, `${JSON.stringify(parsed, null, 2)}\n`);
    return { path, status: "migrated", message: `includeExtensions upgraded (${current.length} → ${upgraded.length})` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, status: "skipped", message };
  }
}

/**
 * Persist a config file that may hold provider credentials.
 *
 * The global config (`~/.graphflow.config.json`) is where a configured
 * `providers.<name>.apiKey` ends up, so it is written 0600 (owner-only) and an
 * existing file is tightened on every save. This is what the DSH plugin
 * disclosure declares (`api_keys[].storage: "file-0600"`); it is a no-op where
 * the platform has no POSIX modes (Windows).
 */
export function writeConfigSecure(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: Windows ACLs / read-only mounts.
  }
}

/**
 * Best-effort tighten of a pre-existing global config that predates the 0600
 * policy (or was written by another tool). `writeConfigSecure` only runs on
 * save/migrate, so without this a stale 0644/0666 file keeps the wrong mode
 * forever — `graphflow audit --privacy` flags it, install/init repair it.
 */
function tightenExistingConfigMode(path: string): boolean {
  try {
    const st = statSync(path);
    if ((st.mode & 0o777) === 0o600) {
      return false;
    }
    chmodSync(path, 0o600);
    return true;
  } catch {
    // Best effort: Windows ACLs / read-only mounts — same policy as writeConfigSecure.
    return false;
  }
}

export function ensureGlobalGraphFlowConfig(options?: { configPath?: string }): ConfigScaffoldResult {
  const path = options?.configPath ?? resolveGlobalConfigPath();
  if (existsSync(path)) {
    const tightened = tightenExistingConfigMode(path);
    try {
      migrateGlobalGraphFlowConfig({ configPath: path });
    } catch {
      // Migration failure is non-fatal — existing config is still usable.
    }
    return {
      path,
      status: "skipped",
      ...(tightened ? { message: "tightened pre-existing config mode to 0600" } : {}),
    };
  }

  try {
    const config = getDefaultConfig();
    const { workspaceRoot: _ignored, ...graphPolicy } = config.graphPolicy;
    const parentDir = join(path, "..");
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeConfigSecure(path, `${JSON.stringify({ ...config, graphPolicy }, null, 2)}\n`);
    return { path, status: "created" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { path, error: message },
      "Failed to create global config; will use in-memory defaults. Set GRAPHFLOW_CONFIG_HOME to use a custom directory."
    );
    return { path, status: "error", message };
  }
}

export function ensureWorkspaceGraphFlowConfig(workspaceRoot: string): ConfigScaffoldResult {
  const configDir = join(workspaceRoot, ".graphflow");
  const path = join(configDir, "config.json");
  if (existsSync(path)) {
    return { path, status: "skipped" };
  }

  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    writeFileSync(path, `${JSON.stringify(getDefaultOverlayConfig(), null, 2)}\n`, "utf8");
    return { path, status: "created" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ path, error: message }, "Failed to create workspace config; will use global or defaults.");
    return { path, status: "error", message };
  }
}
