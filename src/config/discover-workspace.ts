import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir, release } from "node:os";

const RUNTIME_DIR_MARKERS = [
  "/vendor/graphflow",
  "node_modules/@roarpeng/graphflow",
  "graphflow-vscode-",
  "graphflow-tool-",
  "/.cursor/extensions/",
];

const MAX_WALK_DEPTH = 30;

const IDE_WORKSPACE_ENV_KEYS = [
  "GRAPHFLOW_WORKSPACE_ROOT",
  "CURSOR_PROJECT_DIR",
  "VSCODE_CWD",
  "VSCODE_WORKSPACE_FOLDER",
  // Cursor injects this on MCP child processes (single path or path.delimiter-separated).
  "WORKSPACE_FOLDER_PATHS",
  "WORKSPACE_FOLDER",
  "INIT_CWD",
  "PWD",
] as const;

/** Unexpanded IDE placeholders must never be treated as filesystem roots. */
export function isUnresolvedWorkspacePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /\$\{[^}]+\}/.test(trimmed) || /\$[A-Z_][A-Z0-9_]*/.test(trimmed);
}

function parseWorkspaceFolderPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.includes(delimiter)) {
    return trimmed
      .split(delimiter)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  // Some hosts join with commas; keep paths that look absolute.
  if (trimmed.includes(",") && !trimmed.includes(" ")) {
    return trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [trimmed];
}

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

const DEV_PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

/** Common manifest files that indicate a dev project root (without .git). */
export function hasDevProjectMarkers(dir: string): boolean {
  const root = resolve(dir);
  return DEV_PROJECT_MARKERS.some((marker) => existsSync(join(root, marker)));
}

/**
 * Paths that must not be used as implicit workspace roots (e.g. MCP spawn cwd on Windows).
 * Indexing here causes EPERM on protected folders like ElevatedDiagnostics.
 */
export function isUnsafeWorkspaceFallback(dir: string): boolean {
  const normalized = resolve(dir).replace(/\\/g, "/").toLowerCase();
  const home = homedir().replace(/\\/g, "/").toLowerCase();
  if (normalized === home) {
    return true;
  }

  const localAppData = process.env.LOCALAPPDATA?.replace(/\\/g, "/").toLowerCase();
  if (localAppData && normalized === localAppData) {
    return true;
  }

  const roamingAppData = process.env.APPDATA?.replace(/\\/g, "/").toLowerCase();
  if (roamingAppData && normalized === roamingAppData) {
    return true;
  }

  const protectedSegments = new Set([
    "elevateddiagnostics",
    "system volume information",
    "$recycle.bin",
  ]);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => protectedSegments.has(segment))) {
    return true;
  }

  const unsafeRoots = ["/program files/", "/program files (x86)/", "/windows/"];
  return unsafeRoots.some((marker) => normalized.includes(marker));
}

export function isUsableWorkspaceFallback(dir: string): boolean {
  const root = resolve(dir);
  if (isGraphFlowRuntimeDirectory(root) || isUnsafeWorkspaceFallback(root)) {
    return false;
  }
  return hasProjectWorkspaceMarkers(root) || hasDevProjectMarkers(root);
}

function resolveIdeWorkspaceHint(): string | undefined {
  const wsl = isWsl();
  for (const key of IDE_WORKSPACE_ENV_KEYS) {
    if (key === "GRAPHFLOW_WORKSPACE_ROOT") {
      // Handled separately by ensureMcpWorkspaceEnv / resolveRuntimeWorkspaceRoot.
      continue;
    }
    const value = process.env[key]?.trim();
    if (!value || isUnresolvedWorkspacePlaceholder(value)) {
      continue;
    }

    const candidates =
      key === "WORKSPACE_FOLDER_PATHS" ? parseWorkspaceFolderPaths(value) : [value];

    for (const candidate of candidates) {
      if (!candidate || isUnresolvedWorkspacePlaceholder(candidate)) {
        continue;
      }
      const normalized =
        wsl && candidate.startsWith("\\\\wsl$\\") ? wslUncToPath(candidate) : candidate;
      const resolved = resolve(normalized);
      if (isUnsafeWorkspaceFallback(resolved)) {
        continue;
      }
      if (hasProjectWorkspaceMarkers(resolved) || hasDevProjectMarkers(resolved)) {
        return resolved;
      }
      // WSL UNC hints may lack markers on the Linux mount; still accept existing safe paths.
      if (wsl && existsSync(resolved)) {
        return resolved;
      }
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
    if (isUnsafeWorkspaceFallback(current)) {
      // Stop walking upward at unsafe boundaries (e.g. Windows AppData, home dir).
      break;
    }
    if (hasProjectWorkspaceMarkers(current) && !isGraphFlowRuntimeDirectory(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Cursor/npx often start MCP at home or inside the npm package runtime.
  // Prefer IDE-provided project paths over failing closed.
  const hinted = tryResolveIdeWorkspaceHint();
  if (hinted) {
    return hinted;
  }

  return undefined;
}

/** Apply discovered workspace to process.env when MCP starts without an explicit root. */
export function ensureMcpWorkspaceEnv(fromDir: string = process.cwd()): string | undefined {
  const existing = process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim();
  if (existing) {
    if (isUnresolvedWorkspacePlaceholder(existing) || isUnsafeWorkspaceFallback(resolve(existing))) {
      delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
      // Fall through to discovery — never pin MCP to home/AppData/unexpanded placeholders.
    } else {
      const resolved = resolve(existing);
      process.env.GRAPHFLOW_WORKSPACE_ROOT = resolved;
      return process.env.GRAPHFLOW_WORKSPACE_ROOT;
    }
  }

  const discovered = discoverWorkspaceRoot(fromDir);
  if (discovered) {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = discovered;
    return discovered;
  }

  const cwd = resolve(fromDir);
  if (isGraphFlowRuntimeDirectory(cwd)) {
    const hinted = resolveIdeWorkspaceHint();
    if (hinted && !isUnsafeWorkspaceFallback(hinted)) {
      process.env.GRAPHFLOW_WORKSPACE_ROOT = hinted;
      return hinted;
    }
    return undefined;
  }

  if (isUsableWorkspaceFallback(cwd)) {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = cwd;
    return cwd;
  }

  const hinted = resolveIdeWorkspaceHint();
  if (hinted && !isUnsafeWorkspaceFallback(hinted)) {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = hinted;
    return hinted;
  }

  return undefined;
}

/** IDE-provided workspace when process cwd is unsafe or a GraphFlow runtime directory. */
export function tryResolveIdeWorkspaceHint(): string | undefined {
  const hinted = resolveIdeWorkspaceHint();
  if (hinted && !isUnsafeWorkspaceFallback(hinted)) {
    return hinted;
  }
  return undefined;
}

export { isWsl };
