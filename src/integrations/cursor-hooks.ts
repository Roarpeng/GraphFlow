/**
 * cursor-hooks.ts — Cursor native hooks installer (`.cursor/hooks.json`, schema v1).
 *
 * Cursor's hook schema is FLAT (event -> array of `{ command, matcher, ... }`),
 * unlike Claude Code's nested `settings.json` matcher groups. This module mirrors
 * `claude-code-hooks.ts`: it generates ONE portable bash session script and
 * MERGES GraphFlow-owned entries into `~/.cursor/hooks.json` without touching the
 * user's other hooks (idempotent, never overwrite).
 *
 * Flywheel parity: Cursor `sessionStart` / `sessionEnd` / `stop` close the
 * learning loop exactly like Claude Code's SessionStart/SessionEnd/Stop hooks —
 * only an explicit success argument backfills a pending episode (never default
 * success).
 *
 * Cursor event names are camelCase and automatically map from Claude Code's
 * (PreToolUse -> preToolUse, ...). We register only the three lifecycle events
 * that carry the outcome-capture semantics.
 *
 * Safety: all embedded paths are shell-escaped; a malformed existing hooks.json
 * is refused (never overwritten); any failure is silent to the agent loop.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSessionHookScript,
  settingsReferenceHookScript,
  shellQuote,
} from "./claude-code-hooks";

export const CURSOR_HOOKS_HOME_ENV = "GRAPHFLOW_CURSOR_HOME";
export const CURSOR_HOOKS_FILE = "hooks.json";
export const CURSOR_HOOK_SCRIPT = "session.sh";

/** Lifecycle events we install. Cursor also supports preToolUse/postToolUse/etc. */
export type CursorHookEvent = "sessionStart" | "sessionEnd" | "stop";

/** Flat Cursor hook entry (one object per handler; `matcher` filters the event). */
export interface CursorHookEntry {
  command: string;
  matcher?: string;
  timeout?: number;
  failClosed?: boolean;
  loop_limit?: number;
}

export interface CursorHooksConfig {
  version: 1;
  hooks: Partial<Record<CursorHookEvent, CursorHookEntry[]>>;
}

export interface CursorHooksOptions {
  /** graphflow CLI executable (default "graphflow", must be on PATH). */
  graphflowBin?: string;
  /** --config argument forwarded to `graphflow outcome report` (default none). */
  configPath?: string;
  /** Session journal path used by the generated script (default cwd-relative). */
  journalPath?: string;
  /** Directory for the generated script (default <cursorHome>/graphflow-hooks). */
  hooksDir?: string;
  /** Target hooks.json (default <cursorHome>/hooks.json). */
  hooksPath?: string;
  /** Hook timeout seconds (default 30). */
  timeoutSec?: number;
}

export interface CursorHooksStatusOptions {
  cursorHome?: string;
  hooksPath?: string;
  hooksDir?: string;
}

export interface CursorHooksStatus {
  agent: string;
  cursorHome: string;
  hooksPath: string;
  hooksDir: string;
  scriptPath: string;
  detected: boolean;
  installed: boolean;
}

export interface CursorHooksResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

/** Resolve Cursor home (`~/.cursor`), honoring GRAPHFLOW_CURSOR_HOME for tests. */
export function resolveCursorHooksHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CURSOR_HOOKS_HOME_ENV]?.trim();
  return override || join(homedir(), ".cursor");
}

function defaultHooksDir(home: string): string {
  return join(home, "graphflow-hooks");
}

function defaultHooksPath(home: string): string {
  return join(home, CURSOR_HOOKS_FILE);
}

/**
 * Build the Cursor hooks.json payload. Commands are shell-escaped and use the
 * same `session.sh start|end` script the Claude Code installer generates.
 */
export function buildCursorHooksConfig(options: CursorHooksOptions = {}): CursorHooksConfig {
  const hooksDir = options.hooksDir ?? defaultHooksDir(resolveCursorHooksHome());
  const scriptPath = join(hooksDir, CURSOR_HOOK_SCRIPT);
  const quotedScript = shellQuote(scriptPath);
  const startCommand = `bash ${quotedScript} start`;
  const endCommand = `bash ${quotedScript} end`;
  const timeout = options.timeoutSec ?? 30;
  return {
    version: 1,
    hooks: {
      sessionStart: [{ command: startCommand, timeout }],
      sessionEnd: [{ command: endCommand, timeout }],
      stop: [{ command: endCommand, timeout }],
    },
  };
}

/** Merge GraphFlow hook entries into hooks.json (preserve user hooks, append 幂等). */
function mergeCursorHooks(hooksPath: string, config: CursorHooksConfig): CursorHooksResult {
  const existed = existsSync(hooksPath);
  let json: Record<string, unknown>;
  if (existed) {
    const raw = readFileSync(hooksPath, "utf8");
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        status: "error",
        filePath: hooksPath,
        message: "existing hooks.json is not valid JSON; refusing to overwrite",
      };
    }
  } else {
    json = {};
  }

  const existingHooks =
    json.hooks && typeof json.hooks === "object"
      ? (json.hooks as Record<string, unknown>)
      : {};

  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  for (const [event, entries] of Object.entries(config.hooks)) {
    const existing = Array.isArray(existingHooks[event])
      ? (existingHooks[event] as CursorHookEntry[])
      : [];
    const existingCommands = new Set(existing.map((entry) => entry.command));
    const added = (entries ?? []).filter((entry) => !existingCommands.has(entry.command));
    mergedHooks[event] = [...existing, ...added];
  }

  const version = typeof json.version === "number" ? json.version : config.version;
  const next: Record<string, unknown> = { ...json, version, hooks: mergedHooks };
  const payload = `${JSON.stringify(next, null, 2)}\n`;

  if (existed && readFileSync(hooksPath, "utf8") === payload) {
    return { status: "skipped", filePath: hooksPath, message: "already up to date" };
  }
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, payload, "utf8");
  return {
    status: existed ? "updated" : "created",
    filePath: hooksPath,
    message: `hooks installed (${Object.keys(config.hooks).join(", ")})`,
  };
}

/**
 * Doctor/install status for Cursor flywheel hooks. Detected when Cursor home
 * exists; installed when hooks.json references our session script AND the script
 * file is on disk.
 */
export function getCursorHooksStatus(options: CursorHooksStatusOptions = {}): CursorHooksStatus {
  const home = options.cursorHome ?? resolveCursorHooksHome();
  const hooksPath = options.hooksPath ?? defaultHooksPath(home);
  const hooksDir = options.hooksDir ?? defaultHooksDir(home);
  const scriptPath = join(hooksDir, CURSOR_HOOK_SCRIPT);
  const detected = existsSync(home);
  let installed = false;
  if (detected && existsSync(scriptPath) && existsSync(hooksPath)) {
    try {
      installed = settingsReferenceHookScript(readFileSync(hooksPath, "utf8"), scriptPath);
    } catch {
      installed = false;
    }
  }
  return {
    agent: "Cursor hooks",
    cursorHome: home,
    hooksPath,
    hooksDir,
    scriptPath,
    detected,
    installed,
  };
}

/** Install the session script + merge Cursor hook entries. Safe to re-run. */
export function installCursorHooks(options: CursorHooksOptions = {}): CursorHooksResult {
  const home = resolveCursorHooksHome();
  const hooksDir = options.hooksDir ?? defaultHooksDir(home);
  const hooksPath = options.hooksPath ?? defaultHooksPath(home);
  const scriptPath = join(hooksDir, CURSOR_HOOK_SCRIPT);

  // 1) Install the session script (content-compared).
  try {
    mkdirSync(hooksDir, { recursive: true });
    const script = buildSessionHookScript({
      ...(options.graphflowBin !== undefined ? { graphflowBin: options.graphflowBin } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      journalPath:
        options.journalPath ?? "${CURSOR_PROJECT_DIR:-.}/.graphflow/session-journal.jsonl",
      ...(options.timeoutSec !== undefined ? { timeoutSec: options.timeoutSec } : {}),
    });
    if (!existsSync(scriptPath) || readFileSync(scriptPath, "utf8") !== script) {
      writeFileSync(scriptPath, script, { mode: 0o755 });
    }
  } catch (error) {
    return {
      status: "error",
      filePath: scriptPath,
      message: `hook script install failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 2) Merge hooks.json (never overwrites the user's other entries).
  try {
    const config = buildCursorHooksConfig({ ...options, hooksDir });
    return mergeCursorHooks(hooksPath, config);
  } catch (error) {
    return {
      status: "error",
      filePath: hooksPath,
      message: `hooks merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Remove GraphFlow hook entries from hooks.json and delete the session script. */
export function uninstallCursorHooks(
  hooksPathOverride?: string,
  hooksDirOverride?: string
): CursorHooksResult {
  const home = resolveCursorHooksHome();
  const hooksPath = hooksPathOverride ?? defaultHooksPath(home);
  const scriptPath = join(hooksDirOverride ?? defaultHooksDir(home), CURSOR_HOOK_SCRIPT);
  if (!existsSync(hooksPath)) {
    return { status: "skipped", filePath: hooksPath, message: "hooks.json not found" };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { status: "error", filePath: hooksPath, message: "hooks.json is not valid JSON" };
  }

  const hooks =
    json.hooks && typeof json.hooks === "object"
      ? (json.hooks as Record<string, unknown>)
      : {};
  const ourScript = shellQuote(scriptPath);
  let removedAny = false;
  for (const event of ["sessionStart", "sessionEnd", "stop"] as const) {
    const entries = Array.isArray(hooks[event]) ? (hooks[event] as CursorHookEntry[]) : [];
    const kept = entries.filter((entry) => !entry.command.includes(ourScript));
    if (kept.length !== entries.length) {
      removedAny = true;
    }
    if (kept.length > 0) {
      hooks[event] = kept;
    } else if (hooks[event] !== undefined) {
      delete hooks[event];
    }
  }

  const next: Record<string, unknown> = { ...json, hooks };
  writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (existsSync(scriptPath)) {
    try {
      rmSync(scriptPath, { force: true });
    } catch {
      // Deleting the script must not block uninstall.
    }
  }
  return {
    status: removedAny ? "updated" : "skipped",
    filePath: hooksPath,
    message: removedAny ? "hooks removed" : "no graphflow hooks present",
  };
}
