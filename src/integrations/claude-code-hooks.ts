import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * claude-code-hooks.ts — Claude Code hooks 配置生成器（P0-2）
 *
 * 生成 ~/.claude/settings.json 风格的 hooks 片段（SessionStart / SessionEnd / Stop），
 * 自动调用 graphflow CLI 记录 outcome/episode，让学习飞轮无需宿主 agent 主动调用
 * graphflow_report_outcome 也能自动闭环（配套的 auto-capture 默认开启，
 * 可通过 GRAPHFLOW_AUTO_CAPTURE=0 显式关闭）：
 *
 * 1. SessionStart → 初始化会话日志目录（不写图）。
 * 2. SessionEnd / Stop → 读取 src/hooks/auto-capture.ts 写入的最新 pending episode
 *    日志条目，调用 `graphflow outcome report <episodeId> <success>` 回填真实结局
 *    （回填后触发 updateEpisodeOutcome + applySkillLearning，与手动 report_outcome 等价）。
 *
 * 安全：所有嵌入脚本的路径/命令均做 shell 转义（单引号包裹 + 双引号内 fallback 转义），
 * 由 installClaudeCodeHooks 写盘；合并 settings.json 时绝不覆盖用户已有 hooks 配置。
 */

export const SESSION_HOOK_SCRIPT = "session.sh";
const JOURNAL_RELATIVE = ".graphflow/session-journal.jsonl";
/** Test/override: when set, treat this directory as Claude Code home (`~/.claude`). */
export const CLAUDE_HOME_ENV = "GRAPHFLOW_CLAUDE_HOME";

export interface ClaudeCodeHooksOptions {
  /** graphflow CLI 可执行命令（默认 "graphflow"，须在 PATH 中，如 `npm i -g @roarpeng/graphflow`）。 */
  graphflowBin?: string;
  /** 传给 `graphflow outcome report` 的 --config 参数（默认不传）。 */
  configPath?: string;
  /** 会话日志路径（默认 <项目目录>/.graphflow/session-journal.jsonl）。 */
  journalPath?: string;
  /** 生成的脚本目录（默认 ~/.claude/graphflow-hooks）。 */
  hooksDir?: string;
  /** 目标 settings.json 路径（默认 ~/.claude/settings.json）。 */
  settingsPath?: string;
  /** 会话结束默认成功值（默认 true）。 */
  defaultSuccess?: boolean;
  /** hook 超时秒数（默认 30）。 */
  timeoutSec?: number;
}

export interface ClaudeCodeHooksStatusOptions {
  /** Override Claude Code home (default: GRAPHFLOW_CLAUDE_HOME or ~/.claude). */
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

export interface ClaudeCodeHooksConfig {
  hooks: Partial<
    Record<"SessionStart" | "SessionEnd" | "Stop", ClaudeCodeHookEntry[]>
  >;
}

/** 单引号包裹的 shell 安全参数：路径/命令可含空格、单引号等字符。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 双引号赋值内 fallback 值的转义：\\ $ ` " 需反斜杠转义。 */
function shellFallback(value: string): string {
  return value.replace(/([\\$`"])/g, "\\$1");
}

/** Resolve Claude Code home (`~/.claude`), honoring GRAPHFLOW_CLAUDE_HOME for tests. */
export function resolveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLAUDE_HOME_ENV]?.trim();
  if (override) return override;
  return join(homedir(), ".claude");
}

/** Normalize path separators for cross-platform substring checks. */
function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/**
 * True when settings.json references our session hook script.
 * Parses JSON when possible so Windows paths survive JSON backslash escaping
 * (`C:\\Users\\...` in file vs `C:\Users\...` in path.join).
 */
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
    // Fall through to raw substring checks for partially written files.
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

/**
 * Doctor/install status for Claude Code flywheel hooks.
 * Detected when Claude Code home exists; installed when settings.json references
 * our session script and the script file is on disk.
 */
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

/**
 * 生成会话 hook 脚本内容（bash）。`start` 仅准备目录；`end` 解析会话日志中
 * 最新一条 pending episode 并调用 graphflow CLI 回填（成功默认 true，可传参数覆盖）。
 * 所有嵌入路径均做 shell 转义；失败静默（exit 0），绝不阻塞 Claude Code 会话。
 */
export function buildSessionHookScript(options: ClaudeCodeHooksOptions = {}): string {
  const journal = options.journalPath ?? `\${CLAUDE_PROJECT_DIR:-.}/${JOURNAL_RELATIVE}`;
  const bin = options.graphflowBin ?? "graphflow";
  const config = options.configPath ?? "";
  const successDefault = (options.defaultSuccess ?? true) ? "true" : "false";
  const lines = [
    "#!/usr/bin/env bash",
    "# GraphFlow auto-capture session hook (generated by graphflow, do not edit).",
    "# Resolves the most recent pending episode (src/hooks/auto-capture.ts) at",
    "# SessionEnd/Stop by calling: graphflow outcome report <episodeId> <success>",
    "# Runtime overrides: GRAPHFLOW_HOOK_JOURNAL / GRAPHFLOW_HOOK_BIN / GRAPHFLOW_HOOK_CONFIG.",
    "set -u",
    'ACTION="${1:-end}"',
    `SUCCESS="\${2:-${successDefault}}"`,
    `JOURNAL="\${GRAPHFLOW_HOOK_JOURNAL:-${shellFallback(journal)}}"`,
    `GF_BIN="\${GRAPHFLOW_HOOK_BIN:-${shellFallback(bin)}}"`,
    `GF_CONFIG="\${GRAPHFLOW_HOOK_CONFIG:-${shellFallback(config)}}"`,
    "",
    'case "$ACTION" in',
    "  start)",
    '    mkdir -p "$(dirname "$JOURNAL")" 2>/dev/null || true',
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
    'ARGS=(outcome report "$EPID" "$SUCCESS")',
    '[ -n "$GF_CONFIG" ] && ARGS+=(--config "$GF_CONFIG")',
    '"$GF_BIN" "${ARGS[@]}" >/dev/null 2>&1 || true',
    "exit 0",
    "",
  ];
  return lines.join("\n");
}

/**
 * 生成 settings.json 风格 hooks 配置片段。命令参数均经 shellQuote 转义，
 * 可直接合并进 ~/.claude/settings.json 的 "hooks" 字段。
 */
export function buildClaudeCodeHooksConfig(
  options: ClaudeCodeHooksOptions = {}
): ClaudeCodeHooksConfig {
  const hooksDir = options.hooksDir ?? defaultHooksDir(resolveClaudeHome());
  const scriptPath = join(hooksDir, SESSION_HOOK_SCRIPT);
  const quotedScript = shellQuote(scriptPath);
  const startCommand = `bash ${quotedScript} start`;
  const endCommand = `bash ${quotedScript} end`;
  const timeout = options.timeoutSec ?? 30;
  return {
    hooks: {
      SessionStart: [{ type: "command", command: startCommand, timeout }],
      SessionEnd: [{ type: "command", command: endCommand, timeout }],
      Stop: [{ type: "command", command: endCommand, timeout }],
    },
  };
}

/** 合并 hooks 配置到 settings.json（保留用户已有 hooks，append 幂等）。 */
export function installClaudeCodeHooks(
  options: ClaudeCodeHooksOptions = {}
): ClaudeCodeHooksResult {
  const claudeHome = resolveClaudeHome();
  const hooksDir = options.hooksDir ?? defaultHooksDir(claudeHome);
  const settingsPath = options.settingsPath ?? defaultSettingsPath(claudeHome);
  const scriptPath = join(hooksDir, SESSION_HOOK_SCRIPT);

  // 1) 安装会话脚本（内容一致则跳过）
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

  // 2) 合并 settings.json
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

/**
 * 合并 hooks 片段进 settings.json。文件不存在 → created；已存在且 JSON 损坏 → error
 * （绝不覆盖用户配置）；内容无变化 → skipped。
 */
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

/** 卸载：从 settings.json 移除本生成器写入的 hook 条目并删除会话脚本。 */
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
  for (const event of ["SessionStart", "SessionEnd", "Stop"] as const) {
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

  const next: Record<string, unknown> = { ...settings, hooks };
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (existsSync(scriptPath)) {
    try {
      rmSync(scriptPath, { force: true });
    } catch {
      // 删除脚本失败不阻断
    }
  }
  return {
    status: removedAny ? "updated" : "skipped",
    filePath: target,
    message: removedAny ? "hooks removed" : "no graphflow hooks present",
  };
}
