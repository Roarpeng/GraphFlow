/**
 * GraphFlow 3.1 — Multi-Agent MCP, Skill, Rules & Hook Auto-Installer (`src/agent-installer.ts`)
 *
 * Zero-bloat, table-driven installer supporting 20+ mainstream AI coding agents:
 * Cursor, Claude Code, Claude Desktop, VS Code (GitHub Copilot), Windsurf,
 * Trae / Trae CN, Cline, Roo Code, Kilo Code, OpenAI Codex, Gemini CLI,
 * Antigravity, Kimi Code, DeepSeek Harness (DSH), Qoder / Qoder CN,
 * OpenCode, ZCode, Zed, Continue, PearAI, and Amazon Q.
 *
 * Capabilities:
 *  1. Auto-detects installed coding agents on macOS, Linux, Windows, and WSL.
 *  2. Registers GraphFlow MCP server across JSON (`mcpServers`, `servers`,
 *     `context_servers`), OpenCode (`mcp`), ZCode (`mcp.servers`), and Codex (`config.toml`).
 *  3. Installs `skills/graphflow/SKILL.md` into every detected skill-capable agent.
 *  4. Injects non-destructive `<!-- GRAPHFLOW:BEGIN -->` instruction blocks into
 *     `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `global_rules.md`, and `.cursor/rules/graphflow.mdc`.
 *  5. Registers `PreToolUse` / `PostToolUse` host hooks for Claude Code, Cursor, Gemini, and Codex.
 *  6. Cleanly uninstalls all GraphFlow MCP entries, Skills, Rules, and Hooks on `graphflow uninstall`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type McpServersKey = "mcpServers" | "servers" | "context_servers" | "mcp";
export type McpConfigFormat = "json" | "codex-toml" | "opencode" | "zcode";

export interface AgentMcpTarget {
  configPath: string;
  serversKey: McpServersKey;
  configFormat?: McpConfigFormat;
}

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
    kind: "cursor-mdc" | "managed-md" | " dedicated-md";
  }>;
  hookKind?: "claude" | "cursor" | "gemini" | "codex";
  hookConfigPath?: string;
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
  workspaceRoot?: string;
  includeWorkspace?: boolean;
  agentIds?: string[];
  serverName?: string;
}

export interface InstallAllAgentsReport {
  detectedAgents: Array<{ id: string; name: string }>;
  results: AgentInstallItemResult[];
}

export const GRAPHFLOW_BLOCK_BEGIN = "<!-- GRAPHFLOW:BEGIN -->";
export const GRAPHFLOW_BLOCK_END = "<!-- GRAPHFLOW:END -->";

export const SKILL_MD_CONTENT = [
  "---",
  "name: graphflow",
  "description: Token-First Surgical Code Engine (gf_read, gf_edit, gf_exec, gf_macro) across TS/JS, Python, Go, Rust, C/C++, and C#.",
  "---",
  "",
  "# GraphFlow 3.1 — Token-First Surgical Engine",
  "",
  "Always prefer the 4 surgical `gf_*` MCP tools over raw full-file reads or verbose test runs:",
  "",
  "1. **`gf_read`** (`targets`, `q`, `skeleton`, `dedup`):",
  "   - Read exact symbols (`\"src/file.ts#symbol\"`) with automatic **Cross-File Type Closure** and 3-line **`[Blast Radius]`** caller micro-snippets.",
  "   - Fold large files into AST skeletons (`\"src/file.ts\"`, `skeleton: true`) cutting token cost by 93%.",
  "   - Pass `dedup: true` in long sessions to skip re-reading unchanged files (SHA-256 cache).",
  "2. **`gf_edit`** (`file`, `symbol`, `newCode`, `edits`, `renameTo`):",
  "   - Edit symbols or line ranges in-place, apply multi-file atomic batch `edits` bottom-up with zero line drift, or run zero-LLM cross-repo symbol rename (`renameTo`).",
  "   - Enforces instant AST syntax rollback, caller-arity checks, and struct/interface field deletion guards.",
  "3. **`gf_exec`** (`cmd`, `changedFiles`, `handle`, `run`):",
  "   - Run `cmd: \"affected-tests\"` (2-hop reverse import router) or any command with output dehydration (passing runs = 1-line `PASS` receipt; failures inline exact 5-line source context; 3 consecutive failures trigger the loop circuit breaker).",
  "4. **`gf_macro`** (`action: \"list\" | \"run\" | \"save\" | \"mine\" | \"mine-git\"`):",
  "   - Mine git history co-change coupling (`action: \"mine-git\"`) or run auto-compiled `.graphflow/macros/*.mjs` scripts and isomorphic codemods with zero LLM turns.",
  "",
].join("\n");

export const CURSOR_RULE_MDC_CONTENT = [
  "---",
  "description: GraphFlow 3.1 Token-First Surgical Code Engine rules (gf_read, gf_edit, gf_exec, gf_macro)",
  "globs: **/*",
  "alwaysApply: true",
  "---",
  "",
  "# GraphFlow 3.1 Surgical Mode",
  "",
  "- Prefer `gf_read` (`targets: [\"path/file#symbol\"]` or `q: \"keyword\"`) over reading entire large files (>250 lines).",
  "- Prefer `gf_edit` for symbol/line edits, multi-site batch `edits`, and cross-repo `renameTo`; update `[Blast Radius]` callers in the same turn.",
  "- Prefer `gf_exec({ cmd: \"affected-tests\", run: true })` to run affected tests with dehydrated output.",
  "- Prefer `gf_macro({ action: \"mine-git\" })` on new repos to load git co-change coupling hints, and `gf_macro({ action: \"run\", id })` for repeated workflows.",
  "",
].join("\n");

export const MANAGED_INSTRUCTION_BLOCK = [
  GRAPHFLOW_BLOCK_BEGIN,
  "# GraphFlow 3.1 (Token-First Surgical Mode)",
  "",
  "Use GraphFlow's 4 surgical MCP tools (`gf_read`, `gf_edit`, `gf_exec`, `gf_macro`) to minimize token usage and prevent context rot:",
  "",
  "1. `gf_read`: Slice specific symbols (`targets: [\"file#symbol\"]`) with automatic cross-file type closure and `[Blast Radius]` call sites, or fold large files (`skeleton: true`).",
  "2. `gf_edit`: Perform in-place symbol/line edits, bottom-up batch `edits`, or cross-repo `renameTo` with instant AST syntax, caller-arity, and struct-field contract guards.",
  "3. `gf_exec`: Run `cmd: \"affected-tests\"` or shell commands with dehydrated output (1-line `PASS` receipt; 5-line source window on failure; 3-strike loop circuit breaker).",
  "4. `gf_macro`: Run `action: \"mine-git\"` for zero-cold-start git co-change hints, or `action: \"run\"` to execute auto-compiled `.graphflow/macros/*.mjs` scripts.",
  GRAPHFLOW_BLOCK_END,
].join("\n");

function resolvePaths(opts: InstallAllAgentsOptions = {}) {
  const isWin = process.platform === "win32";
  const home = opts.homeDir ?? homedir();
  const appData =
    opts.appDataDir ??
    process.env.APPDATA ??
    (isWin ? join(home, "AppData", "Roaming") : join(home, ".config"));
  const localAppData =
    opts.localAppDataDir ??
    process.env.LOCALAPPDATA ??
    (isWin ? join(home, "AppData", "Local") : join(home, ".local", "share"));
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(home, ".kimi");
  const dshHome = process.env.DSH_HOME?.trim() || join(home, ".dsh");
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
        { filePath: join(home, ".claude", "rules", "graphflow.md"), kind: " dedicated-md" },
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
    },
    {
      id: "trae",
      name: "Trae",
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
      ],
      skillsDirs: [
        join(home, ".trae", "skills"),
        isWin ? join(appData, "Trae", "User", "skills") : join(home, ".config", "Trae", "User", "skills"),
        isWin ? join(appData, "Trae CN", "User", "skills") : join(home, ".config", "Trae CN", "User", "skills"),
      ],
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
    },
    {
      id: "kimi-code",
      name: "Kimi Code",
      markerPaths: [kimiHome, join(home, ".kimi-code")],
      mcpTargets: [{ configPath: join(kimiHome, "mcp.json"), serversKey: "mcpServers" }],
      workspaceMcpTargets: [
        { relativePath: join(".kimi-code", "mcp.json"), serversKey: "mcpServers" },
      ],
      skillsDirs: [join(kimiHome, "skills")],
      rulesFiles: [{ filePath: join(kimiHome, "AGENTS.md"), kind: "managed-md" }],
    },
    {
      id: "deepseek-harness",
      name: "DeepSeek Harness",
      markerPaths: [dshHome],
      mcpTargets: [{ configPath: join(dshHome, "mcp.json"), serversKey: "mcpServers" }],
      skillsDirs: [join(dshHome, "skills")],
    },
    {
      id: "qoder",
      name: "Qoder",
      markerPaths: [
        join(home, ".qoder"),
        join(home, ".qoder-cn"),
        join(appData, "Qoder"),
        join(appData, "QoderCN"),
      ],
      mcpTargets: [{ configPath: join(home, ".qoder", "mcp.json"), serversKey: "mcpServers" }],
      workspaceMcpTargets: [{ relativePath: join(".qoder", "mcp.json"), serversKey: "mcpServers" }],
      skillsDirs: [join(home, ".qoder", "skills"), join(home, ".qoder-cn", "skills")],
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

function resolveMcpLauncherCommand(): { command: string; args: string[] } {
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)
      .pop()
      ?.trim();
    if (globalRoot) {
      const serverJs = join(globalRoot, "@roarpeng", "graphflow", "dist", "mcp-server.js");
      if (existsSync(serverJs)) {
        return { command: "node", args: [serverJs] };
      }
    }
  } catch {
    // fallback to npx
  }
  return {
    command: "npx",
    args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
  };
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJsonSafe(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

  const obj = readJsonSafe(target.configPath);

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

  const obj = readJsonSafe(target.configPath);
  if (format === "opencode") {
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    if (!mcp || !(serverName in mcp)) return false;
    delete mcp[serverName];
    writeJsonSafe(target.configPath, obj);
    return true;
  }
  if (format === "zcode") {
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    const servers = mcp?.servers as Record<string, unknown> | undefined;
    if (!servers || !(serverName in servers)) return false;
    delete servers[serverName];
    writeJsonSafe(target.configPath, obj);
    return true;
  }

  const servers = obj[target.serversKey] as Record<string, unknown> | undefined;
  if (!servers || !(serverName in servers)) return false;
  delete servers[serverName];
  writeJsonSafe(target.configPath, obj);
  return true;
}

function writeManagedFile(
  filePath: string,
  kind: "cursor-mdc" | "managed-md" | " dedicated-md"
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

  if (kind === " dedicated-md") {
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
  kind: "cursor-mdc" | "managed-md" | " dedicated-md"
): boolean {
  if (!existsSync(filePath)) return false;
  if (kind === "cursor-mdc" || kind === " dedicated-md") {
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

function installHostHook(
  hookKind: "claude" | "cursor" | "gemini" | "codex",
  configPath: string
): "installed" | "updated" {
  const existed = existsSync(configPath);
  const obj = readJsonSafe(configPath);
  const hooks =
    obj.hooks && typeof obj.hooks === "object" ? (obj.hooks as Record<string, unknown>) : {};

  if (hookKind === "cursor") {
    obj.version = obj.version ?? 1;
    hooks.preToolUse = [{ command: "graphflow hook pre-tool", timeout: 15 }];
    hooks.postToolUse = [{ command: "graphflow hook post-tool", timeout: 15 }];
  } else if (hookKind === "gemini") {
    hooks.BeforeTool = [
      {
        matcher: ".*",
        hooks: [{ name: "graphflow-pre", type: "command", command: "graphflow hook pre-tool" }],
      },
    ];
    hooks.AfterTool = [
      {
        matcher: ".*",
        hooks: [{ name: "graphflow-post", type: "command", command: "graphflow hook post-tool" }],
      },
    ];
  } else {
    hooks.PreToolUse = [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: "graphflow hook pre-tool", timeout: 15 }],
      },
    ];
    hooks.PostToolUse = [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: "graphflow hook post-tool", timeout: 15 }],
      },
    ];
  }

  obj.hooks = hooks;
  writeJsonSafe(configPath, obj);
  return existed ? "updated" : "installed";
}

export function installAllAgents(opts: InstallAllAgentsOptions = {}): InstallAllAgentsReport {
  const serverName = opts.serverName ?? "graphflow";
  const profiles = buildAgentProfiles(opts);
  const detected = detectInstalledAgents(opts);
  const detectedIds = new Set(detected.map((d) => d.id));
  const launcher = resolveMcpLauncherCommand();
  const results: AgentInstallItemResult[] = [];

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
      }
    }

    // 2. Register SKILL.md
    for (const skillsDir of profile.skillsDirs ?? []) {
      const skillFile = join(skillsDir, "graphflow", "SKILL.md");
      try {
        const existed = existsSync(skillFile);
        mkdirSync(dirname(skillFile), { recursive: true });
        writeFileSync(skillFile, SKILL_MD_CONTENT, "utf8");
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

    // 4. Register Host Hooks (PreToolUse / PostToolUse)
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
  }

  return { detectedAgents: detected, results };
}

export function uninstallAllAgents(opts: InstallAllAgentsOptions = {}): AgentInstallItemResult[] {
  const serverName = opts.serverName ?? "graphflow";
  const profiles = buildAgentProfiles(opts);
  const results: AgentInstallItemResult[] = [];

  for (const profile of profiles) {
    for (const target of profile.mcpTargets) {
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
  }

  return results;
}
