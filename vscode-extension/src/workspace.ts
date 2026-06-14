import { homedir } from "node:os";

export function resolveRuntimeCwd(workspaceRoot?: string, homeDir = homedir()): string {
  return workspaceRoot ?? homeDir;
}

export function requireWorkspaceFolder(workspaceRoot: string | undefined): workspaceRoot is string {
  return Boolean(workspaceRoot);
}
