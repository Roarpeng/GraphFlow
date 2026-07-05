import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, release } from "node:os";

export type McpServersKey = "mcpServers" | "servers" | "context_servers";

export interface McpServerNode {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
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

export type McpConfigFormat = "json" | "codex-toml";

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
      // Claude Code stores user-scope MCP servers under the top-level `mcpServers`
      // key of ~/.claude.json. Per official docs it does NOT read ~/.claude/mcp.json
      // or %APPDATA%/Claude*/mcp.json, so those legacy paths are intentionally dropped.
      markerPaths: [
        join(home, ".claude"),
        join(home, ".claude.json"),
      ],
      userTargets: [
        { configPath: join(home, ".claude.json"), serversKey: "mcpServers" },
      ],
      // Project scope is shared via <project>/.mcp.json (top-level `mcpServers`).
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
      // Gemini CLI reads MCP servers from the `mcpServers` object in settings.json.
      // User scope: ~/.gemini/settings.json; project scope: <project>/.gemini/settings.json.
      // Shared Antigravity toolchain: ~/.gemini/config/mcp_config.json (optional).
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
    // ─── 实验性支持 ───
    {
      id: "antigravity",
      name: "Antigravity",
      // Google Antigravity MCP: ~/.gemini/antigravity/mcp_config.json (mcpServers key).
      // Shared config across Antigravity products: ~/.gemini/config/mcp_config.json.
      // Project scope: .agents/mcp_config.json
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
      // Zed 已在 v0.165+ 支持 MCP（称为 "context servers"）
      // 配置格式: settings.json 中的 "context_servers" 键
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
      // Continue 是 VS Code / JetBrains 的 AI 编程助手扩展
      // MCP 配置写入 ~/.continue/config.yaml 中的 "mcpServers" 节
      // 注意：Continue 的 config.yaml 格式为 YAML，当前实现仅支持 JSON
      // 如需完整支持，需额外添加 YAML 读写逻辑
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
    return { command: explicitNode, env: { ...MCP_STDIO_ENV } };
  }

  // 2. System Node — preferred over Electron because:
  //    - Path is stable across IDE updates
  //    - No need for ELECTRON_RUN_AS_NODE which may not be forwarded by all MCP clients
  //    - Better compatibility with MCP client spawn logic
  const systemNode = resolveSystemNodeCommand();
  if (systemNode && systemNode !== "node") {
    return { command: systemNode, env: { ...MCP_STDIO_ENV } };
  }

  // 3. Electron fallback — when system Node is unavailable, use the IDE's bundled Electron
  const electronExecPath = options.electronExecPath?.trim();
  if (electronExecPath && existsSync(electronExecPath)) {
    return {
      command: electronExecPath,
      env: {
        ...MCP_STDIO_ENV,
        ELECTRON_RUN_AS_NODE: "1",
      },
    };
  }

  // 4. Last resort: bare "node" (relies on PATH resolution at MCP launch time)
  return { command: "node", env: { ...MCP_STDIO_ENV } };
}

function resolveWindowsNpxLaunch(): { command: string; args: string[] } | undefined {
  const node = resolveSystemNodeCommand();
  if (!node) {
    return undefined;
  }
  const nodeDir = dirname(node);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  for (const npxCli of candidates) {
    if (existsSync(npxCli)) {
      return {
        command: node,
        args: [npxCli, "-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      };
    }
  }
  return undefined;
}

export function buildMcpServerNode(options: McpInstallOptions): McpServerNode {
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
      if (isWindows() && options.launcherPath.toLowerCase().endsWith(".cmd")) {
        return {
          command: options.launcherPath,
          args: [],
          env: { ...mcpEnv },
        };
      }

      const launch = resolveMcpNodeLaunch({
        ...(options.nodeCommand !== undefined ? { nodeCommand: options.nodeCommand } : {}),
        ...(options.electronExecPath !== undefined ? { electronExecPath: options.electronExecPath } : {}),
      });
      return {
        command: launch.command,
        args: [options.launcherPath],
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

  // npx 策略：不在 MCP 配置中硬编码 cwd 和 GRAPHFLOW_WORKSPACE_ROOT。
  // MCP client 会使用自己的 cwd 启动进程，MCP server 启动后通过 discover-workspace.ts 自动检测工作区。
  // 硬编码 Linux 风格的 /repo 占位符在 Windows 上无效，会导致启动失败。
  const npxEnv: Record<string, string> = { ...MCP_STDIO_ENV };

  if (isWindows()) {
    const winNpx = resolveWindowsNpxLaunch();
    if (winNpx) {
      return {
        command: winNpx.command,
        args: winNpx.args,
        env: npxEnv,
      };
    }
  }

  const npxCmd = isWindows() ? "npx.cmd" : "npx";
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

  servers[serverName] = {
    ...previous,
    ...node,
    ...(previous?.args && !node.args?.length ? { args: previous.args } : {}),
    ...(previous?.command && !node.command ? { command: previous.command } : {}),
    env: mergedEnv,
  };
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
      const node = buildMcpServerNode(
        target.scope === "workspace" && workspaceRoot
          ? { ...restOptions, workspaceRoot }
          : restOptions
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
}

export interface McpRemoveResult {
  agentId: string;
  agentName: string;
  configPath: string;
  removed: boolean;
  message?: string;
}

/** 从所有检测到的 agent 中移除 GraphFlow MCP 配置 */
export function uninstallMcpFromDetectedAgents(options?: McpRemoveOptions): McpRemoveResult[] {
  const profiles = buildAgentProfiles();
  const detectedIds = new Set(detectInstalledAgents().map((agent) => agent.id));
  const serverName = options?.serverName ?? "graphflow";
  const targetAgentId = options?.agentId;
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
        } else {
          removed = removeMcpEntry(userTarget.configPath, userTarget.serversKey, serverName);
        }
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          configPath: userTarget.configPath,
          removed,
          message: removed ? "已移除" : "未找到配置（可能已移除）",
        });
      } catch (error) {
        results.push({
          agentId: profile.id,
          agentName: profile.name,
          configPath: userTarget.configPath,
          removed: false,
          message: error instanceof Error ? error.message : String(error),
        });
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
    "- 在设置面板的 Smart / Economy 层分别选择 provider（如 openai / anthropic / bailian / doubao）",
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
    "",
    "## 6. 验证路由",
    "运行 `GraphFlow: Settings` 保存后，在 Chat 输入 `@graphflow /diagnose` 查看 provider 健康状态。",
  ].join("\n");
}
