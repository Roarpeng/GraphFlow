import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GraphFlowConfig } from "./schema";
import { loadConfig } from "./loader";
import { mergeGraphFlowConfig } from "./merge";
import { getDefaultConfig } from "./defaults";

export function resolveConfigPath(path = "graphflow.config.json"): string {
  const projectRootConfig = resolve("graphflow.config.json");
  const isDefaultProjectConfig =
    path === "graphflow.config.json" || resolve(path) === projectRootConfig;

  if (!isDefaultProjectConfig) {
    return path;
  }

  const projectConfigPath = ".graphflow/config.json";
  if (existsSync(projectConfigPath)) {
    return projectConfigPath;
  }

  if (existsSync(path)) {
    return path;
  }

  const globalPath = join(homedir(), ".graphflow.config.json");
  if (existsSync(globalPath)) {
    return globalPath;
  }

  return path;
}

export function resolveConfig(path = "graphflow.config.json"): GraphFlowConfig {
  const actualPath = resolveConfigPath(path);
  const normalizedActual = actualPath.replace(/\\/g, "/");
  const isProjectOverlay = normalizedActual.endsWith(".graphflow/config.json");
  const rootConfigPath = "graphflow.config.json";

  if (isProjectOverlay && existsSync(rootConfigPath)) {
    const base = loadConfig(rootConfigPath);
    const overlay = existsSync(actualPath) ? loadConfig(actualPath) : getDefaultConfig();
    return mergeGraphFlowConfig(base, overlay);
  }

  if (existsSync(actualPath)) {
    return loadConfig(actualPath);
  }
  return getDefaultConfig();
}
