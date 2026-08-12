import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, release } from "node:os";

export type McpServersKey = "mcpServers" | "servers" | "context_servers" | "mcp";

export interface McpServerNode {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface OpencodeMcpServerNode {
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
  type: "local";
}

export type McpInstallStrategy = "npx" | "npm-script" | "node-bundled";
export type McpInstallScope = "user" | "all";

export interface McpInstallOptions {
  strategy: McpInstallStrategy;
  /** When "user" (default), only write MCP into user-level agent configs. */
  installScope?: McpInstallScope;
  workspaceRoot?: string;
  npmScriptCwd?: string;
  bundledServerPath?: string;
  /** Cross-platform launcher script (preferred on Windows; never use server.js as command). */
  launcherPath?: string;
  /** Vendor runtime root (parent of dist/). Used as MCP cwd for module resolution. */
  bundledRuntimeRoot?: string;
  /** Explicit node binary. When omitted, resolves system node or editor-bundled node. */
  nodeCommand?: string;
  /** Editor executable for ELECTRON_RUN_AS_NODE fallback when system node is unavailable. */
  electronExecPath?: string;
  serverName?: string;
  /** Test hook: override auto-detected agent ids. Empty array means no agents. */
  agentIdsOverride?: string[];
  /**
   * Force Windows-style MCP launch (`node.exe` + `npx-cli.js` + `NODE`/`NPX_CLI` env).
   * Used for native Windows agents and WSL → Windows agent targets (e.g. Codex).
   */
  windowsHost?: boolean;
  /** Test/injection hook: Windows `node.exe` path (Windows or WSL-mounted). */
  windowsNodePath?: string;
  /** Test/injection hook: Windows `npx-cli.js` path (Windows or WSL-mounted). */
  windowsNpxCliPath?: string;
  /**
   * When true, omit GRAPHFLOW_WORKSPACE_ROOT=${workspaceFolder}.
   * Codex does not expand VS Code/Cursor placeholders.
   */
  omitWorkspaceFolderPlaceholder?: boolean;
}

export interface DetectedAgent {
  id: string;
  name: string;
}

export interface McpInstallResult {
  agentId: string;
  agentName: string;
  configPath: string;
  scope: "user" | "workspace";
  status: "injected" | "created" | "skipped" | "error" | "updated";
  message?: string;
}

export interface McpAgentInstallStatus {
  agentId: string;
  agentName: string;
  configPath: string;
  scope: "user" | "workspace";
  detected: boolean;
  installed: boolean;
}

export type McpConfigFormat = "json" | "codex-toml" | "opencode";

export interface AgentProfile {
  id: string;
  name: string;
  markerPaths: string[];
  userTargets: Array<{ configPath: string; serversKey: McpServersKey; configFormat?: McpConfigFormat }>;
  workspaceRelativePaths?: Array<{ relativePath: string; serversKey: McpServersKey; configFormat?: McpConfigFormat }>;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const rel = release() ?? "";
    if (rel.toLowerCase().includes("microsoft") || rel.toLowerCase().includes("wsl")) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    if (existsSync("/proc/version")) {
      const content = readFileSync("/proc/version", "utf8").toLowerCase();
      if (content.includes("microsoft") || content.includes("wsl")) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function getWindowsHomeFromWsl(): string | undefined {
  if (!isWsl()) {
    return undefined;
  }
  try {
    const output = execFileSync("cmd.exe", ["/c", "echo %USERPROFILE%"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    if (output && output !== "%USERPROFILE%" && !output.includes("is not recognized")) {
      const windowsPath = output.replace(/\\/g, "/");
      const match = windowsPath.match(/^([A-Z]):\/(.+)$/i);
      if (match && match[1] && match[2]) {
        return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

function resolveHomePaths(): { home: string; appData: string; localAppData: string; wslWindowsHome?: string } {
  const home = homedir();
  const appData = process.env.APPDATA ?? (isWindows() ? join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA ?? (isWindows() ? join(home, "AppData", "Local") : "");
  const result: { home: string; appData: string; localAppData: string; wslWindowsHome?: string } = { home, appData, localAppData };
  if (isWsl()) {
    const winHome = getWindowsHomeFromWsl();
    if (winHome) {
      result.wslWindowsHome = winHome;
    }
  }
  return result;
}

function buildWindowsProfilesFromWsl(windowsHome: string): AgentProfile[] {
  const winAppData = join(windowsHome, "AppData", "Roaming");
  const winLocalAppData = join(windowsHome, "AppData", "Local");

  return [
    {
      id: "cursor-windows",
      name: "Cursor (Windows)",
      markerPaths: [
        join(windowsHome, ".cursor"),
        join(winAppData, "Cursor"),
        join(winLocalAppData, "Programs", "cursor"),
        join(winLocalAppData, "cursor"),
      ],
      userTargets: [
        { configPath: join(windowsHome, ".cursor", "mcp.json"), serversKey: "mcpServers" },
        {
          configPath: join(winAppData, "Cursor", "User", "globalStorage", "roval.cursor", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
      workspaceRelativePaths: [],
    },
    {
      id: "vscode-windows",
      name: "VS Code (Windows)",
      markerPaths: [
        join(winAppData, "Code"),
        join(winLocalAppData, "Programs", "Microsoft VS Code"),
      ],
      userTargets: [
        {
          configPath: join(winAppData, "Code", "User", "mcp.json"),
          serversKey: "servers",
        },
      ],
      workspaceRelativePaths: [],
    },
    {
      id: "trae-windows",
      name: "Trae (Windows)",
      markerPaths: [
        join(winAppData, "Trae"),
        join(winAppData, "Trae CN"),
      ],
      userTargets: [
        {
          configPath: join(winAppData, "Trae", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: join(winAppData, "Trae CN", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    // Claude Code (Windows from WSL)
    {
      id: "claude-code-windows",
      name: "Claude Code (Windows)",
      markerPaths: [
        join(windowsHome, ".claude"),
        join(windowsHome, ".claude.json"),
      ],
      userTargets: [
        { configPath: join(windowsHome, ".claude.json"), serversKey: "mcpServers" },
      ],
      workspaceRelativePaths: [{ relativePath: ".mcp.json", serversKey: "mcpServers" }],
    },
    // Codex (Windows from WSL)
    {
      id: "codex-windows",
      name: "Codex (Windows)",
      markerPaths: [join(windowsHome, ".codex")],
      userTargets: [
        { configPath: join(windowsHome, ".codex", "config.toml"), serversKey: "mcpServers", configFormat: "codex-toml" },
      ],
    },
    // Windsurf (Windows from WSL)
    {
      id: "windsurf-windows",
      name: "Windsurf (Windows)",
      markerPaths: [join(windowsHome, ".codeium", "windsurf"), join(winAppData, "Windsurf")],
      userTargets: [
        { configPath: join(windowsHome, ".codeium", "windsurf", "mcp_config.json"), serversKey: "mcpServers" },
      ],
    },
    // Gemini (Windows from WSL)
    {
      id: "gemini-windows",
      name: "Gemini (Windows)",
      markerPaths: [join(windowsHome, ".gemini")],
      userTargets: [
        { configPath: join(windowsHome, ".gemini", "settings.json"), serversKey: "mcpServers" },
      ],
    },
    // Cline (Windows from WSL)
    {
      id: "cline-windows",
      name: "Cline (Windows)",
      markerPaths: [join(winAppData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev")],
      userTargets: [
        { configPath: join(winAppData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), serversKey: "mcpServers" },
      ],
    },
  ];
}

export function buildAgentProfiles(): AgentProfile[] {
  const { home, appData, localAppData, wslWindowsHome } = resolveHomePaths();

  const profiles: AgentProfile[] = [
    {
      id: "cursor",
      name: "Cursor",
      markerPaths: [
        join(home, ".cursor"),
        join(appData, "Cursor"),
        join(localAppData, "Programs", "cursor"),
        join(localAppData, "cursor"),
      ],
      userTargets: [
        { configPath: join(home, ".cursor", "mcp.json"), serversKey: "mcpServers" },
        {
          configPath: join(appData, "Cursor", "User", "globalStorage", "roval.cursor", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
      workspaceRelativePaths: [{ relativePath: join(".cursor", "mcp.json"), serversKey: "mcpServers" }],
    },
    {
      id: "vscode",
      name: "VS Code",
      markerPaths: [
        join(appData, "Code"),
        join(localAppData, "Programs", "Microsoft VS Code"),
        join(home, ".vscode"),
      ],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Code", "User", "mcp.json")
            : join(home, ".config", "Code", "User", "mcp.json"),
          serversKey: "servers",
        },
      ],
      workspaceRelativePaths: [{ relativePath: join(".vscode", "mcp.json"), serversKey: "servers" }],
    },
    {
      id: "trae",
      name: "Trae",
      markerPaths: [
        join(home, ".trae"),
        join(home, ".trae-cn"),
        join(home, ".trae-aicc"),
        join(appData, "Trae"),
        join(appData, "Trae CN"),
        join(appData, "TRAE SOLO CN"),
      ],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Trae", "User", "mcp.json")
            : join(home, ".config", "Trae", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWindows()
            ? join(appData, "Trae CN", "User", "mcp.json")
            : join(home, ".config", "Trae CN", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWindows()
            ? join(appData, "TRAE SOLO CN", "User", "mcp.json")
            : join(home, ".config", "TRAE SOLO CN", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "claude-code",
      name: "Claude Code",
      markerPaths: [
        join(home, ".claude"),
        join(home, ".claude.json"),
      ],
      userTargets: [
        { configPath: join(home, ".claude.json"), serversKey: "mcpServers" },
      ],
      workspaceRelativePaths: [{ relativePath: ".mcp.json", serversKey: "mcpServers" }],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      markerPaths: [join(home, ".codeium", "windsurf"), join(appData, "Windsurf")],
      userTargets: [
        {
          configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "cline",
      name: "Cline",
      markerPaths: [
        join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
        join(appData, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev"),
        join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
      ],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWindows()
            ? join(appData, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "roo-code",
      name: "Roo Code",
      markerPaths: [
        join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
        join(appData, "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
        join(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
      ],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWindows()
            ? join(appData, "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "kilocode",
      name: "Kilo Code",
      markerPaths: [
        join(appData, "Code", "User", "globalStorage", "kilocode.kilocode-ai"),
        join(appData, "Cursor", "User", "globalStorage", "kilocode.kilocode-ai"),
        join(home, ".config", "Code", "User", "globalStorage", "kilocode.kilocode-ai"),
      ],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Code", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Code", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWindows()
            ? join(appData, "Cursor", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Cursor", "User", "globalStorage", "kilocode.kilocode-ai", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "pearai",
      name: "PearAI",
      markerPaths: [
        join(home, ".pearai"),
        join(appData, "PearAI"),
      ],
      userTargets: [
        { configPath: join(home, ".pearai", "mcp.json"), serversKey: "mcpServers" },
        { configPath: join(appData, "PearAI", "User", "mcp.json"), serversKey: "mcpServers" },
      ],
      workspaceRelativePaths: [{ relativePath: join(".pearai", "mcp.json"), serversKey: "mcpServers" }],
    },
    {
      id: "gemini",
      name: "Gemini",
      markerPaths: [
        join(home, ".gemini"),
      ],
      userTargets: [
        {
          configPath: join(home, ".gemini", "settings.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: join(home, ".gemini", "config", "mcp_config.json"),
          serversKey: "mcpServers",
        },
      ],
      workspaceRelativePaths: [
        { relativePath: join(".gemini", "settings.json"), serversKey: "mcpServers" },
      ],
    },
    {
      id: "codex",
      name: "Codex",
      markerPaths: [join(home, ".codex"), join(localAppData, "OpenAI", "Codex")],
      userTargets: [
        {
          configPath: join(home, ".codex", "config.toml"),
          serversKey: "mcpServers",
          configFormat: "codex-toml",
        },
      ],
    },
    {
      id: "antigravity",
      name: "Antigravity",
      markerPaths: [
        join(home, ".gemini", "antigravity"),
        join(home, ".antigravity"),
        join(appData, "Antigravity"),
        join(localAppData, "Programs", "Antigravity"),
      ],
      userTargets: [
        {
          configPath: join(home, ".gemini", "antigravity", "mcp_config.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: join(home, ".gemini", "config", "mcp_config.json"),
          serversKey: "mcpServers",
        },
      ],
      workspaceRelativePaths: [
        { relativePath: join(".agents", "mcp_config.json"), serversKey: "mcpServers" },
      ],
    },
    {
      id: "amazon-q",
      name: "Amazon Q",
      markerPaths: [join(home, ".amazonq")],
      userTargets: [
        { configPath: join(home, ".amazonq", "mcp.json"), serversKey: "mcpServers" },
      ],
    },
    {
      id: "zed",
      name: "Zed",
      markerPaths: [
        join(home, ".config", "zed"),
        isWindows() ? join(appData, "Zed") : undefined,
      ].filter(Boolean) as string[],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Zed", "settings.json")
            : join(home, ".config", "zed", "settings.json"),
          serversKey: "context_servers",
        },
      ],
    },
    {
      id: "continue",
      name: "Continue",
      markerPaths: [
        join(home, ".continue"),
      ],
      userTargets: [
        {
          configPath: join(home, ".continue", "config.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "qoder",
      name: "Qoder",
      markerPaths: [
        join(home, ".qoder"),
        join(home, ".qoder-cn"),
        join(home, ".config", "Qoder"),
        join(home, ".config", "QoderCN"),
        join(appData, "Qoder"),
        join(appData, "QoderCN"),
        join(localAppData, "Programs", "qoder"),
      ],
      userTargets: [
        {
          configPath: join(home, ".qoder", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          // Qoder 实际读取的用户级 MCP 配置（国际版，已实测生效）
          configPath: isWindows()
            ? join(appData, "Qoder", "SharedClientCache", "mcp.json")
            : join(home, ".config", "Qoder", "SharedClientCache", "mcp.json"),
          serversKey: "mcpServers",
        },
        {
          // Qoder CN 版实际读取的用户级 MCP 配置（已实测生效）
          configPath: isWindows()
            ? join(appData, "QoderCN", "SharedClientCache", "mcp.json")
            : join(home, ".config", "QoderCN", "SharedClientCache", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
      workspaceRelativePaths: [{ relativePath: join(".qoder", "mcp.json"), serversKey: "mcpServers" }],
    },
  ];

  if (wslWindowsHome) {
    profiles.push(...buildWindowsProfilesFromWsl(wslWindowsHome));
  }

  const customEnv = process.env.GRAPHFLOW_MCP_CUSTOM_TARGETS;
  if (customEnv) {
    const paths = customEnv.split(isWindows() ? ";" : ":").map((p) => p.trim()).filter(Boolean);
    if (paths.length > 0) {
      profiles.push({
        id: "custom",
        name: "Custom IDE",
        markerPaths: paths.map((p) => dirname(p)),
        userTargets: paths.map((p) => ({ configPath: p, serversKey: "mcpServers" })),
      });
    }
  }

  return profiles;
}

export function detectInstalledAgents(): DetectedAgent[] {
  const profiles = buildAgentProfiles();
  const detected: DetectedAgent[] = [];

  for (const profile of profiles) {
    const found = profile.markerPaths.some((marker) => marker && existsSync(marker));
    if (found) {
      detected.push({ id: profile.id, name: profile.name });
    }
  }

  return detected;
}

function isGraphflowMcpInstalled(
  configPath: string,
  serversKey: McpServersKey,
  serverName: string,
  configFormat: McpConfigFormat = "json"
): boolean {
  if (!existsSync(configPath)) {
    return false;
  }
  if (configFormat === "codex-toml") {
    const raw = readFileSync(configPath, "utf8");
    return new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`, "m").test(raw);
  }
  if (configFormat === "opencode") {
    return isOpencodeMcpInstalled(configPath, serverName);
  }
  const json = readJsonConfig(configPath);
  const servers = (json[serversKey] as Record<string, McpServerNode> | undefined) ?? {};
  return Boolean(servers[serverName]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inspect detected agents and whether GraphFlow MCP is present in each config file. */
export function getMcpInstallStatus(serverName = "graphflow"): McpAgentInstallStatus[] {
  const detectedIds = new Set(detectInstalledAgents().map((agent) => agent.id));
  const profiles = buildAgentProfiles();
  const seen = new Set<string>();
  const statuses: McpAgentInstallStatus[] = [];

  for (const profile of profiles) {
    const detected = detectedIds.has(profile.id);
    if (!detected) {
      continue;
    }

    for (const userTarget of profile.userTargets) {
      const key = `${userTarget.configPath}::${userTarget.serversKey}::${userTarget.configFormat ?? "json"}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      statuses.push({
        agentId: profile.id,
        agentName: profile.name,
        configPath: userTarget.configPath,
        scope: "user",
        detected: true,
        installed: isGraphflowMcpInstalled(
          userTarget.configPath,
          userTarget.serversKey,
          serverName,
          userTarget.configFormat ?? "json"
        ),
      });
    }
  }

  return statuses;
}

const MCP_STDIO_ENV: Record<string, string> = {
  GRAPHFLOW_MCP_STDIO: "1",
  GRAPHFLOW_LOG_JSON: "1",
};

const EPHEMERAL_NODE_PATH_MARKERS = ["/fnm_multishells/", "\\fnm_multishells\\"];

export { isWsl };

/** fnm multishell paths are session-temporary and break MCP after shell restart. */
export function isEphemeralNodePath(nodePath: string): boolean {
  const normalized = nodePath.replace(/\\/g, "/").toLowerCase();
  return EPHEMERAL_NODE_PATH_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()));
}

function isBareNodeCommand(nodePath: string): boolean {
  const base = nodePath.trim().toLowerCase();
  return base === "node" || base === "node.exe";
}

function isUsableNodeCommand(nodePath: string): boolean {
  const trimmed = nodePath.trim();
  if (!trimmed) {
    return false;
  }
  if (isBareNodeCommand(trimmed)) {
    return true;
  }
  if (isEphemeralNodePath(trimmed)) {
    return false;
  }
  return existsSync(trimmed);
}

/**
  * 判断给定的 node 路径是否属于 IDE/编辑器内嵌的 Node 运行时。
  * 在 TRAE、Cursor、VS Code 等进程环境中，PATH 最前面通常是 IDE 自带的 Node，
  * 这些路径可能包含空格（如 "TRAE SOLO CN"）且版本不稳定，不适合作为 MCP 启动的运行时。
  */
 export function isIdeBundledNode(nodePath: string): boolean {
  const normalized = nodePath.replace(/\\/g, "/").toLowerCase();
  const ideMarkers = [
    "appdata",        // Windows %APPDATA% 或 %LOCALAPPDATA% 下的内嵌 Node
    "modulardata",    // TRAE 内嵌 Node 路径特征
    "trae",
    "cursor",
    "vs code",
    "vscode",
    "electron",
    "windsurf",
    "cline",
  ];
  return ideMarkers.some((marker) => normalized.includes(marker.toLowerCase()));
}

export function resolveSystemNodeCommand(): string | undefined {
  const candidates: string[] = [];

  try {
    const lookup = isWindows() ? "where.exe" : "which";
    const target = isWindows() ? "node.exe" : "node";
    const output = execFileSync(lookup, [target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    candidates.push(...output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch {
    // fall through
  }

  if (!isWindows()) {
    candidates.push("/usr/local/bin/node", "/usr/bin/node");
  }

  // 第一轮：优先选择非 IDE 内嵌的系统 Node
  for (const candidate of candidates) {
    if (
      isUsableNodeCommand(candidate) &&
      !isEphemeralNodePath(candidate) &&
      !isIdeBundledNode(candidate)
    ) {
      return candidate;
    }
  }

  // 第二轮：回退到原始行为（包括 IDE 内嵌 Node），确保在纯 IDE 环境下也能工作
  for (const candidate of candidates) {
    if (isUsableNodeCommand(candidate) && !isEphemeralNodePath(candidate)) {
      return candidate;
    }
  }

  return "node";
}

export function resolveMcpNodeLaunch(options: {
  nodeCommand?: string;
  electronExecPath?: string;
}): { command: string; env: Record<string, string> } {
  // 1. Explicit node command (highest priority)
  const explicitNode = options.nodeCommand?.trim();
  if (explicitNode && isUsableNodeCommand(explicitNode) && !isEphemeralNodePath(explicitNode)) {
    return {
      command: preferSpaceFreeWindowsPath(explicitNode),
      env: { ...MCP_STDIO_ENV },
    };
  }

  // 2. System Node — preferred over Electron because:
  //    - Path is stable across IDE updates
  //    - No need for ELECTRON_RUN_AS_NODE which may not be forwarded by all MCP clients
  //    - Better compatibility with MCP client spawn logic
  const systemNode = resolveSystemNodeCommand();
  if (systemNode && systemNode !== "node") {
    const safeNode = preferSpaceFreeWindowsPath(systemNode);
    // Trae/some clients invoke `command` via cmd.exe without quoting. If we still
    // have spaces (8.3 disabled), fall back to bare "node" so PATH resolution works.
    if (safeNode.includes(" ")) {
      return { command: "node", env: { ...MCP_STDIO_ENV } };
    }
    return { command: safeNode, env: { ...MCP_STDIO_ENV } };
  }

  // 3. Electron fallback — when system Node is unavailable, use the IDE's bundled Electron
  const electronExecPath = options.electronExecPath?.trim();
  if (electronExecPath && existsSync(electronExecPath)) {
    const safeElectron = preferSpaceFreeWindowsPath(electronExecPath);
    if (safeElectron.includes(" ")) {
      return { command: "node", env: { ...MCP_STDIO_ENV } };
    }
    return {
      command: safeElectron,
      env: {
        ...MCP_STDIO_ENV,
        ELECTRON_RUN_AS_NODE: "1",
      },
    };
  }

  // 4. Last resort: bare "node" (relies on PATH resolution at MCP launch time)
  return { command: "node", env: { ...MCP_STDIO_ENV } };
}

/** Convert `/mnt/c/foo` ↔ `C:\foo` for WSL ↔ Windows path bridging. */
export function toWindowsPathFromWsl(pathValue: string): string {
  const normalized = pathValue.replace(/\//g, "\\");
  const mnt = normalized.match(/^\\mnt\\([A-Za-z])\\(.*)$/);
  if (mnt?.[1] && mnt[2] !== undefined) {
    return `${mnt[1].toUpperCase()}:\\${mnt[2]}`;
  }
  return pathValue.includes("/") ? pathValue.replace(/\//g, "\\") : pathValue;
}

export function toWslPathFromWindows(pathValue: string): string {
  const match = pathValue.replace(/\//g, "\\").match(/^([A-Za-z]):\\(.*)$/);
  if (match?.[1] && match[2] !== undefined) {
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
  }
  return pathValue;
}

function pathExistsOnWindowsHost(windowsPath: string): boolean {
  if (isWindows()) {
    return existsSync(windowsPath);
  }
  if (isWsl()) {
    return existsSync(toWslPathFromWindows(windowsPath));
  }
  return false;
}

/**
 * On Windows (or via cmd.exe from WSL), convert a long path containing spaces
 * to its 8.3 short form. Many MCP clients (e.g., TRAE / Codex) spawn `command`
 * without reliable quoting, so "C:\Program Files\..." breaks. Short names like
 * "C:\PROGRA~1\..." avoid this. Codex on Windows also needs NODE/NPX_CLI env
 * pointing at these short paths for npx-cli registration to succeed.
 */
export function getWindowsShortPath(longPath: string): string | undefined {
  if (!longPath) {
    return longPath;
  }
  const windowsPath = isWsl() && longPath.startsWith("/mnt/")
    ? toWindowsPathFromWsl(longPath)
    : longPath;
  if (!windowsPath.includes(" ")) {
    return windowsPath;
  }
  if (!isWindows() && !isWsl()) {
    return undefined;
  }
  // Try cmd.exe first (works on native Windows and from WSL)
  try {
    const result = execSync(
      `for %A in ("${windowsPath}") do @echo %~sA`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        shell: "cmd.exe",
      }
    ).trim();
    const lines = result.split(/\r?\n/).filter((l) => l.trim());
    const shortPath = lines[lines.length - 1]?.trim();
    if (shortPath && !shortPath.includes(" ") && pathExistsOnWindowsHost(shortPath)) {
      return shortPath;
    }
  } catch {
    // fall through to PowerShell
  }
  // Fallback: PowerShell with FileSystemObject COM (native Windows only)
  if (isWindows()) {
    try {
      const escaped = windowsPath.replace(/'/g, "''");
      const result = execSync(
        `$fso = New-Object -ComObject Scripting.FileSystemObject; if (Test-Path -LiteralPath '${escaped}') { if ((Get-Item -LiteralPath '${escaped}') -is [System.IO.DirectoryInfo]) { $fso.GetFolder('${escaped}').ShortPath } else { $fso.GetFile('${escaped}').ShortPath } }`,
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
          shell: "powershell.exe",
        }
      ).trim();
      if (result && !result.includes(" ") && existsSync(result)) {
        return result;
      }
    } catch {
      // 8.3 name generation may be disabled on some volumes
    }
  }
  return undefined;
}

/** Prefer 8.3 short path on Windows when the input contains spaces; otherwise keep as-is. */
export function preferSpaceFreeWindowsPath(pathValue: string): string {
  if ((!isWindows() && !isWsl()) || !pathValue.includes(" ")) {
    return pathValue;
  }
  return getWindowsShortPath(pathValue) ?? pathValue;
}

/**
 * Final guard for MCP clients (notably Trae) that spawn `command` via cmd.exe
 * without quoting. Ensures install-time configs never write spaced absolute paths.
 */
export function sanitizeMcpServerNodeForWindowsClients(node: McpServerNode): McpServerNode {
  if (!isWindows()) {
    return node;
  }

  let command = preferSpaceFreeWindowsPath(node.command);
  // Absolute node/electron paths that still contain spaces → bare "node" via PATH.
  if (
    command.includes(" ") &&
    (/[\\/]node(\.exe)?$/i.test(command) || /[\\/]electron(\.exe)?$/i.test(command))
  ) {
    command = "node";
  }

  const args = node.args.map((arg) => {
    if (!arg.includes(" ")) {
      return arg;
    }
    // Only rewrite filesystem-looking args; leave flags like "--foo bar" alone.
    if (/^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith("\\\\") || arg.includes("/") || arg.includes("\\")) {
      return preferSpaceFreeWindowsPath(arg);
    }
    return arg;
  });

  const sanitized: McpServerNode = {
    command,
    args,
  };
  if (node.env) {
    sanitized.env = node.env;
  }
  if (node.cwd) {
    sanitized.cwd = preferSpaceFreeWindowsPath(node.cwd);
  }
  return sanitized;
}

/** True when command/cwd/path-like args still contain spaces (unsafe for unquoted cmd spawn). */
export function mcpNodeNeedsWindowsSpaceRepair(node: McpServerNode): boolean {
  if (node.command.includes(" ")) {
    return true;
  }
  if (node.cwd?.includes(" ")) {
    return true;
  }
  return node.args.some((arg) => {
    if (!arg.includes(" ")) {
      return false;
    }
    return /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith("\\\\") || arg.includes("/") || arg.includes("\\");
  });
}

export interface McpWindowsSpaceRepairResult {
  agentId: string;
  agentName: string;
  configPath: string;
  repaired: boolean;
  beforeCommand?: string;
  afterCommand?: string;
}

/**
 * Painless migrate: rewrite existing GraphFlow MCP entries that still use spaced
 * absolute paths (e.g. Program Files). Scans every known agent config path that
 * exists — not only currently "detected" markers — so Trae / Trae CN / TRAE SOLO
 * variants are all fixed on extension activate without a manual Install click.
 */
export function repairUnsafeWindowsMcpCommands(
  serverName = "graphflow",
  options?: {
    /** Test/injection hook — override scanned targets. */
    targets?: Array<{
      agentId: string;
      agentName: string;
      configPath: string;
      serversKey: McpServersKey;
    }>;
  }
): McpWindowsSpaceRepairResult[] {
  if (!isWindows()) {
    return [];
  }

  const results: McpWindowsSpaceRepairResult[] = [];
  const seen = new Set<string>();

  const targets =
    options?.targets ??
    buildAgentProfiles().flatMap((profile) =>
      profile.userTargets
        .filter((t) => (t.configFormat ?? "json") !== "codex-toml" && (t.configFormat ?? "json") !== "opencode")
        .map((t) => ({
          agentId: profile.id,
          agentName: profile.name,
          configPath: t.configPath,
          serversKey: t.serversKey,
        }))
    );

  for (const target of targets) {
    const key = `${target.configPath}::${target.serversKey}`;
    if (seen.has(key) || !existsSync(target.configPath)) {
      continue;
    }
    seen.add(key);

    try {
      const json = readJsonConfig(target.configPath);
      const servers = (json[target.serversKey] as Record<string, McpServerNode> | undefined) ?? {};
      const previous = servers[serverName];
      if (!previous || typeof previous.command !== "string" || !Array.isArray(previous.args)) {
        continue;
      }
      if (!mcpNodeNeedsWindowsSpaceRepair(previous)) {
        results.push({
          agentId: target.agentId,
          agentName: target.agentName,
          configPath: target.configPath,
          repaired: false,
          beforeCommand: previous.command,
          afterCommand: previous.command,
        });
        continue;
      }

      const sanitized = sanitizeMcpServerNodeForWindowsClients(previous);
      servers[serverName] = sanitized;
      json[target.serversKey] = servers;
      writeJsonConfig(target.configPath, json);
      results.push({
        agentId: target.agentId,
        agentName: target.agentName,
        configPath: target.configPath,
        repaired: true,
        beforeCommand: previous.command,
        afterCommand: sanitized.command,
      });
    } catch {
      // Config may be malformed; skip — install path will recreate.
    }
  }

  return results;
}

/** True when a path looks like GraphFlow's extension mcp-launcher script. */
export function isGraphFlowMcpLauncherPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = basename(normalized).toLowerCase();
  return base === "mcp-launcher.cjs" || base === "mcp-launcher.cmd";
}

/**
 * Find a missing GraphFlow mcp-launcher path referenced by an MCP server node.
 * Returns the stale path when the node points at a launcher that is not on disk.
 */
export function findMissingGraphFlowMcpLauncher(node: McpServerNode): string | undefined {
  const candidates: string[] = [];
  if (typeof node.command === "string" && isGraphFlowMcpLauncherPath(node.command)) {
    candidates.push(node.command);
  }
  if (Array.isArray(node.args)) {
    for (const arg of node.args) {
      if (typeof arg === "string" && isGraphFlowMcpLauncherPath(arg)) {
        candidates.push(arg);
      }
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface McpStaleLauncherRepairResult {
  agentId: string;
  agentName: string;
  configPath: string;
  repaired: boolean;
  beforeCommand?: string;
  afterCommand?: string;
  beforeLauncher?: string;
  afterLauncher?: string;
}

export interface RepairStaleGraphFlowMcpLaunchersOptions {
  /** Absolute path to the current extension mcp-launcher.cjs / .cmd. */
  launcherPath: string;
  /** Command used to run the launcher (node / electron). Default: "node". */
  command?: string;
  serverName?: string;
  /** When set, also scan workspace-relative MCP configs (e.g. .cursor/mcp.json). */
  workspaceRoot?: string;
  /** Optional cwd for the MCP server entry (vendor runtime root). */
  cwd?: string;
  /** Test/injection hook — override scanned targets. */
  targets?: Array<{
    agentId: string;
    agentName: string;
    configPath: string;
    serversKey: McpServersKey;
  }>;
}

/**
 * After VSIX upgrades, user/workspace MCP configs often still point at the previous
 * extension folder (`…/roarpeng.graphflow-1.9.6/mcp-launcher.cjs`). Cursor Agents
 * Window prefers project MCP and fails hard when that file is gone, while the IDE
 * may still work via a newer user-level entry. Rewrite missing launcher refs to the
 * active extension launcher on activate (and when Install MCP runs).
 */
export function repairStaleGraphFlowMcpLaunchers(
  options: RepairStaleGraphFlowMcpLaunchersOptions
): McpStaleLauncherRepairResult[] {
  const launcherPath = options.launcherPath?.trim();
  if (!launcherPath || !existsSync(launcherPath)) {
    return [];
  }

  const serverName = options.serverName ?? "graphflow";
  const results: McpStaleLauncherRepairResult[] = [];
  const seen = new Set<string>();

  const targets =
    options.targets ??
    buildAgentProfiles().flatMap((profile) => {
      const user = profile.userTargets
        .filter((t) => (t.configFormat ?? "json") !== "codex-toml" && (t.configFormat ?? "json") !== "opencode")
        .map((t) => ({
          agentId: profile.id,
          agentName: profile.name,
          configPath: t.configPath,
          serversKey: t.serversKey,
        }));
      const workspace =
        options.workspaceRoot && profile.workspaceRelativePaths
          ? profile.workspaceRelativePaths
              .filter((t) => (t.configFormat ?? "json") !== "codex-toml" && (t.configFormat ?? "json") !== "opencode")
              .map((t) => ({
                agentId: profile.id,
                agentName: `${profile.name} (workspace)`,
                configPath: join(options.workspaceRoot!, t.relativePath),
                serversKey: t.serversKey,
              }))
          : [];
      return [...user, ...workspace];
    });

  for (const target of targets) {
    const key = `${target.configPath}::${target.serversKey}`;
    if (seen.has(key) || !existsSync(target.configPath)) {
      continue;
    }
    seen.add(key);

    try {
      const json = readJsonConfig(target.configPath);
      const servers = (json[target.serversKey] as Record<string, McpServerNode> | undefined) ?? {};
      const previous = servers[serverName];
      if (!previous || typeof previous.command !== "string") {
        continue;
      }

      const missingLauncher = findMissingGraphFlowMcpLauncher({
        ...previous,
        args: Array.isArray(previous.args) ? previous.args : [],
      });
      if (!missingLauncher) {
        results.push({
          agentId: target.agentId,
          agentName: target.agentName,
          configPath: target.configPath,
          repaired: false,
          beforeCommand: previous.command,
          afterCommand: previous.command,
          beforeLauncher: Array.isArray(previous.args)
            ? previous.args.find((a) => typeof a === "string" && isGraphFlowMcpLauncherPath(a))
            : undefined,
          afterLauncher: Array.isArray(previous.args)
            ? previous.args.find((a) => typeof a === "string" && isGraphFlowMcpLauncherPath(a))
            : undefined,
        });
        continue;
      }

      const explicitCommand = options.command?.trim();
      const nextCommand =
        explicitCommand ||
        (previous.command &&
        !isGraphFlowMcpLauncherPath(previous.command) &&
        existsSync(previous.command)
          ? previous.command
          : "node");
      const next: McpServerNode = {
        command: nextCommand,
        args: [launcherPath],
        ...(previous.cwd || options.cwd ? { cwd: options.cwd ?? previous.cwd } : {}),
        ...(previous.env ? { env: { ...previous.env } } : {}),
      };
      servers[serverName] = next;
      json[target.serversKey] = servers;
      writeJsonConfig(target.configPath, json);
      results.push({
        agentId: target.agentId,
        agentName: target.agentName,
        configPath: target.configPath,
        repaired: true,
        beforeCommand: previous.command,
        afterCommand: next.command,
        beforeLauncher: missingLauncher,
        afterLauncher: launcherPath,
      });
    } catch {
      // Config may be malformed; skip — install path will recreate.
    }
  }

  return results;
}

function windowsDirname(windowsPath: string): string {
  const normalized = windowsPath.replace(/\//g, "\\");
  const idx = normalized.lastIndexOf("\\");
  return idx >= 0 ? normalized.slice(0, idx) : ".";
}

function windowsJoin(...parts: string[]): string {
  return parts
    .map((p, i) => {
      const n = p.replace(/\//g, "\\");
      if (i === 0) {
        return n.replace(/\\+$/g, "");
      }
      return n.replace(/^\\+|\\+$/g, "");
    })
    .filter((p) => p.length > 0)
    .join("\\");
}

function resolveWindowsNodeCandidates(options?: {
  windowsHost?: boolean;
  windowsNodePath?: string;
}): string[] {
  const candidates: string[] = [];
  if (options?.windowsNodePath?.trim()) {
    candidates.push(options.windowsNodePath.trim());
  }

  const wantWindows = Boolean(options?.windowsHost) || isWindows();
  if (!wantWindows) {
    return candidates;
  }

  if (isWindows()) {
    const system = resolveSystemNodeCommand();
    if (system) {
      candidates.push(system);
    }
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    candidates.push(windowsJoin(programFiles, "nodejs", "node.exe"));
    candidates.push("C:\\PROGRA~1\\nodejs\\node.exe");
    return candidates;
  }

  // WSL → Windows host: resolve via cmd.exe, then common mount points.
  try {
    const output = execFileSync("cmd.exe", ["/c", "where node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    for (const line of output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (/^[A-Za-z]:\\/.test(line) && !isIdeBundledNode(line)) {
        candidates.push(line);
      }
    }
  } catch {
    // ignore
  }

  candidates.push(
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\PROGRA~1\\nodejs\\node.exe",
    "/mnt/c/Program Files/nodejs/node.exe",
    "/mnt/c/PROGRA~1/nodejs/node.exe"
  );
  return candidates;
}

export interface WindowsNpxLaunch {
  command: string;
  args: string[];
  /** Codex / Windows npx shims require these for reliable MCP registration. */
  env: { NODE: string; NPX_CLI: string };
}

/**
 * Resolve `node.exe` + `npx-cli.js` with space-free (8.3) Windows paths and
 * NODE/NPX_CLI env — required for Codex MCP registration on Windows.
 */
export function resolveWindowsNpxLaunch(options?: {
  windowsHost?: boolean;
  windowsNodePath?: string;
  windowsNpxCliPath?: string;
}): WindowsNpxLaunch | undefined {
  const wantWindows = Boolean(options?.windowsHost) || isWindows();
  if (!wantWindows) {
    return undefined;
  }

  const explicitNode = options?.windowsNodePath?.trim();
  const explicitNpxCli = options?.windowsNpxCliPath?.trim();
  // Test / forced injection: trust caller paths (already short-form recommended).
  if (explicitNode && explicitNpxCli) {
    const node = explicitNode.startsWith("/mnt/")
      ? toWindowsPathFromWsl(explicitNode)
      : explicitNode.replace(/\//g, "\\");
    const npxCli = explicitNpxCli.startsWith("/mnt/")
      ? toWindowsPathFromWsl(explicitNpxCli)
      : explicitNpxCli.replace(/\//g, "\\");
    const shortNode = getWindowsShortPath(node) ?? node;
    const shortNpxCli = getWindowsShortPath(npxCli) ?? npxCli;
    if (shortNode.includes(" ") || shortNpxCli.includes(" ")) {
      return undefined;
    }
    return {
      command: shortNode,
      args: [shortNpxCli, "-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      env: {
        NODE: shortNode,
        NPX_CLI: shortNpxCli,
      },
    };
  }

  const nodeCandidates = resolveWindowsNodeCandidates(options);
  let node: string | undefined;
  for (const candidate of nodeCandidates) {
    const windowsStyle = candidate.startsWith("/mnt/")
      ? toWindowsPathFromWsl(candidate)
      : candidate;
    if (pathExistsOnWindowsHost(windowsStyle) || pathExistsOnWindowsHost(candidate)) {
      node = windowsStyle;
      break;
    }
  }
  if (!node) {
    return undefined;
  }

  const nodeDir = windowsDirname(node);
  const npxCandidates = [
    windowsJoin(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    // Some installs put npm next to node under Program Files
    windowsJoin(windowsDirname(nodeDir), "node_modules", "npm", "bin", "npx-cli.js"),
  ];

  for (const npxCliRaw of npxCandidates) {
    const npxCli = npxCliRaw.startsWith("/mnt/")
      ? toWindowsPathFromWsl(npxCliRaw)
      : npxCliRaw.replace(/\//g, "\\");
    if (!pathExistsOnWindowsHost(npxCli) && !pathExistsOnWindowsHost(npxCliRaw)) {
      continue;
    }
    const shortNode = getWindowsShortPath(node) ?? node;
    const shortNpxCli = getWindowsShortPath(npxCli) ?? npxCli;
    if (shortNode.includes(" ") || shortNpxCli.includes(" ")) {
      // Can't resolve to a space-free path; fall back to npx.cmd which
      // relies on PATH resolution and handles quoting internally.
      return undefined;
    }
    return {
      command: shortNode,
      args: [shortNpxCli, "-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      env: {
        NODE: shortNode,
        NPX_CLI: shortNpxCli,
      },
    };
  }
  return undefined;
}

export function buildMcpServerNode(options: McpInstallOptions): McpServerNode {
  return sanitizeMcpServerNodeForWindowsClients(buildMcpServerNodeRaw(options));
}

function buildMcpServerNodeRaw(options: McpInstallOptions): McpServerNode {
  const cwd = options.workspaceRoot ?? options.npmScriptCwd ?? process.cwd();
  // Only inject workspace root when explicitly passed (workspace-scope installs).
  // Never fall back to process.env — that pollutes user-level agent configs.
  const workspaceRootEnv = options.workspaceRoot?.trim() ?? "";
  const mcpEnv: Record<string, string> = {
    ...MCP_STDIO_ENV,
  };
  if (workspaceRootEnv) {
    mcpEnv.GRAPHFLOW_WORKSPACE_ROOT = workspaceRootEnv;
  }

  if (options.strategy === "node-bundled") {
    if (!options.bundledServerPath) {
      throw new Error("bundledServerPath is required for node-bundled strategy");
    }
    const runtimeRoot =
      options.bundledRuntimeRoot ?? join(options.bundledServerPath, "..", "..", "..");
    if (options.launcherPath) {
      // Cursor/Node spawn(.cmd, {shell:false}) fails on Windows with EINVAL /
      // "系统找不到指定的路径". Prefer the sibling .cjs under node; fall back to cmd /c.
      let launcherForSpawn = options.launcherPath;
      if (isWindows() && options.launcherPath.toLowerCase().endsWith(".cmd")) {
        const cjsSibling = options.launcherPath.replace(/\.cmd$/i, ".cjs");
        if (existsSync(cjsSibling)) {
          launcherForSpawn = cjsSibling;
        } else {
          return {
            command: "cmd.exe",
            args: ["/c", options.launcherPath],
            env: { ...mcpEnv },
          };
        }
      }

      const launch = resolveMcpNodeLaunch({
        ...(options.nodeCommand !== undefined ? { nodeCommand: options.nodeCommand } : {}),
        ...(options.electronExecPath !== undefined ? { electronExecPath: options.electronExecPath } : {}),
      });
      return {
        command: launch.command,
        args: [launcherForSpawn],
        env: { ...mcpEnv, ...launch.env },
      };
    }

    const launch = resolveMcpNodeLaunch({
      ...(options.nodeCommand !== undefined ? { nodeCommand: options.nodeCommand } : {}),
      ...(options.electronExecPath !== undefined ? { electronExecPath: options.electronExecPath } : {}),
    });
    return {
      command: launch.command,
      args: [options.bundledServerPath],
      cwd: runtimeRoot,
      env: { ...mcpEnv, ...launch.env },
    };
  }

  if (options.strategy === "npm-script") {
    const npmCmd = isWindows() ? "npm.cmd" : "npm";
    return {
      command: npmCmd,
      args: ["run", "start:mcp"],
      cwd: options.npmScriptCwd ?? cwd,
      env: {},
    };
  }

  // npx 策略：不硬编码绝对路径 cwd（跨机器无效）。
  // 写入 Cursor/VS Code 可展开的 ${workspaceFolder}，让 MCP 子进程拿到真实项目根。
  // 不支持插值的宿主会留下字面量；discover-workspace 会忽略 unresolved placeholder
  // 并回退到 WORKSPACE_FOLDER_PATHS / rootDir。
  // Codex 不支持 ${workspaceFolder}，由 omitWorkspaceFolderPlaceholder 跳过。
  const npxEnv: Record<string, string> = {
    ...MCP_STDIO_ENV,
  };
  if (!options.omitWorkspaceFolderPlaceholder) {
    npxEnv.GRAPHFLOW_WORKSPACE_ROOT = "${workspaceFolder}";
  }

  const winNpx = resolveWindowsNpxLaunch({
    ...(options.windowsHost !== undefined ? { windowsHost: options.windowsHost } : {}),
    ...(options.windowsNodePath !== undefined ? { windowsNodePath: options.windowsNodePath } : {}),
    ...(options.windowsNpxCliPath !== undefined ? { windowsNpxCliPath: options.windowsNpxCliPath } : {}),
  });
  if (winNpx) {
    return {
      command: winNpx.command,
      args: winNpx.args,
      env: { ...npxEnv, ...winNpx.env },
    };
  }

  const npxCmd = isWindows() || options.windowsHost ? "npx.cmd" : "npx";
  return {
    command: npxCmd,
    args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
    env: npxEnv,
  };
}

function uniqueTargets(
  targets: Array<{
    configPath: string;
    serversKey: McpServersKey;
    configFormat: McpConfigFormat;
    scope: "user" | "workspace";
  }>
): Array<{
  configPath: string;
  serversKey: McpServersKey;
  configFormat: McpConfigFormat;
  scope: "user" | "workspace";
}> {
  const seen = new Set<string>();
  const unique: Array<{
    configPath: string;
    serversKey: McpServersKey;
    configFormat: McpConfigFormat;
    scope: "user" | "workspace";
  }> = [];
  for (const target of targets) {
    const key = `${target.configPath}::${target.serversKey}::${target.configFormat}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function resolveTargetsForAgents(
  agentIds: Set<string>,
  workspaceRoot: string | undefined,
  installScope: McpInstallScope
): Array<{
  agentId: string;
  agentName: string;
  configPath: string;
  serversKey: McpServersKey;
  configFormat: McpConfigFormat;
  scope: "user" | "workspace";
}> {
  const profiles = buildAgentProfiles();
  const targets: Array<{
    agentId: string;
    agentName: string;
    configPath: string;
    serversKey: McpServersKey;
    configFormat: McpConfigFormat;
    scope: "user" | "workspace";
  }> = [];

  for (const profile of profiles) {
    if (!agentIds.has(profile.id)) {
      continue;
    }

    for (const userTarget of profile.userTargets) {
      targets.push({
        agentId: profile.id,
        agentName: profile.name,
        configPath: userTarget.configPath,
        serversKey: userTarget.serversKey,
        configFormat: userTarget.configFormat ?? "json",
        scope: "user",
      });
    }

    if (installScope === "all" && workspaceRoot && profile.workspaceRelativePaths) {
      for (const workspaceTarget of profile.workspaceRelativePaths) {
        targets.push({
          agentId: profile.id,
          agentName: profile.name,
          configPath: join(workspaceRoot, workspaceTarget.relativePath),
          serversKey: workspaceTarget.serversKey,
          configFormat: workspaceTarget.configFormat ?? "json",
          scope: "workspace",
        });
      }
    }
  }

  return uniqueTargets(targets).map((target) => {
    const profile = profiles.find((item) =>
      item.userTargets.some((userTarget) => userTarget.configPath === target.configPath) ||
      item.workspaceRelativePaths?.some(
        (workspaceTarget) => workspaceRoot && join(workspaceRoot, workspaceTarget.relativePath) === target.configPath
      )
    );
    return {
      agentId: profile?.id ?? "unknown",
      agentName: profile?.name ?? "Unknown",
      ...target,
    };
  });
}

function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Existing config is corrupt (manual edit, encoding issue, etc).
    // Back it up and start fresh so registration can proceed instead of failing.
    try {
      const backupPath = `${path}.bak-${Date.now()}`;
      writeFileSync(backupPath, raw, "utf8");
    } catch {
      // Ignore backup failure — proceed with reset
    }
    return {};
  }
}

function writeJsonConfig(path: string, json: Record<string, unknown>): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function removeCodexMcpSection(content: string, serverName: string): string {
  // Remove [mcp_servers.serverName] and [mcp_servers.serverName.env] sections
  const blockPattern = new RegExp(
    `\\n?\\[mcp_servers\\.${escapeRegExp(serverName)}(?:\\.[^\\]]+)?\\][^\\[]*`,
    "g"
  );
  let cleaned = content.replace(blockPattern, "").trimEnd();

  // Remove orphaned lines from previous buggy injections — any line that starts with
  // an array value (["..."]) followed by "enabled = true" and "startup_timeout_sec = 120".
  // These occur when the TOML args array was written without its section header.
  // This handles npx entries, npm-script entries, and node-bundled entries.
  const orphanPattern = new RegExp(
    `\\n?\\["[^\\]]*\\]\\s*\\n\\s*enabled\\s*=\\s*true\\s*\\n\\s*startup_timeout_sec\\s*=\\s*\\d+`,
    "g"
  );
  cleaned = cleaned.replace(orphanPattern, "").trimEnd();

  return cleaned;
}

function formatOpencodeMcpEntry(node: McpServerNode): OpencodeMcpServerNode {
  const environment: Record<string, string> = { ...(node.env ?? {}) };
  // Remove key that opencode reads natively; avoid duplication
  delete environment.GRAPHFLOW_MCP_STDIO;
  return {
    command: [node.command, ...node.args],
    enabled: true,
    environment,
    type: "local",
  };
}

function injectIntoOpencodeConfig(
  configPath: string,
  serverName: string,
  node: McpServerNode
): "injected" | "created" | "updated" {
  const existed = existsSync(configPath);
  const json = readJsonConfig(configPath);
  const servers = (json.mcp as Record<string, OpencodeMcpServerNode> | undefined) ?? {};
  const serverExisted = !!servers[serverName];
  servers[serverName] = formatOpencodeMcpEntry(node);
  json.mcp = servers;
  writeJsonConfig(configPath, json);
  if (!existed) return "created";
  if (!serverExisted) return "injected";
  return "updated";
}

function removeOpencodeMcpEntry(
  configPath: string,
  serverName: string
): boolean {
  if (!existsSync(configPath)) {
    return false;
  }
  const json = readJsonConfig(configPath);
  const servers = (json.mcp as Record<string, OpencodeMcpServerNode> | undefined) ?? {};
  if (!servers[serverName]) {
    return false;
  }
  delete servers[serverName];
  if (Object.keys(servers).length === 0) {
    delete json.mcp;
  } else {
    json.mcp = servers;
  }
  writeJsonConfig(configPath, json);
  return true;
}

function isOpencodeMcpInstalled(
  configPath: string,
  serverName: string
): boolean {
  if (!existsSync(configPath)) {
    return false;
  }
  const json = readJsonConfig(configPath);
  const servers = (json.mcp as Record<string, OpencodeMcpServerNode> | undefined) ?? {};
  return !!servers[serverName];
}

function formatCodexMcpTomlBlock(serverName: string, node: McpServerNode): string {
  const args =
    node.args.length > 0 ? `args = [${node.args.map((arg) => JSON.stringify(arg)).join(", ")}]` : undefined;
  const lines = [
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(node.command)}`,
    ...(args ? [args] : []),
    "enabled = true",
    "startup_timeout_sec = 120",
  ];
  if (node.env && Object.keys(node.env).length > 0) {
    lines.push("", `[mcp_servers.${serverName}.env]`);
    for (const [key, value] of Object.entries(node.env)) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

function injectIntoCodexToml(
  configPath: string,
  serverName: string,
  node: McpServerNode
): "injected" | "created" | "updated" {
  const existed = existsSync(configPath);
  const previous = existed ? readFileSync(configPath, "utf8") : "";
  const serverExisted = existed && new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`, "m").test(previous);
  const cleaned = removeCodexMcpSection(previous, serverName);
  const block = formatCodexMcpTomlBlock(serverName, node);
  const next = cleaned.length > 0 ? `${cleaned}\n\n${block}\n` : `${block}\n`;
  const dir = dirname(configPath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, next, "utf8");
  if (!existed) return "created";
  if (!serverExisted) return "injected";
  return "updated";
}

function injectIntoAgentConfig(
  configPath: string,
  serversKey: McpServersKey,
  configFormat: McpConfigFormat,
  serverName: string,
  node: McpServerNode
): "injected" | "created" | "updated" {
  if (configFormat === "codex-toml") {
    return injectIntoCodexToml(configPath, serverName, node);
  }
  if (configFormat === "opencode") {
    return injectIntoOpencodeConfig(configPath, serverName, node);
  }
  return injectIntoConfig(configPath, serversKey, serverName, node);
}

function injectIntoConfig(
  configPath: string,
  serversKey: McpServersKey,
  serverName: string,
  node: McpServerNode
): "injected" | "created" | "updated" {
  const existed = existsSync(configPath);
  const json = readJsonConfig(configPath);
  const servers = (json[serversKey] as Record<string, McpServerNode> | undefined) ?? {};

  const serverExisted = !!servers[serverName];
  const previous = servers[serverName];

  // Merge env: start with previous user env, override with new env.
  // Clean up stale env vars that should not persist across strategy changes.
  const mergedEnv: Record<string, string> = {
    ...(previous?.env ?? {}),
    ...(node.env ?? {}),
  };
  // Clean up stale ELECTRON_RUN_AS_NODE when the new command no longer needs it
  // (e.g. switched from Electron fallback to system Node).
  if (!node.env?.ELECTRON_RUN_AS_NODE) {
    delete mergedEnv.ELECTRON_RUN_AS_NODE;
  }
  // Clean up stale GRAPHFLOW_WORKSPACE_ROOT when the new config doesn't include it
  // (e.g. switched from npx with ${workspaceFolder} to node-bundled without cwd).
  if (!node.env?.GRAPHFLOW_WORKSPACE_ROOT) {
    delete mergedEnv.GRAPHFLOW_WORKSPACE_ROOT;
  }

  servers[serverName] = sanitizeMcpServerNodeForWindowsClients({
    ...previous,
    ...node,
    ...(previous?.args && !node.args?.length ? { args: previous.args } : {}),
    ...(previous?.command && !node.command ? { command: previous.command } : {}),
    env: mergedEnv,
  });
  if (!Object.prototype.hasOwnProperty.call(node, "cwd")) {
    delete servers[serverName].cwd;
  }
  json[serversKey] = servers;
  writeJsonConfig(configPath, json);
  
  if (!existed) return "created";
  if (!serverExisted) return "injected";
  return "updated";
}

/** 从 JSON 配置文件中移除指定 MCP 服务器的配置条目 */
export function removeMcpEntry(
  configPath: string,
  serversKey: McpServersKey,
  serverName: string
): boolean {
  if (!existsSync(configPath)) {
    return false;
  }
  const json = readJsonConfig(configPath);
  const servers = (json[serversKey] as Record<string, McpServerNode> | undefined) ?? {};
  if (!servers[serverName]) {
    return false;
  }
  delete servers[serverName];
  if (Object.keys(servers).length === 0) {
    delete json[serversKey];
  } else {
    json[serversKey] = servers;
  }
  writeJsonConfig(configPath, json);
  return true;
}

/** 从 Codex TOML 配置文件中移除指定 MCP 服务器的配置条目 */
export function removeCodexMcpEntry(
  configPath: string,
  serverName: string
): boolean {
  if (!existsSync(configPath)) {
    return false;
  }
  const content = readFileSync(configPath, "utf8");
  const existed = new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`, "m").test(content);
  if (!existed) {
    return false;
  }
  const cleaned = removeCodexMcpSection(content, serverName);
  writeFileSync(configPath, cleaned.length > 0 ? `${cleaned}\n` : "", "utf8");
  return true;
}

export function installMcpToDetectedAgents(options: McpInstallOptions): McpInstallResult[] {
  const agentIds = new Set(
    options.agentIdsOverride ?? detectInstalledAgents().map((agent) => agent.id)
  );
  const serverName = options.serverName ?? "graphflow";
  const results: McpInstallResult[] = [];

  if (agentIds.size === 0) {
    return [
      {
        agentId: "none",
        agentName: "None",
        configPath: "",
        scope: "user",
        status: "skipped",
        message: "No supported agent tools detected on this machine.",
      },
    ];
  }

  const installScope = options.installScope ?? "user";
  const targets = resolveTargetsForAgents(agentIds, options.workspaceRoot, installScope);
  for (const target of targets) {
    try {
      const { workspaceRoot, ...restOptions } = options;
      const windowsHost =
        Boolean(restOptions.windowsHost) ||
        isWindows() ||
        target.agentId.endsWith("-windows");
      const isCodex = target.configFormat === "codex-toml";
      const node = buildMcpServerNode(
        target.scope === "workspace" && workspaceRoot
          ? {
              ...restOptions,
              workspaceRoot,
              windowsHost,
              omitWorkspaceFolderPlaceholder:
                Boolean(restOptions.omitWorkspaceFolderPlaceholder) || isCodex,
            }
          : {
              ...restOptions,
              windowsHost,
              omitWorkspaceFolderPlaceholder:
                Boolean(restOptions.omitWorkspaceFolderPlaceholder) || isCodex,
            }
      );
      const status = injectIntoAgentConfig(
        target.configPath,
        target.serversKey,
        target.configFormat,
        serverName,
        node
      );
      results.push({
        agentId: target.agentId,
        agentName: target.agentName,
        configPath: target.configPath,
        scope: target.scope,
        status,
      });
    } catch (error) {
      results.push({
        agentId: target.agentId,
        agentName: target.agentName,
        configPath: target.configPath,
        scope: target.scope,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export interface McpRemoveOptions {
  /** 仅移除指定 agent 的 MCP 配置（不传则移除所有检测到的 agent） */
  agentId?: string;
  serverName?: string;
  /** When set, also remove workspace-scoped MCP configs under this root. */
  workspaceRoot?: string;
}

export interface McpRemoveResult {
  agentId: string;
  agentName: string;
  configPath: string;
  removed: boolean;
  message?: string;
  scope?: "user" | "workspace";
}

/** 从所有检测到的 agent 中移除 GraphFlow MCP 配置（user + optional workspace） */
export function uninstallMcpFromDetectedAgents(options?: McpRemoveOptions): McpRemoveResult[] {
  const profiles = buildAgentProfiles();
  const detectedIds = new Set(detectInstalledAgents().map((agent) => agent.id));
  const serverName = options?.serverName ?? "graphflow";
  const targetAgentId = options?.agentId;
  const workspaceRoot = options?.workspaceRoot?.trim() || process.cwd();
  const results: McpRemoveResult[] = [];

  for (const profile of profiles) {
    // 如果指定了 agent，则仅处理该 agent
    if (targetAgentId && profile.id !== targetAgentId) {
      continue;
    }
    if (!detectedIds.has(profile.id)) {
      continue;
    }

    const seen = new Set<string>();
    for (const userTarget of profile.userTargets) {
      const key = `${userTarget.configPath}::${userTarget.serversKey}::${userTarget.configFormat ?? "json"}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      try {
        let removed = false;
        if (userTarget.configFormat === "codex-toml") {
          removed = removeCodexMcpEntry(userTarget.configPath, serverName);
        } else if (userTarget.configFormat === "opencode") {
          removed = removeOpencodeMcpEntry(userTarget.configPath, serverName);
        } else {
          removed = removeMcpEntry(userTarget.configPath, userTarget.serversKey, serverName);
        }
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          configPath: userTarget.configPath,
          removed,
          scope: "user",
          message: removed ? "已移除" : "未找到配置（可能已移除）",
        });
      } catch (error) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          configPath: userTarget.configPath,
          removed: false,
          scope: "user",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (workspaceRoot && profile.workspaceRelativePaths) {
      for (const workspaceTarget of profile.workspaceRelativePaths) {
        const configPath = join(workspaceRoot, workspaceTarget.relativePath);
        const key = `${configPath}::${workspaceTarget.serversKey}::${workspaceTarget.configFormat ?? "json"}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (!existsSync(configPath)) {
          continue;
        }
        try {
          let removed = false;
          if (workspaceTarget.configFormat === "codex-toml") {
            removed = removeCodexMcpEntry(configPath, serverName);
          } else if (workspaceTarget.configFormat === "opencode") {
            removed = removeOpencodeMcpEntry(configPath, serverName);
          } else {
            removed = removeMcpEntry(configPath, workspaceTarget.serversKey, serverName);
          }
          results.push({
            agentId: profile.id,
            agentName: `${profile.name} (workspace)`,
            configPath,
            removed,
            scope: "workspace",
            message: removed ? "已移除" : "未找到配置（可能已移除）",
          });
        } catch (error) {
          results.push({
            agentId: profile.id,
            agentName: `${profile.name} (workspace)`,
            configPath,
            removed: false,
            scope: "workspace",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  return results;
}

export function formatModelConfigGuide(workspaceRoot?: string): string {
  const root = workspaceRoot ?? process.cwd();
  return [
    "# GraphFlow 模型配置指南",
    "",
    "## 1. 打开设置面板",
    "在 VS Code 命令面板运行：`GraphFlow: Settings`",
    "",
    "## 2. 配置 LLM Provider（规划 / 执行任务）",
    "- 在设置面板的 Smart / Economy 层分别选择 provider（如 deepseek / openai / anthropic / bailian / doubao）",
    "- API Key：填环境变量名（如 `DEEPSEEK_API_KEY`）、`${DEEPSEEK_API_KEY}`、或直接 `sk-...`",
    "- Base URL：每层卡片内直接填写（如 DeepSeek 使用 `https://api.deepseek.com`）",
    "- Smart / Economy 模型均可选；留空则使用 provider 默认路由",
    "",
    "## 3. 知识图谱何时更新？",
    "- **结构索引**（Symbol/File/边）：在 MCP `preview`、任务 `run`（`autoIndexOnPreview` / `autoIndexOnRun`）、`index`/`rebuild` 命令时触发，非常驻后台守护进程",
    "",
    "## 4. 配置文件位置",
    "- 全局默认（推荐，一次配置所有项目可用）：`~/.graphflow.config.json`",
    `- 项目根目录（可选覆盖）：\`${join(root, "graphflow.config.json")}\``,
    `- 项目覆盖层（可选）：\`${join(root, ".graphflow", "config.json")}\``,
    "",
    "## 5. 验证 MCP",
    "在 Cursor / Claude Code / VS Code / Trae / Codex 对话框中说：",
    '> "使用 graphflow 预览当前项目的 orchestrator 相关上下文"',
    "",
    "Codex 配置写入 `~/.codex/config.toml` 的 `[mcp_servers.graphflow]`；Trae 写入 `User/mcp.json`。",
    "Windows 上 Codex 使用 node.exe + npx-cli.js，并写入 NODE / NPX_CLI（优先 8.3 短路径，如 C:\\PROGRA~1\\nodejs\\...）。",
    "",
    "## 6. 验证路由",
    "运行 `GraphFlow: Settings` 保存后，在 Chat 输入 `@graphflow /diagnose` 查看 provider 健康状态。",
  ].join("\n");
}
