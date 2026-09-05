import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverWorkspaceRoot,
  ensureMcpWorkspaceEnv,
  isUnsafeWorkspaceFallback,
} from "../src/config/discover-workspace";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";
import { buildMcpServerNode } from "../src/integrations/agent-mcp-installer";
import { createTempDir, createTempProjectRoot, rmTrackedRoots } from "./helpers/temp-workspace";

/**
 * M75 — After `graphflow install`, Cursor often spawns MCP with cwd=/home/<user>.
 * Discovery must never return the home directory (error: "from discovery: /home/..."),
 * and must prefer Cursor's WORKSPACE_FOLDER_PATHS / ${workspaceFolder}.
 *
 * Isolation: no process.chdir(), no writes under the real home. npx runtime and
 * project fixtures live in os.tmpdir(); unsafe-cwd is exercised via fromDir /
 * process.cwd mock. homedir() is only used as a path string.
 */

const tempRoots: string[] = [];
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
  return createTempProjectRoot(prefix, tempRoots);
}

function mockCwd(dir: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(dir);
}

function clearIdeEnv(): void {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearIdeEnv();
});

afterEach(() => {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
  rmTrackedRoots(tempRoots);
});

describe("M75 MCP home-cwd discovery after install", () => {
  it("never returns homedir from discoverWorkspaceRoot via IDE hints", () => {
    const home = homedir();
    expect(isUnsafeWorkspaceFallback(home)).toBe(true);

    // npx package runtime in a temp tree (not $HOME/.npm) + poisoned PWD=home.
    const runtime = join(
      createTempDir("m75-npx-runtime", tempRoots),
      "node_modules",
      "@roarpeng",
      "graphflow"
    );
    mkdirSync(runtime, { recursive: true });
    process.env.PWD = home;

    const discovered = discoverWorkspaceRoot(runtime);
    expect(discovered === undefined || !isUnsafeWorkspaceFallback(discovered)).toBe(true);
    expect(discovered).not.toBe(resolve(home));
  });

  it("uses WORKSPACE_FOLDER_PATHS when MCP cwd is homedir", () => {
    const project = createTempProject("m75-workspace-paths");
    const home = homedir();
    process.env.WORKSPACE_FOLDER_PATHS = project;
    mockCwd(home);

    const discovered = discoverWorkspaceRoot(home);
    expect(discovered).toBe(resolve(project));

    const ensured = ensureMcpWorkspaceEnv(home);
    expect(ensured).toBe(resolve(project));

    const runtimeRoot = resolveRuntimeWorkspaceRoot({ fromDir: home });
    expect(runtimeRoot).toBe(resolve(project));
  });

  it("ignores unresolved ${workspaceFolder} placeholder env", () => {
    const project = createTempProject("m75-placeholder");
    process.env.GRAPHFLOW_WORKSPACE_ROOT = "${workspaceFolder}";
    process.env.WORKSPACE_FOLDER_PATHS = project;
    mockCwd(homedir());

    const resolved = resolveRuntimeWorkspaceRoot({ fromDir: homedir() });
    expect(resolved).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT === "${workspaceFolder}").toBe(false);
  });

  it("supports multi-root WORKSPACE_FOLDER_PATHS and picks the first safe project", () => {
    const project = createTempProject("m75-multi-root");
    process.env.WORKSPACE_FOLDER_PATHS = [homedir(), project].join(delimiter);
    mockCwd(homedir());

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
    mockCwd(homedir());

    expect(() => resolveRuntimeWorkspaceRoot({ fromDir: homedir() })).not.toThrow(/from discovery/i);
    // Without a project hint, unsafe cwd still refuses indexing — but not via discovery leak.
    expect(() => resolveRuntimeWorkspaceRoot({ fromDir: homedir() })).toThrow(/unsafe workspace root/i);
  });
});
