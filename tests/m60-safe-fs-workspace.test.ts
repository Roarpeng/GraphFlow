import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureMcpWorkspaceEnv,
  hasDevProjectMarkers,
  isUnsafeWorkspaceFallback,
  isUsableWorkspaceFallback,
} from "../src/config/discover-workspace";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";
import { walkFiles } from "../src/graph/file-indexer-walker";
import { isIgnorableFsError, safeReaddirSync } from "../src/utils/safe-fs";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  for (const key of [
    "GRAPHFLOW_WORKSPACE_ROOT",
    "CURSOR_PROJECT_DIR",
    "VSCODE_CWD",
    "VSCODE_WORKSPACE_FOLDER",
    "INIT_CWD",
    "PWD",
  ]) {
    delete process.env[key];
  }
});

function clearIdeWorkspaceEnv(): void {
  for (const key of [
    "GRAPHFLOW_WORKSPACE_ROOT",
    "CURSOR_PROJECT_DIR",
    "VSCODE_CWD",
    "VSCODE_WORKSPACE_FOLDER",
    "INIT_CWD",
    "PWD",
  ]) {
    delete process.env[key];
  }
}

describe("M60 safe fs and unsafe workspace roots", () => {
  it("isIgnorableFsError recognizes EPERM/EACCES/ENOENT", () => {
    expect(isIgnorableFsError({ code: "EPERM" })).toBe(true);
    expect(isIgnorableFsError({ code: "EACCES" })).toBe(true);
    expect(isIgnorableFsError({ code: "ENOENT" })).toBe(true);
    expect(isIgnorableFsError({ code: "EBUSY" })).toBe(false);
  });

  it("safeReaddirSync returns empty array for missing directories", () => {
    expect(safeReaddirSync(join(tmpdir(), "graphflow-missing-dir-xyz"))).toEqual([]);
  });

  it("flags Windows AppData Local as unsafe workspace fallback", () => {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
      return;
    }
    const localAppData = process.env.LOCALAPPDATA;
    expect(isUnsafeWorkspaceFallback(localAppData)).toBe(true);
    expect(isUnsafeWorkspaceFallback(join(localAppData, "ElevatedDiagnostics"))).toBe(true);
  });

  it("does not flag normal project directories as unsafe", () => {
    const project = createTempRoot("graphflow-safe-project");
    mkdirSync(join(project, ".git"));
    expect(isUnsafeWorkspaceFallback(project)).toBe(false);
    expect(isUsableWorkspaceFallback(project)).toBe(true);
  });

  it("hasDevProjectMarkers detects package.json without .git", () => {
    const project = createTempRoot("graphflow-dev-marker");
    writeFileSync(join(project, "package.json"), "{}");
    expect(hasDevProjectMarkers(project)).toBe(true);
    expect(isUsableWorkspaceFallback(project)).toBe(true);
  });

  it("ensureMcpWorkspaceEnv refuses AppData Local as implicit workspace", () => {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
      return;
    }
    clearIdeWorkspaceEnv();
    const localAppData = process.env.LOCALAPPDATA;

    const resolved = ensureMcpWorkspaceEnv(localAppData);
    expect(resolved).toBeUndefined();
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
  });

  it("ensureMcpWorkspaceEnv uses IDE hint when cwd is unsafe", () => {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
      return;
    }
    clearIdeWorkspaceEnv();
    const project = createTempRoot("graphflow-ide-hint");
    mkdirSync(join(project, ".git"));
    const localAppData = process.env.LOCALAPPDATA;
    process.env.VSCODE_CWD = project;

    const resolved = ensureMcpWorkspaceEnv(localAppData);
    expect(resolved).toBe(project);
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBe(project);
  });

  it("resolveRuntimeWorkspaceRoot throws for unsafe cwd without discovery", () => {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
      return;
    }
    clearIdeWorkspaceEnv();
    const localAppData = process.env.LOCALAPPDATA;
    const previousCwd = process.cwd();
    try {
      process.chdir(localAppData);
      expect(() => resolveRuntimeWorkspaceRoot()).toThrow(/unsafe workspace root/i);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("walkFiles returns project files under a normal directory tree", () => {
    const root = createTempRoot("graphflow-walk-safe");
    const readable = join(root, "src");
    mkdirSync(readable, { recursive: true });
    writeFileSync(join(readable, "app.ts"), "export const x = 1;\n");

    const files = walkFiles(root, [".ts"]);
    expect(files.some((file) => file.endsWith("app.ts"))).toBe(true);
  });

  it("walkFiles skips agent tooling dirs incl. .claude/worktrees full-repo copies", () => {
    const root = createTempRoot("graphflow-walk-ignored");
    const cases: string[] = [
      ".agent", ".claude", ".cursor", ".gemini", ".joycode", ".trae", "Cursor",
    ];
    for (const dir of cases) {
      mkdirSync(join(root, dir, "nested"), { recursive: true });
      writeFileSync(join(root, dir, "nested", "worktree-copy.ts"), "export const x = 1;\n");
    }

    const files = walkFiles(root, [".ts"]);
    expect(files).toEqual([]);
  });

  it("walkFiles still indexes real source next to ignored agent dirs", () => {
    const root = createTempRoot("graphflow-walk-mixed");
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, ".claude", "worktrees", "agent-abc"), { recursive: true });
    writeFileSync(join(root, "src", "deep", "main.ts"), "export const main = 1;\n");
    writeFileSync(join(root, ".claude", "worktrees", "agent-abc", "dup.ts"), "export const dup = 1;\n");

    const files = walkFiles(root, [".ts"]);
    expect(files).toHaveLength(1);
    expect(files[0].endsWith(join("src", "deep", "main.ts"))).toBe(true);
  });
});
