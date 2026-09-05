/**
 * Cursor HostAdapter install slice.
 *
 * Composes existing MCP + rules + skill installers. Isolated `home` /
 * GRAPHFLOW_CURSOR_HOME writes only under that `.cursor` directory so tests
 * never touch the real user home.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildMcpServerNode,
  detectInstalledAgents,
  getMcpInstallStatus,
  installMcpToDetectedAgents,
  removeMcpEntry,
  uninstallMcpFromDetectedAgents,
} from "./agent-mcp-installer";
import { getHostAdapter } from "./host-adapter";
import {
  getAgentSkillStatus,
  installCursorRules,
  removeAgentSkill,
  removeGraphFlowOwnedFile,
  resolveCursorRulesSourcePath,
  resolveSkillSourcePath,
} from "./skill-installer";

export const CURSOR_HOST_ADAPTER_ID = "cursor";
export const CURSOR_HOME_ENV = "GRAPHFLOW_CURSOR_HOME";

const CURSOR_PROFILE_IDS = ["cursor", "cursor-windows"] as const;

export interface CursorHostInstallResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

export interface CursorHostMcpTarget {
  path: string;
  installed: boolean;
  scope: "user" | "workspace";
  agentName: string;
}

export interface CursorHostStatus {
  hostId: string;
  agent: string;
  detected: boolean;
  installed: boolean;
  mcpInstalled: boolean;
  rulesInstalled: boolean;
  skillInstalled: boolean;
  home: string;
  mcpPath: string;
  rulesPath: string;
  skillPath: string;
  mcpTargets: CursorHostMcpTarget[];
}

function cursorDisplayName(): string {
  return getHostAdapter(CURSOR_HOST_ADAPTER_ID)?.displayName ?? "Cursor";
}

function isolatedCursorHome(override?: string): string | undefined {
  const explicit = override?.trim() || process.env[CURSOR_HOME_ENV]?.trim();
  return explicit || undefined;
}

export function resolveCursorHome(override?: string): string {
  return isolatedCursorHome(override) ?? join(homedir(), ".cursor");
}

function cursorPaths(home: string): { mcpPath: string; rulesPath: string; skillPath: string; skillsRoot: string } {
  return {
    mcpPath: join(home, "mcp.json"),
    rulesPath: join(home, "rules", "graphflow.mdc"),
    skillPath: join(home, "skills", "graphflow", "SKILL.md"),
    skillsRoot: join(home, "skills"),
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

function writeCursorMcp(configPath: string): { status: "created" | "updated" | "skipped" | "error"; filePath: string; message?: string } {
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

function detectedCursorProfileIds(): string[] {
  const ids = detectInstalledAgents()
    .map((agent) => agent.id)
    .filter((id): id is (typeof CURSOR_PROFILE_IDS)[number] =>
      (CURSOR_PROFILE_IDS as readonly string[]).includes(id)
    );
  if (ids.length === 0 && existsSync(join(homedir(), ".cursor"))) {
    return ["cursor"];
  }
  return ids;
}

function installCursorSkillAt(skillsRoot: string): { status: "created" | "updated" | "skipped" | "error"; filePath: string; message?: string } {
  const sourceDir = resolveSkillSourcePath();
  const destFile = join(skillsRoot, "graphflow", "SKILL.md");
  if (!sourceDir) {
    return { status: "skipped", filePath: destFile, message: "Skill source (SKILL.md) not found" };
  }
  try {
    const copied = copyIfChanged(join(sourceDir, "SKILL.md"), join(skillsRoot, "graphflow"), "SKILL.md");
    return copied;
  } catch (error) {
    return {
      status: "error",
      filePath: destFile,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function installCursorRulesAt(home: string): { status: "created" | "updated" | "skipped" | "error"; filePath: string; message?: string } {
  const rulesPath = join(home, "rules", "graphflow.mdc");
  const sourceDir = resolveCursorRulesSourcePath();
  if (!sourceDir) {
    return { status: "skipped", filePath: rulesPath, message: "Cursor rules source (graphflow.mdc) not found" };
  }
  try {
    return copyIfChanged(join(sourceDir, "graphflow.mdc"), join(home, "rules"), "graphflow.mdc");
  } catch (error) {
    return {
      status: "error",
      filePath: rulesPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function resultFromParts(
  parts: Array<{ status: string; filePath?: string; message?: string }>,
  fallbackPath: string
): CursorHostInstallResult {
  const status = rollupStatus(parts);
  const filePath = parts.find((part) => part.filePath)?.filePath ?? fallbackPath;
  const message = parts
    .map((part) => part.message)
    .filter((item): item is string => Boolean(item))
    .join("; ");
  const result: CursorHostInstallResult = { status, filePath };
  if (message) result.message = message;
  return result;
}

export function getCursorHostStatus(options: { home?: string } = {}): CursorHostStatus {
  const isolated = isolatedCursorHome(options.home);
  const home = resolveCursorHome(options.home);
  const paths = cursorPaths(home);
  const agent = cursorDisplayName();

  if (isolated) {
    const detected = existsSync(home);
    const mcpInstalled = detected && isMcpServerInstalled(paths.mcpPath);
    const rulesInstalled = existsSync(paths.rulesPath);
    const skillInstalled = existsSync(paths.skillPath);
    return {
      hostId: CURSOR_HOST_ADAPTER_ID,
      agent,
      detected,
      installed: mcpInstalled,
      mcpInstalled,
      rulesInstalled,
      skillInstalled,
      home,
      mcpPath: paths.mcpPath,
      rulesPath: paths.rulesPath,
      skillPath: paths.skillPath,
      mcpTargets: detected
        ? [{ path: paths.mcpPath, installed: mcpInstalled, scope: "user", agentName: agent }]
        : [],
    };
  }

  const mcp = getMcpInstallStatus().filter((item) => item.agentId === "cursor" || item.agentId === "cursor-windows");
  const skill = getAgentSkillStatus().find((item) => item.agent === "Cursor skill");
  const detected = mcp.length > 0 || existsSync(home) || detectedCursorProfileIds().length > 0;
  const mcpInstalled = mcp.some((item) => item.installed);
  const skillInstalled = skill?.installed ?? existsSync(paths.skillPath);
  const rulesInstalled = existsSync(paths.rulesPath);
  return {
    hostId: CURSOR_HOST_ADAPTER_ID,
    agent,
    detected,
    installed: mcpInstalled,
    mcpInstalled,
    rulesInstalled,
    skillInstalled,
    home,
    mcpPath: mcp[0]?.configPath ?? paths.mcpPath,
    rulesPath: paths.rulesPath,
    skillPath: skill?.configPath ?? paths.skillPath,
    mcpTargets: mcp.map((item) => ({
      path: item.configPath,
      installed: item.installed,
      scope: item.scope,
      agentName: item.agentName,
    })),
  };
}

export function installCursorHost(options: { home?: string } = {}): CursorHostInstallResult {
  const isolated = isolatedCursorHome(options.home);
  const home = resolveCursorHome(options.home);
  const paths = cursorPaths(home);

  if (isolated) {
    if (!existsSync(home)) {
      return { status: "skipped", filePath: paths.mcpPath, message: `${cursorDisplayName()} not detected` };
    }
    const mcp = writeCursorMcp(paths.mcpPath);
    const rules = installCursorRulesAt(home);
    const skill = installCursorSkillAt(paths.skillsRoot);
    return resultFromParts([mcp, rules, skill], paths.mcpPath);
  }

  const ids = detectedCursorProfileIds();
  if (ids.length === 0 && !existsSync(home)) {
    return { status: "skipped", filePath: paths.mcpPath, message: `${cursorDisplayName()} not detected` };
  }

  const mcp = installMcpToDetectedAgents({
    strategy: "npx",
    installScope: "user",
    agentIdsOverride: ids.length > 0 ? ids : ["cursor"],
  });
  const rules = installCursorRules();
  const skill = existsSync(home)
    ? installCursorSkillAt(paths.skillsRoot)
    : { status: "skipped" as const, filePath: paths.skillPath, message: "Cursor skill marker not found" };

  return resultFromParts(
    [
      ...mcp.map((item) => ({
        status: item.status,
        filePath: item.configPath,
        ...(item.message ? { message: item.message } : {}),
      })),
      ...rules.map((item) => ({
        status: item.status,
        ...(item.message ? { message: item.message } : {}),
      })),
      skill,
    ],
    mcp[0]?.configPath ?? paths.mcpPath
  );
}

export function uninstallCursorHost(options: { home?: string } = {}): CursorHostInstallResult {
  const isolated = isolatedCursorHome(options.home);
  const home = resolveCursorHome(options.home);
  const paths = cursorPaths(home);

  if (isolated) {
    if (!existsSync(paths.mcpPath) && !existsSync(paths.rulesPath) && !existsSync(paths.skillPath)) {
      return { status: "skipped", filePath: paths.mcpPath, message: "not found" };
    }
    const mcpRemoved = existsSync(paths.mcpPath) ? removeMcpEntry(paths.mcpPath, "mcpServers", "graphflow") : false;
    const rulesRemoved = removeGraphFlowOwnedFile(paths.rulesPath);
    const skillRemoved = removeAgentSkill(paths.skillsRoot);
    if (!mcpRemoved && !rulesRemoved && !skillRemoved) {
      return { status: "skipped", filePath: paths.mcpPath, message: "no GraphFlow Cursor files" };
    }
    return { status: "updated", filePath: paths.mcpPath, message: "removed GraphFlow Cursor MCP + rules + skill" };
  }

  const mcp = [
    ...uninstallMcpFromDetectedAgents({ agentId: "cursor" }),
    ...uninstallMcpFromDetectedAgents({ agentId: "cursor-windows" }),
  ];
  const rulesRemoved = removeGraphFlowOwnedFile(paths.rulesPath);
  const appData = process.env.APPDATA;
  const appDataRules =
    process.platform === "win32" && appData
      ? removeGraphFlowOwnedFile(join(appData, "Cursor", "User", "rules", "graphflow.mdc"))
      : false;
  const skillRemoved = removeAgentSkill(paths.skillsRoot);
  const mcpRemoved = mcp.some((item) => item.removed);
  if (!mcpRemoved && !rulesRemoved && !appDataRules && !skillRemoved) {
    return { status: "skipped", filePath: paths.mcpPath, message: "no GraphFlow Cursor files" };
  }
  return { status: "updated", filePath: paths.mcpPath, message: "removed GraphFlow Cursor MCP + rules + skill" };
}
