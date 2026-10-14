import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { removeDirIfEmpty, writeJsonOrRemove } from "./config-file-cleanup";

/**
 * claude-code-hooks.ts — Claude Code hooks 配置生成器（P0-2 + GraphFlow 3.0 PreToolUse/PostToolUse 省流拦截器）
 *
 * 生成 ~/.claude/settings.json 风格的 hooks 片段：
 *   - SessionStart / SessionEnd / Stop：自动记录与回填 episode outcome
 *   - PreToolUse / PostToolUse（当 enableToolInterceptors 开启时）：
 *       * PreToolUse 拦截对 >250 行大文件的无边界原生 Read，自动折叠为 AST Skeleton 视图（省 75-93% Token）
 *       * PostToolUse 拦截冗余 Bash 测试/构建输出，自动脱水压缩并录制到习惯轨迹库
 */

export const SESSION_HOOK_SCRIPT = "session.sh";
const JOURNAL_RELATIVE = ".graphflow/session-journal.jsonl";
export const CLAUDE_HOME_ENV = "GRAPHFLOW_CLAUDE_HOME";

export interface ClaudeCodeHooksOptions {
  graphflowBin?: string;
  configPath?: string;
  journalPath?: string;
  hooksDir?: string;
  settingsPath?: string;
  defaultSuccess?: boolean;
  timeoutSec?: number;
  /** 开启 GraphFlow 3.0 PreToolUse / PostToolUse 透明省流拦截器。 */
  enableToolInterceptors?: boolean;
}

export interface ClaudeCodeHooksStatusOptions {
  claudeHome?: string;
  settingsPath?: string;
  hooksDir?: string;
}

export interface ClaudeCodeHooksStatus {
  agent: string;
  claudeHome: string;
  settingsPath: string;
  hooksDir: string;
  scriptPath: string;
  detected: boolean;
  installed: boolean;
}

export interface ClaudeCodeHooksResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

export interface ClaudeCodeHookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

export type ClaudeCodeHookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "PreToolUse"
  | "PostToolUse";

export interface ClaudeCodeHooksConfig {
  hooks: Partial<Record<ClaudeCodeHookEventName, ClaudeCodeHookEntry[]>>;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellFallback(value: string): string {
  return value.replace(/([\\$`"])/g, "\\$1");
}

export function resolveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLAUDE_HOME_ENV]?.trim();
  if (override) return override;
  return join(homedir(), ".claude");
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

export function settingsReferenceHookScript(raw: string, scriptPath: string): boolean {
  const needle = normalizePathForMatch(scriptPath);
  if (!needle) return false;
  try {
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const hooks = parsed.hooks;
    if (hooks && typeof hooks === "object") {
      for (const entries of Object.values(hooks)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const command =
            entry && typeof entry === "object" && typeof (entry as { command?: unknown }).command === "string"
              ? (entry as { command: string }).command
              : "";
          if (command && normalizePathForMatch(command).includes(needle)) {
            return true;
          }
        }
      }
    }
  } catch {
    // Fall through
  }
  const quoted = shellQuote(scriptPath);
  const jsonEscaped = scriptPath.replace(/\\/g, "\\\\");
  return (
    raw.includes(scriptPath) ||
    raw.includes(quoted) ||
    raw.includes(jsonEscaped) ||
    raw.includes(shellQuote(jsonEscaped)) ||
    normalizePathForMatch(raw).includes(needle)
  );
}

function defaultHooksDir(claudeHome?: string): string {
  return join(claudeHome ?? resolveClaudeHome(), "graphflow-hooks");
}

function defaultSettingsPath(claudeHome?: string): string {
  return join(claudeHome ?? resolveClaudeHome(), "settings.json");
}

export function getClaudeCodeHooksStatus(
  options: ClaudeCodeHooksStatusOptions = {}
): ClaudeCodeHooksStatus {
  const claudeHome = options.claudeHome ?? resolveClaudeHome();
  const settingsPath = options.settingsPath ?? defaultSettingsPath(claudeHome);
  const hooksDir = options.hooksDir ?? defaultHooksDir(claudeHome);
  const scriptPath = join(hooksDir, SESSION_HOOK_SCRIPT);
  const detected = existsSync(claudeHome);
  let installed = false;
  if (detected && existsSync(scriptPath) && existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf8");
      installed = settingsReferenceHookScript(raw, scriptPath);
    } catch {
      installed = false;
    }
  }
  return {
    agent: "Claude Code hooks",
    claudeHome,
    settingsPath,
    hooksDir,
    scriptPath,
    detected,
    installed,
  };
}

export function buildSessionHookScript(options: ClaudeCodeHooksOptions = {}): string {
  const journal = options.journalPath ?? `\${CLAUDE_PROJECT_DIR:-.}/${JOURNAL_RELATIVE}`;
  const bin = options.graphflowBin ?? "graphflow";
  const config = options.configPath ?? "";
  const defaultSuccess = options.defaultSuccess ?? false;
  const successFallback = defaultSuccess ? "true" : "";
  const lines = [
    "#!/usr/bin/env bash",
    "# GraphFlow auto-capture & V3 Token-First interceptor hook (generated by graphflow, do not edit).",
    "# Resolves the most recent pending episode (src/hooks/auto-capture.ts) at",
    "# SessionEnd/Stop. Does not default pending episodes to success.",
    "# Missing $2 skips outcome report (episode stays pending).",
    "# Explicit $2 true/false calls: graphflow outcome report <episodeId> <success>",
    "# PreToolUse / PostToolUse actions delegate to GraphFlow V3 host-interceptor.",
    "# Runtime overrides: GRAPHFLOW_HOOK_JOURNAL / GRAPHFLOW_HOOK_BIN / GRAPHFLOW_HOOK_CONFIG.",
    "set -u",
    'ACTION="${1:-end}"',
    `SUCCESS="\${2:-${successFallback}}"`,
    `JOURNAL="\${GRAPHFLOW_HOOK_JOURNAL:-${shellFallback(journal)}}"`,
    `GF_BIN="\${GRAPHFLOW_HOOK_BIN:-${shellFallback(bin)}}"`,
    `GF_CONFIG="\${GRAPHFLOW_HOOK_CONFIG:-${shellFallback(config)}}"`,
    "",
    'case "$ACTION" in',
    "  start)",
    '    mkdir -p "$(dirname "$JOURNAL")" 2>/dev/null || true',
    "    exit 0",
    "    ;;",
    "  pre-tool|post-tool)",
    '    "$GF_BIN" hook "$ACTION" 2>/dev/null || true',
    "    exit 0",
    "    ;;",
    "esac",
    "",
    "# end/stop: resolve the most recent pending episode recorded by auto-capture.",
    '[ -f "$JOURNAL" ] || exit 0',
    'LINE="$(tail -n 1 "$JOURNAL" 2>/dev/null)" || exit 0',
    '[ -n "$LINE" ] || exit 0',
    'EPID="$(printf "%s" "$LINE" | sed -n \'s/.*"episodeId":[[:space:]]*"\\([^"]*\\)".*/\\1/p\')"',
    '[ -n "$EPID" ] || exit 0',
    "",
    "# Skip outcome report unless success is an explicit true/false argument.",
    '[ -n "$SUCCESS" ] || exit 0',
    'case "$SUCCESS" in',
    "  true|false)",
    '    ARGS=(outcome report "$EPID" "$SUCCESS")',
    '    [ -n "$GF_CONFIG" ] && ARGS+=(--config "$GF_CONFIG")',
    '    "$GF_BIN" "${ARGS[@]}" >/dev/null 2>&1 || true',
    "    ;;",
    "esac",
    "exit 0",
    "",
  ];
  return lines.join("\n");
}

export function buildClaudeCodeHooksConfig(
  options: ClaudeCodeHooksOptions = {}
): ClaudeCodeHooksConfig {
  const hooksDir = options.hooksDir ?? defaultHooksDir(resolveClaudeHome());
  const scriptPath = join(hooksDir, SESSION_HOOK_SCRIPT);
  const quotedScript = shellQuote(scriptPath);
  const startCommand = `bash ${quotedScript} start`;
  const endCommand = `bash ${quotedScript} end`;
  const preToolCommand = `bash ${quotedScript} pre-tool`;
  const postToolCommand = `bash ${quotedScript} post-tool`;
  const timeout = options.timeoutSec ?? 30;
  return {
    hooks: {
      SessionStart: [{ type: "command", command: startCommand, timeout }],
      SessionEnd: [{ type: "command", command: endCommand, timeout }],
      Stop: [{ type: "command", command: endCommand, timeout }],
      ...(options.enableToolInterceptors
        ? {
            PreToolUse: [{ type: "command", command: preToolCommand, timeout }],
            PostToolUse: [{ type: "command", command: postToolCommand, timeout }],
          }
        : {}),
    },
  };
}

export function installClaudeCodeHooks(
  options: ClaudeCodeHooksOptions = {}
): ClaudeCodeHooksResult {
  const claudeHome = resolveClaudeHome();
  const hooksDir = options.hooksDir ?? defaultHooksDir(claudeHome);
  const settingsPath = options.settingsPath ?? defaultSettingsPath(claudeHome);
  const scriptPath = join(hooksDir, SESSION_HOOK_SCRIPT);

  try {
    mkdirSync(hooksDir, { recursive: true });
    const script = buildSessionHookScript(options);
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
    return mergeSettingsHooks(settingsPath, buildClaudeCodeHooksConfig(options));
  } catch (error) {
    return {
      status: "error",
      filePath: settingsPath,
      message: `settings merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function mergeSettingsHooks(
  settingsPath: string,
  config: ClaudeCodeHooksConfig
): ClaudeCodeHooksResult {
  const existed = existsSync(settingsPath);
  let settings: Record<string, unknown>;
  if (existed) {
    const raw = readFileSync(settingsPath, "utf8");
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        status: "error",
        filePath: settingsPath,
        message: "existing settings.json is not valid JSON; refusing to overwrite",
      };
    }
  } else {
    settings = {};
  }

  const existingHooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, unknown>)
      : {};

  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  for (const [event, entries] of Object.entries(config.hooks)) {
    const existing = Array.isArray(existingHooks[event]) ? (existingHooks[event] as ClaudeCodeHookEntry[]) : [];
    const existingCommands = new Set(existing.map((entry) => entry.command));
    const added = (entries ?? []).filter((entry) => !existingCommands.has(entry.command));
    mergedHooks[event] = [...existing, ...added];
  }

  const next: Record<string, unknown> = { ...settings, hooks: mergedHooks };
  const payload = `${JSON.stringify(next, null, 2)}\n`;

  if (existed && readFileSync(settingsPath, "utf8") === payload) {
    return { status: "skipped", filePath: settingsPath, message: "already up to date" };
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, payload, "utf8");
  return {
    status: existed ? "updated" : "created",
    filePath: settingsPath,
    message: `hooks installed (${Object.keys(config.hooks).join(", ")})`,
  };
}

export function uninstallClaudeCodeHooks(
  settingsPath?: string,
  hooksDir?: string
): ClaudeCodeHooksResult {
  const claudeHome = resolveClaudeHome();
  const target = settingsPath ?? defaultSettingsPath(claudeHome);
  const scriptPath = join(hooksDir ?? defaultHooksDir(claudeHome), SESSION_HOOK_SCRIPT);
  if (!existsSync(target)) {
    return { status: "skipped", filePath: target, message: "settings.json not found" };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  } catch {
    return { status: "error", filePath: target, message: "settings.json is not valid JSON" };
  }

  const hooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const ourScript = shellQuote(scriptPath);
  let removedAny = false;
  for (const event of ["SessionStart", "SessionEnd", "Stop", "PreToolUse", "PostToolUse"] as const) {
    const entries = Array.isArray(hooks[event]) ? (hooks[event] as ClaudeCodeHookEntry[]) : [];
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
    writeJsonOrRemove(target, { ...settings, hooks });
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
    filePath: target,
    message: removedAny ? "hooks removed" : "no graphflow hooks present",
  };
}
