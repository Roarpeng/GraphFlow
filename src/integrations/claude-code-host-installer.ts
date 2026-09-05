/**
 * Claude Code HostAdapter install slice.
 *
 * Composes existing MCP + CLAUDE.md + skill + hooks installers. Isolated
 * `home` / GRAPHFLOW_CLAUDE_HOME treats that directory as `~/.claude` and
 * writes MCP to the sibling `.claude.json` so tests match production layout.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildMcpServerNode,
  detectInstalledAgents,
  getMcpInstallStatus,
  installMcpToDetectedAgents,
  removeMcpEntry,
  uninstallMcpFromDetectedAgents,
} from "./agent-mcp-installer";
import {
  CLAUDE_HOME_ENV,
  getClaudeCodeHooksStatus,
  installClaudeCodeHooks,
  resolveClaudeHome,
  uninstallClaudeCodeHooks,
  type ClaudeCodeHooksResult,
} from "./claude-code-hooks";
import { getHostAdapter } from "./host-adapter";
import {
  getAgentSkillStatus,
  installClaudeCodeMd,
  removeAgentSkill,
  removeGraphFlowOwnedFile,
  resolveClaudeMdSourcePath,
  resolveSkillSourcePath,
} from "./skill-installer";

export const CLAUDE_CODE_HOST_ADAPTER_ID = "claude-code";

const CLAUDE_PROFILE_IDS = ["claude-code", "claude-code-windows"] as const;

export interface ClaudeCodeHostInstallResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
  hooks?: ClaudeCodeHooksResult;
}

export interface ClaudeCodeHostMcpTarget {
  path: string;
  installed: boolean;
  scope: "user" | "workspace";
  agentName: string;
}

export interface ClaudeCodeHostStatus {
  hostId: string;
  agent: string;
  detected: boolean;
  installed: boolean;
  mcpInstalled: boolean;
  rulesInstalled: boolean;
  skillInstalled: boolean;
  hooksInstalled: boolean;
  home: string;
  mcpPath: string;
  rulesPath: string;
  skillPath: string;
  settingsPath: string;
  hooksDir: string;
  mcpTargets: ClaudeCodeHostMcpTarget[];
}

function claudeDisplayName(): string {
  return getHostAdapter(CLAUDE_CODE_HOST_ADAPTER_ID)?.displayName ?? "Claude Code";
}

function isolatedClaudeHome(override?: string): string | undefined {
  const explicit = override?.trim() || process.env[CLAUDE_HOME_ENV]?.trim();
  return explicit || undefined;
}

export function resolveClaudeCodeHostHome(override?: string): string {
  return isolatedClaudeHome(override) ?? resolveClaudeHome();
}

function claudeMcpPath(home: string): string {
  return join(dirname(home), ".claude.json");
}

function claudePaths(home: string): {
  mcpPath: string;
  rulesPath: string;
  skillPath: string;
  skillsRoot: string;
  settingsPath: string;
  hooksDir: string;
} {
  return {
    mcpPath: claudeMcpPath(home),
    rulesPath: join(home, "CLAUDE.md"),
    skillPath: join(home, "skills", "graphflow", "SKILL.md"),
    skillsRoot: join(home, "skills"),
    settingsPath: join(home, "settings.json"),
    hooksDir: join(home, "graphflow-hooks"),
  };
}

function isMcpServerInstalled(configPath: string, serverName = "graphflow"): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const json = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(json.mcpServers?.[serverName]);
  } catch {
    return false;
  }
}

function copyIfChanged(
  sourcePath: string,
  destDir: string,
  destFileName: string
): { status: "created" | "updated" | "skipped"; filePath: string } {
  const destFile = join(destDir, destFileName);
  const existed = existsSync(destFile);
  if (existed && readFileSync(destFile, "utf8") === readFileSync(sourcePath, "utf8")) {
    return { status: "skipped", filePath: destFile };
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(sourcePath, destFile);
  return { status: existed ? "updated" : "created", filePath: destFile };
}

function writeClaudeMcp(configPath: string): { status: "created" | "updated" | "skipped" | "error"; filePath: string; message?: string } {
  try {
    const node = buildMcpServerNode({ strategy: "npx" });
    const existed = existsSync(configPath);
    let json: Record<string, unknown> = {};
    if (existed) {
      try {
        json = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      } catch {
        json = {};
      }
    }
    const servers =
      json.mcpServers && typeof json.mcpServers === "object"
        ? { ...(json.mcpServers as Record<string, unknown>) }
        : {};
    const serverExisted = Boolean(servers.graphflow);
    servers.graphflow = node;
    const next = { ...json, mcpServers: servers };
    const payload = `${JSON.stringify(next, null, 2)}\n`;
    if (existed && readFileSync(configPath, "utf8") === payload) {
      return { status: "skipped", filePath: configPath, message: "already up to date" };
    }
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, payload, "utf8");
    if (!existed) return { status: "created", filePath: configPath };
    if (!serverExisted) return { status: "created", filePath: configPath };
    return { status: "updated", filePath: configPath };
  } catch (error) {
    return {
      status: "error",
      filePath: configPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function rollupStatus(
  results: Array<{ status: string }>
): "created" | "updated" | "skipped" | "error" {
  if (results.some((item) => item.status === "error")) return "error";
  if (results.some((item) => item.status === "created" || item.status === "injected")) return "created";
  if (results.some((item) => item.status === "updated")) return "updated";
  return "skipped";
}

function detectedClaudeProfileIds(): string[] {
  const ids = detectInstalledAgents()
    .map((agent) => agent.id)
    .filter((id): id is (typeof CLAUDE_PROFILE_IDS)[number] =>
      (CLAUDE_PROFILE_IDS as readonly string[]).includes(id)
    );
  if (ids.length === 0 && existsSync(resolveClaudeHome())) {
    return ["claude-code"];
  }
  return ids;
}

function installClaudeSkillAt(skillsRoot: string): { status: "created" | "updated" | "skipped" | "error"; filePath: string; message?: string } {
  const sourceDir = resolveSkillSourcePath();
  const destFile = join(skillsRoot, "graphflow", "SKILL.md");
  if (!sourceDir) {
    return { status: "skipped", filePath: destFile, message: "Skill source (SKILL.md) not found" };
  }
  try {
    return copyIfChanged(join(sourceDir, "SKILL.md"), join(skillsRoot, "graphflow"), "SKILL.md");
  } catch (error) {
    return {
      status: "error",
      filePath: destFile,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function installClaudeMdAt(home: string): { status: "created" | "updated" | "skipped" | "error"; filePath: string; message?: string } {
  const dest = join(home, "CLAUDE.md");
  const sourcePath = resolveClaudeMdSourcePath();
  if (!sourcePath) {
    return { status: "skipped", filePath: dest, message: "CLAUDE.md source not found" };
  }
  try {
    return copyIfChanged(sourcePath, home, "CLAUDE.md");
  } catch (error) {
    return {
      status: "error",
      filePath: dest,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function resultFromParts(
  parts: Array<{ status: string; filePath?: string; message?: string }>,
  fallbackPath: string,
  hooks?: ClaudeCodeHooksResult
): ClaudeCodeHostInstallResult {
  const status = rollupStatus(parts);
  const filePath = hooks?.filePath ?? parts.find((part) => part.filePath)?.filePath ?? fallbackPath;
  const message = parts
    .map((part) => part.message)
    .filter((item): item is string => Boolean(item))
    .join("; ");
  const result: ClaudeCodeHostInstallResult = { status, filePath };
  if (message) result.message = message;
  if (hooks) result.hooks = hooks;
  return result;
}

export function getClaudeCodeHostStatus(options: { home?: string } = {}): ClaudeCodeHostStatus {
  const isolated = isolatedClaudeHome(options.home);
  const home = resolveClaudeCodeHostHome(options.home);
  const paths = claudePaths(home);
  const agent = claudeDisplayName();

  if (isolated) {
    const hooks = getClaudeCodeHooksStatus({
      claudeHome: home,
      settingsPath: paths.settingsPath,
      hooksDir: paths.hooksDir,
    });
    const detected = existsSync(home);
    const mcpInstalled = detected && isMcpServerInstalled(paths.mcpPath);
    const rulesInstalled = existsSync(paths.rulesPath);
    const skillInstalled = existsSync(paths.skillPath);
    return {
      hostId: CLAUDE_CODE_HOST_ADAPTER_ID,
      agent,
      detected,
      installed: mcpInstalled,
      mcpInstalled,
      rulesInstalled,
      skillInstalled,
      hooksInstalled: hooks.installed,
      home,
      mcpPath: paths.mcpPath,
      rulesPath: paths.rulesPath,
      skillPath: paths.skillPath,
      settingsPath: paths.settingsPath,
      hooksDir: paths.hooksDir,
      mcpTargets: detected
        ? [{ path: paths.mcpPath, installed: mcpInstalled, scope: "user", agentName: agent }]
        : [],
    };
  }

  const mcp = getMcpInstallStatus().filter(
    (item) => item.agentId === "claude-code" || item.agentId === "claude-code-windows"
  );
  const skill = getAgentSkillStatus().find((item) => item.agent === "Claude Code skill");
  const hooks = getClaudeCodeHooksStatus();
  const detected = mcp.length > 0 || hooks.detected || existsSync(home) || detectedClaudeProfileIds().length > 0;
  const mcpInstalled = mcp.some((item) => item.installed);
  return {
    hostId: CLAUDE_CODE_HOST_ADAPTER_ID,
    agent,
    detected,
    installed: mcpInstalled,
    mcpInstalled,
    rulesInstalled: existsSync(paths.rulesPath),
    skillInstalled: skill?.installed ?? existsSync(paths.skillPath),
    hooksInstalled: hooks.installed,
    home,
    mcpPath: mcp[0]?.configPath ?? paths.mcpPath,
    rulesPath: paths.rulesPath,
    skillPath: skill?.configPath ?? paths.skillPath,
    settingsPath: hooks.settingsPath,
    hooksDir: hooks.hooksDir,
    mcpTargets: mcp.map((item) => ({
      path: item.configPath,
      installed: item.installed,
      scope: item.scope,
      agentName: item.agentName,
    })),
  };
}

export function installClaudeCodeHost(options: { home?: string } = {}): ClaudeCodeHostInstallResult {
  const isolated = isolatedClaudeHome(options.home);
  const home = resolveClaudeCodeHostHome(options.home);
  const paths = claudePaths(home);

  if (isolated) {
    if (!existsSync(home)) {
      return { status: "skipped", filePath: paths.mcpPath, message: `${claudeDisplayName()} not detected` };
    }
    const mcp = writeClaudeMcp(paths.mcpPath);
    const md = installClaudeMdAt(home);
    const skill = installClaudeSkillAt(paths.skillsRoot);
    const hooks = installClaudeCodeHooks({
      settingsPath: paths.settingsPath,
      hooksDir: paths.hooksDir,
    });
    return resultFromParts([mcp, md, skill, hooks], paths.settingsPath, hooks);
  }

  const ids = detectedClaudeProfileIds();
  if (ids.length === 0 && !existsSync(home)) {
    return { status: "skipped", filePath: paths.mcpPath, message: `${claudeDisplayName()} not detected` };
  }

  const mcp = installMcpToDetectedAgents({
    strategy: "npx",
    installScope: "user",
    agentIdsOverride: ids.length > 0 ? ids : ["claude-code"],
  });
  const md = installClaudeCodeMd();
  const skill = existsSync(home)
    ? installClaudeSkillAt(paths.skillsRoot)
    : { status: "skipped" as const, filePath: paths.skillPath, message: "Claude Code skill marker not found" };
  const hooksStatus = getClaudeCodeHooksStatus();
  const hooks: ClaudeCodeHooksResult = hooksStatus.detected
    ? installClaudeCodeHooks({
        settingsPath: hooksStatus.settingsPath,
        hooksDir: hooksStatus.hooksDir,
      })
    : { status: "skipped", filePath: hooksStatus.settingsPath, message: "Claude Code not detected" };

  return resultFromParts(
    [
      ...mcp.map((item) => ({
        status: item.status,
        filePath: item.configPath,
        ...(item.message ? { message: item.message } : {}),
      })),
      ...md.map((item) => ({
        status: item.status,
        ...(item.message ? { message: item.message } : {}),
      })),
      skill,
      hooks,
    ],
    hooks.filePath ?? mcp[0]?.configPath ?? paths.settingsPath,
    hooks
  );
}

export function uninstallClaudeCodeHost(options: { home?: string } = {}): ClaudeCodeHostInstallResult {
  const isolated = isolatedClaudeHome(options.home);
  const home = resolveClaudeCodeHostHome(options.home);
  const paths = claudePaths(home);

  if (isolated) {
    const hooks = uninstallClaudeCodeHooks(paths.settingsPath, paths.hooksDir);
    const mcpRemoved = existsSync(paths.mcpPath) ? removeMcpEntry(paths.mcpPath, "mcpServers", "graphflow") : false;
    const mdRemoved = removeGraphFlowOwnedFile(paths.rulesPath);
    const skillRemoved = removeAgentSkill(paths.skillsRoot);
    const hooksRemoved = hooks.status === "updated";
    if (!mcpRemoved && !mdRemoved && !skillRemoved && !hooksRemoved) {
      return {
        status: "skipped",
        filePath: paths.settingsPath,
        message: "no GraphFlow Claude Code files",
        hooks,
      };
    }
    return {
      status: "updated",
      filePath: paths.settingsPath,
      message: "removed GraphFlow Claude Code MCP + rules + skill + hooks",
      hooks,
    };
  }

  const mcp = [
    ...uninstallMcpFromDetectedAgents({ agentId: "claude-code" }),
    ...uninstallMcpFromDetectedAgents({ agentId: "claude-code-windows" }),
  ];
  const mdRemoved = removeGraphFlowOwnedFile(paths.rulesPath);
  const appData = process.env.APPDATA;
  const appDataMd =
    process.platform === "win32" && appData
      ? removeGraphFlowOwnedFile(join(appData, "Claude Code", "CLAUDE.md"))
      : false;
  const skillRemoved = removeAgentSkill(paths.skillsRoot);
  const hooksStatus = getClaudeCodeHooksStatus();
  const hooks = hooksStatus.detected
    ? uninstallClaudeCodeHooks(hooksStatus.settingsPath, hooksStatus.hooksDir)
    : { status: "skipped" as const, filePath: hooksStatus.settingsPath, message: "Claude Code not detected" };
  const mcpRemoved = mcp.some((item) => item.removed);
  if (!mcpRemoved && !mdRemoved && !appDataMd && !skillRemoved && hooks.status !== "updated") {
    return {
      status: "skipped",
      filePath: hooks.filePath ?? paths.settingsPath,
      message: "no GraphFlow Claude Code files",
      hooks,
    };
  }
  return {
    status: "updated",
    filePath: hooks.filePath ?? paths.settingsPath,
    message: "removed GraphFlow Claude Code MCP + rules + skill + hooks",
    hooks,
  };
}
