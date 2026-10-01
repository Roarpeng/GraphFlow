/**
 * Ensure the heavy optional runtime packages are available to every host.
 *
 * The shared MCP runtime (~/.graphflow/runtime, synced from the VSIX) ships
 * without better-sqlite3 and @huggingface/transformers. Without them Cursor,
 * Cline and ZCode silently fall back to the JSON store + hash embeddings while
 * the npm package (DSH, CLI) uses SQLite — the same project then grows two
 * diverging graphs. This module installs both under ~/.graphflow/optional-deps;
 * better-sqlite3 is built for the runtime (node or Electron) calling it.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { FileLock } from "../utils/file-lock";
import { ANYDOC_NPM_PACKAGE } from "./ensure-anydoc";
import {
  currentNativeRuntime,
  isOptionalDepInstalled,
  requireFromOptionalDeps,
  resolveOptionalDepsRoot,
  resolveSqliteDepsRoot,
} from "../utils/optional-deps";

/** Keep in sync with package.json optionalDependencies. */
export const RUNTIME_DEP_PACKAGES = {
  "better-sqlite3": "^12.10.0",
  "@huggingface/transformers": "^4.3.0",
} as const;

export type RuntimeDepName = keyof typeof RUNTIME_DEP_PACKAGES;
export const GRAPHFLOW_OPTIONAL_DEPS_AUTO_ENV = "GRAPHFLOW_OPTIONAL_DEPS_AUTO";
const MARKER_FILE = ".runtime-deps.json";
const LOCK_FILE = ".runtime-deps.lock";
/** A failed background install is not retried more often than this. */
const FAILED_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RuntimeDepSource = "bundled" | "optional-deps" | "missing";

export interface RuntimeDepStatus {
  name: RuntimeDepName;
  source: RuntimeDepSource;
  installRoot: string;
  version?: string;
  /** Present in optional-deps but fails to load (e.g. native ABI mismatch). */
  loadError?: string;
}

export interface RuntimeDepsMarker {
  updatedAt: string;
  installs: Record<string, { version?: string; runtime: string; abi: string; at: string }>;
  lastFailure?: { at: string; message: string };
}

export interface EnsureRuntimeDepsResult {
  status: "already" | "installed" | "skipped" | "failed" | "busy";
  message: string;
  deps: RuntimeDepStatus[];
  root: string;
}

function installRootFor(name: RuntimeDepName, root: string): string {
  return name === "better-sqlite3" ? resolveSqliteDepsRoot(root) : root;
}

function markerPath(root: string): string {
  return join(root, MARKER_FILE);
}

export function readRuntimeDepsMarker(root: string = resolveOptionalDepsRoot()): RuntimeDepsMarker | undefined {
  try {
    return JSON.parse(readFileSync(markerPath(root), "utf8")) as RuntimeDepsMarker;
  } catch {
    return undefined;
  }
}

function writeMarker(root: string, marker: RuntimeDepsMarker): void {
  writeFileSync(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function readInstalledVersion(installRoot: string, pkg: string): string | undefined {
  try {
    const pkgJson = join(installRoot, "node_modules", ...pkg.split("/"), "package.json");
    return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function canResolveBundled(pkg: string): boolean {
  try {
    createRequire(__filename).resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

/**
 * better-sqlite3 loads its native binding lazily inside the Database
 * constructor, so an ABI mismatch only surfaces when a database is opened.
 */
function probeSqlite(installRoot: string): string | undefined {
  try {
    const Database = requireFromOptionalDeps<typeof import("better-sqlite3")>("better-sqlite3", installRoot);
    const db = new Database(":memory:");
    db.close();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function inspectRuntimeDeps(
  root: string = resolveOptionalDepsRoot(),
  options?: { isBundled?: (name: RuntimeDepName) => boolean }
): RuntimeDepStatus[] {
  const isBundled = options?.isBundled ?? canResolveBundled;
  return (Object.keys(RUNTIME_DEP_PACKAGES) as RuntimeDepName[]).map((name) => {
    const installRoot = installRootFor(name, root);
    if (isBundled(name)) {
      return { name, source: "bundled", installRoot };
    }
    if (!isOptionalDepInstalled(name, installRoot)) {
      return { name, source: "missing", installRoot };
    }
    const version = readInstalledVersion(installRoot, name);
    const base: RuntimeDepStatus = { name, source: "optional-deps", installRoot, ...(version ? { version } : {}) };
    if (name === "better-sqlite3") {
      const loadError = probeSqlite(installRoot);
      return loadError ? { ...base, loadError } : base;
    }
    return base;
  });
}

function needsInstall(deps: RuntimeDepStatus[]): RuntimeDepName[] {
  return deps.filter((d) => d.source === "missing" || d.loadError).map((d) => d.name);
}

function resolveNpmCommand(): string {
  if (process.env.GRAPHFLOW_NPM?.trim()) {
    return process.env.GRAPHFLOW_NPM.trim();
  }
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * npm 12 skips dependency install scripts unless the project allows them, and
 * rejects `--allow-scripts` on the command line for a project install. The
 * `allowScripts` field is the supported switch; older npm ignores it.
 * better-sqlite3 fetches its native binding in `install`, so it needs it.
 */
export const RUNTIME_DEPS_ALLOW_SCRIPTS: Record<string, boolean> = { "better-sqlite3": true };

export function ensurePackageJson(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const pkgJson = join(dir, "package.json");
  let pkg: Record<string, unknown> = { name: "graphflow-optional-deps", private: true, version: "0.0.0" };
  let existed = false;
  if (existsSync(pkgJson)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        pkg = parsed as Record<string, unknown>;
        existed = true;
      }
    } catch {
      // unreadable → rewrite with defaults
    }
  }
  const current =
    pkg.allowScripts && typeof pkg.allowScripts === "object" && !Array.isArray(pkg.allowScripts)
      ? (pkg.allowScripts as Record<string, unknown>)
      : {};
  const missing = Object.keys(RUNTIME_DEPS_ALLOW_SCRIPTS).filter((name) => current[name] === undefined);
  if (existed && missing.length === 0) return;
  pkg.allowScripts = { ...current, ...RUNTIME_DEPS_ALLOW_SCRIPTS };
  writeFileSync(pkgJson, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/** A better-sqlite3 that installed but cannot find its binding: its install script did not run. */
function scriptPolicyHint(name: RuntimeDepName, detail: string, installRoot: string): string {
  if (name !== "better-sqlite3" || !/bindings|\.node\b|NODE_MODULE_VERSION/i.test(detail)) return "";
  return ` (its install script likely did not run: npm >= 12 blocks dependency scripts unless ${join(installRoot, "package.json")} allows them via "allowScripts", or npm is configured with ignore-scripts)`;
}

/**
 * anydoc is installed into the same root with `--no-save`; a saving
 * `npm install` prunes every package missing from package.json, so record it
 * as a dependency before installing next to it.
 */
const UNSAVED_SIBLING_PACKAGES = [ANYDOC_NPM_PACKAGE];

export function adoptUnsavedSiblingPackages(dir: string, names: string[] = UNSAVED_SIBLING_PACKAGES): string[] {
  const pkgJsonPath = join(dir, "package.json");
  let pkg: { dependencies?: Record<string, string> } & Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as typeof pkg;
  } catch {
    return [];
  }
  const adopted: string[] = [];
  for (const name of names) {
    if (pkg.dependencies?.[name]) continue;
    const version = readInstalledVersion(dir, name);
    if (!version) continue;
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: version };
    adopted.push(name);
  }
  if (adopted.length > 0) {
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }
  return adopted;
}

/** npm env that pins native prebuilds to the runtime executing this process. */
export function nativeInstallEnv(): Record<string, string> {
  const rt = currentNativeRuntime();
  const env: Record<string, string> = { npm_config_runtime: rt.runtime, npm_config_target: rt.target };
  if (rt.runtime === "electron") {
    env.npm_config_disturl = "https://electronjs.org/headers";
  }
  return env;
}

/**
 * onnxruntime-node's postinstall fetches CUDA provider binaries from NuGet on
 * linux-x64; embeddings run on the bundled CPU provider, and that download is
 * unreachable behind many networks (fails the whole install).
 */
export function transformersInstallEnv(): Record<string, string> {
  return process.env.ONNXRUNTIME_NODE_INSTALL || process.env.ONNXRUNTIME_NODE_INSTALL_CUDA
    ? {}
    : { ONNXRUNTIME_NODE_INSTALL: "skip" };
}

function runNpmInstall(
  installRoot: string,
  specs: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
  log: (m: string) => void
): Promise<void> {
  const npm = resolveNpmCommand();
  return new Promise((resolve, reject) => {
    // Install scripts must run: better-sqlite3 fetches its prebuilt binding in `install`.
    const child = spawn(npm, ["install", "--no-audit", "--no-fund", "--omit=dev", ...specs], {
      cwd: installRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => log(chunk.toString("utf8").trimEnd()));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`npm install ${specs.join(" ")} timed out after ${timeoutMs}ms`));
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
      reject(new Error(`npm install ${specs.join(" ")} exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

export function isRuntimeDepsAutoInstallDisabled(): boolean {
  const flag = process.env[GRAPHFLOW_OPTIONAL_DEPS_AUTO_ENV]?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return true;
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    typeof process.env.VITEST_WORKER_ID === "string" ||
    process.env.CI === "true"
  );
}

/**
 * Install missing runtime deps under ~/.graphflow/optional-deps. Never throws;
 * callers keep the existing JSON / hash fallback on failure.
 */
export async function ensureRuntimeDepsInstalled(options?: {
  root?: string;
  force?: boolean;
  /** Background callers respect the failed-install backoff; explicit CLI runs do not. */
  respectBackoff?: boolean;
  timeoutMs?: number;
  logger?: (message: string) => void;
  /** Inject install for tests. */
  installFn?: (installRoot: string, specs: string[], env: Record<string, string>) => Promise<void>;
  /** Test hook: treat packages as (not) resolvable from the running bundle. */
  isBundled?: (name: RuntimeDepName) => boolean;
}): Promise<EnsureRuntimeDepsResult> {
  const root = options?.root ?? resolveOptionalDepsRoot();
  const log = options?.logger ?? (() => undefined);
  const timeoutMs = options?.timeoutMs ?? 15 * 60_000;
  const inspect = () => inspectRuntimeDeps(root, options?.isBundled ? { isBundled: options.isBundled } : undefined);

  const before = inspect();
  const missing = options?.force
    ? before.filter((d) => d.source !== "bundled").map((d) => d.name)
    : needsInstall(before);
  if (missing.length === 0) {
    return { status: "already", message: "runtime deps already available", deps: before, root };
  }

  const previous = readRuntimeDepsMarker(root);
  if (options?.respectBackoff && previous?.lastFailure) {
    const since = Date.now() - Date.parse(previous.lastFailure.at);
    if (Number.isFinite(since) && since < FAILED_RETRY_INTERVAL_MS) {
      return {
        status: "skipped",
        message: `previous install failed ${Math.round(since / 60000)}m ago (${previous.lastFailure.message}); retry with 'graphflow deps install'`,
        deps: before,
        root,
      };
    }
  }

  ensurePackageJson(root);
  const lock = new FileLock(join(root, LOCK_FILE));
  if (!(await lock.acquire(2000, 250))) {
    return { status: "busy", message: "another GraphFlow process is installing runtime deps", deps: before, root };
  }
  const rt = currentNativeRuntime();
  const marker: RuntimeDepsMarker = { updatedAt: new Date().toISOString(), installs: { ...(previous?.installs ?? {}) } };
  const failures: string[] = [];
  try {
    const install =
      options?.installFn ?? ((dir, specs, env) => runNpmInstall(dir, specs, env, timeoutMs, log));
    for (const name of missing) {
      const installRoot = installRootFor(name, root);
      const spec = `${name}@${RUNTIME_DEP_PACKAGES[name]}`;
      const env = name === "better-sqlite3" ? nativeInstallEnv() : transformersInstallEnv();
      try {
        ensurePackageJson(installRoot);
        adoptUnsavedSiblingPackages(installRoot);
        log(`[GraphFlow] Installing ${spec} into ${installRoot} …`);
        await install(installRoot, [spec], env);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const after = inspect();
    for (const dep of after) {
      if (dep.source === "optional-deps" && !dep.loadError && missing.includes(dep.name)) {
        marker.installs[`${dep.name}@${dep.name === "better-sqlite3" ? `${rt.runtime}-abi${rt.abi}` : "napi"}`] = {
          ...(dep.version ? { version: dep.version } : {}),
          runtime: rt.runtime,
          abi: rt.abi,
          at: marker.updatedAt,
        };
      }
    }
    for (const name of needsInstall(after)) {
      if (!failures.some((f) => f.startsWith(`${name}:`))) {
        const dep = after.find((d) => d.name === name);
        const detail = dep?.loadError ?? "still missing after install";
        failures.push(`${name}: ${detail}${scriptPolicyHint(name, detail, installRootFor(name, root))}`);
      }
    }
    if (failures.length > 0) {
      const message = failures.join("; ");
      writeMarker(root, { ...marker, lastFailure: { at: marker.updatedAt, message: message.slice(0, 400) } });
      log(`[GraphFlow] runtime deps install incomplete: ${message}`);
      return { status: "failed", message, deps: after, root };
    }
    writeMarker(root, marker);
    log(`[GraphFlow] runtime deps ready (${missing.join(", ")})`);
    return { status: "installed", message: `installed ${missing.join(", ")}`, deps: after, root };
  } finally {
    lock.release();
  }
}
