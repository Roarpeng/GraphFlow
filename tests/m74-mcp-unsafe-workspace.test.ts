import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureMcpWorkspaceEnv,
  isUnsafeWorkspaceFallback,
} from "../src/config/discover-workspace";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";
import { createTempProjectRoot, rmTrackedRoots } from "./helpers/temp-workspace";

/**
 * M74 — MCP unsafe workspace regression.
 *
 * vscode-extension/mcp-launcher.cjs must never pin GRAPHFLOW_WORKSPACE_ROOT to
 * homedir/AppData (see comment on resolveChildWorkspaceRoot). Pure CJS spawn
 * side-effects make the launcher awkward to unit-test; these cases cover the
 * shared TS helpers the launcher mirrors.
 *
 * Isolation: no process.chdir(), no writes under $HOME. Project fixtures live
 * in os.tmpdir(); unsafe-cwd is exercised via fromDir / process.cwd mock.
 * homedir() is only used as a path string for the unsafe-root predicate.
 */

const tempRoots: string[] = [];
const envKeys = [
  "GRAPHFLOW_WORKSPACE_ROOT",
  "CURSOR_PROJECT_DIR",
  "WORKSPACE_FOLDER",
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

beforeEach(() => {
  for (const key of envKeys) {
    delete process.env[key];
  }
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

    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;
    mockCwd(project);

    const discovered = resolveRuntimeWorkspaceRoot({ fromDir: project });
    expect(discovered).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
  });

  it("ensureMcpWorkspaceEnv rediscovers a real project after clearing home env", () => {
    const project = createTempProject("m74-rediscover");
    process.env.GRAPHFLOW_WORKSPACE_ROOT = homedir();
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.WORKSPACE_FOLDER;

    const resolved = ensureMcpWorkspaceEnv(project);
    expect(resolved).toBe(resolve(project));
    expect(process.env.GRAPHFLOW_WORKSPACE_ROOT).toBe(resolve(project));
  });
});
