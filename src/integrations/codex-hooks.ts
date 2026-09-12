import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const CODEX_HOME_ENV = "GRAPHFLOW_CODEX_HOME";
export const CODEX_HOST_ADAPTER_ID = "codex";
export const CODEX_HOOKS_FILE = "hooks.json";
export const CODEX_HOOK_SCRIPT = "session.sh";
export const CODEX_HOOK_EVENTS = ["SessionStart", "SessionEnd"] as const;

export interface CodexHooksOptions {
  graphflowBin?: string;
  configPath?: string;
  journalPath?: string;
  hooksDir?: string;
  hooksPath?: string;
  timeoutSec?: number;
}

export interface CodexHooksStatusOptions {
  codexHome?: string;
  hooksPath?: string;
  hooksDir?: string;
}

export interface CodexHooksStatus {
  agent: string;
  codexHome: string;
  hooksPath: string;
  hooksDir: string;
  scriptPath: string;
  detected: boolean;
  installed: boolean;
}

export interface CodexHooksResult extends NestedMergeResult {}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CODEX_HOME_ENV]?.trim() || env.CODEX_HOME?.trim();
  return override || join(homedir(), ".codex");
}

function codexHooksDir(home: string): string {
  return join(home, "graphflow-hooks");
}

function codexHooksPath(home: string): string {
  return join(home, CODEX_HOOKS_FILE);
}

export function buildCodexHooksGroups(hooksDir: string): NestedHooksByEvent {
  const scriptPath = join(hooksDir, CODEX_HOOK_SCRIPT);
  const quoted = shellQuote(scriptPath);
  const group = (command: string): NestedHookGroup => ({
    matcher: "*",
    hooks: [{ type: "command", command, timeout: 30, statusMessage: "GraphFlow session hook" }],
  });
  return {
    SessionStart: [group(`bash ${quoted} start`)],
    SessionEnd: [group(`bash ${quoted} end`)],
  };
}

export function getCodexHooksStatus(options: CodexHooksStatusOptions = {}): CodexHooksStatus {
  const home = options.codexHome ?? resolveCodexHome();
  const hooksPath = options.hooksPath ?? codexHooksPath(home);
  const hooksDir = options.hooksDir ?? codexHooksDir(home);
  const scriptPath = join(hooksDir, CODEX_HOOK_SCRIPT);
  const detected = existsSync(home);
  let installed = false;
  if (detected && existsSync(scriptPath) && existsSync(hooksPath)) {
    try {
      installed = nestedHooksReferenceScript(readFileSync(hooksPath, "utf8"), scriptPath);
    } catch {
      installed = false;
    }
  }
  return { agent: "Codex CLI hooks", codexHome: home, hooksPath, hooksDir, scriptPath, detected, installed };
}

export function installCodexHooks(options: CodexHooksOptions = {}): CodexHooksResult {
  const home = resolveCodexHome();
  const hooksPath = options.hooksPath ?? codexHooksPath(home);
  const hooksDir = options.hooksDir ?? codexHooksDir(home);
  const scriptPath = join(hooksDir, CODEX_HOOK_SCRIPT);

  try {
    mkdirSync(hooksDir, { recursive: true });
    const script = buildSessionHookScript({
      ...(options.graphflowBin !== undefined ? { graphflowBin: options.graphflowBin } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      journalPath:
        options.journalPath ?? "${CODEX_PROJECT_DIR:-.}/.graphflow/session-journal.jsonl",
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
    return mergeNestedHooks(hooksPath, buildCodexHooksGroups(hooksDir));
  } catch (error) {
    return {
      status: "error",
      filePath: hooksPath,
      message: `hooks merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function uninstallCodexHooks(hooksPathOverride?: string, hooksDirOverride?: string): CodexHooksResult {
  const home = resolveCodexHome();
  const hooksPath = hooksPathOverride ?? codexHooksPath(home);
  const hooksDir = hooksDirOverride ?? codexHooksDir(home);
  const scriptPath = join(hooksDir, CODEX_HOOK_SCRIPT);
  const { result } = removeNestedHooks(hooksPath, CODEX_HOOK_EVENTS, scriptPath);
  removeHookScript(scriptPath);
  return result;
}

export function codexHostPaths(home: string): { hooksPath: string; hooksDir: string } {
  return { hooksPath: codexHooksPath(home), hooksDir: codexHooksDir(home) };
}

export function installCodexHooksForHost(options: { home?: string } = {}): CodexHooksResult {
  return installCodexHooks(codexHostPaths(options.home ?? resolveCodexHome()));
}

export function uninstallCodexHooksForHost(options: { home?: string } = {}): CodexHooksResult {
  const paths = codexHostPaths(options.home ?? resolveCodexHome());
  return uninstallCodexHooks(paths.hooksPath, paths.hooksDir);
}

export function getCodexHooksForHostStatus(options: { home?: string } = {}): {
  detected: boolean;
  installed: boolean;
  path: string;
} {
  const home = options.home ?? resolveCodexHome();
  const paths = codexHostPaths(home);
  const status = getCodexHooksStatus({ codexHome: home, ...paths });
  return { detected: status.detected, installed: status.installed, path: paths.hooksPath };
}
