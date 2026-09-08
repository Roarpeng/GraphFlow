/**
 * HostAdapter install dispatch.
 *
 * v1.13 added the capability registry (`host-adapter.ts`). Two dispatch paths:
 * - **Hand-written slices** (host-specific behaviour): DeepSeek Harness, Cursor,
 *   Claude Code, Kimi Code.
 * - **Profile-backed generic slice** (`profile-host-installer.ts`): every other
 *   registry host (Trae, VS Code, Windsurf, Cline, Roo Code, Kilo Code, PearAI,
 *   Gemini, Codex, Antigravity, Amazon Q, Zed, Continue, Qoder, Opencode).
 *
 * Every registry host is therefore installable through `installViaHostAdapter`;
 * `installViaHostAdapter` returns `unsupported` only for an id that is in the
 * registry but has neither slice (a programming error, asserted by tests).
 */
import {
  CLAUDE_CODE_HOST_ADAPTER_ID,
  getClaudeCodeHostStatus,
  installClaudeCodeHost,
  uninstallClaudeCodeHost,
  type ClaudeCodeHostInstallResult,
  type ClaudeCodeHostStatus,
} from "./claude-code-host-installer";
import {
  CURSOR_HOST_ADAPTER_ID,
  getCursorHostStatus,
  installCursorHost,
  uninstallCursorHost,
  type CursorHostInstallResult,
  type CursorHostStatus,
} from "./cursor-host-installer";
import {
  DSH_HOST_ADAPTER_ID,
  getDshHarnessStatus,
  installDshHarness,
  uninstallDshHarness,
  type DshHarnessInstallResult,
  type DshHarnessStatus,
} from "./dsh-harness-installer";
import {
  KIMI_CODE_HOST_ADAPTER_ID,
  getKimiCodeHostStatus,
  installKimiCodeHost,
  uninstallKimiCodeHost,
  type KimiCodeHostInstallResult,
  type KimiCodeHostStatus,
} from "./kimi-code-host-installer";
import { getHostAdapter } from "./host-adapter";
import {
  PROFILE_HOST_IDS,
  getProfileHostStatus,
  installProfileHost,
  isProfileHost,
  uninstallProfileHost,
  type ProfileHostStatus,
} from "./profile-host-installer";

export { CLAUDE_CODE_HOST_ADAPTER_ID, CURSOR_HOST_ADAPTER_ID, DSH_HOST_ADAPTER_ID, KIMI_CODE_HOST_ADAPTER_ID };

export const HOST_ADAPTER_INSTALL_UNMIGRATED =
  "install path is not yet migrated onto HostAdapter";

/** Hosts with a hand-written install slice (host-specific behaviour). */
export const HAND_WRITTEN_HOST_ADAPTER_IDS = [
  DSH_HOST_ADAPTER_ID,
  CURSOR_HOST_ADAPTER_ID,
  CLAUDE_CODE_HOST_ADAPTER_ID,
  KIMI_CODE_HOST_ADAPTER_ID,
] as const;

/** Hosts whose slice is fully derived from profile / skill / instruction targets. */
export const PROFILE_HOST_ADAPTER_IDS = PROFILE_HOST_IDS;

/** Every host that `installViaHostAdapter` can install. */
export const HOST_ADAPTER_MIGRATED_IDS = [
  ...HAND_WRITTEN_HOST_ADAPTER_IDS,
  ...PROFILE_HOST_ADAPTER_IDS,
] as const;

export interface HostAdapterInstallOptions {
  home?: string;
}

export type HostAdapterInstallStatus = DshHarnessInstallResult["status"] | "unsupported";

export interface HostAdapterInstallResult {
  hostId: string;
  displayName: string;
  status: HostAdapterInstallStatus;
  filePath?: string;
  message?: string;
}

export interface HostAdapterHostStatus {
  hostId: string;
  agent: string;
  detected: boolean;
  installed: boolean;
  glueInstalled?: boolean;
  skillInstalled?: boolean;
  mcpInstalled?: boolean;
  rulesInstalled?: boolean;
  hooksInstalled?: boolean;
  home?: string;
  mcpPath?: string;
  rulesPath?: string;
  skillPath?: string;
  hooksPath?: string;
  settingsPath?: string;
  patchPath?: string;
  dshHome?: string;
  mcpTargets?: Array<{
    path: string;
    installed: boolean;
    scope?: "user" | "workspace";
    agentName?: string;
  }>;
}

type SliceInstallResult =
  | DshHarnessInstallResult
  | CursorHostInstallResult
  | ClaudeCodeHostInstallResult
  | KimiCodeHostInstallResult
  | { status: "created" | "updated" | "skipped" | "error"; filePath?: string; message?: string };

function unknownHost(hostId: string): HostAdapterInstallResult {
  return {
    hostId,
    displayName: hostId,
    status: "error",
    message: `unknown host adapter: ${hostId}`,
  };
}

function unsupportedHost(hostId: string, displayName: string): HostAdapterInstallResult {
  return {
    hostId,
    displayName,
    status: "unsupported",
    message: `${displayName} ${HOST_ADAPTER_INSTALL_UNMIGRATED}`,
  };
}

function dshHomeOptions(options: HostAdapterInstallOptions): { dshHome?: string } {
  return typeof options.home === "string" ? { dshHome: options.home } : {};
}

function sliceHomeOptions(options: HostAdapterInstallOptions): { home?: string } {
  return typeof options.home === "string" ? { home: options.home } : {};
}

function withAdapterMeta(
  hostId: string,
  displayName: string,
  result: SliceInstallResult
): HostAdapterInstallResult {
  const mapped: HostAdapterInstallResult = {
    hostId,
    displayName,
    status: result.status,
  };
  if (result.filePath !== undefined) mapped.filePath = result.filePath;
  if (result.message !== undefined) mapped.message = result.message;
  return mapped;
}

function fromDshStatus(status: DshHarnessStatus): HostAdapterHostStatus {
  return {
    hostId: DSH_HOST_ADAPTER_ID,
    agent: status.agent,
    detected: status.detected,
    installed: status.installed,
    glueInstalled: status.glueInstalled,
    skillInstalled: status.skillInstalled,
    mcpInstalled: status.installed,
    home: status.dshHome,
    patchPath: status.patchPath,
    skillPath: status.skillPath,
    dshHome: status.dshHome,
  };
}

function fromCursorStatus(status: CursorHostStatus): HostAdapterHostStatus {
  return {
    hostId: status.hostId,
    agent: status.agent,
    detected: status.detected,
    installed: status.installed,
    mcpInstalled: status.mcpInstalled,
    rulesInstalled: status.rulesInstalled,
    skillInstalled: status.skillInstalled,
    home: status.home,
    mcpPath: status.mcpPath,
    rulesPath: status.rulesPath,
    skillPath: status.skillPath,
    mcpTargets: status.mcpTargets,
  };
}

function fromKimiStatus(status: KimiCodeHostStatus): HostAdapterHostStatus {
  return {
    hostId: status.hostId,
    agent: status.agent,
    detected: status.detected,
    installed: status.installed,
    mcpInstalled: status.mcpInstalled,
    rulesInstalled: status.rulesInstalled,
    skillInstalled: status.skillInstalled,
    home: status.home,
    mcpPath: status.mcpPath,
    rulesPath: status.rulesPath,
    skillPath: status.skillPath,
    mcpTargets: status.mcpTargets,
  };
}

function fromClaudeStatus(status: ClaudeCodeHostStatus): HostAdapterHostStatus {
  return {
    hostId: status.hostId,
    agent: status.agent,
    detected: status.detected,
    installed: status.installed,
    mcpInstalled: status.mcpInstalled,
    rulesInstalled: status.rulesInstalled,
    skillInstalled: status.skillInstalled,
    hooksInstalled: status.hooksInstalled,
    home: status.home,
    mcpPath: status.mcpPath,
    rulesPath: status.rulesPath,
    skillPath: status.skillPath,
    hooksPath: status.settingsPath,
    settingsPath: status.settingsPath,
    mcpTargets: status.mcpTargets,
  };
}

function fromProfileStatus(status: ProfileHostStatus): HostAdapterHostStatus {
  const mapped: HostAdapterHostStatus = {
    hostId: status.hostId,
    agent: status.agent,
    detected: status.detected,
    installed: status.installed,
    mcpInstalled: status.mcpInstalled,
    mcpTargets: status.mcpTargets,
  };
  if (status.mcpPath !== undefined) mapped.mcpPath = status.mcpPath;
  if (status.skillPath !== undefined) mapped.skillPath = status.skillPath;
  if (status.rulesPath !== undefined) mapped.rulesPath = status.rulesPath;
  if (status.skillInstalled !== undefined) mapped.skillInstalled = status.skillInstalled;
  if (status.rulesInstalled !== undefined) mapped.rulesInstalled = status.rulesInstalled;
  return mapped;
}

/** Install a migrated host slice. Unknown registry ids error; unmigrated hosts are unsupported. */
export function installViaHostAdapter(
  hostId: string,
  options: HostAdapterInstallOptions = {}
): HostAdapterInstallResult {
  const adapter = getHostAdapter(hostId);
  if (!adapter) return unknownHost(hostId);
  if (adapter.id === DSH_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, installDshHarness(dshHomeOptions(options)));
  }
  if (adapter.id === CURSOR_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, installCursorHost(sliceHomeOptions(options)));
  }
  if (adapter.id === CLAUDE_CODE_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, installClaudeCodeHost(sliceHomeOptions(options)));
  }
  if (adapter.id === KIMI_CODE_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, installKimiCodeHost(sliceHomeOptions(options)));
  }
  if (isProfileHost(adapter.id)) {
    const profileResult = installProfileHost(adapter.id, sliceHomeOptions(options));
    if (profileResult) {
      return withAdapterMeta(adapter.id, adapter.displayName, profileResult);
    }
  }
  return unsupportedHost(adapter.id, adapter.displayName);
}

export function uninstallViaHostAdapter(
  hostId: string,
  options: HostAdapterInstallOptions = {}
): HostAdapterInstallResult {
  const adapter = getHostAdapter(hostId);
  if (!adapter) return unknownHost(hostId);
  if (adapter.id === DSH_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, uninstallDshHarness(dshHomeOptions(options)));
  }
  if (adapter.id === CURSOR_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, uninstallCursorHost(sliceHomeOptions(options)));
  }
  if (adapter.id === CLAUDE_CODE_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, uninstallClaudeCodeHost(sliceHomeOptions(options)));
  }
  if (adapter.id === KIMI_CODE_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, uninstallKimiCodeHost(sliceHomeOptions(options)));
  }
  if (isProfileHost(adapter.id)) {
    const profileResult = uninstallProfileHost(adapter.id, sliceHomeOptions(options));
    if (profileResult) {
      return withAdapterMeta(adapter.id, adapter.displayName, profileResult);
    }
  }
  return unsupportedHost(adapter.id, adapter.displayName);
}

export function getHostAdapterInstallStatus(
  hostId: string,
  options: HostAdapterInstallOptions = {}
): HostAdapterHostStatus | undefined {
  const adapter = getHostAdapter(hostId);
  if (!adapter) return undefined;
  if (adapter.id === DSH_HOST_ADAPTER_ID) {
    return fromDshStatus(getDshHarnessStatus(dshHomeOptions(options)));
  }
  if (adapter.id === CURSOR_HOST_ADAPTER_ID) {
    return fromCursorStatus(getCursorHostStatus(sliceHomeOptions(options)));
  }
  if (adapter.id === CLAUDE_CODE_HOST_ADAPTER_ID) {
    return fromClaudeStatus(getClaudeCodeHostStatus(sliceHomeOptions(options)));
  }
  if (adapter.id === KIMI_CODE_HOST_ADAPTER_ID) {
    return fromKimiStatus(getKimiCodeHostStatus(sliceHomeOptions(options)));
  }
  if (isProfileHost(adapter.id)) {
    const profileStatus = getProfileHostStatus(adapter.id, sliceHomeOptions(options));
    if (profileStatus) return fromProfileStatus(profileStatus);
  }
  return undefined;
}
