import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphFlowConfig } from "./schema";
import { loadConfig } from "./loader";
import { mergeGraphFlowConfig } from "./merge";
import { getDefaultConfig } from "./defaults";
import { resolveGlobalConfigPath } from "./scaffold";

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
    if (existsSync(path)) {
      return loadConfig(path);
    }
    return getDefaultConfig();
  }

  const globalPath = resolveGlobalConfigPath();
  const base = existsSync(globalPath) ? loadConfig(globalPath) : getDefaultConfig();

  const projectRoot = resolve("graphflow.config.json");
  const overlayPath = resolve(".graphflow/config.json");

  if (existsSync(projectRoot) && existsSync(overlayPath)) {
    const rootConfig = loadConfig(projectRoot);
    const withRoot = mergeGraphFlowConfig(base, rootConfig);
    return mergeGraphFlowConfig(withRoot, loadConfig(overlayPath));
  }

  if (existsSync(projectRoot)) {
    return mergeGraphFlowConfig(base, loadConfig(projectRoot));
  }

  if (existsSync(overlayPath)) {
    return mergeGraphFlowConfig(base, loadConfig(overlayPath));
  }

  return base;
}
