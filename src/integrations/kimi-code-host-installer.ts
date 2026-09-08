/**
 * Kimi Code HostAdapter install slice.
 *
 * Writes user-level MCP (`mcp.json`), Skill, and AGENTS.md under
 * `$KIMI_CODE_HOME` (default `~/.kimi-code`). Isolated
 * `home` / GRAPHFLOW_KIMI_CODE_HOME never touches the real user home.
 *
 * Kimi Code does not expand `${workspaceFolder}`; MCP env omits that placeholder.
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
import { getHostAdapter } from "./host-adapter";
import {
  isolatedKimiCodeHome,
  KIMI_CODE_HOST_ADAPTER_ID,
  resolveKimiCodeHome,
} from "./kimi-code-paths";
import {
  buildInstructionBlock,
  getAgentSkillStatus,
  removeAgentSkill,
  removeGraphFlowOwnedFile,
  resolveSkillSourcePath,
} from "./skill-installer";

export { KIMI_CODE_HOST_ADAPTER_ID, KIMI_CODE_HOME_ENV, resolveKimiCodeHome } from "./kimi-code-paths";

const KIMI_CODE_PROFILE_IDS = ["kimi-code", "kimi-code-windows"] as const;

export interface KimiCodeHostInstallResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

export interface KimiCodeHostMcpTarget {
  path: string;
  installed: boolean;
  scope: "user" | "workspace";
  agentName: string;
}

export interface KimiCodeHostStatus {
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
  mcpTargets: KimiCodeHostMcpTarget[];
}

function kimiDisplayName(): string {
  return getHostAdapter(KIMI_CODE_HOST_ADAPTER_ID)?.displayName ?? "Kimi Code";
}

function kimiPaths(home: string): {
  mcpPath: string;
  rulesPath: string;
  skillPath: string;
  skillsRoot: string;
} {
  return {
    mcpPath: join(home, "mcp.json"),
    rulesPath: join(home, "AGENTS.md"),
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

function isInstructionInstalled(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, "utf8");
    return content.includes("GRAPHFLOW:BEGIN") && content.includes("GRAPHFLOW:END");
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

function writeKimiMcp(configPath: string): {
  status: "created" | "updated" | "skipped" | "error";
  filePath: string;
  message?: string;
} {
  try {
    const node = buildMcpServerNode({ strategy: "npx", omitWorkspaceFolderPlaceholder: true });
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
    if (!existed || !serverExisted) return { status: "created", filePath: configPath };
    return { status: "updated", filePath: configPath };
  } catch (error) {
    return {
      status: "error",
      filePath: configPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function installKimiSkillAt(skillsRoot: string): {
  status: "created" | "updated" | "skipped" | "error";
  filePath: string;
  message?: string;
} {
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

function installKimiAgentsMd(home: string): {
  status: "created" | "updated" | "skipped" | "error";
  filePath: string;
  message?: string;
} {
  const filePath = join(home, "AGENTS.md");
  try {
    const block = buildInstructionBlock();
    const existed = existsSync(filePath);
    if (!existed) {
      mkdirSync(home, { recursive: true });
      writeFileSync(filePath, `${block}\n`, "utf8");
      return { status: "created", filePath };
    }
    const current = readFileSync(filePath, "utf8");
    const begin = "<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->";
    const end = "<!-- GRAPHFLOW:END -->";
    const beginIdx = current.indexOf(begin);
    const endIdx = current.indexOf(end);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const next = `${current.slice(0, beginIdx)}${block.trimEnd()}${current.slice(endIdx + end.length)}`;
      if (next === current) return { status: "skipped", filePath, message: "already up to date" };
      writeFileSync(filePath, next, "utf8");
      return { status: "updated", filePath };
    }
    const separator = current.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(filePath, `${current}${separator}${block}\n`, "utf8");
    return { status: "updated", filePath };
  } catch (error) {
    return {
      status: "error",
      filePath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function rollupStatus(results: Array<{ status: string }>): "created" | "updated" | "skipped" | "error" {
  if (results.some((item) => item.status === "error")) return "error";
  if (results.some((item) => item.status === "created" || item.status === "injected")) return "created";
  if (results.some((item) => item.status === "updated")) return "updated";
  return "skipped";
}

function resultFromParts(
  parts: Array<{ status: string; filePath?: string; message?: string }>,
  fallbackPath: string
): KimiCodeHostInstallResult {
  const status = rollupStatus(parts);
  const filePath = parts.find((part) => part.filePath)?.filePath ?? fallbackPath;
  const message = parts
    .map((part) => part.message)
    .filter((item): item is string => Boolean(item))
    .join("; ");
  const result: KimiCodeHostInstallResult = { status, filePath };
  if (message) result.message = message;
  return result;
}

function detectedKimiProfileIds(): string[] {
  const ids = detectInstalledAgents()
    .map((agent) => agent.id)
    .filter((id): id is (typeof KIMI_CODE_PROFILE_IDS)[number] =>
      (KIMI_CODE_PROFILE_IDS as readonly string[]).includes(id)
    );
  if (ids.length === 0 && existsSync(resolveKimiCodeHome())) {
    return ["kimi-code"];
  }
  return ids;
}

export function getKimiCodeHostStatus(options: { home?: string } = {}): KimiCodeHostStatus {
  const isolated = isolatedKimiCodeHome(options.home);
  const home = resolveKimiCodeHome(options.home);
  const paths = kimiPaths(home);
  const agent = kimiDisplayName();

  if (isolated) {
    const detected = existsSync(home);
    const mcpInstalled = detected && isMcpServerInstalled(paths.mcpPath);
    const rulesInstalled = isInstructionInstalled(paths.rulesPath);
    const skillInstalled = existsSync(paths.skillPath);
    return {
      hostId: KIMI_CODE_HOST_ADAPTER_ID,
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

  const mcp = getMcpInstallStatus().filter(
    (item) => item.agentId === "kimi-code" || item.agentId === "kimi-code-windows"
  );
  const skill = getAgentSkillStatus().find((item) => item.agent === "Kimi Code skill");
  const detected = mcp.length > 0 || existsSync(home) || detectedKimiProfileIds().length > 0;
  const mcpInstalled = mcp.some((item) => item.installed) || isMcpServerInstalled(paths.mcpPath);
  const skillInstalled = skill?.installed ?? existsSync(paths.skillPath);
  const rulesInstalled = isInstructionInstalled(paths.rulesPath);
  return {
    hostId: KIMI_CODE_HOST_ADAPTER_ID,
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
    mcpTargets: mcp.length > 0
      ? mcp.map((item) => ({
          path: item.configPath,
          installed: item.installed,
          scope: item.scope,
          agentName: item.agentName,
        }))
      : detected
        ? [{ path: paths.mcpPath, installed: mcpInstalled, scope: "user" as const, agentName: agent }]
        : [],
  };
}

export function installKimiCodeHost(options: { home?: string } = {}): KimiCodeHostInstallResult {
  const isolated = isolatedKimiCodeHome(options.home);
  const home = resolveKimiCodeHome(options.home);
  const paths = kimiPaths(home);

  if (isolated) {
    if (!existsSync(home)) {
      return { status: "skipped", filePath: paths.mcpPath, message: `${kimiDisplayName()} not detected` };
    }
    const mcp = writeKimiMcp(paths.mcpPath);
    const rules = installKimiAgentsMd(home);
    const skill = installKimiSkillAt(paths.skillsRoot);
    return resultFromParts([mcp, rules, skill], paths.mcpPath);
  }

  const ids = detectedKimiProfileIds();
  if (ids.length === 0 && !existsSync(home)) {
    return { status: "skipped", filePath: paths.mcpPath, message: `${kimiDisplayName()} not detected` };
  }

  const mcp = installMcpToDetectedAgents({
    strategy: "npx",
    installScope: "user",
    omitWorkspaceFolderPlaceholder: true,
    agentIdsOverride: ids.length > 0 ? ids : ["kimi-code"],
  });
  const rules = existsSync(home)
    ? installKimiAgentsMd(home)
    : { status: "skipped" as const, filePath: paths.rulesPath, message: "Kimi Code home not found" };
  const skill = existsSync(home)
    ? installKimiSkillAt(paths.skillsRoot)
    : { status: "skipped" as const, filePath: paths.skillPath, message: "Kimi Code skill marker not found" };

  return resultFromParts(
    [
      ...mcp.map((item) => ({
        status: item.status,
        filePath: item.configPath,
        ...(item.message ? { message: item.message } : {}),
      })),
      rules,
      skill,
    ],
    mcp[0]?.configPath ?? paths.mcpPath
  );
}

export function uninstallKimiCodeHost(options: { home?: string } = {}): KimiCodeHostInstallResult {
  const isolated = isolatedKimiCodeHome(options.home);
  const home = resolveKimiCodeHome(options.home);
  const paths = kimiPaths(home);

  if (isolated) {
    if (!existsSync(paths.mcpPath) && !existsSync(paths.rulesPath) && !existsSync(paths.skillPath)) {
      return { status: "skipped", filePath: paths.mcpPath, message: "not found" };
    }
    const mcpRemoved = existsSync(paths.mcpPath) ? removeMcpEntry(paths.mcpPath, "mcpServers", "graphflow") : false;
    const rulesRemoved = removeGraphFlowOwnedFile(paths.rulesPath);
    const skillRemoved = removeAgentSkill(paths.skillsRoot);
    if (!mcpRemoved && !rulesRemoved && !skillRemoved) {
      return { status: "skipped", filePath: paths.mcpPath, message: "no GraphFlow Kimi Code files" };
    }
    return { status: "updated", filePath: paths.mcpPath, message: "removed GraphFlow Kimi Code MCP + AGENTS.md + skill" };
  }

  const mcp = [
    ...uninstallMcpFromDetectedAgents({ agentId: "kimi-code" }),
    ...uninstallMcpFromDetectedAgents({ agentId: "kimi-code-windows" }),
  ];
  const rulesRemoved = removeGraphFlowOwnedFile(paths.rulesPath);
  const skillRemoved = removeAgentSkill(paths.skillsRoot);
  const mcpRemoved = mcp.some((item) => item.removed) || (existsSync(paths.mcpPath) && removeMcpEntry(paths.mcpPath, "mcpServers", "graphflow"));
  if (!mcpRemoved && !rulesRemoved && !skillRemoved) {
    return { status: "skipped", filePath: paths.mcpPath, message: "no GraphFlow Kimi Code files" };
  }
  return { status: "updated", filePath: paths.mcpPath, message: "removed GraphFlow Kimi Code MCP + AGENTS.md + skill" };
}
