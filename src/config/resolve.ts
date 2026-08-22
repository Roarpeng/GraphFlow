import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphFlowConfig } from "./schema";
import { loadConfigSafe } from "./loader";
import { mergeGraphFlowConfig } from "./merge";
import { getDefaultConfig } from "./defaults";
import { resolveGlobalConfigPath } from "./scaffold";
import { bindRuntimeWorkspaceRoot } from "./workspace-root";
import { applyProviderEnvFromConfig } from "./provider-env";
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

function finalizeConfig(config: GraphFlowConfig): GraphFlowConfig {
  applyProviderEnvFromConfig(config);
  return config;
}

/**
 * Resolve the effective GraphFlow config for the current process.
 *
 * @param path Explicit config path; default resolves project/global/overlay layers.
 * @param bind Optional workspace-root override, forwarded into the internal
 *   `bindRuntimeWorkspaceRoot` so a caller-provided `rootDir` (e.g. an MCP tool
 *   argument) takes priority over `projectWorkspaceRoot` and over discovery
 *   from an unsafe `process.cwd()` (home dir / AppData), instead of throwing
 *   "Refusing to index unsafe workspace root" before the override is applied.
 */
export function resolveConfig(
  path = "graphflow.config.json",
  bind?: { rootDir?: string }
): GraphFlowConfig {
  if (!isDefaultProjectConfigPath(path)) {
    const result = loadConfigSafe(path);
    if (result.usedFallback && result.error) {
      logger.warn({ path: result.configPath, error: result.error }, "Using default config for explicit path");
    }
    const projectRoot = result.config.graphPolicy.workspaceRoot;
    return finalizeConfig(
      bindRuntimeWorkspaceRoot(
        result.config,
        mergeRuntimeWorkspaceBind(bind, projectRoot)
      )
    );
  }

  const globalPath = resolveGlobalConfigPath();
  const base = existsSync(globalPath) ? loadLayer(globalPath) : getDefaultConfig();

  const projectRoot = resolve("graphflow.config.json");
  const overlayPath = resolve(".graphflow/config.json");

  let merged: GraphFlowConfig;
  let projectWorkspaceRoot: string | undefined;

  if (existsSync(projectRoot) && existsSync(overlayPath)) {
    const projectLayer = loadLayer(projectRoot);
    const overlayLayer = loadLayer(overlayPath);
    merged = mergeGraphFlowConfig(mergeGraphFlowConfig(base, projectLayer), overlayLayer);
    projectWorkspaceRoot =
      overlayLayer.graphPolicy.workspaceRoot ?? projectLayer.graphPolicy.workspaceRoot;
  } else if (existsSync(projectRoot)) {
    const projectLayer = loadLayer(projectRoot);
    merged = mergeGraphFlowConfig(base, projectLayer);
    projectWorkspaceRoot = projectLayer.graphPolicy.workspaceRoot;
  } else if (existsSync(overlayPath)) {
    const overlayLayer = loadLayer(overlayPath);
    merged = mergeGraphFlowConfig(base, overlayLayer);
    projectWorkspaceRoot = overlayLayer.graphPolicy.workspaceRoot;
  } else {
    merged = base;
  }

  return finalizeConfig(
    bindRuntimeWorkspaceRoot(
      merged,
      mergeRuntimeWorkspaceBind(bind, projectWorkspaceRoot)
    )
  );
}

/**
 * Merge the caller-provided `rootDir` override with the project-level
 * `workspaceRoot` for the internal bind. `rootDir` is listed first so
 * `resolveRuntimeWorkspaceRoot`'s existing priority applies: explicit rootDir
 * wins over projectWorkspaceRoot. Returns undefined when neither is present
 * (equivalent to the historical no-options call).
 */
function mergeRuntimeWorkspaceBind(
  bind: { rootDir?: string } | undefined,
  projectWorkspaceRoot: string | undefined
): { rootDir?: string; projectWorkspaceRoot?: string } | undefined {
  const merged: { rootDir?: string; projectWorkspaceRoot?: string } = {
    ...(bind?.rootDir ? { rootDir: bind.rootDir } : {}),
    ...(projectWorkspaceRoot ? { projectWorkspaceRoot } : {}),
  };
  return merged.rootDir !== undefined || merged.projectWorkspaceRoot !== undefined
    ? merged
    : undefined;
}

function loadLayer(path: string): GraphFlowConfig {
  const result = loadConfigSafe(path);
  if (result.usedFallback && result.error) {
    logger.warn({ path: result.configPath, error: result.error }, "Config layer ignored due to load failure");
    return getDefaultConfig();
  }
  return result.config;
}
