import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureMcpWorkspaceEnv,
  isUnsafeWorkspaceFallback,
} from "../src/config/discover-workspace";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";

/**
 * M74 — MCP unsafe workspace regression.
 *
 * vscode-extension/mcp-launcher.cjs must never pin GRAPHFLOW_WORKSPACE_ROOT to
 * homedir/AppData (see comment on resolveChildWorkspaceRoot). Pure CJS spawn
 * side-effects make the launcher awkward to unit-test; these cases cover the
 * shared TS helpers the launcher mirrors.
 */

const tempRoots: string[] = [];
let previousCwd = process.cwd();
let previousWorkspaceEnv = process.env.GRAPHFLOW_WORKSPACE_ROOT;
let previousCursorProject = process.env.CURSOR_PROJECT_DIR;
let previousWorkspaceFolder = process.env.WORKSPACE_FOLDER;

function createTempProject(prefix: string): string {
  const root = join(
    process.cwd(),
    "tmp",
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: prefix }), "utf8");
  mkdirSync(join(root, ".git"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  process.chdir(previousCwd);
  if (previousWorkspaceEnv === undefined) {
    delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
  } else {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = previousWorkspaceEnv;
  }
  if (previousCursorProject === undefined) {
    delete process.env.CURSOR_PROJECT_DIR;
  } else {
    process.env.CURSOR_PROJECT_DIR = previousCursorProject;
  }
  if (previousWorkspaceFolder === undefined) {
    delete process.env.WORKSPACE_FOLDER;
  } else {
    process.env.WORKSPACE_FOLDER = previousWorkspaceFolder;
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("M74 MCP unsafe workspace regression", () => {
  it("isUnsafeWorkspaceFallback(homedir) is true", () => {
    expect(isUnsafeWorkspaceFallback(homedir())).toBe(true);
  });

  it("clears GRAPHFLOW_WORKSPACE_ROOT when set to homedir", () => {
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();

    const resolved = ensureMcpWorkspaceEnv(homedir());
    expect(resolved === undefined || !isUnsafeWorkspaceFallback(resolved)).toBe(true);
    if (process.env.GRAPHFLOW_WORKSPACE_ROOT) {
      expect(isUnsafeWorkspaceFallback(process.env.GRAPHFLOW_WORKSPACE_ROOT)).toBe(false);
    }
  });

  it("resolveRuntimeWorkspaceRoot clears homedir env and honors safe rootDir", () => {
    const project = createTempProject("m74-safe-root");
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();

    const withOverride = resolveRuntimeWorkspaceRoot({ rootDir: project });
    expect(withOverride).toBe(resolve(project));

    // Env may still be poisoned when rootDir short-circuits; clear path:
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();
    previousCwd = process.cwd();
    process.chdir(project);
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;

    const discovered = resolveRuntimeWorkspaceRoot();
    expect(discovered).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
  });

  it("ensureMcpWorkspaceEnv rediscovers a real project after clearing home env", () => {
    const project = createTempProject("m74-rediscover");
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();
    previousCwd = process.cwd();
    process.chdir(project);
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;

    const resolved = ensureMcpWorkspaceEnv(project);
    expect(resolved).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBe(resolve(project));
  });
});
