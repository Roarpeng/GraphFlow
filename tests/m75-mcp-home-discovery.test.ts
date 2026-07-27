import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverWorkspaceRoot,
  ensureMcpWorkspaceEnv,
  isUnsafeWorkspaceFallback,
} from "../src/config/discover-workspace";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";
import { buildMcpServerNode } from "../src/integrations/agent-mcp-installer";

/**
 * M75 — After `graphflow install`, Cursor often spawns MCP with cwd=/home/<user>.
 * Discovery must never return the home directory (error: "from discovery: /home/..."),
 * and must prefer Cursor's WORKSPACE_FOLDER_PATHS / ${workspaceFolder}.
 */

const tempRoots: string[] = [];
let previousCwd = process.cwd();
const envKeys = [
  "GRAPHFLOW_WORKSPACE_ROOT",
  "CURSOR_PROJECT_DIR",
  "VSCODE_CWD",
  "VSCODE_WORKSPACE_FOLDER",
  "WORKSPACE_FOLDER_PATHS",
  "WORKSPACE_FOLDER",
  "INIT_CWD",
  "PWD",
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Partial<
  Record<(typeof envKeys)[number], string | undefined>
>;

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

function clearIdeEnv(): void {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

afterEach(() => {
  process.chdir(previousCwd);
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("M75 MCP home-cwd discovery after install", () => {
  it("never returns homedir from discoverWorkspaceRoot via IDE hints", () => {
    clearIdeEnv();
    const home = homedir();
    expect(isUnsafeWorkspaceFallback(home)).toBe(true);

    // Simulate npx package runtime under home + poisoned PWD=home (dotfiles .git common).
    const runtime = join(
      home,
      ".npm",
      "_npx",
      "m75test",
      "node_modules",
      "@roarpeng",
      "graphflow"
    );
    mkdirSync(runtime, { recursive: true });
    tempRoots.push(join(home, ".npm", "_npx", "m75test"));
    process.env.PWD = home;

    const discovered = discoverWorkspaceRoot(runtime);
    expect(discovered === undefined || !isUnsafeWorkspaceFallback(discovered)).toBe(true);
    expect(discovered).not.toBe(resolve(home));
  });

  it("uses WORKSPACE_FOLDER_PATHS when MCP cwd is homedir", () => {
    clearIdeEnv();
    const project = createTempProject("m75-workspace-paths");
    const home = homedir();
    process.env.WORKSPACE_FOLDER_PATHS = project;

    previousCwd = process.cwd();
    process.chdir(home);

    const discovered = discoverWorkspaceRoot(home);
    expect(discovered).toBe(resolve(project));

    const ensured = ensureMcpWorkspaceEnv(home);
    expect(ensured).toBe(resolve(project));

    const runtimeRoot = resolveRuntimeWorkspaceRoot();
    expect(runtimeRoot).toBe(resolve(project));
  });

  it("ignores unresolved ${workspaceFolder} placeholder env", () => {
    clearIdeEnv();
    const project = createTempProject("m75-placeholder");
    process.env.GRAPHFLOW_WORKSPACE_ROOT = "${workspaceFolder}";
    process.env.WORKSPACE_FOLDER_PATHS = project;

    previousCwd = process.cwd();
    process.chdir(homedir());

    const resolved = resolveRuntimeWorkspaceRoot();
    expect(resolved).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT === "${workspaceFolder}").toBe(false);
  });

  it("supports multi-root WORKSPACE_FOLDER_PATHS and picks the first safe project", () => {
    clearIdeEnv();
    const project = createTempProject("m75-multi-root");
    process.env.WORKSPACE_FOLDER_PATHS = [homedir(), project].join(delimiter);

    previousCwd = process.cwd();
    process.chdir(homedir());

    expect(discoverWorkspaceRoot(homedir())).toBe(resolve(project));
  });

  it("npx MCP install pins GRAPHFLOW_WORKSPACE_ROOT to Cursor ${workspaceFolder}", () => {
    const node = buildMcpServerNode({
      strategy: "npx",
      workspaceRoot: undefined,
    });
    expect(node.env?.GRAPHFLOW_WORKSPACE_ROOT).toBe("${workspaceFolder}");
  });

  it("resolveRuntimeWorkspaceRoot does not throw 'from discovery' for homedir cwd", () => {
    clearIdeEnv();
    previousCwd = process.cwd();
    process.chdir(homedir());

    expect(() => resolveRuntimeWorkspaceRoot()).not.toThrow(/from discovery/i);
    // Without a project hint, unsafe cwd still refuses indexing — but not via discovery leak.
    expect(() => resolveRuntimeWorkspaceRoot()).toThrow(/unsafe workspace root/i);
  });
});
