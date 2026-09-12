import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildSessionHookScript, shellQuote } from "./claude-code-hooks";
import {
  mergeNestedHooks,
  nestedHooksReferenceScript,
  removeHookScript,
  removeNestedHooks,
  type NestedHookGroup,
  type NestedHooksByEvent,
  type NestedMergeResult,
} from "./nested-command-hooks";

export const GEMINI_HOME_ENV = "GRAPHFLOW_GEMINI_HOME";
export const GEMINI_HOST_ADAPTER_ID = "gemini";
export const GEMINI_HOOK_SCRIPT = "session.sh";
export const GEMINI_HOOK_EVENTS = ["SessionStart", "SessionEnd"] as const;

export interface GeminiHooksOptions {
  graphflowBin?: string;
  configPath?: string;
  journalPath?: string;
  hooksDir?: string;
  settingsPath?: string;
  timeoutSec?: number;
}

export interface GeminiHooksStatusOptions {
  geminiHome?: string;
  settingsPath?: string;
  hooksDir?: string;
}

export interface GeminiHooksStatus {
  agent: string;
  geminiHome: string;
  settingsPath: string;
  hooksDir: string;
  scriptPath: string;
  detected: boolean;
  installed: boolean;
}

export interface GeminiHooksResult extends NestedMergeResult {}

export function resolveGeminiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GEMINI_HOME_ENV]?.trim();
  return override || join(homedir(), ".gemini");
}

function geminiHooksDir(home: string): string {
  return join(home, "graphflow-hooks");
}

function geminiSettingsPath(home: string): string {
  return join(home, "settings.json");
}

export function buildGeminiHooksGroups(hooksDir: string): NestedHooksByEvent {
  const scriptPath = join(hooksDir, GEMINI_HOOK_SCRIPT);
  const quoted = shellQuote(scriptPath);
  const group = (command: string): NestedHookGroup => ({
    matcher: "*",
    hooks: [{ name: "graphflow-session", type: "command", command, timeout: 30000 }],
  });
  return {
    SessionStart: [group(`bash ${quoted} start`)],
    SessionEnd: [group(`bash ${quoted} end`)],
  };
}

export function getGeminiHooksStatus(options: GeminiHooksStatusOptions = {}): GeminiHooksStatus {
  const home = options.geminiHome ?? resolveGeminiHome();
  const settingsPath = options.settingsPath ?? geminiSettingsPath(home);
  const hooksDir = options.hooksDir ?? geminiHooksDir(home);
  const scriptPath = join(hooksDir, GEMINI_HOOK_SCRIPT);
  const detected = existsSync(home);
  let installed = false;
  if (detected && existsSync(scriptPath) && existsSync(settingsPath)) {
    try {
      installed = nestedHooksReferenceScript(readFileSync(settingsPath, "utf8"), scriptPath);
    } catch {
      installed = false;
    }
  }
  return { agent: "Gemini CLI hooks", geminiHome: home, settingsPath, hooksDir, scriptPath, detected, installed };
}

export function installGeminiHooks(options: GeminiHooksOptions = {}): GeminiHooksResult {
  const home = resolveGeminiHome();
  const settingsPath = options.settingsPath ?? geminiSettingsPath(home);
  const hooksDir = options.hooksDir ?? geminiHooksDir(home);
  const scriptPath = join(hooksDir, GEMINI_HOOK_SCRIPT);

  try {
    mkdirSync(hooksDir, { recursive: true });
    const script = buildSessionHookScript({
      ...(options.graphflowBin !== undefined ? { graphflowBin: options.graphflowBin } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      journalPath:
        options.journalPath ?? "${GEMINI_PROJECT_DIR:-.}/.graphflow/session-journal.jsonl",
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

  try {
    return mergeNestedHooks(settingsPath, buildGeminiHooksGroups(hooksDir));
  } catch (error) {
    return {
      status: "error",
      filePath: settingsPath,
      message: `hooks merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function uninstallGeminiHooks(settingsPathOverride?: string, hooksDirOverride?: string): GeminiHooksResult {
  const home = resolveGeminiHome();
  const settingsPath = settingsPathOverride ?? geminiSettingsPath(home);
  const hooksDir = hooksDirOverride ?? geminiHooksDir(home);
  const scriptPath = join(hooksDir, GEMINI_HOOK_SCRIPT);
  const { result } = removeNestedHooks(settingsPath, GEMINI_HOOK_EVENTS, scriptPath);
  removeHookScript(scriptPath);
  return result;
}

export function geminiHostPaths(home: string): { settingsPath: string; hooksDir: string } {
  return { settingsPath: geminiSettingsPath(home), hooksDir: geminiHooksDir(home) };
}

export function installGeminiHooksForHost(options: { home?: string } = {}): GeminiHooksResult {
  return installGeminiHooks(geminiHostPaths(options.home ?? resolveGeminiHome()));
}

export function uninstallGeminiHooksForHost(options: { home?: string } = {}): GeminiHooksResult {
  const paths = geminiHostPaths(options.home ?? resolveGeminiHome());
  return uninstallGeminiHooks(paths.settingsPath, paths.hooksDir);
}

export function getGeminiHooksForHostStatus(options: { home?: string } = {}): {
  detected: boolean;
  installed: boolean;
  path: string;
} {
  const home = options.home ?? resolveGeminiHome();
  const paths = geminiHostPaths(home);
  const status = getGeminiHooksStatus({ geminiHome: home, ...paths });
  return { detected: status.detected, installed: status.installed, path: paths.settingsPath };
}
