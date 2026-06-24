import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type McpServersKey = "mcpServers" | "servers";

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

interface AgentProfile {
  id: string;
  name: string;
  markerPaths: string[];
  userTargets: Array<{ configPath: string; serversKey: McpServersKey; configFormat?: McpConfigFormat }>;
  workspaceRelativePaths?: Array<{ relativePath: string; serversKey: McpServersKey; configFormat?: McpConfigFormat }>;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function resolveHomePaths(): { home: string; appData: string; localAppData: string } {
  const home = homedir();
  const appData = process.env.APPDATA ?? (isWindows() ? join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA ?? (isWindows() ? join(home, "AppData", "Local") : "");
  return { home, appData, localAppData };
}

function buildAgentProfiles(): AgentProfile[] {
  const { home, appData, localAppData } = resolveHomePaths();

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
        join(appData, "Trae"),
        join(localAppData, "Programs", "Trae"),
      ],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Trae", "User", "mcp.json")
            : join(home, ".config", "Trae", "User", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "claude-code",
      name: "Claude Code",
      markerPaths: [
        join(home, ".claude"),
        join(appData, "Claude"),
        join(appData, "Claude Code"),
      ],
      userTargets: [
        { configPath: join(home, ".claude", "mcp.json"), serversKey: "mcpServers" },
        {
          configPath: isWindows() ? join(appData, "Claude Code", "mcp.json") : join(home, ".claude", "mcp.json"),
          serversKey: "mcpServers",
        },
      ],
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
        join(appData, "Code", "User", "globalStorage", "roval.vscode-roo-cline"),
        join(appData, "Cursor", "User", "globalStorage", "roval.vscode-roo-cline"),
        join(home, ".config", "Code", "User", "globalStorage", "roval.vscode-roo-cline"),
      ],
      userTargets: [
        {
          configPath: isWindows()
            ? join(appData, "Code", "User", "globalStorage", "roval.vscode-roo-cline", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Code", "User", "globalStorage", "roval.vscode-roo-cline", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
        {
          configPath: isWindows()
            ? join(appData, "Cursor", "User", "globalStorage", "roval.vscode-roo-cline", "settings", "cline_mcp_settings.json")
            : join(home, ".config", "Cursor", "User", "globalStorage", "roval.vscode-roo-cline", "settings", "cline_mcp_settings.json"),
          serversKey: "mcpServers",
        },
      ],
    },
    {
      id: "gemini",
      name: "Gemini",
      markerPaths: [
        join(home, ".gemini", "antigravity"),
      ],
      userTargets: [
        {
          configPath: join(home, ".gemini", "antigravity", "mcp.json"),
          serversKey: "mcpServers",
        },
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
  ];

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

export function resolveSystemNodeCommand(): string | undefined {
  try {
    const lookup = isWindows() ? "where.exe" : "which";
    const target = isWindows() ? "node.exe" : "node";
    const output = execFileSync(lookup, [target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0);
    return firstLine?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveMcpNodeLaunch(options: {
  nodeCommand?: string;
  electronExecPath?: string;
}): { command: string; env: Record<string, string> } {
  const explicitNode = options.nodeCommand?.trim();
  const systemNode = explicitNode || resolveSystemNodeCommand();
  if (systemNode) {
    return { command: systemNode, env: { ...MCP_STDIO_ENV } };
  }

  const electronExecPath = options.electronExecPath ?? process.execPath;
  return {
    command: electronExecPath,
    env: {
      ...MCP_STDIO_ENV,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
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
  const mcpEnv: Record<string, string> = {
    ...MCP_STDIO_ENV,
    ...(options.workspaceRoot ? { GRAPHFLOW_WORKSPACE_ROOT: options.workspaceRoot } : {}),
  };

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
          cwd: runtimeRoot,
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
        cwd: runtimeRoot,
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

  if (isWindows()) {
    const winNpx = resolveWindowsNpxLaunch();
    if (winNpx) {
      return {
        command: winNpx.command,
        args: winNpx.args,
        ...(options.workspaceRoot ? { cwd: options.workspaceRoot } : {}),
        env: { ...mcpEnv },
      };
    }
  }

  const npxCmd = isWindows() ? "npx.cmd" : "npx";
  return {
    command: npxCmd,
    args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
    ...(options.workspaceRoot ? { cwd: options.workspaceRoot } : {}),
    env: { ...mcpEnv },
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
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJsonConfig(path: string, json: Record<string, unknown>): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function removeCodexMcpSection(content: string, serverName: string): string {
  const blockPattern = new RegExp(
    `\\n?\\[mcp_servers\\.${escapeRegExp(serverName)}(?:\\.[^\\]]+)?\\][^\\[]*`,
    "g"
  );
  return content.replace(blockPattern, "").trimEnd();
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
  servers[serverName] = node;
  json[serversKey] = servers;
  writeJsonConfig(configPath, json);
  
  if (!existed) return "created";
  if (!serverExisted) return "injected";
  return "updated";
}

export function installMcpToDetectedAgents(options: McpInstallOptions): McpInstallResult[] {
  const agentIds = new Set(
    options.agentIdsOverride ?? detectInstalledAgents().map((agent) => agent.id)
  );
  const serverName = options.serverName ?? "graphflow";
  const node = buildMcpServerNode(options);
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
    "## 3. 知识图谱语义提取（可选）",
    "- Settings → **Graph Semantic Enrichment** → 语义提取后端：",
    "  - **继承 Economy（网络）**：使用 Economy 的云端模型（如 DeepSeek）",
    "  - **自定义网络模型**：单独指定 Provider / Model / API Key / Base URL",
    "  - **本地 OpenBMB**：使用本地 MiniCPM",
    "",
    "## 4. 知识图谱何时更新？",
    "- **结构索引**（Symbol/File/边）：在 MCP `preview`、任务 `run`（`autoIndexOnPreview` / `autoIndexOnRun`）、`index`/`rebuild` 命令时触发，非常驻后台守护进程",
    "- **语义富化**（Symbol 中文摘要）：索引后若 `semanticEnrichment.autoRunOnIndex=true` 则静默小批量执行；任务编排改文件后也会增量富化；也可手动 `Enrich Graph Semantics`",
    "",
    "## 5. 配置文件位置",
    "- 全局默认（推荐，一次配置所有项目可用）：`~/.graphflow.config.json`",
    `- 项目根目录（可选覆盖）：\`${join(root, "graphflow.config.json")}\``,
    `- 项目覆盖层（可选）：\`${join(root, ".graphflow", "config.json")}\``,
    "",
    "## 6. OpenBMB 本地模型（可选）",
    "- 在设置面板启用 OpenBMB auto-download，或运行 `GraphFlow: Download MiniCPM Model`",
    "- 然后运行 `GraphFlow: Enrich Graph Semantics` 验证本地推理路径",
    "",
    "## 7. 验证 MCP",
    "在 Cursor / Claude Code / VS Code / Trae / Codex 对话框中说：",
    '> "使用 graphflow 预览当前项目的 orchestrator 相关上下文"',
    "",
    "Codex 配置写入 `~/.codex/config.toml` 的 `[mcp_servers.graphflow]`；Trae 写入 `User/mcp.json`。",
    "",
    "## 8. 验证路由",
    "运行 `GraphFlow: Settings` 保存后，在 Chat 输入 `@graphflow /diagnose` 查看 provider 健康状态。",
  ].join("\n");
}
