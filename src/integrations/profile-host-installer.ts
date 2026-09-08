/**
 * Generic profile-backed HostAdapter install slice.
 *
 * v1.13 added the HostAdapter capability registry. v1.14/v1.15 migrated
 * DeepSeek Harness, Cursor, Claude Code, and Kimi Code with hand-written
 * slices. This module migrates the **remaining** profile-registry hosts
 * (Trae, VS Code, Windsurf, Cline, Roo Code, Kilo Code, PearAI, Gemini,
 * Codex, Antigravity, Amazon Q, Zed, Continue, Qoder, Opencode) with ONE
 * generic slice driven by `PROFILE_HOST_SPECS`, so `installViaHostAdapter`
 * becomes the single install / uninstall / status entry point for every host.
 *
 * Scoping guarantees (no cross-host writes):
 * - MCP writes are scoped by `agentIdsOverride` (exact profile ids only).
 * - Skill writes are scoped by exact `getAgentSkillTargets()` agent names.
 * - Instruction writes are scoped by exact `getAgentInstructionTargets()` names.
 *
 * Every operation is safe to re-run: MCP entries are keyed by server name (no
 * duplicates), Skill / instruction writes are content-compared, and uninstall
 * returns `skipped` when there was nothing of ours to remove. A repeated MCP
 * write may still report `updated` when the launcher node is rewritten.
 */
import {
  detectInstalledAgents,
  getMcpInstallStatus,
  installMcpToDetectedAgents,
  uninstallMcpFromDetectedAgents,
  type McpInstallOptions,
  type McpInstallResult,
  type McpRemoveResult,
} from "./agent-mcp-installer";
import { getHostAdapter } from "./host-adapter";
import {
  getAgentInstructionStatus,
  getAgentSkillStatus,
  installInstructionsToTargets,
  installSkillToTargets,
  removeInstructionsFromTargets,
  removeSkillFromTargets,
  type SkillInstallResult,
} from "./skill-installer";

export interface ProfileHostSpec {
  /**
   * `agent-mcp-installer` profile ids owned by this host. Includes the WSL
   * `-windows` variant when one exists; unknown ids are ignored by the installer,
   * so listing them is safe on native Windows / Linux.
   */
  profileIds: readonly string[];
  /** `getAgentSkillTargets().agent` names owned by this host. */
  skillTargets?: readonly string[];
  /** `getAgentInstructionTargets().agent` names owned by this host. */
  instructionTargets?: readonly string[];
}

/**
 * Registry of hosts whose install slice is fully derived from existing
 * profile / skill / instruction targets. Migrated (hand-written) hosts —
 * `deepseek-harness`, `cursor`, `claude-code`, `kimi-code` — are intentionally
 * absent: they have host-specific behaviour (hooks, overlays, placeholder rules).
 */
export const PROFILE_HOST_SPECS: Readonly<Record<string, ProfileHostSpec>> = {
  trae: { profileIds: ["trae", "trae-windows"] },
  vscode: { profileIds: ["vscode", "vscode-windows"] },
  windsurf: { profileIds: ["windsurf", "windsurf-windows"], instructionTargets: ["Windsurf"] },
  cline: { profileIds: ["cline", "cline-windows"], instructionTargets: ["Cline"] },
  "roo-code": {
    profileIds: ["roo-code"],
    skillTargets: ["Roo Code"],
    instructionTargets: ["Roo Code"],
  },
  kilocode: {
    profileIds: ["kilocode"],
    skillTargets: ["Kilo Code"],
    instructionTargets: ["Kilo Code"],
  },
  pearai: { profileIds: ["pearai"] },
  gemini: { profileIds: ["gemini", "gemini-windows"], instructionTargets: ["Gemini"] },
  codex: {
    profileIds: ["codex", "codex-windows"],
    skillTargets: ["Codex", "Codex (agents)"],
    instructionTargets: ["Codex"],
  },
  antigravity: { profileIds: ["antigravity"], skillTargets: ["Antigravity"] },
  "amazon-q": { profileIds: ["amazon-q"] },
  zed: { profileIds: ["zed"] },
  continue: { profileIds: ["continue"] },
  qoder: { profileIds: ["qoder"], skillTargets: ["Qoder", "Qoder CN"] },
  opencode: { profileIds: ["opencode"], instructionTargets: ["Opencode"] },
};

export const PROFILE_HOST_IDS = Object.keys(PROFILE_HOST_SPECS);

export type ProfileHostInstallStatus = "created" | "updated" | "skipped" | "error";

export interface ProfileHostInstallResult {
  status: ProfileHostInstallStatus;
  filePath?: string;
  message?: string;
}

export interface ProfileHostMcpTarget {
  path: string;
  installed: boolean;
  scope: "user" | "workspace";
  agentName: string;
}

export interface ProfileHostStatus {
  hostId: string;
  agent: string;
  detected: boolean;
  installed: boolean;
  mcpInstalled: boolean;
  skillInstalled?: boolean;
  rulesInstalled?: boolean;
  mcpPath?: string;
  skillPath?: string;
  rulesPath?: string;
  mcpTargets: ProfileHostMcpTarget[];
}

export function getProfileHostSpec(hostId: string): ProfileHostSpec | undefined {
  return PROFILE_HOST_SPECS[hostId];
}

export function isProfileHost(hostId: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROFILE_HOST_SPECS, hostId);
}

function rollupStatus(parts: Array<{ status: string }>): ProfileHostInstallStatus {
  if (parts.some((part) => part.status === "error")) return "error";
  if (parts.some((part) => part.status === "created" || part.status === "injected")) return "created";
  if (parts.some((part) => part.status === "updated")) return "updated";
  return "skipped";
}

function resultFromParts(
  parts: Array<{ status: string; filePath?: string; message?: string }>,
  fallbackPath?: string
): ProfileHostInstallResult {
  const result: ProfileHostInstallResult = { status: rollupStatus(parts) };
  const filePath = parts.find((part) => part.filePath)?.filePath ?? fallbackPath;
  if (filePath !== undefined) result.filePath = filePath;
  const message = parts
    .map((part) => part.message)
    .filter((item): item is string => Boolean(item))
    .join("; ");
  if (message) result.message = message;
  return result;
}

function mcpParts(results: McpInstallResult[]): Array<{ status: string; filePath?: string; message?: string }> {
  return results.map((item) => {
    const part: { status: string; filePath?: string; message?: string } = {
      status: item.status,
      filePath: item.configPath,
    };
    if (item.message !== undefined) part.message = item.message;
    return part;
  });
}

/** Only removals count as work; already-absent entries must not mask a `skipped` rollup. */
function mcpRemoveParts(
  results: McpRemoveResult[]
): Array<{ status: string; filePath?: string; message?: string }> {
  return results
    .filter((item) => item.removed)
    .map((item) => {
      const part: { status: string; filePath?: string; message?: string } = {
        status: "updated",
        filePath: item.configPath,
      };
      if (item.message !== undefined) part.message = item.message;
      return part;
    });
}

function skillParts(results: SkillInstallResult[]): Array<{ status: string; message?: string }> {
  return results.map((item) => {
    const part: { status: string; message?: string } = { status: item.status };
    if (item.message !== undefined) part.message = item.message;
    return part;
  });
}

export interface ProfileHostInstallOptions {
  /** Reserved for symmetry with the hand-written slices; profile hosts resolve paths from the host registry. */
  home?: string;
  /** Test hook: override the MCP profile ids (empty array = no agents, no writes). */
  agentIdsOverride?: readonly string[];
}

function mcpInstallOptions(spec: ProfileHostSpec, options: ProfileHostInstallOptions): McpInstallOptions {
  return {
    strategy: "npx",
    installScope: "user",
    agentIdsOverride:
      options.agentIdsOverride !== undefined ? [...options.agentIdsOverride] : [...spec.profileIds],
  };
}

/**
 * Install MCP + Skill + instruction block for one profile-backed host.
 * Returns `undefined` when the host has no profile spec (caller falls back).
 */
export function installProfileHost(
  hostId: string,
  options: ProfileHostInstallOptions = {}
): ProfileHostInstallResult | undefined {
  const spec = getProfileHostSpec(hostId);
  if (!spec) return undefined;

  const mcp = installMcpToDetectedAgents(mcpInstallOptions(spec, options));
  const skills = spec.skillTargets ? skillParts(installSkillToTargets(spec.skillTargets)) : [];
  const instructions = spec.instructionTargets
    ? skillParts(installInstructionsToTargets(spec.instructionTargets))
    : [];

  const parts = [...mcpParts(mcp), ...skills, ...instructions];
  if (parts.length === 0) {
    return { status: "skipped", message: `${hostId} has no MCP target on this machine` };
  }
  return resultFromParts(parts, mcp[0]?.configPath);
}

/** Remove MCP + Skill + instruction block for one profile-backed host. */
export function uninstallProfileHost(
  hostId: string,
  _options: ProfileHostInstallOptions = {}
): ProfileHostInstallResult | undefined {
  const spec = getProfileHostSpec(hostId);
  if (!spec) return undefined;

  const mcp = spec.profileIds.flatMap((agentId) => uninstallMcpFromDetectedAgents({ agentId }));
  const removedMcp = mcp.filter((item) => item.removed);
  const skills = spec.skillTargets ? skillParts(removeSkillFromTargets(spec.skillTargets)) : [];
  const instructions = spec.instructionTargets
    ? skillParts(removeInstructionsFromTargets(spec.instructionTargets))
    : [];

  const parts = [...mcpRemoveParts(mcp), ...skills, ...instructions];
  const status = rollupStatus(parts);
  if (status === "skipped") {
    return { status: "skipped", message: "no GraphFlow files for this host" };
  }
  return resultFromParts(parts, removedMcp[0]?.configPath);
}

/** Detect / status snapshot for one profile-backed host. */
export function getProfileHostStatus(
  hostId: string,
  _options: ProfileHostInstallOptions = {}
): ProfileHostStatus | undefined {
  const spec = getProfileHostSpec(hostId);
  if (!spec) return undefined;

  const adapter = getHostAdapter(hostId);
  const agent = adapter?.displayName ?? hostId;

  const mcp = getMcpInstallStatus().filter((item) => spec.profileIds.includes(item.agentId));
  const detectedIds = new Set(detectInstalledAgents().map((item) => item.id));
  const detected =
    mcp.some((item) => item.detected) || spec.profileIds.some((id) => detectedIds.has(id));

  const mcpInstalled = mcp.some((item) => item.installed);

  const skillStatuses = (spec.skillTargets ?? [])
    .map((name) => getAgentSkillStatus().find((item) => item.agent === `${name} skill`))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const skillInstalled = skillStatuses.length > 0
    ? skillStatuses.every((item) => item.installed)
    : undefined;

  const instructionStatuses = (spec.instructionTargets ?? [])
    .map((name) => getAgentInstructionStatus().find((item) => item.agent === name))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const rulesInstalled = instructionStatuses.length > 0
    ? instructionStatuses.every((item) => item.installed)
    : undefined;

  const status: ProfileHostStatus = {
    hostId,
    agent,
    detected,
    installed: mcpInstalled,
    mcpInstalled,
    mcpTargets: mcp.map((item) => ({
      path: item.configPath,
      installed: item.installed,
      scope: item.scope,
      agentName: item.agentName,
    })),
  };

  if (mcp[0]?.configPath !== undefined) status.mcpPath = mcp[0].configPath;
  if (skillStatuses[0]?.configPath !== undefined) status.skillPath = skillStatuses[0].configPath;
  if (instructionStatuses[0]?.configPath !== undefined) {
    status.rulesPath = instructionStatuses[0].configPath;
  }
  if (skillInstalled !== undefined) status.skillInstalled = skillInstalled;
  if (rulesInstalled !== undefined) status.rulesInstalled = rulesInstalled;

  return status;
}
