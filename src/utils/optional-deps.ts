import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Heavy optional packages (better-sqlite3, @huggingface/transformers) are not
 * bundled into the shared MCP runtime (~/.graphflow/runtime). They are installed
 * on demand into this directory so every host resolves the same store backend
 * and embedding model.
 */
export const GRAPHFLOW_OPTIONAL_DEPS_ROOT_ENV = "GRAPHFLOW_OPTIONAL_DEPS_ROOT";

export function resolveOptionalDepsRoot(home?: string): string {
  const fromEnv = process.env[GRAPHFLOW_OPTIONAL_DEPS_ROOT_ENV]?.trim();
  if (fromEnv && home === undefined) {
    return fromEnv;
  }
  return join(home ?? homedir(), ".graphflow", "optional-deps");
}

/**
 * Embedding model cache shared by every host. transformers otherwise caches
 * inside its own package directory, so each bundled copy re-downloads the
 * model and an npm upgrade of the package deletes it.
 */
export function resolveSharedModelCacheDir(home?: string): string {
  return join(home ?? homedir(), ".graphflow", "models");
}

export function resolveOptionalDepsNodeModules(home?: string): string {
  return join(resolveOptionalDepsRoot(home), "node_modules");
}

export type NativeRuntime = { runtime: "node" | "electron"; target: string; abi: string };

export function currentNativeRuntime(): NativeRuntime {
  const electron = (process.versions as Record<string, string | undefined>).electron;
  return electron
    ? { runtime: "electron", target: electron, abi: process.versions.modules }
    : { runtime: "node", target: process.versions.node, abi: process.versions.modules };
}

/**
 * better-sqlite3 is a native addon compiled per ABI: the MCP server runs on
 * node while the VS Code / Cursor extension host runs on Electron, so each
 * gets its own install directory. N-API packages (transformers) share the root.
 */
export function resolveSqliteDepsRoot(root: string = resolveOptionalDepsRoot(), rt: NativeRuntime = currentNativeRuntime()): string {
  return join(root, `sqlite-${rt.runtime}-abi${rt.abi}`);
}

export function isOptionalDepInstalled(pkg: string, root: string = resolveOptionalDepsRoot()): boolean {
  return existsSync(join(root, "node_modules", ...pkg.split("/"), "package.json"));
}

/** Resolve a package entry from the optional-deps directory; undefined when absent. */
export function resolveFromOptionalDeps(pkg: string, root: string = resolveOptionalDepsRoot()): string | undefined {
  if (!isOptionalDepInstalled(pkg, root)) {
    return undefined;
  }
  const anchor = join(root, "package.json");
  try {
    return createRequire(existsSync(anchor) ? anchor : join(root, "noop.js")).resolve(pkg);
  } catch {
    return undefined;
  }
}

/** CommonJS require of a package installed in the optional-deps directory. */
export function requireFromOptionalDeps<T>(pkg: string, root: string = resolveOptionalDepsRoot()): T {
  const resolved = resolveFromOptionalDeps(pkg, root);
  if (!resolved) {
    throw new Error(`[graphflow] optional dependency '${pkg}' is not installed in ${root}`);
  }
  return createRequire(join(root, "noop.js"))(resolved) as T;
}
