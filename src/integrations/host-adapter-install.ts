/**
 * Thin HostAdapter install dispatch.
 *
 * v1.13 added the capability registry (`host-adapter.ts`). This module is the
 * first installer slice on top of it: DeepSeek Harness home overlay.
 * Cursor and Claude Code still use their existing installers — migrate those
 * hosts here next, do not grow this file into a rewrite of agent-mcp-installer.
 */
import { getHostAdapter } from "./host-adapter";
import {
  DSH_HOST_ADAPTER_ID,
  getDshHarnessStatus,
  installDshHarness,
  uninstallDshHarness,
  type DshHarnessInstallResult,
  type DshHarnessStatus,
} from "./dsh-harness-installer";

export { DSH_HOST_ADAPTER_ID };

export const HOST_ADAPTER_INSTALL_UNMIGRATED =
  "install path is not yet migrated onto HostAdapter";

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

function withAdapterMeta(
  hostId: string,
  displayName: string,
  result: DshHarnessInstallResult
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

/** Install the migrated host slice. DSH only in this PR; other hosts are unsupported. */
export function installViaHostAdapter(
  hostId: string,
  options: HostAdapterInstallOptions = {}
): HostAdapterInstallResult {
  const adapter = getHostAdapter(hostId);
  if (!adapter) return unknownHost(hostId);
  if (adapter.id === DSH_HOST_ADAPTER_ID) {
    return withAdapterMeta(adapter.id, adapter.displayName, installDshHarness(dshHomeOptions(options)));
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
  return unsupportedHost(adapter.id, adapter.displayName);
}

export function getHostAdapterInstallStatus(
  hostId: string,
  options: HostAdapterInstallOptions = {}
): DshHarnessStatus | undefined {
  const adapter = getHostAdapter(hostId);
  if (!adapter || adapter.id !== DSH_HOST_ADAPTER_ID) return undefined;
  return getDshHarnessStatus(dshHomeOptions(options));
}
