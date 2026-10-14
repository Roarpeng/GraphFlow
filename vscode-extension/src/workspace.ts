import { homedir } from "node:os";
import { resolve } from "node:path";

export function resolveRuntimeCwd(workspaceRoot?: string, homeDir = homedir()): string {
  if (workspaceRoot) {
    return resolve(workspaceRoot);
  }
  const envRoot = process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim();
  if (envRoot && envRoot !== "${workspaceFolder}") {
    return resolve(envRoot);
  }
  return resolve(homeDir);
}

export function requireWorkspaceFolder(workspaceRoot: string | undefined): workspaceRoot is string {
  return Boolean(workspaceRoot);
}
