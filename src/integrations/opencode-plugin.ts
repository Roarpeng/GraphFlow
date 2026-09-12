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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENCODE_HOST_ADAPTER_ID = "opencode";
/** Test/override: treat this directory as the opencode config home. */
export const OPENCODE_HOME_ENV = "GRAPHFLOW_OPENCODE_HOME";
export const OPENCODE_PLUGIN_FILE = "graphflow.mjs";
export const OPENCODE_PLUGIN_SUBDIR = "plugins";

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
