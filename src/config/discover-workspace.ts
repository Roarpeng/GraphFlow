import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { release } from "node:os";

const RUNTIME_DIR_MARKERS = [
  "/vendor/graphflow",
  "node_modules/@roarpeng/graphflow",
  "graphflow-vscode-",
  "/.cursor/extensions/",
];

const MAX_WALK_DEPTH = 30;

const IDE_WORKSPACE_ENV_KEYS = [
  "GRAPHFLOW_WORKSPACE_ROOT",
  "CURSOR_PROJECT_DIR",
  "VSCODE_CWD",
  "VSCODE_WORKSPACE_FOLDER",
  "INIT_CWD",
  "PWD",
] as const;

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const rel = release() || "";
    if (rel.toLowerCase().includes("microsoft") || rel.toLowerCase().includes("wsl")) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    if (existsSync("/proc/version")) {
      const content = readFileSync("/proc/version", "utf8").toLowerCase();
      if (content.includes("microsoft") || content.includes("wsl")) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/** True when cwd looks like GraphFlow's bundled runtime (extension vendor / npm package), not a user repo. */
export function isGraphFlowRuntimeDirectory(dir: string): boolean {
  const normalized = resolve(dir).replace(/\\/g, "/").toLowerCase();
  return RUNTIME_DIR_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()));
}

/** True when a directory looks like a user project workspace for GraphFlow. */
export function hasProjectWorkspaceMarkers(dir: string): boolean {
  const root = resolve(dir);
  if (existsSync(join(root, ".git"))) {
    return true;
  }
  if (existsSync(join(root, "graphflow.config.json"))) {
    return true;
  }
  if (existsSync(join(root, ".graphflow", "config.json"))) {
    return true;
  }
  const graphStore = join(root, "graphflow-out", "graphflow-graph.json");
  if (!existsSync(graphStore)) {
    return false;
  }
  try {
    return statSync(graphStore).size > 10;
  } catch {
    return false;
  }
}

function resolveIdeWorkspaceHint(): string | undefined {
  const wsl = isWsl();
  for (const key of IDE_WORKSPACE_ENV_KEYS) {
    if (key === "GRAPHFLOW_WORKSPACE_ROOT") {
      continue;
    }
    const value = process.env[key]?.trim();
    if (!value) {
      continue;
    }
    const normalized = wsl && value.startsWith("\\\\wsl$\\")
      ? wslUncToPath(value)
      : value;
    const resolved = resolve(normalized);
    if (hasProjectWorkspaceMarkers(resolved)) {
      return resolved;
    }
    if (wsl && existsSync(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

function wslUncToPath(uncPath: string): string {
  const match = uncPath.match(/^\\\\wsl\$\\([^\\]+)\\(.+)$/i);
  if (match && match[1] && match[2]) {
    const distro = match[1];
    const rest = match[2].replace(/\\/g, "/");
    return `/${distro}/${rest}`;
  }
  return uncPath.replace(/\\/g, "/");
}

/**
 * Walk upward from `fromDir` to find the nearest user project root.
 * Skips GraphFlow runtime directories (extension vendor, global npm package).
 *
 * IDE env hints (CURSOR_PROJECT_DIR, etc.) are only used when `fromDir` is a
 * GraphFlow runtime directory — e.g. extension vendor — where upward walk cannot
 * reach the user's opened workspace.
 */
export function discoverWorkspaceRoot(fromDir: string = process.cwd()): string | undefined {
  const resolvedFrom = resolve(fromDir);

  let current = resolvedFrom;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (hasProjectWorkspaceMarkers(current) && !isGraphFlowRuntimeDirectory(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (isGraphFlowRuntimeDirectory(resolvedFrom)) {
    return resolveIdeWorkspaceHint();
  }

  return undefined;
}

/** Apply discovered workspace to process.env when MCP starts without an explicit root. */
export function ensureMcpWorkspaceEnv(fromDir: string = process.cwd()): string | undefined {
  const existing = process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim();
  if (existing) {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = resolve(existing);
    return process.env.GRAPHFLOW_WORKSPACE_ROOT;
  }

  const discovered = discoverWorkspaceRoot(fromDir);
  if (discovered) {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = discovered;
    return discovered;
  }

  const cwd = resolve(fromDir);
  if (!isGraphFlowRuntimeDirectory(cwd)) {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = cwd;
    return cwd;
  }

  return undefined;
}

export { isWsl };
