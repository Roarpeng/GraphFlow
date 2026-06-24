import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, getDefaultOverlayConfig } from "./defaults";

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

export function ensureGlobalGraphFlowConfig(options?: { configPath?: string }): ConfigScaffoldResult {
  const path = options?.configPath ?? resolveGlobalConfigPath();
  if (existsSync(path)) {
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
