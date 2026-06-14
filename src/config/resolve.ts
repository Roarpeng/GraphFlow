import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphFlowConfig } from "./schema";
import { loadConfigSafe } from "./loader";
import { mergeGraphFlowConfig } from "./merge";
import { getDefaultConfig } from "./defaults";
import { resolveGlobalConfigPath } from "./scaffold";
import { logger } from "../utils/logger";

function isDefaultProjectConfigPath(path: string): boolean {
  const projectRootConfig = resolve("graphflow.config.json");
  return path === "graphflow.config.json" || resolve(path) === projectRootConfig;
}

/** Path used for reading settings metadata (most specific existing config). */
export function resolveConfigPath(path = "graphflow.config.json"): string {
  if (!isDefaultProjectConfigPath(path)) {
    return path;
  }

  const projectRootConfig = resolve("graphflow.config.json");
  if (existsSync(projectRootConfig)) {
    return projectRootConfig;
  }

  const globalPath = resolveGlobalConfigPath();
  if (existsSync(globalPath)) {
    return globalPath;
  }

  const overlayPath = resolve(".graphflow/config.json");
  if (existsSync(overlayPath)) {
    return overlayPath;
  }

  return path;
}

/** Path used when persisting settings; defaults to global unless a project root config already exists. */
export function resolveWritableConfigPath(path = "graphflow.config.json"): string {
  if (!isDefaultProjectConfigPath(path)) {
    return path;
  }

  const projectRootConfig = resolve("graphflow.config.json");
  if (existsSync(projectRootConfig)) {
    return projectRootConfig;
  }

  return resolveGlobalConfigPath();
}

export function resolveConfig(path = "graphflow.config.json"): GraphFlowConfig {
  if (!isDefaultProjectConfigPath(path)) {
    const result = loadConfigSafe(path);
    if (result.usedFallback && result.error) {
      logger.warn({ path: result.configPath, error: result.error }, "Using default config for explicit path");
    }
    return result.config;
  }

  const globalPath = resolveGlobalConfigPath();
  const base = existsSync(globalPath) ? loadLayer(globalPath) : getDefaultConfig();

  const projectRoot = resolve("graphflow.config.json");
  const overlayPath = resolve(".graphflow/config.json");

  if (existsSync(projectRoot) && existsSync(overlayPath)) {
    const withRoot = mergeGraphFlowConfig(base, loadLayer(projectRoot));
    return mergeGraphFlowConfig(withRoot, loadLayer(overlayPath));
  }

  if (existsSync(projectRoot)) {
    return mergeGraphFlowConfig(base, loadLayer(projectRoot));
  }

  if (existsSync(overlayPath)) {
    return mergeGraphFlowConfig(base, loadLayer(overlayPath));
  }

  return base;
}

function loadLayer(path: string): GraphFlowConfig {
  const result = loadConfigSafe(path);
  if (result.usedFallback && result.error) {
    logger.warn({ path: result.configPath, error: result.error }, "Config layer ignored due to load failure");
    return getDefaultConfig();
  }
  return result.config;
}
