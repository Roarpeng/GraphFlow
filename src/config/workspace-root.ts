import { resolve } from "node:path";
import type { GraphFlowConfig } from "./schema";
import {
  discoverWorkspaceRoot,
  isGraphFlowRuntimeDirectory,
  isUnresolvedWorkspacePlaceholder,
  isUnsafeWorkspaceFallback,
  isUsableWorkspaceFallback,
  tryResolveIdeWorkspaceHint,
} from "./discover-workspace";

/**
 * Resolve the workspace root used for graph store paths and indexing.
 *
 * Priority:
 * 1. Explicit override (e.g. indexGraph rootDir)
 * 2. GRAPHFLOW_WORKSPACE_ROOT env (for MCP / IDE launchers)
 * 3. Project-level workspaceRoot (graphflow.config.json or overlay only)
 * 4. process.cwd()
 *
 * Global config (~/.graphflow.config.json) must never pin workspaceRoot — it is
 * shared across all projects on the machine.
 */
function assertSafeWorkspaceRoot(root: string, source: string): string {
  const resolved = resolve(root);
  if (isUnsafeWorkspaceFallback(resolved)) {
    throw new Error(
      `Refusing to use unsafe workspace root from ${source}: ${resolved}. ` +
        `Set GRAPHFLOW_WORKSPACE_ROOT to your project directory (not home/AppData).`
    );
  }
  return resolved;
}

export function resolveRuntimeWorkspaceRoot(options?: {
  rootDir?: string;
  projectWorkspaceRoot?: string;
  /**
   * Injectable working directory used for upward discovery and the final cwd
   * fallback. Defaults to process.cwd(). Lets tests exercise unsafe-cwd paths
   * without process.chdir() (which races under parallel test workers).
   */
  fromDir?: string;
}): string {
  if (options?.rootDir?.trim()) {
    return assertSafeWorkspaceRoot(options.rootDir.trim(), "rootDir");
  }

  const envRoot = process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim();
  if (envRoot) {
    const resolvedEnv = resolve(envRoot);
    // Cursor often spawns MCP with cwd=home and a poisoned env; clear and
    // fall through so explicit rootDir / discovery can still succeed.
    // Also clear unexpanded placeholders like ${workspaceFolder} left by hosts
    // that do not interpolate mcp.json env values.
    if (isUnresolvedWorkspacePlaceholder(envRoot) || isUnsafeWorkspaceFallback(resolvedEnv)) {
      delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
    } else {
      return resolvedEnv;
    }
  }

  if (options?.projectWorkspaceRoot?.trim()) {
    return assertSafeWorkspaceRoot(options.projectWorkspaceRoot.trim(), "projectWorkspaceRoot");
  }

  const baseDir = options?.fromDir?.trim() ? resolve(options.fromDir.trim()) : process.cwd();

  const discovered = discoverWorkspaceRoot(baseDir);
  if (discovered) {
    // Defense in depth: discovery must never surface home/AppData. Skip if it does.
    if (!isUnsafeWorkspaceFallback(discovered)) {
      return resolve(discovered);
    }
  }

  const cwd = resolve(baseDir);
  if (isUsableWorkspaceFallback(cwd)) {
    return cwd;
  }

  if (isGraphFlowRuntimeDirectory(cwd) || isUnsafeWorkspaceFallback(cwd)) {
    const hinted = tryResolveIdeWorkspaceHint();
    if (hinted) {
      return assertSafeWorkspaceRoot(hinted, "IDE workspace hint");
    }
    if (isGraphFlowRuntimeDirectory(cwd)) {
      return cwd;
    }
    throw new Error(
      `Refusing to index unsafe workspace root: ${cwd}. Set GRAPHFLOW_WORKSPACE_ROOT to your project directory.`
    );
  }

  return cwd;
}

export function bindRuntimeWorkspaceRoot(
  config: GraphFlowConfig,
  options?: {
    rootDir?: string;
    projectWorkspaceRoot?: string;
  }
): GraphFlowConfig {
  const workspaceRoot = resolveRuntimeWorkspaceRoot(options);
  return {
    ...config,
    graphPolicy: {
      ...config.graphPolicy,
      workspaceRoot,
    },
  };
}

/** Strip workspaceRoot before persisting machine-wide global config. */
export function stripWorkspaceRootForGlobalPersist(config: GraphFlowConfig): GraphFlowConfig {
  const { workspaceRoot: _ignored, ...graphPolicy } = config.graphPolicy;
  return {
    ...config,
    graphPolicy: graphPolicy as GraphFlowConfig["graphPolicy"],
  };
}
