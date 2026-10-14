/**
 * cursor-hooks.ts — Cursor native hooks installer (`.cursor/hooks.json`, schema v1)
 * with GraphFlow 3.0 `preToolUse` / `postToolUse` token-guard interceptors.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { removeDirIfEmpty, writeJsonOrRemove } from "./config-file-cleanup";
import {
  buildSessionHookScript,
  settingsReferenceHookScript,
  shellQuote,
} from "./claude-code-hooks";

export const CURSOR_HOOKS_HOME_ENV = "GRAPHFLOW_CURSOR_HOME";
export const CURSOR_HOOKS_FILE = "hooks.json";
export const CURSOR_HOOK_SCRIPT = "session.sh";

export type CursorHookEvent =
  | "sessionStart"
  | "sessionEnd"
  | "stop"
  | "preToolUse"
  | "postToolUse";

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
  graphflowBin?: string;
  configPath?: string;
  journalPath?: string;
  hooksDir?: string;
  hooksPath?: string;
  timeoutSec?: number;
  /** Enable GraphFlow 3.0 preToolUse / postToolUse token-saving interceptors. */
  enableToolInterceptors?: boolean;
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

export function buildCursorHooksConfig(options: CursorHooksOptions = {}): CursorHooksConfig {
  const hooksDir = options.hooksDir ?? defaultHooksDir(resolveCursorHooksHome());
  const scriptPath = join(hooksDir, CURSOR_HOOK_SCRIPT);
  const quotedScript = shellQuote(scriptPath);
  const startCommand = `bash ${quotedScript} start`;
  const endCommand = `bash ${quotedScript} end`;
  const preToolCommand = `bash ${quotedScript} pre-tool`;
  const postToolCommand = `bash ${quotedScript} post-tool`;
  const timeout = options.timeoutSec ?? 30;
  return {
    version: 1,
    hooks: {
      sessionStart: [{ command: startCommand, timeout }],
      sessionEnd: [{ command: endCommand, timeout }],
      stop: [{ command: endCommand, timeout }],
      ...(options.enableToolInterceptors
        ? {
            preToolUse: [{ command: preToolCommand, timeout }],
            postToolUse: [{ command: postToolCommand, timeout }],
          }
        : {}),
    },
  };
}

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

export function installCursorHooks(options: CursorHooksOptions = {}): CursorHooksResult {
  const home = resolveCursorHooksHome();
  const hooksDir = options.hooksDir ?? defaultHooksDir(home);
  const hooksPath = options.hooksPath ?? defaultHooksPath(home);
  const scriptPath = join(hooksDir, CURSOR_HOOK_SCRIPT);

  try {
    mkdirSync(hooksDir, { recursive: true });
    const script = buildSessionHookScript({
      ...(options.graphflowBin !== undefined ? { graphflowBin: options.graphflowBin } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      journalPath:
        options.journalPath ?? "${CURSOR_PROJECT_DIR:-.}/.graphflow/session-journal.jsonl",
      ...(options.timeoutSec !== undefined ? { timeoutSec: options.timeoutSec } : {}),
      ...(options.enableToolInterceptors !== undefined
        ? { enableToolInterceptors: options.enableToolInterceptors }
        : {}),
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
  for (const event of ["sessionStart", "sessionEnd", "stop", "preToolUse", "postToolUse"] as const) {
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

  if (removedAny) {
    writeJsonOrRemove(hooksPath, { ...json, hooks }, ["version"]);
  }
  if (existsSync(scriptPath)) {
    try {
      rmSync(scriptPath, { force: true });
    } catch {
      // ignore
    }
  }
  removeDirIfEmpty(dirname(scriptPath));
  return {
    status: removedAny ? "updated" : "skipped",
    filePath: hooksPath,
    message: removedAny ? "hooks removed" : "no graphflow hooks present",
  };
}
