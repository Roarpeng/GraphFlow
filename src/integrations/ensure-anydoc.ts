/**
 * Ensure optional @firecrawl/anydoc is available for Office/PDF → Markdown.
 *
 * VSIX does not ship native anydoc binaries. The VS Code/Cursor extension
 * (and optionally CLI) downloads the current-platform package into
 * ~/.graphflow/optional-deps via npm, then sets GRAPHFLOW_ANYDOC_NODE_MODULES.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Keep in sync with package.json optionalDependencies[@firecrawl/anydoc]. */
export const ANYDOC_NPM_PACKAGE = "@firecrawl/anydoc";
export const ANYDOC_PINNED_VERSION = "0.1.7";

export type EnsureAnydocStatus = "already" | "installed" | "skipped" | "failed";

export interface EnsureAnydocResult {
  status: EnsureAnydocStatus;
  message: string;
  nodeModules?: string;
  version?: string;
}

export function resolveAnydocOptionalDepsRoot(home = homedir()): string {
  return join(home, ".graphflow", "optional-deps");
}

export function resolveAnydocNodeModules(home = homedir()): string {
  return join(resolveAnydocOptionalDepsRoot(home), "node_modules");
}

function versionMarkerPath(depsRoot: string): string {
  return join(depsRoot, ".anydoc-version");
}

export function readInstalledAnydocVersion(depsRoot = resolveAnydocOptionalDepsRoot()): string | undefined {
  try {
    const marker = readFileSync(versionMarkerPath(depsRoot), "utf8").trim();
    if (marker) {
      return marker;
    }
  } catch {
    // fall through
  }
  try {
    const pkgPath = join(depsRoot, "node_modules", "@firecrawl", "anydoc", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function isAnydocPresent(nodeModules = resolveAnydocNodeModules()): boolean {
  return existsSync(join(nodeModules, "@firecrawl", "anydoc", "package.json"));
}

export function inspectAnydocStatus(home = homedir()): {
  ready: boolean;
  version?: string;
  nodeModules: string;
} {
  const nodeModules = resolveAnydocNodeModules(home);
  const version = readInstalledAnydocVersion(resolveAnydocOptionalDepsRoot(home));
  const ready = Boolean(tryRequireAnydoc() || isAnydocPresent(nodeModules));
  return { ready, ...(version ? { version } : {}), nodeModules };
}

/**
 * Point Node resolution at the optional-deps node_modules (extension + MCP child).
 */
export function applyAnydocRequireEnv(nodeModules = resolveAnydocNodeModules()): boolean {
  if (!existsSync(nodeModules)) {
    return false;
  }
  process.env.GRAPHFLOW_ANYDOC_NODE_MODULES = nodeModules;
  const parts = (process.env.NODE_PATH ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.includes(nodeModules)) {
    process.env.NODE_PATH = parts.length > 0 ? `${nodeModules}${delimiter}${parts.join(delimiter)}` : nodeModules;
  }
  try {
    // Refresh Node's module search paths after NODE_PATH mutation.
     
    const Module = require("node:module") as { _initPaths?: () => void };
    Module._initPaths?.();
  } catch {
    // ignore — createRequire(path) still works for document-convert
  }
  return true;
}

/** Try loading anydoc from env path or default resolution. */
export function tryRequireAnydoc(): unknown | null {
  const existing = process.env.GRAPHFLOW_ANYDOC_NODE_MODULES?.trim();
  if (existing && existsSync(join(existing, "@firecrawl", "anydoc", "package.json"))) {
    try {
      const req = createRequire(join(existing, "@firecrawl", "anydoc", "package.json"));
      return req(ANYDOC_NPM_PACKAGE);
    } catch {
      // fall through to default home path
    }
  }

  applyAnydocRequireEnv(resolveAnydocNodeModules());
  const fromEnv = process.env.GRAPHFLOW_ANYDOC_NODE_MODULES?.trim();
  if (fromEnv) {
    try {
      const req = createRequire(join(fromEnv, "@firecrawl", "anydoc", "package.json"));
      return req(ANYDOC_NPM_PACKAGE);
    } catch {
      // fall through
    }
  }
  try {
    const req = createRequire(__filename);
    return req(ANYDOC_NPM_PACKAGE);
  } catch {
    return null;
  }
}

function resolveNpmCommand(): string {
  if (process.env.GRAPHFLOW_NPM?.trim()) {
    return process.env.GRAPHFLOW_NPM.trim();
  }
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpmInstall(depsRoot: string, version: string, timeoutMs: number): Promise<void> {
  const npm = resolveNpmCommand();
  const spec = `${ANYDOC_NPM_PACKAGE}@${version}`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      npm,
      ["install", "--ignore-scripts", "--no-save", "--no-package-lock", spec],
      {
        cwd: depsRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32",
      }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`npm install ${spec} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm install ${spec} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * Ensure platform anydoc binary is installed under ~/.graphflow/optional-deps.
 * No-op when disabled, already present at the pinned version, or already require-able.
 */
export async function ensureAnydocInstalled(options?: {
  enabled?: boolean;
  version?: string;
  timeoutMs?: number;
  home?: string;
  /** Inject install for tests. */
  installFn?: (depsRoot: string, version: string) => Promise<void>;
  logger?: (message: string) => void;
}): Promise<EnsureAnydocResult> {
  const enabled = options?.enabled ?? true;
  const version = options?.version ?? ANYDOC_PINNED_VERSION;
  const timeoutMs = options?.timeoutMs ?? 180_000;
  const home = options?.home ?? homedir();
  const log = options?.logger ?? (() => undefined);

  if (!enabled) {
    return { status: "skipped", message: "anydoc auto-download disabled" };
  }

  const depsRoot = resolveAnydocOptionalDepsRoot(home);
  const nodeModules = resolveAnydocNodeModules(home);

  if (tryRequireAnydoc()) {
    const nm = isAnydocPresent(nodeModules) ? nodeModules : process.env.GRAPHFLOW_ANYDOC_NODE_MODULES;
    return {
      status: "already",
      message: "anydoc already resolvable",
      ...(nm ? { nodeModules: nm } : {}),
      version: readInstalledAnydocVersion(depsRoot) ?? version,
    };
  }

  if (isAnydocPresent(nodeModules) && readInstalledAnydocVersion(depsRoot) === version) {
    applyAnydocRequireEnv(nodeModules);
    if (tryRequireAnydoc()) {
      return {
        status: "already",
        message: `anydoc ${version} already installed in ${nodeModules}`,
        nodeModules,
        version,
      };
    }
  }

  try {
    mkdirSync(depsRoot, { recursive: true });
    // Minimal package.json so npm install --prefix-like cwd works cleanly
    const pkgJson = join(depsRoot, "package.json");
    if (!existsSync(pkgJson)) {
      writeFileSync(
        pkgJson,
        JSON.stringify({ name: "graphflow-optional-deps", private: true, version: "0.0.0" }, null, 2),
        "utf8"
      );
    }

    log(`[GraphFlow] Downloading ${ANYDOC_NPM_PACKAGE}@${version} into ${depsRoot} …`);
    const install = options?.installFn ?? ((root, ver) => runNpmInstall(root, ver, timeoutMs));
    await install(depsRoot, version);
    writeFileSync(versionMarkerPath(depsRoot), `${version}\n`, "utf8");
    applyAnydocRequireEnv(nodeModules);

    if (!tryRequireAnydoc()) {
      return {
        status: "failed",
        message: `installed files under ${nodeModules} but require(@firecrawl/anydoc) still failed`,
        nodeModules,
        version,
      };
    }

    log(`[GraphFlow] anydoc ${version} ready`);
    return {
      status: "installed",
      message: `installed ${ANYDOC_NPM_PACKAGE}@${version}`,
      nodeModules,
      version,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[GraphFlow] anydoc download failed: ${message}`);
    return { status: "failed", message };
  }
}
