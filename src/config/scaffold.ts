import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, getDefaultOverlayConfig } from "./defaults";
import { isLegacyWebOnlyExtensions, resolveIncludeExtensions } from "./include-extensions.js";
import type { GraphFlowConfig } from "./schema";

export interface ConfigScaffoldResult {
  path: string;
  status: "created" | "skipped";
}

export function resolveGlobalConfigPath(): string {
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
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return { path, status: "migrated", message: `includeExtensions upgraded (${current.length} → ${upgraded.length})` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, status: "skipped", message };
  }
}

export function ensureGlobalGraphFlowConfig(options?: { configPath?: string }): ConfigScaffoldResult {
  const path = options?.configPath ?? resolveGlobalConfigPath();
  if (existsSync(path)) {
    migrateGlobalGraphFlowConfig({ configPath: path });
    return { path, status: "skipped" };
  }

  const config = getDefaultConfig();
  const { workspaceRoot: _ignored, ...graphPolicy } = config.graphPolicy;
  const parentDir = join(path, "..");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(
    path,
    `${JSON.stringify({ ...config, graphPolicy }, null, 2)}\n`,
    "utf8"
  );
  return { path, status: "created" };
}

export function ensureWorkspaceGraphFlowConfig(workspaceRoot: string): ConfigScaffoldResult {
  const configDir = join(workspaceRoot, ".graphflow");
  const path = join(configDir, "config.json");
  if (existsSync(path)) {
    return { path, status: "skipped" };
  }

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(path, `${JSON.stringify(getDefaultOverlayConfig(), null, 2)}\n`, "utf8");
  return { path, status: "created" };
}
