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

export interface McpInstallOptions {
  strategy: McpInstallStrategy;
  workspaceRoot?: string;
  npmScriptCwd?: string;
  bundledServerPath?: string;
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
  status: "injected" | "created" | "skipped" | "error";
  message?: string;
}

interface AgentProfile {
  id: string;
  name: string;
  markerPaths: string[];
  userTargets: Array<{ configPath: string; serversKey: McpServersKey }>;
  workspaceRelativePaths?: Array<{ relativePath: string; serversKey: McpServersKey }>;
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

  return [
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
      markerPaths: [join(appData, "Trae"), join(localAppData, "Programs", "Trae")],
      userTargets: [
        { configPath: join(appData, "Trae", "User", "mcp.json"), serversKey: "mcpServers" },
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
  ];
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

export function buildMcpServerNode(options: McpInstallOptions): McpServerNode {
  const cwd = options.workspaceRoot ?? options.npmScriptCwd ?? process.cwd();

  if (options.strategy === "node-bundled") {
    if (!options.bundledServerPath) {
      throw new Error("bundledServerPath is required for node-bundled strategy");
    }
    const runtimeRoot =
      options.bundledRuntimeRoot ?? join(options.bundledServerPath, "..", "..", "..");
    const launch = resolveMcpNodeLaunch({
      ...(options.nodeCommand !== undefined ? { nodeCommand: options.nodeCommand } : {}),
      ...(options.electronExecPath !== undefined ? { electronExecPath: options.electronExecPath } : {}),
    });
    return {
      command: launch.command,
      args: [options.bundledServerPath],
      cwd: runtimeRoot,
      env: launch.env,
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

  const npxCmd = isWindows() ? "npx.cmd" : "npx";
  return {
    command: npxCmd,
    args: ["-y", "graphflow-mcp"],
    ...(options.workspaceRoot ? { cwd: options.workspaceRoot } : {}),
    env: {},
  };
}

function uniqueTargets(
  targets: Array<{ configPath: string; serversKey: McpServersKey; scope: "user" | "workspace" }>
): Array<{ configPath: string; serversKey: McpServersKey; scope: "user" | "workspace" }> {
  const seen = new Set<string>();
  const unique: Array<{ configPath: string; serversKey: McpServersKey; scope: "user" | "workspace" }> = [];
  for (const target of targets) {
    const key = `${target.configPath}::${target.serversKey}`;
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
  workspaceRoot?: string
): Array<{ agentId: string; agentName: string; configPath: string; serversKey: McpServersKey; scope: "user" | "workspace" }> {
  const profiles = buildAgentProfiles();
  const targets: Array<{
    agentId: string;
    agentName: string;
    configPath: string;
    serversKey: McpServersKey;
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
        scope: "user",
      });
    }

    if (workspaceRoot && profile.workspaceRelativePaths) {
      for (const workspaceTarget of profile.workspaceRelativePaths) {
        targets.push({
          agentId: profile.id,
          agentName: profile.name,
          configPath: join(workspaceRoot, workspaceTarget.relativePath),
          serversKey: workspaceTarget.serversKey,
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

function injectIntoConfig(
  configPath: string,
  serversKey: McpServersKey,
  serverName: string,
  node: McpServerNode
): "injected" | "created" {
  const existed = existsSync(configPath);
  const json = readJsonConfig(configPath);
  const servers = (json[serversKey] as Record<string, McpServerNode> | undefined) ?? {};
  servers[serverName] = node;
  json[serversKey] = servers;
  writeJsonConfig(configPath, json);
  return existed ? "injected" : "created";
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

  const targets = resolveTargetsForAgents(agentIds, options.workspaceRoot);
  for (const target of targets) {
    try {
      const status = injectIntoConfig(target.configPath, target.serversKey, serverName, node);
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
    "- 在设置面板选择 provider（如 openai / anthropic / bailian / doubao）",
    "- 填写 API Key 对应的环境变量名（如 `DEEPSEEK_API_KEY`）",
    "- 如使用 DeepSeek 等 OpenAI 兼容接口，填写 Base URL（如 `https://api.deepseek.com`）",
    "- `smart` 模型用于 Planner/Validator；`economy` 模型用于 Worker",
    "",
    "## 3. 配置文件位置",
    `- 项目根目录：\`${join(root, "graphflow.config.json")}\``,
    `- 覆盖层：\`${join(root, ".graphflow", "config.json")}\``,
    "",
    "## 4. 语义增强（可选，本地 MiniCPM）",
    "- 在设置面板启用 OpenBMB auto-download，或运行 `GraphFlow: Download MiniCPM Model`",
    "- 然后运行 `GraphFlow: Enrich Graph Semantics` 验证本地推理路径",
    "",
    "## 5. 验证 MCP",
    "在 Cursor / Claude Code / VS Code Agent 对话框中说：",
    '> "使用 graphflow 预览当前项目的 orchestrator 相关上下文"',
    "",
    "## 6. 验证路由",
    "运行 `GraphFlow: Settings` 保存后，在 Chat 输入 `@graphflow /diagnose` 查看 provider 健康状态。",
  ].join("\n");
}
