import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverWorkspaceRoot,
  ensureMcpWorkspaceEnv,
  hasProjectWorkspaceMarkers,
  isGraphFlowRuntimeDirectory,
  isUnsafeWorkspaceFallback,
} from "../src/config/discover-workspace";

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

describe("M50 discover workspace", () => {
  it("detects GraphFlow runtime directories", () => {
    expect(isGraphFlowRuntimeDirectory("/home/user/.cursor/extensions/roarpeng.graphflow-vscode-1.0.0/vendor/graphflow")).toBe(
      true
    );
    expect(isGraphFlowRuntimeDirectory("/repo/my-project")).toBe(false);
  });

  it("finds project root via .git marker", () => {
    const project = createTempRoot("graphflow-discover-git");
    const nested = join(project, "src", "lib");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(project, ".git"));

    expect(hasProjectWorkspaceMarkers(project)).toBe(true);
    expect(discoverWorkspaceRoot(nested)).toBe(project);
  });

  it("finds project root via graphflow-out store", () => {
    const project = createTempRoot("graphflow-discover-store");
    const nested = join(project, "pkg");
    mkdirSync(nested, { recursive: true });
    const storeDir = join(project, "graphflow-out");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, "graphflow-graph.json"), '{"nodes":[],"edges":[]}');

    expect(discoverWorkspaceRoot(nested)).toBe(project);
  });

  it("prefers CURSOR_PROJECT_DIR when it has workspace markers", () => {
    const project = createTempRoot("graphflow-discover-cursor");
    mkdirSync(join(project, ".git"));
    const vendor = join(project, ".cursor", "extensions", "roarpeng.graphflow-vscode-1.0.0", "vendor", "graphflow");
    mkdirSync(vendor, { recursive: true });

    process.env.CURSOR_PROJECT_DIR = project;
    expect(discoverWorkspaceRoot(vendor)).toBe(project);
  });

  it("ensureMcpWorkspaceEnv sets GRAPHFLOW_WORKSPACE_ROOT from discovery", () => {
    const project = createTempRoot("graphflow-discover-env");
    mkdirSync(join(project, ".git"));
    const nested = join(project, "apps", "web");
    mkdirSync(nested, { recursive: true });

    const resolved = ensureMcpWorkspaceEnv(nested);
    expect(resolved).toBe(project);
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBe(project);
  });

  it("ensureMcpWorkspaceEnv resolves existing GRAPHFLOW_WORKSPACE_ROOT", () => {
    const project = createTempRoot("graphflow-discover-explicit");
    mkdirSync(join(project, ".git"));
    process.env.GRAPHFLOW_WORKSPACE_ROOT = project;

    const resolved = ensureMcpWorkspaceEnv("/tmp/unrelated");
    expect(resolved).toBe(project);
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBe(project);
  });

  it("treats AppData-style paths as unsafe implicit workspace roots", () => {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
      return;
    }
    clearIdeWorkspaceEnv();
    const localAppData = process.env.LOCALAPPDATA;
    expect(isUnsafeWorkspaceFallback(localAppData)).toBe(true);
    expect(ensureMcpWorkspaceEnv(localAppData)).toBeUndefined();

    const elevated = join(localAppData, "ElevatedDiagnostics");
    expect(isUnsafeWorkspaceFallback(elevated)).toBe(true);
    expect(ensureMcpWorkspaceEnv(elevated)).toBeUndefined();
  });
});
