/**
 * GraphFlow 3.1 — Multi-Agent MCP, Skill, Rules & Hook Auto-Installer (`src/agent-installer.ts`)
 *
 * Zero-bloat, table-driven installer supporting 21 mainstream AI coding agents:
 * Cursor, Claude Code, Claude Desktop, VS Code (GitHub Copilot), Windsurf,
 * Trae / Trae CN / TRAE SOLO CN, Cline, Roo Code, Kilo Code, OpenAI Codex,
 * Gemini CLI, Antigravity, Kimi Code, DeepSeek Harness (DSH), Qoder / Qoder CN,
 * OpenCode, ZCode, Zed, Continue, PearAI, and Amazon Q.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stripJsonComments } from "./semantic-index.js";

export type McpServersKey = "mcpServers" | "servers" | "context_servers" | "mcp";
export type McpConfigFormat = "json" | "codex-toml" | "opencode" | "zcode";

/**
 * Hosts with a host hook file GraphFlow can manage (tool and/or prompt phases).
 *
 * Prompt-only Tier-1 hosts: zcode, windsurf, trae, qoder, kimi-code, continue.
 */
export type HookKind =
  | "claude"
  | "cursor"
  | "gemini"
  | "codex"
  | "zcode"
  | "windsurf"
  | "trae"
  | "qoder"
  | "kimi-code"
  | "continue";

export interface AgentMcpTarget {
  configPath: string;
  serversKey: McpServersKey;
  configFormat?: McpConfigFormat;
}

/**
 * Tier-2 prompt-reflex assets: hosts without a UserPromptSubmit-style config
 * hook get the reflex via a plugin/hook FILE the host auto-loads. Install
 * writes the asset; uninstall deletes it (plus, for dsh, the managed patch
 * block that references it).
 */
export type ReflexAssetType = "opencode-kilo-plugin" | "cline-hook" | "dsh-plugin";

export interface AgentProfile {
  id: string;
  name: string;
  markerPaths: string[];
  mcpTargets: AgentMcpTarget[];
  workspaceMcpTargets?: Array<{
    relativePath: string;
    serversKey: McpServersKey;
    configFormat?: McpConfigFormat;
  }>;
  skillsDirs?: string[];
  rulesFiles?: Array<{
    filePath: string;
    kind: "cursor-mdc" | "managed-md" | "dedicated-md";
  }>;
  hookKind?: HookKind;
  hookConfigPath?: string;
  /**
   * DeepSeek Harness does not read `mcp.json`; its MCP servers are Cordis
   * plugin inserts in a profile patch file. When set, install writes/updates a
   * marker-delimited block in this file and uninstall removes it.
   */
  cordisPatchPath?: string;
  /** Prompt-reflex plugin/hook files for Tier-2 hosts (see ReflexAssetType). */
  reflexAssets?: Array<{ type: ReflexAssetType; targetPath: string }>;
}

export interface AgentInstallItemResult {
  agentId: string;
  agentName: string;
  category: "mcp" | "skill" | "rule" | "hook";
  targetPath: string;
  status: "installed" | "updated" | "removed" | "skipped" | "error";
  message?: string;
}

export interface InstallAllAgentsOptions {
  homeDir?: string;
  appDataDir?: string;
  localAppDataDir?: string;
  /**
   * DeepSeek Harness profile dir. When omitted, `DSH_HOME` is used for the
   * real (non-isolated) run, falling back to `<home>/.dsh`.
   */
  dshHome?: string;
  workspaceRoot?: string;
  includeWorkspace?: boolean;
  agentIds?: string[];
  serverName?: string;
  /**
   * Remove legacy registrations during install (default true): GraphFlow
   * entries under a different server key, stale launcher commands, and
   * leftovers for agents that are no longer installed. Only graphflow-owned
   * keys/blocks are touched. Pass `pruneLegacy: false` (CLI `--no-prune`)
   * to register without cleaning.
   */
  pruneLegacy?: boolean;
}

/**
 * Uninstall scope. `agentIds` wins, then `all`, otherwise only agents that are
 * actually detected are touched (safe default — never wipe every profile).
 */
export type UninstallAllAgentsOptions = InstallAllAgentsOptions & { all?: boolean };

export interface InstallAllAgentsReport {
  detectedAgents: Array<{ id: string; name: string }>;
  results: AgentInstallItemResult[];
}

/** Files GraphFlow would (or did) register for one detected agent. */
export interface AgentRegistrationPaths {
  mcp: string[];
  skill: string[];
  rule: string[];
  hook: string | undefined;
}

/** Per-agent registration state reported by `graphflow status`. */
export interface AgentRegistrationStatus {
  id: string;
  name: string;
  mcp: boolean;
  skill: boolean;
  /** `undefined` when the host has no rules/instructions surface at all. */
  rule: boolean | undefined;
  /** `undefined` when the host has no host-hook surface at all. */
  hook: boolean | undefined;
  paths: AgentRegistrationPaths;
}

export const GRAPHFLOW_BLOCK_BEGIN = "<!-- GRAPHFLOW:BEGIN -->";
export const GRAPHFLOW_BLOCK_END = "<!-- GRAPHFLOW:END -->";

/**
 * Managed DeepSeek Harness Cordis patch markers. DSH (DeepSeek Harness) reads
 * MCP registration from `~/.dsh/cordis.patch.yml` (a Cordis bundle patch), not
 * from `~/.dsh/mcp.json`, so the installer owns exactly this marker-delimited
 * block and never touches surrounding user patches.
 */
export const GRAPHFLOW_DSH_BEGIN = "# GRAPHFLOW-DSH-BEGIN";
export const GRAPHFLOW_DSH_END = "# GRAPHFLOW-DSH-END";

/**
 * Skill content single source of truth: `skills/graphflow/SKILL.md` at the
 * package root (also what `npx skills add <owner>/GraphFlow` distributes).
 * Falls back to a minimal inline copy only if the file is unreadable.
 */
const FALLBACK_SKILL_MD = [
  "---",
  "name: graphflow",
  "description: Token-First Surgical Code Engine (gf_read, gf_edit, gf_exec, gf_macro) — AST symbol slicing, blast-radius guards, dehydrated test logs, bilingual code search, habit macros. Run `npx @roarpeng/graphflow@latest install` to register the MCP server.",
  "---",
  "",
  "# GraphFlow — Token-First Surgical Engine",
  "",
  "Prefer the 4 surgical `gf_*` MCP tools over full-file reads and verbose test runs. If the tools are not registered yet, run `npx @roarpeng/graphflow@latest install`.",
].join("\n");

export function getSkillMdContent(): string {
  try {
    const skillPath = join(__dirname, "..", "skills", "graphflow", "SKILL.md");
    return readFileSync(skillPath, "utf8").trimEnd() + "\n";
  } catch {
    return FALLBACK_SKILL_MD;
  }
}

export const CURSOR_RULE_MDC_CONTENT = [
  "---",
  "description: GraphFlow 3.1 Token-First Surgical Code Engine rules (gf_read, gf_edit, gf_exec, gf_macro)",
  "globs: **/*",
  "alwaysApply: true",
  "---",
  "",
  "# GraphFlow 3.1 Surgical Mode (外科手术省 Token 模式)",
  "",
  "- Prefer `gf_read` (`targets: [\"path/file#symbol\"]` or `q: \"keyword / 中文关键词\"`) over reading entire large files (>250 lines).",
  "- Prefer `gf_edit` for symbol/line edits, multi-site batch `edits`, and cross-repo `renameTo`; update `[Blast Radius]` callers in the same turn.",
  "- Prefer `gf_exec({ cmd: \"affected-tests\", run: true })` to run affected tests with dehydrated output.",
  "- Prefer `gf_macro({ action: \"mine-git\" })` on new repos to load git co-change coupling hints, and `gf_macro({ action: \"run\", id })` for repeated workflows.",
  "",
].join("\n");

export const MANAGED_INSTRUCTION_BLOCK = [
  GRAPHFLOW_BLOCK_BEGIN,
  "# GraphFlow 3.1 (Token-First Surgical Mode / 外科手术省 Token 模式)",
  "",
  "Use GraphFlow's 4 surgical MCP tools (`gf_read`, `gf_edit`, `gf_exec`, `gf_macro`) to minimize token usage and prevent context rot:",
  "",
  "1. `gf_read`: Slice specific symbols (`targets: [\"file#symbol\"]`) or search by English/Chinese keywords (`q: \"keyword / 中文词\"`) with automatic cross-file type closure and `[Blast Radius]` call sites.",
  "2. `gf_edit`: Perform in-place symbol/line edits, bottom-up batch `edits`, or cross-repo `renameTo` with instant AST syntax, caller-arity, and struct-field contract guards.",
  "3. `gf_exec`: Run `cmd: \"affected-tests\"` or shell commands with dehydrated output (1-line `PASS` receipt; 5-line source window on failure; 3-strike loop circuit breaker).",
  "4. `gf_macro`: Run `action: \"mine-git\"` for zero-cold-start git co-change hints, or `action: \"run\"` to execute auto-compiled `.graphflow/macros/*.mjs` scripts.",
  GRAPHFLOW_BLOCK_END,
].join("\n");

function resolvePaths(opts: InstallAllAgentsOptions = {}) {
  const isWin = process.platform === "win32";
  const homeProvided = typeof opts.homeDir === "string" && opts.homeDir.trim().length > 0;
  const home = homeProvided ? opts.homeDir!.trim() : homedir();
  const appData =
    opts.appDataDir ??
    process.env.APPDATA ??
    (isWin ? join(home, "AppData", "Roaming") : join(home, ".config"));
  const localAppData =
    opts.localAppDataDir ??
    process.env.LOCALAPPDATA ??
    (isWin ? join(home, "AppData", "Local") : join(home, ".local", "share"));
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(home, ".kimi");
  // An explicit `homeDir` means the caller wants an isolated sandbox (tests,
  // CI): never fall back to the ambient real DSH_HOME in that case.
  const optDshHome = typeof opts.dshHome === "string" ? opts.dshHome.trim() : "";
  const envDshHome = homeProvided ? "" : process.env.DSH_HOME?.trim() ?? "";
  const dshHome = optDshHome || envDshHome || join(home, ".dsh");
  return { isWin, home, appData, localAppData, kimiHome, dshHome };
}

export function buildAgentProfiles(opts: InstallAllAgentsOptions = {}): AgentProfile[] {
  const { isWin, home, appData, localAppData, kimiHome, dshHome } = resolvePaths(opts);

  return [
    {
      id: "cursor",
      name: "Cursor",
      markerPaths: [
        join(home, ".cursor"),
        join(appData, "Cursor"),
        join(localAppData, "Programs", "cursor"),
      ],
      mcpTargets: [{ configPath: join(home, ".cursor", "mcp.json"), serversKey: "mcpServers" }],
      workspaceMcpTargets: [{ relativePath: join(".cursor", "mcp.json"), serversKey: "mcpServers" }],
      skillsDirs: [join(home, ".cursor", "skills")],
      rulesFiles: [{ filePath: join(home, ".cursor", "rules", "graphflow.mdc"), kind: "cursor-mdc" }],
      hookKind: "cursor",
      hookConfigPath: join(home, ".cursor", "hooks.json"),
    },
    {
      id: "claude-code",
      name: "Claude Code",
      markerPaths: [join(home, ".claude"), join(home, ".claude.json")],
      mcpTargets: [{ configPath: join(home, ".claude.json"), serversKey: "mcpServers" }],
      workspaceMcpTargets: [{ relativePath: ".mcp.json", serversKey: "mcpServers" }],
      skillsDirs: [join(home, ".claude", "skills")],
      rulesFiles: [
        { filePath: join(home, ".claude", "CLAUDE.md"), kind: "managed-md" },
        { filePath: join(home, ".claude", "rules", "graphflow.md"), kind: "dedicated-md" },
      ],
      hookKind: "claude",
      hookConfigPath: join(home, ".claude", "settings.json"),
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      markerPaths: [
        join(appData, "Claude"),
        join(home, "Library", "Application Support", "Claude"),
      ],
      mcpTargets: [
        {
          configPath:
            process.platform === "darwin"
              ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
              : join(appData, "Claude", "claude_desktop_config.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "vscode",
      name: "VS Code",
      markerPaths: [
        join(appData, "Code"),
        join(localAppData, "Programs", "Microsoft VS Code"),
        join(home, ".vscode"),
      ],
      mcpTargets: [
        {
          configPath: isWin
            ? join(appData, "Code", "User", "mcp.json")
            : join(home, ".config", "Code", "User", "mcp.json"),
          serversKey: "servers",
        },
      ],
      workspaceMcpTargets: [{ relativePath: join(".vscode", "mcp.json"), serversKey: "servers" }],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      markerPaths: [join(home, ".codeium", "windsurf"), join(appData, "Windsurf")],
      mcpTargets: [
        {
          configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
          serversKey: "mcpServers",
        },
      ],
      rulesFiles: [
        {
          filePath: join(home, ".codeium", "windsurf", "memories", "global_rules.md"),
          kind: "managed-md",
        },
      ],
      hookKind: "windsurf",
      hookConfigPath: join(home, ".codeium", "windsurf", "hooks.json"),
    },
    {
      id: "trae",
      name: "Trae / Trae CN",
      markerPaths: [
        join(home, ".trae"),
        join(home, ".trae-cn"),
        join(appData, "Trae"),
        join(appData, "Trae CN"),
        join(appData, "TRAE SOLO CN"),
      ],
      mcpTargets: [
        {
          configPath: isWin
            ? join(appData, "Trae", "User", "mcp.json")
            : join(home, ".config", "Trae", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWin
            ? join(appData, "Trae CN", "User", "mcp.json")
            : join(home, ".config", "Trae CN", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWin
            ? join(appData, "TRAE SOLO CN", "User", "mcp.json")
            : join(home, ".config", "TRAE SOLO CN", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
      skillsDirs: [
        join(home, ".trae", "skills"),
        join(home, ".trae-cn", "skills"),
        isWin ? join(appData, "Trae", "User", "skills") : join(home, ".config", "Trae", "User", "skills"),
        isWin ? join(appData, "Trae CN", "User", "skills") : join(home, ".config", "Trae CN", "User", "skills"),
        isWin ? join(appData, "TRAE SOLO CN", "User", "skills") : join(home, ".config", "TRAE SOLO CN", "User", "skills"),
      ],
      // Standard (international) build only; the CN build (.trae-cn) is left alone.
      hookKind: "trae",
      hookConfigPath: join(home, ".trae", "hooks.json"),
    },
    {
      id: "codex",
      name: "Codex",
      markerPaths: [join(home, ".codex"), join(localAppData, "OpenAI", "Codex")],
      mcpTargets: [
        {
          configPath: join(home, ".codex", "config.toml"),
          serversKey: "mcpServers",
          configFormat: "codex-toml",
        },
      ],
      skillsDirs: [join(home, ".codex", "skills"), join(home, ".agents", "skills")],
      rulesFiles: [{ filePath: join(home, ".codex", "AGENTS.md"), kind: "managed-md" }],
      hookKind: "codex",
      hookConfigPath: join(home, ".codex", "hooks.json"),
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      markerPaths: [join(home, ".gemini")],
      mcpTargets: [{ configPath: join(home, ".gemini", "settings.json"), serversKey: "mcpServers" }],
      workspaceMcpTargets: [
        { relativePath: join(".gemini", "settings.json"), serversKey: "mcpServers" },
      ],
      rulesFiles: [{ filePath: join(home, ".gemini", "GEMINI.md"), kind: "managed-md" }],
      hookKind: "gemini",
      hookConfigPath: join(home, ".gemini", "settings.json"),
    },
    {
      id: "antigravity",
      name: "Antigravity",
      markerPaths: [join(home, ".gemini", "antigravity"), join(home, ".antigravity")],
      mcpTargets: [
        {
          configPath: join(home, ".gemini", "antigravity", "mcp_config.json"),
          serversKey: "mcpServers",
        },
        {
          // Read by current Antigravity builds (verified live: a 2.x-era
          // registration here kept spawning a vendored 2.2.0 server even
          // after the modern paths above were updated). Must stay in the
          // install/prune map or stale 2.x entries survive undetected.
          configPath: join(home, ".gemini", "config", "mcp_config.json"),
          serversKey: "mcpServers",
        },
      ],
      workspaceMcpTargets: [
        { relativePath: join(".agents", "mcp_config.json"), serversKey: "mcpServers" },
      ],
      skillsDirs: [join(home, ".gemini", "antigravity", "skills")],
    },
    {
      id: "cline",
      name: "Cline",
      markerPaths: [
        join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
        join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
      ],
      mcpTargets: [
        {
          configPath: isWin
            ? join(
                appData,
                "Code",
                "User",
                "globalStorage",
                "saoudrizwan.claude-dev",
                "settings",
                "cline_mcp_settings.json"
              )
            : join(
                home,
                ".config",
                "Code",
                "User",
                "globalStorage",
                "saoudrizwan.claude-dev",
                "settings",
                "cline_mcp_settings.json"
              ),
          serversKey: "mcpServers",
        },
      ],
      // Tier-2 prompt reflex: file-based UserPromptSubmit hook (Unix only —
      // skipped on win32 where Cline itself does not support hook files).
      reflexAssets: [
        { type: "cline-hook", targetPath: join(home, "Documents", "Cline", "Hooks", "UserPromptSubmit") },
      ],
    },
    {
      id: "roo-code",
      name: "Roo Code",
      markerPaths: [
        join(home, ".roo"),
        join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
        join(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
      ],
      mcpTargets: [
        {
          configPath: isWin
            ? join(
                appData,
                "Code",
                "User",
                "globalStorage",
                "rooveterinaryinc.roo-cline",
                "settings",
                "cline_mcp_settings.json"
              )
            : join(
                home,
                ".config",
                "Code",
                "User",
                "globalStorage",
                "rooveterinaryinc.roo-cline",
                "settings",
                "cline_mcp_settings.json"
              ),
          serversKey: "mcpServers",
        },
      ],
      skillsDirs: [join(home, ".roo", "skills")],
      rulesFiles: [{ filePath: join(home, ".roo", "rules", "AGENTS.md"), kind: "managed-md" }],
    },
    {
      id: "kilocode",
      name: "Kilo Code",
      markerPaths: [
        join(home, ".kilocode"),
        join(appData, "Code", "User", "globalStorage", "kilocode.kilocode-ai"),
      ],
      mcpTargets: [
        {
          configPath: isWin
            ? join(
                appData,
                "Code",
                "User",
                "globalStorage",
                "kilocode.kilocode-ai",
                "settings",
                "cline_mcp_settings.json"
              )
            : join(
                home,
                ".config",
                "Code",
                "User",
                "globalStorage",
                "kilocode.kilocode-ai",
                "settings",
                "cline_mcp_settings.json"
              ),
          serversKey: "mcpServers",
        },
      ],
      skillsDirs: [join(home, ".kilocode", "skills")],
      rulesFiles: [{ filePath: join(home, ".kilocode", "AGENTS.md"), kind: "managed-md" }],
      // Tier-2 prompt reflex: shared OpenCode-compatible plugin auto-loads
      // from ~/.config/kilo/plugin/ ({plugin,plugins}/*.{ts,js} glob).
      reflexAssets: [
        { type: "opencode-kilo-plugin", targetPath: join(home, ".config", "kilo", "plugin", "graphflow-prompt-reflex.ts") },
      ],
    },
    {
      id: "kimi-code",
      name: "Kimi Code",
      markerPaths: [kimiHome, join(home, ".kimi-code")],
      mcpTargets: [
        { configPath: join(kimiHome, "mcp.json"), serversKey: "mcpServers" },
        { configPath: join(home, ".kimi-code", "mcp.json"), serversKey: "mcpServers" },
      ],
      workspaceMcpTargets: [
        { relativePath: join(".kimi-code", "mcp.json"), serversKey: "mcpServers" },
      ],
      skillsDirs: [join(kimiHome, "skills"), join(home, ".kimi-code", "skills")],
      rulesFiles: [{ filePath: join(kimiHome, "AGENTS.md"), kind: "managed-md" }],
      hookKind: "kimi-code",
      hookConfigPath: join(home, ".kimi-code", "config.toml"),
    },
    {
      id: "deepseek-harness",
      name: "DeepSeek Harness",
      markerPaths: [dshHome],
      mcpTargets: [{ configPath: join(dshHome, "mcp.json"), serversKey: "mcpServers" }],
      skillsDirs: [join(dshHome, "skills")],
      // DSH loads MCP servers from a Cordis patch file, not from mcp.json.
      cordisPatchPath: join(dshHome, "cordis.patch.yml"),
      // Tier-2 prompt reflex: Cordis plugin + managed patch row (the patch
      // block is written to cordisPatchPath alongside the MCP block).
      reflexAssets: [
        { type: "dsh-plugin", targetPath: join(dshHome, "plugins", "graphflow-prompt-reflex.mjs") },
      ],
    },
    {
      id: "qoder",
      name: "Qoder / Qoder CN",
      markerPaths: [
        join(home, ".qoder"),
        join(home, ".qoder-cn"),
        join(appData, "Qoder"),
        join(appData, "QoderCN"),
      ],
      mcpTargets: [
        { configPath: join(home, ".qoder", "mcp.json"), serversKey: "mcpServers" },
        { configPath: join(home, ".qoder-cn", "mcp.json"), serversKey: "mcpServers" },
        {
          configPath: isWin
            ? join(appData, "Qoder", "SharedClientCache", "mcp.json")
            : join(home, ".config", "Qoder", "SharedClientCache", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWin
            ? join(appData, "QoderCN", "SharedClientCache", "mcp.json")
            : join(home, ".config", "QoderCN", "SharedClientCache", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
      workspaceMcpTargets: [{ relativePath: join(".qoder", "mcp.json"), serversKey: "mcpServers" }],
      skillsDirs: [join(home, ".qoder", "skills"), join(home, ".qoder-cn", "skills")],
      hookKind: "qoder",
      hookConfigPath: join(home, ".qoder", "settings.json"),
    },
    {
      id: "opencode",
      name: "OpenCode",
      markerPaths: [join(home, ".config", "opencode"), join(appData, "opencode")],
      mcpTargets: [
        {
          configPath: join(home, ".config", "opencode", "opencode.json"),
          serversKey: "mcp",
          configFormat: "opencode",
        },
      ],
      workspaceMcpTargets: [
        {
          relativePath: join(".opencode", "opencode.json"),
          serversKey: "mcp",
          configFormat: "opencode",
        },
      ],
      skillsDirs: [join(home, ".config", "opencode", "skills")],
      rulesFiles: [
        { filePath: join(home, ".config", "opencode", "AGENTS.md"), kind: "managed-md" },
      ],
      // Tier-2 prompt reflex: v1 plugin auto-loads from the plugin/ glob dir,
      // no opencode.json registration needed.
      reflexAssets: [
        { type: "opencode-kilo-plugin", targetPath: join(home, ".config", "opencode", "plugin", "graphflow-prompt-reflex.ts") },
      ],
    },
    {
      id: "zcode",
      name: "ZCode",
      markerPaths: [join(home, ".zcode"), join(appData, "zcode")],
      mcpTargets: [
        {
          configPath: join(home, ".zcode", "cli", "config.json"),
          serversKey: "mcpServers",
          configFormat: "zcode",
        },
      ],
      skillsDirs: [join(home, ".zcode", "skills")],
      rulesFiles: [{ filePath: join(home, ".zcode", "AGENTS.md"), kind: "managed-md" }],
      hookKind: "zcode",
      hookConfigPath: join(home, ".zcode", "cli", "config.json"),
    },
    {
      id: "zed",
      name: "Zed",
      markerPaths: [join(home, ".config", "zed"), join(appData, "Zed")],
      mcpTargets: [
        {
          configPath: isWin
            ? join(appData, "Zed", "settings.json")
            : join(home, ".config", "zed", "settings.json"),
          serversKey: "context_servers",
        },
      ],
    },
    {
      id: "continue",
      name: "Continue",
      markerPaths: [join(home, ".continue")],
      mcpTargets: [{ configPath: join(home, ".continue", "config.json"), serversKey: "mcpServers" }],
      // Hooks currently run in the Continue CLI only (the IDE extension ignores
      // them); still registered so CLI sessions get the prompt hook.
      hookKind: "continue",
      hookConfigPath: join(home, ".continue", "settings.json"),
    },
    {
      id: "pearai",
      name: "PearAI",
      markerPaths: [join(home, ".pearai"), join(appData, "PearAI")],
      mcpTargets: [{ configPath: join(home, ".pearai", "mcp.json"), serversKey: "mcpServers" }],
    },
    {
      id: "amazon-q",
      name: "Amazon Q",
      markerPaths: [join(home, ".amazonq")],
      mcpTargets: [{ configPath: join(home, ".amazonq", "mcp.json"), serversKey: "mcpServers" }],
    },
    {
      id: "workbuddy",
      name: "WorkBuddy",
      markerPaths: [join(home, ".workbuddy")],
      mcpTargets: [{ configPath: join(home, ".workbuddy", "mcp.json"), serversKey: "mcpServers" }],
      // WorkBuddy has no global instructions file: the skill is the surface, so
      // no rulesFiles here (a stray AGENTS.md would simply be ignored).
      skillsDirs: [join(home, ".workbuddy", "skills")],
    },
  ];
}

export function detectInstalledAgents(
  opts: InstallAllAgentsOptions = {}
): Array<{ id: string; name: string }> {
  const profiles = buildAgentProfiles(opts);
  const filterSet = opts.agentIds?.length ? new Set(opts.agentIds) : undefined;
  const detected: Array<{ id: string; name: string }> = [];
  for (const p of profiles) {
    if (filterSet && !filterSet.has(p.id)) continue;
    if (filterSet || p.markerPaths.some((m) => m && existsSync(m))) {
      detected.push({ id: p.id, name: p.name });
    }
  }
  return detected;
}

/**
 * Global roots where `@roarpeng/graphflow` may live.
 *
 * `npm root -g` alone is not enough: when npm is shimmed by a version manager
 * (or by a bundled runtime, as in this machine) it reports a root that has
 * nothing to do with where `npm i -g` actually installed the package — the
 * launcher then silently degrades to `npx -y`, which needs the network on every
 * MCP start. `npm prefix -g` and the platform default cover that.
 */
function candidateGlobalRoots(): string[] {
  const roots: string[] = [];
  // On Windows `execFileSync("npm", …)` fails outright: npm ships as npm.cmd /
  // npm.ps1 and there is no npm.exe to exec. Trying the .cmd first is what makes
  // the two npm-derived candidates actually run there; without it every machine
  // silently fell through to the platform default.
  const npmCommands = process.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"];
  const run = (args: string[]) => {
    for (const command of npmCommands) {
      try {
        const out = execFileSync(command, args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .split(/\r?\n/)
          .pop()
          ?.trim();
        if (out) return out;
      } catch {
        // try the next npm spelling
      }
    }
    return undefined;
  };
  const root = run(["root", "-g"]);
  if (root) roots.push(root);
  const prefix = run(["prefix", "-g"]);
  if (prefix) roots.push(join(prefix, "node_modules"));
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) roots.push(join(appData, "npm", "node_modules"));
  } else {
    roots.push("/usr/local/lib/node_modules", join(process.env.HOME ?? "/root", ".npm-global", "lib", "node_modules"));
  }
  return [...new Set(roots)];
}

function resolveMcpLauncherCommand(): { command: string; args: string[] } {
  for (const globalRoot of candidateGlobalRoots()) {
    const serverJs = join(globalRoot, "@roarpeng", "graphflow", "dist", "mcp-server.js");
    if (existsSync(serverJs)) {
      // Absolute node: hosts start MCP servers with a bare environment where
      // `node` is not necessarily on PATH.
      return { command: process.execPath, args: [serverJs] };
    }
  }
  return {
    command: "npx",
    args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
  };
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Result of reading a config file GraphFlow is about to rewrite. */
type JsonConfigRead =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; detail: string };

/**
 * Reads a host config file for a write path. Hosts that allow JSONC (VS Code
 * `settings.json`, Codex `config.toml`-adjacent files) are common, so the text is
 * retried with comments and trailing commas stripped before it is declared broken.
 */
function readJsonConfig(filePath: string): JsonConfigRead {
  if (!existsSync(filePath)) return { ok: true, data: {} };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if (!raw.trim()) return { ok: true, data: {} };

  let detail = "unknown parse failure";
  for (const text of [raw, stripJsonComments(raw)]) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, data: parsed as Record<string, unknown> };
      }
      detail = Array.isArray(parsed)
        ? "the file contains a JSON array, not an object"
        : `the file contains ${parsed === null ? "null" : `a ${typeof parsed}`}, not an object`;
      break;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, detail };
}

/**
 * Reads a config file that is about to be rewritten.
 *
 * {@link readJsonSafe} degrades to `{}` so read-only callers keep working; doing the same
 * before a write is destructive. The caller then merges its one entry into an empty
 * object and replaces the file, so a stray trailing comma or comment in
 * `~/.cursor/mcp.json` silently deletes every other MCP server the user configured.
 * Rewriting callers therefore refuse to touch a file they cannot parse, and leave a
 * backup next to it.
 */
function readJsonForUpdate(filePath: string): Record<string, unknown> {
  const result = readJsonConfig(filePath);
  if (result.ok) return result.data;

  const backupPath = `${filePath}.graphflow-bak`;
  try {
    copyFileSync(filePath, backupPath);
  } catch {
    // The backup is a courtesy; the refusal below is what protects the file.
  }
  throw new Error(
    `refusing to overwrite ${filePath}: it is not valid JSON (${result.detail}). ` +
      `A backup was written to ${backupPath}. Fix or delete the file and re-run.`
  );
}

function writeJsonSafe(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // Write to a sibling temp file and rename: a crash, a full disk or a killed editor must
  // not leave the host's config half-written — rename() is atomic on POSIX and NTFS.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

function writeMcpTarget(
  target: AgentMcpTarget,
  serverName: string,
  launcher: { command: string; args: string[] }
): "installed" | "updated" {
  const existed = existsSync(target.configPath);
  const format = target.configFormat ?? "json";

  if (format === "codex-toml") {
    mkdirSync(dirname(target.configPath), { recursive: true });
    const current = existed ? readFileSync(target.configPath, "utf8") : "";
    const sectionHeader = `[mcp_servers.${serverName}]`;
    const argsJson = JSON.stringify(launcher.args);
    const newBlock = `${sectionHeader}\ncommand = ${JSON.stringify(launcher.command)}\nargs = ${argsJson}\n`;
    const sectionRegex = new RegExp(
      `\\[mcp_servers\\.${serverName}\\][\\s\\S]*?(?=\\n\\[|$)`,
      "m"
    );
    const updated = sectionRegex.test(current)
      ? current.replace(sectionRegex, newBlock.trimEnd())
      : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${newBlock}`;
    writeFileSync(target.configPath, `${updated.trimEnd()}\n`, "utf8");
    return existed ? "updated" : "installed";
  }

  const obj = readJsonForUpdate(target.configPath);

  if (format === "opencode") {
    const mcp =
      obj.mcp && typeof obj.mcp === "object" ? (obj.mcp as Record<string, unknown>) : {};
    mcp[serverName] = {
      type: "local",
      command: [launcher.command, ...launcher.args],
      enabled: true,
    };
    obj.mcp = mcp;
    writeJsonSafe(target.configPath, obj);
    return existed ? "updated" : "installed";
  }

  if (format === "zcode") {
    const mcp =
      obj.mcp && typeof obj.mcp === "object" ? (obj.mcp as Record<string, unknown>) : {};
    const servers =
      mcp.servers && typeof mcp.servers === "object"
        ? (mcp.servers as Record<string, unknown>)
        : {};
    servers[serverName] = {
      command: launcher.command,
      args: launcher.args,
    };
    mcp.servers = servers;
    obj.mcp = mcp;
    writeJsonSafe(target.configPath, obj);
    return existed ? "updated" : "installed";
  }

  const servers =
    obj[target.serversKey] && typeof obj[target.serversKey] === "object"
      ? (obj[target.serversKey] as Record<string, unknown>)
      : {};
  servers[serverName] = {
    command: launcher.command,
    args: launcher.args,
  };
  obj[target.serversKey] = servers;
  writeJsonSafe(target.configPath, obj);
  return existed ? "updated" : "installed";
}

/** Removes a container that became empty, so uninstall leaves no `{"mcpServers":{}}` shell. */
function pruneEmptyObjectKey(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    delete parent[key];
  }
}

function removeMcpTarget(target: AgentMcpTarget, serverName: string): boolean {
  if (!existsSync(target.configPath)) return false;
  const format = target.configFormat ?? "json";

  if (format === "codex-toml") {
    const current = readFileSync(target.configPath, "utf8");
    const sectionRegex = new RegExp(
      `\\n?\\[mcp_servers\\.${serverName}\\][\\s\\S]*?(?=\\n\\[|$)`,
      "m"
    );
    if (!sectionRegex.test(current)) return false;
    const next = current.replace(sectionRegex, "").trim();
    writeFileSync(target.configPath, next ? `${next}\n` : "", "utf8");
    return true;
  }

  const obj = readJsonForUpdate(target.configPath);
  if (format === "opencode") {
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    if (!mcp || !(serverName in mcp)) return false;
    delete mcp[serverName];
    pruneEmptyObjectKey(obj, "mcp");
    writeJsonSafe(target.configPath, obj);
    return true;
  }
  if (format === "zcode") {
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    const servers = mcp?.servers as Record<string, unknown> | undefined;
    if (!servers || !(serverName in servers)) return false;
    delete servers[serverName];
    if (mcp) pruneEmptyObjectKey(mcp, "servers");
    pruneEmptyObjectKey(obj, "mcp");
    writeJsonSafe(target.configPath, obj);
    return true;
  }

  const servers = obj[target.serversKey] as Record<string, unknown> | undefined;
  if (!servers || !(serverName in servers)) return false;
  delete servers[serverName];
  pruneEmptyObjectKey(obj, target.serversKey);
  writeJsonSafe(target.configPath, obj);
  return true;
}

function writeManagedFile(
  filePath: string,
  kind: "cursor-mdc" | "managed-md" | "dedicated-md"
): "installed" | "updated" | "skipped" {
  const existed = existsSync(filePath);
  mkdirSync(dirname(filePath), { recursive: true });

  if (kind === "cursor-mdc") {
    if (existed && readFileSync(filePath, "utf8") === CURSOR_RULE_MDC_CONTENT) {
      return "skipped";
    }
    writeFileSync(filePath, CURSOR_RULE_MDC_CONTENT, "utf8");
    return existed ? "updated" : "installed";
  }

  if (kind === "dedicated-md") {
    const content = `${MANAGED_INSTRUCTION_BLOCK}\n`;
    if (existed && readFileSync(filePath, "utf8") === content) {
      return "skipped";
    }
    writeFileSync(filePath, content, "utf8");
    return existed ? "updated" : "installed";
  }

  if (!existed) {
    writeFileSync(filePath, `${MANAGED_INSTRUCTION_BLOCK}\n`, "utf8");
    return "installed";
  }

  const current = readFileSync(filePath, "utf8");
  const beginIdx = current.indexOf(GRAPHFLOW_BLOCK_BEGIN);
  const endIdx = current.indexOf(GRAPHFLOW_BLOCK_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const next =
      current.slice(0, beginIdx) +
      MANAGED_INSTRUCTION_BLOCK +
      current.slice(endIdx + GRAPHFLOW_BLOCK_END.length);
    if (next === current) return "skipped";
    writeFileSync(filePath, next, "utf8");
    return "updated";
  }

  const appended = `${current.trimEnd()}\n\n${MANAGED_INSTRUCTION_BLOCK}\n`;
  writeFileSync(filePath, appended, "utf8");
  return "updated";
}

function removeManagedFile(
  filePath: string,
  kind: "cursor-mdc" | "managed-md" | "dedicated-md"
): boolean {
  if (!existsSync(filePath)) return false;
  if (kind === "cursor-mdc" || kind === "dedicated-md") {
    rmSync(filePath, { force: true });
    return true;
  }
  const current = readFileSync(filePath, "utf8");
  const beginIdx = current.indexOf(GRAPHFLOW_BLOCK_BEGIN);
  const endIdx = current.indexOf(GRAPHFLOW_BLOCK_END);
  if (beginIdx < 0 || endIdx <= beginIdx) return false;
  const stripped = (
    current.slice(0, beginIdx).trimEnd() +
    "\n" +
    current.slice(endIdx + GRAPHFLOW_BLOCK_END.length).trimStart()
  ).trim();
  if (!stripped) {
    rmSync(filePath, { force: true });
  } else {
    writeFileSync(filePath, `${stripped}\n`, "utf8");
  }
  return true;
}

/* ---------------------- DSH Cordis patch management ---------------------- */

function normalizeCordisPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function yamlDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Plain YAML scalar for simple tokens (npx, node, graphflow); quote otherwise. */
function yamlPlainOrSingleQuoted(value: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) ? value : yamlSingleQuoted(value);
}

/**
 * Launcher recorded in the DSH Cordis insert. This mirrors the known-working
 * legacy patch (`npx -y --package=@roarpeng/graphflow graphflow-mcp`) and is
 * kept fixed so the generated block stays deterministic across machines; the
 * legacy `mcp.json` copy above still uses the global-aware launcher.
 */
const DSH_CORDIS_LAUNCHER: { command: string; args: string[] } = {
  command: "npx",
  args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
};

/**
 * The managed DSH Cordis insert. `cwd` is pinned to the workspace root so the
 * MCP server resolves relative `gf_*` targets inside the project instead of the
 * DSH profile directory. It replaces the legacy `cwd: !!js process.cwd()`
 * variant (which only worked when DSH itself happened to start in the project).
 */
function buildDshCordisBlock(serverName: string, opts: InstallAllAgentsOptions): string {
  const workspace = normalizeCordisPath(opts.workspaceRoot ?? process.cwd());
  const args = DSH_CORDIS_LAUNCHER.args.map((arg) => yamlSingleQuoted(arg)).join(", ");
  return [
    GRAPHFLOW_DSH_BEGIN,
    "- insert:",
    `    - id: ${yamlPlainOrSingleQuoted(`mcp-${serverName}`)}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    `        serverName: ${yamlPlainOrSingleQuoted(serverName)}`,
    "        transport: stdio",
    `        command: ${yamlPlainOrSingleQuoted(DSH_CORDIS_LAUNCHER.command)}`,
    `        args: [${args}]`,
    `        cwd: ${yamlDoubleQuoted(workspace)}`,
    `        env: { GRAPHFLOW_WORKSPACE_ROOT: ${yamlDoubleQuoted(workspace)}, GRAPHFLOW_MCP_STDIO: '1', GRAPHFLOW_LOG_JSON: '1' }`,
    "        failOnStartupError: false",
    GRAPHFLOW_DSH_END,
  ].join("\n");
}

/** Locate every graphflow-owned marker span (unterminated begin markers clamp to EOF). */
function findCordisMarkerSpans(raw: string): Array<{ begin: number; end: number }> {
  const spans: Array<{ begin: number; end: number }> = [];
  let cursor = 0;
  for (;;) {
    const begin = raw.indexOf(GRAPHFLOW_DSH_BEGIN, cursor);
    if (begin < 0) break;
    const endStart = raw.indexOf(GRAPHFLOW_DSH_END, begin + GRAPHFLOW_DSH_BEGIN.length);
    const end = endStart < 0 ? raw.length : endStart + GRAPHFLOW_DSH_END.length;
    spans.push({ begin, end });
    cursor = end;
  }
  return spans;
}

/** Parameterized variant of findCordisMarkerSpans for other managed blocks. */
function findManagedMarkerSpans(
  raw: string,
  beginMarker: string,
  endMarker: string
): Array<{ begin: number; end: number }> {
  const spans: Array<{ begin: number; end: number }> = [];
  let cursor = 0;
  for (;;) {
    const begin = raw.indexOf(beginMarker, cursor);
    if (begin < 0) break;
    const endStart = raw.indexOf(endMarker, begin + beginMarker.length);
    const end = endStart < 0 ? raw.length : endStart + endMarker.length;
    spans.push({ begin, end });
    cursor = end;
  }
  return spans;
}

/**
 * Idempotently write the managed Cordis insert:
 * - existing marker block(s): replace the first, drop duplicates, keep the rest
 *   of the patch byte-for-byte;
 * - empty file / exact `[]`: write just the block;
 * - anything else: append a new block, preserving existing patches.
 */
function writeDshCordisPatch(
  filePath: string,
  serverName: string,
  opts: InstallAllAgentsOptions
): "installed" | "updated" {
  const existed = existsSync(filePath);
  const current = existed ? readFileSync(filePath, "utf8") : "";
  const block = buildDshCordisBlock(serverName, opts);
  const spans = findCordisMarkerSpans(current);
  let next: string;

  if (spans.length > 0) {
    let rebuilt = "";
    let cursor = 0;
    spans.forEach((span, index) => {
      rebuilt += current.slice(cursor, span.begin);
      if (index === 0) rebuilt += block;
      cursor = span.end;
    });
    next = rebuilt + current.slice(cursor);
  } else {
    // `[]` (possibly padded / followed by comments) is the canonical "empty
    // patch" placeholder; replace it instead of appending a second YAML root.
    const withoutFlowSeq = current.replace(/^\s*\[[ \t]*\]/, "");
    const hadEmptyFlowSeq = withoutFlowSeq !== current;
    const remainder = hadEmptyFlowSeq ? withoutFlowSeq.replace(/^[ \t]*\r?\n/, "") : "";
    if (current.trim() === "") {
      next = block;
    } else if (hadEmptyFlowSeq) {
      next = remainder.trim() ? `${block}\n${remainder.replace(/^\s+/, "")}` : block;
    } else {
      next = `${current.trimEnd()}\n${block}`;
    }
  }

  next = `${next.trimEnd()}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  if (!existed || next !== current) {
    writeFileSync(filePath, next, "utf8");
  }
  return existed ? "updated" : "installed";
}

/** Remove every graphflow-owned Cordis block, keeping unrelated patches valid. */
function removeDshCordisPatch(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const current = readFileSync(filePath, "utf8");
  const spans = findCordisMarkerSpans(current);
  if (spans.length === 0) return false;
  let rebuilt = "";
  let cursor = 0;
  for (const span of spans) {
    rebuilt += current.slice(cursor, span.begin);
    cursor = span.end;
  }
  rebuilt += current.slice(cursor);
  const cleaned = rebuilt
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
  // Keep a valid top-level YAML array even when the managed block was the only
  // entry; an empty file parses as `null` and Cordis expects a patch list.
  writeFileSync(filePath, cleaned ? `${cleaned}\n` : "[]\n", "utf8");
  return true;
}

export const GRAPHFLOW_DSH_HOOK_BEGIN = "# GRAPHFLOW-DSH-HOOK-BEGIN";
export const GRAPHFLOW_DSH_HOOK_END = "# GRAPHFLOW-DSH-HOOK-END";

/**
 * Bundled prompt-reflex asset sources (assets/reflex/*). Kept as real files
 * so they stay lintable and byte-identical to the verified upstream sources
 * instead of escaping through a template literal.
 */
const reflexAssetFiles: Record<ReflexAssetType, string> = {
  "opencode-kilo-plugin": "graphflow-prompt-reflex.opencode-kilo.ts",
  "cline-hook": "UserPromptSubmit.cline.js",
  "dsh-plugin": "graphflow-prompt-reflex.dsh.mjs",
};

const reflexAssetsDir = join(__dirname, "..", "assets", "reflex");

function reflexAssetContent(type: ReflexAssetType): string {
  return readFileSync(join(reflexAssetsDir, reflexAssetFiles[type]), "utf8");
}

/** Write/refresh one prompt-reflex asset file. Returns a status + optional note. */
function installReflexAsset(
  type: ReflexAssetType,
  targetPath: string
): { status: "installed" | "updated" | "skipped"; message?: string } {
  if (type === "cline-hook" && process.platform === "win32") {
    // Cline documents its shebang hook files as Unix-only.
    return { status: "skipped", message: "Cline hooks are not supported on Windows by Cline itself" };
  }
  const existed = existsSync(targetPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, reflexAssetContent(type), "utf8");
  if (type === "cline-hook") {
    try {
      chmodSync(targetPath, 0o755);
    } catch {
      // ignore — executable bit is irrelevant on some filesystems
    }
  }
  return { status: existed ? "updated" : "installed" };
}

/** Delete a graphflow-owned reflex asset file. Only removes OUR content. */
function removeReflexAsset(type: ReflexAssetType, targetPath: string): boolean {
  if (!existsSync(targetPath)) return false;
  const marker =
    type === "cline-hook" ? "GraphFlow Prompt Reflex adapter" : "graphflow-prompt-reflex";
  try {
    if (!readFileSync(targetPath, "utf8").includes(marker)) return false;
  } catch {
    return false;
  }
  rmSync(targetPath, { force: true });
  return true;
}

function buildDshHookPatchBlock(): string {
  return [
    `${GRAPHFLOW_DSH_HOOK_BEGIN} — GraphFlow prompt reflex (Tier-2). The plugin`,
    `# file lives beside this patch: relative './' names are anchored to this`,
    `# file's directory by dsh app-boot.`,
    `- insert:`,
    `    - id: graphflow-prompt-reflex`,
    `      name: './plugins/graphflow-prompt-reflex.mjs'`,
    `      config:`,
    `        bin: graphflow`,
    `        npxArgs: ['-y', '--package=@roarpeng/graphflow', 'graphflow']`,
    `        timeoutMs: 20000`,
    `        onMacro: rewrite`,
    GRAPHFLOW_DSH_HOOK_END,
  ].join("\n");
}

/** Managed-block writer for the dsh reflex plugin row (same span rules as MCP). */
function writeDshHookPatch(filePath: string): "installed" | "updated" {
  const existed = existsSync(filePath);
  const current = existed ? readFileSync(filePath, "utf8") : "";
  const block = buildDshHookPatchBlock();
  const spans = findManagedMarkerSpans(current, GRAPHFLOW_DSH_HOOK_BEGIN, GRAPHFLOW_DSH_HOOK_END);
  let next: string;
  if (spans.length > 0) {
    let rebuilt = "";
    let cursor = 0;
    spans.forEach((span, index) => {
      rebuilt += current.slice(cursor, span.begin);
      if (index === 0) rebuilt += block;
      cursor = span.end;
    });
    next = rebuilt + current.slice(cursor);
  } else if (current.trim() === "") {
    next = block;
  } else if (/^\s*\[[ \t]*]/.test(current)) {
    const remainder = current.replace(/^\s*\[[ \t]*]/, "").replace(/^[ \t]*\r?\n/, "");
    next = remainder.trim() ? `${block}\n${remainder.replace(/^\s+/, "")}` : block;
  } else {
    next = `${current.trimEnd()}\n${block}`;
  }
  next = `${next.trimEnd()}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  if (!existed || next !== current) {
    writeFileSync(filePath, next, "utf8");
  }
  return existed ? "updated" : "installed";
}

/** Remove only the reflex plugin row, leaving the MCP managed block intact. */
function removeDshHookPatch(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const current = readFileSync(filePath, "utf8");
  const spans = findManagedMarkerSpans(current, GRAPHFLOW_DSH_HOOK_BEGIN, GRAPHFLOW_DSH_HOOK_END);
  if (spans.length === 0) return false;
  let rebuilt = "";
  let cursor = 0;
  for (const span of spans) {
    rebuilt += current.slice(cursor, span.begin);
    cursor = span.end;
  }
  rebuilt += current.slice(cursor);
  const cleaned = rebuilt.replace(/[ \t]+\r?\n/g, "\n").replace(/\r?\n{3,}/g, "\n\n").trim();
  writeFileSync(filePath, cleaned ? `${cleaned}\n` : "[]\n", "utf8");
  return true;
}

const GRAPHFLOW_HOOK_COMMAND = "graphflow hook";

/** Hook phases GraphFlow registers in host configs (tool calls + prompt submit). */
type HookPhase = "pre" | "post" | "prompt";

/**
 * Per-kind event keys for every phase GraphFlow registers. A key is omitted
 * when the host has no surface for that phase — ZCode plus the Tier-1 hosts
 * (windsurf, trae, qoder, kimi-code, continue) only get the prompt phase:
 * ZCode/Windsurf have no tool-call hook surface and Trae/Qoder/Kimi/Continue
 * only the UserPromptSubmit-equivalent one is registered.
 */
function hookPhaseKeys(hookKind: HookKind): { pre?: string; post?: string; prompt?: string } {
  if (hookKind === "cursor") {
    return { pre: "preToolUse", post: "postToolUse", prompt: "beforeSubmitPrompt" };
  }
  if (hookKind === "gemini") {
    return { pre: "BeforeTool", post: "AfterTool", prompt: "BeforeAgent" };
  }
  if (hookKind === "zcode") {
    return { prompt: "UserPromptSubmit" };
  }
  // Windsurf (~/.codeium/windsurf/hooks.json): pre_user_prompt, flat entries.
  if (hookKind === "windsurf") {
    return { prompt: "pre_user_prompt" };
  }
  // Trae (~/.trae/hooks.json), Qoder (~/.qoder/settings.json), Kimi Code
  // (~/.kimi-code/config.toml) and Continue (~/.continue/settings.json) all
  // name the prompt event UserPromptSubmit (Claude-compatible).
  if (
    hookKind === "trae" ||
    hookKind === "qoder" ||
    hookKind === "kimi-code" ||
    hookKind === "continue"
  ) {
    return { prompt: "UserPromptSubmit" };
  }
  return { pre: "PreToolUse", post: "PostToolUse", prompt: "UserPromptSubmit" };
}

/** `[event key, phase]` pairs this kind actually registers, in write order. */
function hookPhaseEntries(hookKind: HookKind): Array<[string, HookPhase]> {
  const { pre, post, prompt } = hookPhaseKeys(hookKind);
  const entries: Array<[string, HookPhase]> = [];
  if (pre) entries.push([pre, "pre"]);
  if (post) entries.push([post, "post"]);
  if (prompt) entries.push([prompt, "prompt"]);
  return entries;
}

/**
 * Where one kind keeps its per-event hook arrays. Every kind but ZCode uses the
 * `hooks` object directly; ZCode nests them under `hooks.events.<Event>` and
 * requires the top-level `hooks.enabled` feature flag to be true.
 */
function zcodeHookEventsContainer(hooks: Record<string, unknown>): Record<string, unknown> {
  const rawEvents = hooks.events;
  const events =
    rawEvents && typeof rawEvents === "object" && !Array.isArray(rawEvents)
      ? (rawEvents as Record<string, unknown>)
      : {};
  hooks.events = events;
  return events;
}

function isGraphflowHookCommand(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().includes(GRAPHFLOW_HOOK_COMMAND);
}

/** A hook object is graphflow-owned when its command (or Gemini name) says so. */
function isGraphflowHookObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (isGraphflowHookCommand(record.command)) return true;
  const name = record.name;
  return (
    typeof name === "string" &&
    (name === "graphflow-pre" || name === "graphflow-post" || name === "graphflow-prompt")
  );
}

/**
 * Strip graphflow-owned hook entries from one phase array while preserving every
 * user entry/object:
 * - Claude/Codex/Gemini entries carry a nested `hooks` array; filter it
 *   hook-by-hook and drop the wrapper only when nothing user-owned remains;
 * - Cursor entries are flat `{ command, timeout }` objects, filtered directly;
 * - unknown/primitive entries are never touched.
 */
function sanitizeHostHookEntries(entries: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      kept.push(entry);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const nested = record.hooks;
    if (Array.isArray(nested)) {
      const filteredNested = nested.filter((hook) => !isGraphflowHookObject(hook));
      if (filteredNested.length === 0) continue;
      if (filteredNested.length !== nested.length) {
        kept.push({ ...record, hooks: filteredNested });
        continue;
      }
      kept.push(entry);
      continue;
    }
    if (isGraphflowHookObject(record)) continue;
    kept.push(entry);
  }
  return kept;
}

/**
 * Hook command per kind and phase. The prompt phase speaks three input
 * protocols: generic stdin JSON (claude/codex/zcode plus the Tier-1 hosts
 * windsurf/trae/qoder/kimi-code/continue), Gemini's BeforeAgent payload, and
 * Cursor's beforeSubmitPrompt payload.
 */
function buildGraphflowHookCommand(hookKind: HookKind, phase: HookPhase): string {
  if (phase === "prompt") {
    if (hookKind === "gemini") return `${GRAPHFLOW_HOOK_COMMAND} user-prompt --protocol gemini`;
    if (hookKind === "cursor") return `${GRAPHFLOW_HOOK_COMMAND} user-prompt --protocol cursor`;
    return `${GRAPHFLOW_HOOK_COMMAND} user-prompt`;
  }
  return `${GRAPHFLOW_HOOK_COMMAND} ${phase}-tool`;
}

function buildGraphflowHookEntry(
  hookKind: HookKind,
  phase: HookPhase
): Record<string, unknown> {
  const command = buildGraphflowHookCommand(hookKind, phase);
  if (phase === "prompt") {
    // UserPromptSubmit-level events match no tool, so no matcher field.
    if (hookKind === "cursor") return { command, timeout: 15 };
    if (hookKind === "gemini") {
      return {
        matcher: ".*",
        hooks: [{ name: "graphflow-prompt", type: "command", command, timeout: 60000 }],
      };
    }
    if (hookKind === "zcode") {
      return { hooks: [{ type: "command", command, timeoutMs: 60000 }] };
    }
    // Windsurf hooks.json entries are flat { command } objects: the documented
    // schema has no matcher / nested hooks / type / timeout fields at all.
    if (hookKind === "windsurf") return { command };
    // claude / codex / trae / qoder / continue: Claude-like nested entries;
    // timeout is in seconds on every one of these hosts.
    return { hooks: [{ type: "command", command, timeout: 60 }] };
  }
  if (hookKind === "cursor") return { command, timeout: 15 };
  if (hookKind === "gemini") {
    return {
      matcher: ".*",
      hooks: [{ name: `graphflow-${phase}`, type: "command", command }],
    };
  }
  return {
    matcher: ".*",
    hooks: [{ type: "command", command, timeout: 15 }],
  };
}

/* -------- Kimi Code TOML hooks (`~/.kimi-code/config.toml` [[hooks]]) -------- */

/**
 * Kimi Code reads hooks from `~/.kimi-code/config.toml` as `[[hooks]]` array
 * tables whose ONLY legal fields are event/matcher/command/timeout (timeout in
 * seconds, 1-600; any extra field breaks config loading). This package has no
 * TOML parser, so — exactly like the Codex `config.toml` MCP path — the managed
 * table is maintained with a span-based read-modify-write that preserves every
 * user byte outside graphflow-owned tables.
 */
interface KimiHookSpan {
  begin: number;
  end: number;
  text: string;
  event: string;
  command: string;
}

/** One `[[hooks]]` table per span: header line through just before the next `[` table header (or EOF). */
function findKimiHookSpans(raw: string): KimiHookSpan[] {
  const spans: KimiHookSpan[] = [];
  const headerRe = /^[ \t]*\[\[hooks\]\][ \t]*\r?$/gm;
  const headers: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw)) !== null) headers.push(match.index);
  for (const begin of headers) {
    const tableRe = /^[ \t]*\[/gm;
    let end = raw.length;
    let next: RegExpExecArray | null;
    while ((next = tableRe.exec(raw)) !== null) {
      if (next.index > begin) {
        end = next.index;
        break;
      }
    }
    const text = raw.slice(begin, end);
    const event = text.match(/^[ \t]*event[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m)?.[1] ?? "";
    const command = text.match(/^[ \t]*command[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m)?.[1] ?? "";
    spans.push({ begin, end, text, event, command });
  }
  return spans;
}

/** Splice the given spans out of `raw`, keeping everything between them byte-for-byte. */
function dropTomlSpans(raw: string, spans: Array<{ begin: number; end: number }>): string {
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.begin < cursor) continue; // overlapping spans: the first one wins
    out += raw.slice(cursor, span.begin);
    cursor = span.end;
  }
  return out + raw.slice(cursor);
}

/** Canonical managed Kimi [[hooks]] table (JSON-string escaping is TOML basic-string compatible). */
function buildKimiHookBlock(event: string, command: string): string {
  return [
    "[[hooks]]",
    `event = ${JSON.stringify(event)}`,
    `command = ${JSON.stringify(command)}`,
    "timeout = 60",
  ].join("\n");
}

function installKimiHostHook(configPath: string): "installed" | "updated" {
  const existed = existsSync(configPath);
  const original = existed ? readFileSync(configPath, "utf8") : "";
  let next = original;
  for (const [event, phase] of hookPhaseEntries("kimi-code")) {
    const block = buildKimiHookBlock(event, buildGraphflowHookCommand("kimi-code", phase));
    const owned = findKimiHookSpans(next).filter((span) =>
      isGraphflowHookCommand(span.command)
    );
    // Idempotent: the exact managed table is already the only graphflow-owned
    // [[hooks]] entry — leave the file byte-for-byte as-is.
    if (owned.length === 1 && owned[0]!.text.trim() === block) continue;
    // Otherwise refresh in place: strip every graphflow-owned table, append the
    // canonical one (separated by one blank line).
    const stripped =
      owned.length > 0 ? dropTomlSpans(next, owned).replace(/\r?\n{3,}/g, "\n\n") : next;
    next = stripped.trim() ? `${stripped.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  if (!existed || next !== original) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, next, "utf8");
  }
  return existed ? "updated" : "installed";
}

function removeKimiHostHook(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  const current = readFileSync(configPath, "utf8");
  const owned = findKimiHookSpans(current).filter((span) =>
    isGraphflowHookCommand(span.command)
  );
  if (owned.length === 0) return false;
  const cleaned = dropTomlSpans(current, owned)
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
  writeFileSync(configPath, cleaned ? `${cleaned}\n` : "", "utf8");
  return true;
}

function hasKimiGraphflowHook(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    return findKimiHookSpans(readFileSync(configPath, "utf8")).some((span) =>
      isGraphflowHookCommand(span.command)
    );
  } catch {
    return false;
  }
}

/**
 * Merge the GraphFlow PreToolUse/PostToolUse/UserPromptSubmit hooks into a host
 * hook config instead of replacing the user's hook arrays. Existing graphflow-owned
 * entries are refreshed in place (idempotent reinstall); every user hook is preserved.
 *
 * ZCode is the odd one out: its config-file hooks live under
 * `hooks.events.<Event>` (never top-level `hooks.<Event>`) and require the
 * top-level `hooks.enabled` flag, which install turns on.
 *
 * Kimi Code is the other odd one out: its hooks live in TOML `[[hooks]]`
 * tables (see installKimiHostHook), not in JSON.
 */
export function installHostHook(hookKind: HookKind, configPath: string): "installed" | "updated" {
  if (hookKind === "kimi-code") return installKimiHostHook(configPath);
  const existed = existsSync(configPath);
  const obj = readJsonForUpdate(configPath);
  const rawHooks = obj.hooks;
  const hooks: Record<string, unknown> =
    rawHooks && typeof rawHooks === "object" && !Array.isArray(rawHooks)
      ? { ...(rawHooks as Record<string, unknown>) }
      : {};

  let container: Record<string, unknown> = hooks;
  if (hookKind === "zcode") {
    hooks.enabled = true;
    container = zcodeHookEventsContainer(hooks);
  }

  for (const [key, phase] of hookPhaseEntries(hookKind)) {
    const existing = Array.isArray(container[key]) ? (container[key] as unknown[]) : [];
    container[key] = [...sanitizeHostHookEntries(existing), buildGraphflowHookEntry(hookKind, phase)];
  }

  if (hookKind === "cursor") obj.version = obj.version ?? 1;
  obj.hooks = hooks;
  writeJsonSafe(configPath, obj);
  return existed ? "updated" : "installed";
}

/**
 * Remove only graphflow-owned hooks (tool and prompt phases) from a host hook
 * config. User hooks (and any unrelated phases/keys) are preserved, the file is
 * kept and stays valid JSON. For ZCode an emptied `hooks.events` table is
 * deleted but the user-visible `hooks.enabled` flag is left in place — it is
 * harmless without entries. Returns true when at least one graphflow hook
 * entry was removed.
 */
export function removeHostHook(hookKind: HookKind, configPath: string): boolean {
  if (hookKind === "kimi-code") return removeKimiHostHook(configPath);
  if (!existsSync(configPath)) return false;
  const obj = readJsonForUpdate(configPath);
  const rawHooks = obj.hooks;
  if (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks)) return false;
  const hooks = { ...(rawHooks as Record<string, unknown>) };
  const rawContainer: unknown = hookKind === "zcode" ? hooks.events : hooks;
  if (!rawContainer || typeof rawContainer !== "object" || Array.isArray(rawContainer)) {
    return false;
  }
  const container = rawContainer as Record<string, unknown>;
  let removed = false;

  for (const [key] of hookPhaseEntries(hookKind)) {
    const entries = container[key];
    if (!Array.isArray(entries)) continue;
    const filtered = sanitizeHostHookEntries(entries as unknown[]);
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
      if (filtered.length === 0) delete container[key];
      else container[key] = filtered;
      removed = true;
    }
  }

  if (!removed) return false;
  if (hookKind === "zcode") {
    if (Object.keys(container).length === 0) delete hooks.events;
    obj.hooks = hooks;
  } else {
    if (Object.keys(hooks).length === 0) delete obj.hooks;
    else obj.hooks = hooks;
  }
  writeJsonSafe(configPath, obj);
  return true;
}

/** True when at least one graphflow-owned hook is registered for this host. */
function hasGraphflowHook(hookKind: HookKind, configPath: string): boolean {
  if (hookKind === "kimi-code") return hasKimiGraphflowHook(configPath);
  if (!existsSync(configPath)) return false;
  const obj = readJsonSafe(configPath);
  const rawHooks = obj.hooks;
  if (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks)) return false;
  const hooks = rawHooks as Record<string, unknown>;
  const rawContainer: unknown = hookKind === "zcode" ? hooks.events : hooks;
  if (!rawContainer || typeof rawContainer !== "object" || Array.isArray(rawContainer)) {
    return false;
  }
  const container = rawContainer as Record<string, unknown>;
  for (const [key] of hookPhaseEntries(hookKind)) {
    const entries = container[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as unknown[]) {
      if (isGraphflowHookObject(entry)) return true;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const nested = (entry as Record<string, unknown>).hooks;
      if (Array.isArray(nested) && nested.some((hook) => isGraphflowHookObject(hook))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Legacy cleanup support: entries that reference a GraphFlow launcher under a
 * different server key (renamed by older installers), stale launcher commands
 * (old global dist paths, node.exe + npx-cli.js shims), and registrations left
 * behind for agents that are no longer installed. Only graphflow-owned
 * keys/blocks are ever removed — third-party entries are never deleted.
 */

/** True when a config value visibly points at a GraphFlow launcher. */
function isGraphflowLauncherValue(value: unknown): boolean {
  try {
    return JSON.stringify(value).toLowerCase().includes("graphflow");
  } catch {
    return false;
  }
}

/** GraphFlow-looking server keys other than the canonical one. No file writes. */
function findLegacyMcpKeys(target: AgentMcpTarget, serverName: string): string[] {
  if (!existsSync(target.configPath)) return [];
  const format = target.configFormat ?? "json";

  if (format === "codex-toml") {
    const current = readFileSync(target.configPath, "utf8");
    const out: string[] = [];
    const sectionRegex = /\[mcp_servers\.([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = sectionRegex.exec(current)) !== null) {
      const name = match[1] ?? "";
      if (!name || name === serverName) continue;
      const blockRegex = new RegExp(
        `\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\$&")}\\][\\s\\S]*?(?=\\n\\[|$)`,
        "m"
      );
      const block = current.match(blockRegex)?.[0] ?? "";
      if (block.toLowerCase().includes("graphflow")) out.push(name);
    }
    return out;
  }

  const obj = readJsonSafe(target.configPath);
  const serversOf = (holder: unknown): Record<string, unknown> =>
    holder && typeof holder === "object" ? (holder as Record<string, unknown>) : {};
  let servers: Record<string, unknown> = {};
  if (format === "opencode") {
    servers = serversOf(obj.mcp);
  } else if (format === "zcode") {
    const mcp = serversOf(obj.mcp);
    servers = serversOf(mcp.servers);
  } else {
    servers = serversOf(obj[target.serversKey]);
  }
  return Object.keys(servers).filter(
    (key) => key !== serverName && isGraphflowLauncherValue(servers[key])
  );
}

function removeMcpKey(target: AgentMcpTarget, key: string): boolean {
  if (!existsSync(target.configPath)) return false;
  const format = target.configFormat ?? "json";

  if (format === "codex-toml") {
    const current = readFileSync(target.configPath, "utf8");
    const sectionRegex = new RegExp(
      `\\n?\\[mcp_servers\\.${key.replace(/[.*+?^${}()|[\]\\]/g, "\$&")}\\][\\s\\S]*?(?=\\n\\[|$)`,
      "m"
    );
    if (!sectionRegex.test(current)) return false;
    const next = current.replace(sectionRegex, "").trim();
    writeFileSync(target.configPath, next ? `${next}\n` : "", "utf8");
    return true;
  }

  const obj = readJsonForUpdate(target.configPath);
  if (format === "opencode") {
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    if (!mcp || !(key in mcp)) return false;
    delete mcp[key];
    pruneEmptyObjectKey(obj, "mcp");
    writeJsonSafe(target.configPath, obj);
    return true;
  }
  if (format === "zcode") {
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    const servers = mcp?.servers as Record<string, unknown> | undefined;
    if (!servers || !(key in servers)) return false;
    delete servers[key];
    if (mcp) pruneEmptyObjectKey(mcp, "servers");
    pruneEmptyObjectKey(obj, "mcp");
    writeJsonSafe(target.configPath, obj);
    return true;
  }

  const servers = obj[target.serversKey] as Record<string, unknown> | undefined;
  if (!servers || !(key in servers)) return false;
  delete servers[key];
  pruneEmptyObjectKey(obj, target.serversKey);
  writeJsonSafe(target.configPath, obj);
  return true;
}

/**
 * Delete legacy GraphFlow registrations across every profile in scope:
 * alias server keys in all existing configs, plus the full GraphFlow
 * footprint (MCP key, skill dir, managed rule blocks, graphflow-owned host
 * hooks) for agents that are no longer installed.
 */
export function pruneLegacyRegistrations(
  opts: InstallAllAgentsOptions = {}
): AgentInstallItemResult[] {
  const serverName = opts.serverName ?? "graphflow";
  const profiles = buildAgentProfiles(opts);
  const detectedIds = new Set(detectInstalledAgents(opts).map((d) => d.id));
  const filterSet = opts.agentIds?.length ? new Set(opts.agentIds) : undefined;
  const results: AgentInstallItemResult[] = [];

  for (const profile of profiles) {
    if (filterSet && !filterSet.has(profile.id)) continue;
    const pushRemoved = (
      category: AgentInstallItemResult["category"],
      targetPath: string,
      message: string
    ): void => {
      results.push({
        agentId: profile.id,
        agentName: profile.name,
        category,
        targetPath,
        status: "removed",
        message,
      });
    };

    const pushError = (
      category: AgentInstallItemResult["category"],
      targetPath: string,
      err: unknown
    ): void => {
      results.push({
        agentId: profile.id,
        agentName: profile.name,
        category,
        targetPath,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    };

    // 1. Alias server keys in every existing config (detected or not).
    for (const target of profile.mcpTargets) {
      for (const alias of findLegacyMcpKeys(target, serverName)) {
        try {
          if (removeMcpKey(target, alias)) {
            pushRemoved("mcp", target.configPath, `legacy MCP alias "${alias}" removed`);
          }
        } catch (err) {
          pushError("mcp", target.configPath, err);
          break; // the same file will fail for every remaining alias
        }
      }
    }

    if (detectedIds.has(profile.id)) continue;

    // 2. Full footprint removal for agents that are no longer installed.
    for (const target of profile.mcpTargets) {
      try {
        if (removeMcpTarget(target, serverName)) {
          pushRemoved("mcp", target.configPath, "stale graphflow MCP entry removed (agent not installed)");
        }
      } catch (err) {
        pushError("mcp", target.configPath, err);
      }
    }
    // DSH Cordis patches are graphflow-owned blocks: drop them when DSH is no
    // longer installed, and let the install pass replace them when it is.
    if (profile.cordisPatchPath && removeDshCordisPatch(profile.cordisPatchPath)) {
      pushRemoved(
        "mcp",
        profile.cordisPatchPath,
        "stale graphflow Cordis patch removed (agent not installed)"
      );
    }
    for (const skillsDir of profile.skillsDirs ?? []) {
      const skillDir = join(skillsDir, "graphflow");
      if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true, force: true });
        pushRemoved("skill", join(skillDir, "SKILL.md"), "stale graphflow skill removed (agent not installed)");
      }
    }
    for (const rule of profile.rulesFiles ?? []) {
      if (removeManagedFile(rule.filePath, rule.kind)) {
        pushRemoved("rule", rule.filePath, "stale graphflow rule block removed (agent not installed)");
      }
    }
    if (profile.hookKind && profile.hookConfigPath) {
      try {
        if (removeHostHook(profile.hookKind, profile.hookConfigPath)) {
          pushRemoved(
            "hook",
            profile.hookConfigPath,
            "stale graphflow hooks removed (agent not installed)"
          );
        }
      } catch (err) {
        pushError("hook", profile.hookConfigPath, err);
      }
    }
  }

  return results;
}

export function installAllAgents(opts: InstallAllAgentsOptions = {}): InstallAllAgentsReport {
  const serverName = opts.serverName ?? "graphflow";
  const profiles = buildAgentProfiles(opts);
  const detected = detectInstalledAgents(opts);
  const detectedIds = new Set(detected.map((d) => d.id));
  const launcher = resolveMcpLauncherCommand();
  const results: AgentInstallItemResult[] = [];

  // Legacy cleanup first (default on): alias keys everywhere, plus the full
  // footprint for agents that are no longer installed. The register loop
  // below then overwrites any stale canonical entries for detected agents.
  if (opts.pruneLegacy !== false) {
    results.push(...pruneLegacyRegistrations(opts));
  }

  for (const profile of profiles) {
    if (!detectedIds.has(profile.id)) continue;

    // 1. Register MCP Server
    for (const target of profile.mcpTargets) {
      try {
        const status = writeMcpTarget(target, serverName, launcher);
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "mcp",
          targetPath: target.configPath,
          status,
        });
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "mcp",
          targetPath: target.configPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (opts.includeWorkspace && opts.workspaceRoot && profile.workspaceMcpTargets) {
      for (const wsTarget of profile.workspaceMcpTargets) {
        const fullPath = join(opts.workspaceRoot, wsTarget.relativePath);
        try {
          const status = writeMcpTarget(
            {
              configPath: fullPath,
              serversKey: wsTarget.serversKey,
              ...(wsTarget.configFormat ? { configFormat: wsTarget.configFormat } : {}),
            },
            serverName,
            launcher
          );
          results.push({
            agentId: profile.id,
            agentName: `${profile.name} (workspace)`,
            category: "mcp",
            targetPath: fullPath,
            status,
          });
        } catch (err) {
          results.push({
            agentId: profile.id,
            agentName: `${profile.name} (workspace)`,
            category: "mcp",
            targetPath: fullPath,
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 1b. DSH: register MCP via the profile's Cordis patch file (the path DSH
    // actually reads; `mcp.json` above is only kept as a harmless legacy copy).
    if (profile.cordisPatchPath) {
      try {
        const status = writeDshCordisPatch(
          profile.cordisPatchPath,
          serverName,
          opts
        );
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "mcp",
          targetPath: profile.cordisPatchPath,
          status,
        });
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "mcp",
          targetPath: profile.cordisPatchPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Register SKILL.md
    for (const skillsDir of profile.skillsDirs ?? []) {
      const skillFile = join(skillsDir, "graphflow", "SKILL.md");
      try {
        const existed = existsSync(skillFile);
        mkdirSync(dirname(skillFile), { recursive: true });
        writeFileSync(skillFile, getSkillMdContent(), "utf8");
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "skill",
          targetPath: skillFile,
          status: existed ? "updated" : "installed",
        });
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "skill",
          targetPath: skillFile,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Register Rules & Instruction Blocks
    for (const rule of profile.rulesFiles ?? []) {
      try {
        const status = writeManagedFile(rule.filePath, rule.kind);
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "rule",
          targetPath: rule.filePath,
          status,
        });
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "rule",
          targetPath: rule.filePath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. Register Host Hooks (PreToolUse / PostToolUse / UserPromptSubmit)
    if (profile.hookKind && profile.hookConfigPath) {
      try {
        const status = installHostHook(profile.hookKind, profile.hookConfigPath);
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: profile.hookConfigPath,
          status,
        });
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: profile.hookConfigPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Prompt-Reflex plugin assets (Tier-2 hosts: OpenCode/Kilo/Cline/DSH).
    for (const asset of profile.reflexAssets ?? []) {
      try {
        const { status, message } = installReflexAsset(asset.type, asset.targetPath);
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: asset.targetPath,
          status,
          ...(message ? { message } : {}),
        });
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: asset.targetPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5b. DSH: the Cordis patch row that loads the reflex plugin.
    if (profile.cordisPatchPath && (profile.reflexAssets ?? []).some((a) => a.type === "dsh-plugin")) {
      try {
        const status = writeDshHookPatch(profile.cordisPatchPath);
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: profile.cordisPatchPath,
          status,
        });
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: profile.cordisPatchPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { detectedAgents: detected, results };
}

/**
 * Remove GraphFlow registrations. Scope is deliberately narrow by default:
 *   1. `agentIds` (if non-empty) -> only those profiles;
 *   2. `all: true`               -> every profile (explicit `--all`);
 *   3. otherwise                 -> only agents detected on this machine.
 * This prevents an uninstall from wiping registrations for editors the user
 * does not even have installed.
 */
export function uninstallAllAgents(opts: UninstallAllAgentsOptions = {}): AgentInstallItemResult[] {
  const serverName = opts.serverName ?? "graphflow";
  const profiles = buildAgentProfiles(opts);
  const results: AgentInstallItemResult[] = [];
  const scopedIds = opts.agentIds?.length
    ? new Set(opts.agentIds)
    : opts.all
      ? undefined
      : new Set(detectInstalledAgents(opts).map((detected) => detected.id));

  for (const profile of profiles) {
    if (scopedIds && !scopedIds.has(profile.id)) continue;

    for (const target of profile.mcpTargets) {
      try {
        const removed = removeMcpTarget(target, serverName);
        if (removed) {
          results.push({
            agentId: profile.id,
            agentName: profile.name,
            category: "mcp",
            targetPath: target.configPath,
            status: "removed",
          });
        }
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "mcp",
          targetPath: target.configPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // DSH reads the Cordis patch, not mcp.json: remove the managed block too.
    if (profile.cordisPatchPath && removeDshCordisPatch(profile.cordisPatchPath)) {
      results.push({
        agentId: profile.id,
        agentName: profile.name,
        category: "mcp",
        targetPath: profile.cordisPatchPath,
        status: "removed",
      });
    }

    for (const skillsDir of profile.skillsDirs ?? []) {
      const skillDir = join(skillsDir, "graphflow");
      if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true, force: true });
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "skill",
          targetPath: join(skillDir, "SKILL.md"),
          status: "removed",
        });
      }
    }

    for (const rule of profile.rulesFiles ?? []) {
      const removed = removeManagedFile(rule.filePath, rule.kind);
      if (removed) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "rule",
          targetPath: rule.filePath,
          status: "removed",
        });
      }
    }

    // 4. Remove GraphFlow host hooks, preserving the host's user hooks.
    if (profile.hookKind && profile.hookConfigPath) {
      try {
        if (removeHostHook(profile.hookKind, profile.hookConfigPath)) {
          results.push({
            agentId: profile.id,
            agentName: profile.name,
            category: "hook",
            targetPath: profile.hookConfigPath,
            status: "removed",
          });
        }
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: profile.hookConfigPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. Remove prompt-reflex plugin assets (Tier-2 hosts) and, for DSH, the
    // managed patch row that loads the reflex plugin (MCP block untouched).
    for (const asset of profile.reflexAssets ?? []) {
      try {
        if (removeReflexAsset(asset.type, asset.targetPath)) {
          results.push({
            agentId: profile.id,
            agentName: profile.name,
            category: "hook",
            targetPath: asset.targetPath,
            status: "removed",
          });
        }
      } catch (err) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: asset.targetPath,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (profile.cordisPatchPath && (profile.reflexAssets ?? []).some((a) => a.type === "dsh-plugin")) {
      if (removeDshHookPatch(profile.cordisPatchPath)) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          category: "hook",
          targetPath: profile.cordisPatchPath,
          status: "removed",
        });
      }
    }
  }

  return results;
}

/* ------------------- Registration status (`graphflow status`) ------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\$&");
}

/** Whether one MCP config target contains the canonical GraphFlow server entry. */
function mcpTargetHasServer(target: AgentMcpTarget, serverName: string): boolean {
  if (!existsSync(target.configPath)) return false;
  const format = target.configFormat ?? "json";
  if (format === "codex-toml") {
    const current = readFileSync(target.configPath, "utf8");
    return new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]\\s*$`, "m").test(current);
  }
  const obj = readJsonSafe(target.configPath);
  if (format === "opencode") {
    const servers = asRecord(obj.mcp);
    return !!servers && serverName in servers;
  }
  if (format === "zcode") {
    const servers = asRecord(asRecord(obj.mcp)?.servers);
    return !!servers && serverName in servers;
  }
  const servers = asRecord(obj[target.serversKey]);
  return !!servers && serverName in servers;
}

/** DSH registration is real only when the managed Cordis patch block is present. */
function dshCordisRegistered(cordisPatchPath: string): boolean {
  if (!existsSync(cordisPatchPath)) return false;
  try {
    return findCordisMarkerSpans(readFileSync(cordisPatchPath, "utf8")).length > 0;
  } catch {
    return false;
  }
}

function managedRuleRegistered(
  rule: NonNullable<AgentProfile["rulesFiles"]>[number]
): boolean {
  if (!existsSync(rule.filePath)) return false;
  if (rule.kind === "managed-md") {
    try {
      return readFileSync(rule.filePath, "utf8").includes(GRAPHFLOW_BLOCK_BEGIN);
    } catch {
      return false;
    }
  }
  // cursor-mdc / dedicated-md files are fully GraphFlow-owned.
  return true;
}

function buildRegistrationStatus(
  profile: AgentProfile,
  serverName: string
): AgentRegistrationStatus {
  const mcpPaths: string[] = [];
  for (const target of profile.mcpTargets) mcpPaths.push(target.configPath);

  let mcp: boolean;
  if (profile.cordisPatchPath) {
    mcpPaths.unshift(profile.cordisPatchPath);
    // DSH ignores mcp.json, so success means the Cordis patch block exists.
    mcp = dshCordisRegistered(profile.cordisPatchPath);
  } else {
    mcp = profile.mcpTargets.some((target) => mcpTargetHasServer(target, serverName));
  }

  const skillPaths = (profile.skillsDirs ?? []).map((dir) =>
    join(dir, "graphflow", "SKILL.md")
  );
  const rules = profile.rulesFiles ?? [];
  const hookPath =
    profile.hookKind && profile.hookConfigPath ? profile.hookConfigPath : undefined;

  return {
    id: profile.id,
    name: profile.name,
    mcp,
    skill: skillPaths.some((skillPath) => existsSync(skillPath)),
    rule: rules.length > 0 ? rules.some((rule) => managedRuleRegistered(rule)) : undefined,
    hook:
      profile.hookKind && profile.hookConfigPath
        ? hasGraphflowHook(profile.hookKind, profile.hookConfigPath)
        : undefined,
    paths: {
      mcp: mcpPaths,
      skill: skillPaths,
      rule: rules.map((rule) => rule.filePath),
      hook: hookPath,
    },
  };
}

/**
 * Report registration state for every agent in scope:
 * - default: detected agents only;
 * - `agentIds`: only the requested profiles;
 * - `all: true`: every known profile (useful to spot leftovers).
 */
export function getAgentRegistrationStatus(
  opts: UninstallAllAgentsOptions = {}
): AgentRegistrationStatus[] {
  const serverName = opts.serverName ?? "graphflow";
  const profiles = buildAgentProfiles(opts);
  const detectedIds = new Set(detectInstalledAgents(opts).map((agent) => agent.id));
  const filterSet = opts.agentIds?.length ? new Set(opts.agentIds) : undefined;
  const inScope = (id: string): boolean => {
    if (filterSet) return filterSet.has(id);
    if (opts.all) return true;
    return detectedIds.has(id);
  };
  return profiles
    .filter((profile) => inScope(profile.id))
    .map((profile) => buildRegistrationStatus(profile, serverName));
}
