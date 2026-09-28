/**
 * opencode plugin install slice.
 *
 * opencode loads local plugins from `<config>/plugins/*.{js,ts,mjs}` (global:
 * `~/.config/opencode/plugins`, project: `.opencode/plugins`). It calls each
 * exported plugin function with the opencode context and runs the returned hooks.
 *
 * GraphFlow ships ONE self-contained ESM plugin (`opencode/plugin.mjs`) that
 * closes the learning loop on session boundaries (dsh/plugin.mjs parity). This
 * module copies it into the opencode plugin directory (content-compared,
 * idempotent) and reports install status for `doctor`.
 *
 * opencode runs on Bun and installs npm dependencies for local plugins itself;
 * the bundled plugin uses only `node:child_process`, so no package.json is
 * required in the plugin directory.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENCODE_HOST_ADAPTER_ID = "opencode";
/** Test/override: treat this directory as the opencode config home. */
export const OPENCODE_HOME_ENV = "GRAPHFLOW_OPENCODE_HOME";
export const OPENCODE_PLUGIN_FILE = "graphflow.mjs";
export const OPENCODE_PLUGIN_SUBDIR = "plugins";
/**
 * Persistent opt-in for the plugin's MCP registration, written beside the
 * installed plugin.
 *
 * The environment variable works but is a trap. opencode keeps a long-lived
 * service process that owns and re-spawns the MCP children, so a variable
 * exported in a later shell never reaches it — and unless it is in an rc file it
 * is gone on the next launch, including a GUI launch. That was observed
 * directly: the variable was set, the user restarted, and nothing changed
 * because the service had been up for three hours. The marker travels with the
 * install instead, so the setting survives restarts and new machines.
 */
export const OPENCODE_MCP_MARKER_FILE = "graphflow-mcp.json";

export interface OpenCodeMcpRegistration {
  enabled: boolean;
  /** Absolute path of the GraphFlow checkout whose build opencode should launch. */
  workspaceRoot?: string;
  filePath?: string;
  status: "created" | "updated" | "removed" | "absent" | "unchanged" | "error";
  message?: string;
}

/**
 * The MCP server entry opencode.json should carry when the workspace build is
 * preferred: `<workspaceRoot>/dist/surfaces/mcp/server.js`.
 */
export function openCodeWorkspaceServerPath(workspaceRoot: string): string {
  return join(workspaceRoot, "dist", "surfaces", "mcp", "server.js");
}

export function opencodeMcpMarkerPath(home: string): string {
  return join(opencodePluginDir(home), OPENCODE_MCP_MARKER_FILE);
}

export function getOpenCodeMcpRegistration(options: { home?: string } = {}): OpenCodeMcpRegistration {
  const home = options.home ?? resolveOpenCodeHome();
  const filePath = opencodeMcpMarkerPath(home);
  if (!existsSync(filePath)) return { enabled: false, status: "absent" };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      enabled?: unknown;
      workspaceRoot?: unknown;
    };
    return {
      enabled: parsed.enabled === true,
      ...(typeof parsed.workspaceRoot === "string" && parsed.workspaceRoot
        ? { workspaceRoot: parsed.workspaceRoot }
        : {}),
      filePath,
      status: parsed.enabled === true ? "unchanged" : "absent",
    };
  } catch (error) {
    return {
      enabled: false,
      filePath,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function setOpenCodeMcpRegistration(
  options: { enabled: boolean; home?: string; workspaceRoot?: string }
): OpenCodeMcpRegistration {
  const home = options.home ?? resolveOpenCodeHome();
  const filePath = opencodeMcpMarkerPath(home);
  try {
    if (!options.enabled) {
      if (!existsSync(filePath)) return { enabled: false, filePath, status: "unchanged" };
      rmSync(filePath);
      return { enabled: false, filePath, status: "removed" };
    }
    const before = getOpenCodeMcpRegistration({ home });
    // The workspace is recorded rather than assumed: `install` may be run from
    // anywhere, and a marker that silently pointed at the wrong checkout would
    // write a plausible-looking entry that launches a stale build.
    const workspaceRoot = options.workspaceRoot ?? before.workspaceRoot ?? process.cwd();
    mkdirSync(opencodePluginDir(home), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ enabled: true, workspaceRoot }, null, 2)}\n`, "utf8");
    const unchanged =
      before.enabled &&
      before.status === "unchanged" &&
      before.workspaceRoot === workspaceRoot;
    return {
      enabled: true,
      workspaceRoot,
      filePath,
      status: unchanged ? "unchanged" : before.status === "absent" ? "created" : "updated",
    };
  } catch (error) {
    return {
      enabled: false,
      filePath,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface OpenCodePluginResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

export interface OpenCodePluginStatus {
  detected: boolean;
  installed: boolean;
  path: string;
}

/** Resolve opencode config home (`~/.config/opencode`), honoring the env override. */
export function resolveOpenCodeHome(override?: string): string {
  const explicit = override?.trim() || process.env[OPENCODE_HOME_ENV]?.trim();
  return explicit || join(homedir(), ".config", "opencode");
}

export function opencodePluginDir(home: string): string {
  return join(home, OPENCODE_PLUGIN_SUBDIR);
}

export function opencodePluginPath(home: string): string {
  return join(opencodePluginDir(home), OPENCODE_PLUGIN_FILE);
}

/**
 * Locate the bundled plugin source. Works from both `src/integrations` (tsx)
 * and `dist/integrations` (published package), plus the CWD for tests.
 */
export function resolveOpenCodePluginSourcePath(): string | undefined {
  const candidates = [
    join(process.cwd(), "opencode", "plugin.mjs"),
    join(__dirname, "..", "..", "opencode", "plugin.mjs"),
    join(__dirname, "..", "..", "..", "opencode", "plugin.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function getOpenCodePluginStatus(options: { home?: string } = {}): OpenCodePluginStatus {
  const home = resolveOpenCodeHome(options.home);
  return {
    detected: existsSync(home),
    installed: existsSync(opencodePluginPath(home)),
    path: opencodePluginPath(home),
  };
}

export function installOpenCodePlugin(options: { home?: string } = {}): OpenCodePluginResult {
  const home = resolveOpenCodeHome(options.home);
  const dest = opencodePluginPath(home);
  const source = resolveOpenCodePluginSourcePath();
  if (!source) {
    return { status: "skipped", filePath: dest, message: "opencode plugin source not found" };
  }
  try {
    const existed = existsSync(dest);
    if (existed && readFileSync(dest, "utf8") === readFileSync(source, "utf8")) {
      return { status: "skipped", filePath: dest, message: "already up to date" };
    }
    mkdirSync(opencodePluginDir(home), { recursive: true });
    copyFileSync(source, dest);
    return { status: existed ? "updated" : "created", filePath: dest };
  } catch (error) {
    return {
      status: "error",
      filePath: dest,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function uninstallOpenCodePlugin(options: { home?: string } = {}): OpenCodePluginResult {
  const home = resolveOpenCodeHome(options.home);
  const dest = opencodePluginPath(home);
  if (!existsSync(dest)) {
    return { status: "skipped", filePath: dest, message: "not found" };
  }
  try {
    rmSync(dest, { force: true });
    return { status: "updated", filePath: dest, message: "removed GraphFlow opencode plugin" };
  } catch (error) {
    return {
      status: "error",
      filePath: dest,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
