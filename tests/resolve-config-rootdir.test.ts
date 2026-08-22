import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import { resolveConfig } from "../src/config/resolve";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";

/**
 * Caller-provided rootDir must survive resolveConfig's internal bind.
 *
 * Regression: resolveConfig() unconditionally bound the runtime workspace
 * root before callers could inject their tool-level rootDir. With an unsafe
 * process.cwd() (home dir / AppData — the typical MCP spawn cwd), every tool
 * call threw "Refusing to index unsafe workspace root" even though the caller
 * passed rootDir. resolveConfig now forwards a `bind.rootDir` override into
 * the internal bind, so rootDir (priority 1) wins before cwd discovery
 * (priority 4/5) is ever consulted.
 *
 * No process.chdir() here: m74/m75 used chdir and raced under parallel
 * workers; resolveRuntimeWorkspaceRoot accepts an injectable fromDir and the
 * resolveConfig tests mock process.cwd() with vi.spyOn instead.
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
const previousEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]])
) as Partial<Record<(typeof envKeys)[number], string | undefined>>;

function createTempProject(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: prefix }), "utf8");
  mkdirSync(join(root, ".git"));
  tempRoots.push(root);
  return root;
}

function writeProjectConfig(root: string, workspaceRoot?: string): string {
  const config = getDefaultConfig();
  config.graphPolicy.workspaceRoot = workspaceRoot ?? root;
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
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
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("resolveConfig rootDir binding with unsafe cwd", () => {
  it("default branch: rootDir wins over unsafe cwd and does not throw", () => {
    const project = createTempProject("rc-safe-default");
    mockCwd(homedir()); // e.g. MCP server spawned with cwd = user home

    let config: ReturnType<typeof resolveConfig> | undefined;
    expect(() => {
      config = resolveConfig(undefined, { rootDir: project });
    }).not.toThrow();

    expect(config?.graphPolicy.workspaceRoot).toBe(resolve(project));
  });

  it("still refuses unsafe cwd when no rootDir is passed (safety kept)", () => {
    mockCwd(homedir());
    expect(() => resolveConfig(undefined)).toThrow(/unsafe workspace root/i);
  });

  it("explicit configPath branch: rootDir overrides the config's workspaceRoot", () => {
    const projectRoot = createTempProject("rc-explicit-a");
    const override = createTempProject("rc-explicit-b");
    const configPath = writeProjectConfig(projectRoot, projectRoot);
    mockCwd(homedir());

    // Both rootDir and a config-level workspaceRoot present: rootDir wins.
    const withRoot = resolveConfig(configPath, { rootDir: override });
    expect(withRoot.graphPolicy.workspaceRoot).toBe(resolve(override));

    // Without rootDir, the explicit config's workspaceRoot is preserved
    // instead of falling through to the unsafe cwd.
    const noRoot = resolveConfig(configPath);
    expect(noRoot.graphPolicy.workspaceRoot).toBe(resolve(projectRoot));
  });

  it("default branch: project config workspaceRoot is honored", () => {
    const project = createTempProject("rc-project");
    writeProjectConfig(project, project);
    mockCwd(project);

    const config = resolveConfig(undefined);
    expect(config.graphPolicy.workspaceRoot).toBe(resolve(project));
  });
});

describe("resolveRuntimeWorkspaceRoot fromDir injection", () => {
  it("refuses unsafe fromDir without override, honors rootDir with one", () => {
    const project = createTempProject("rc-fromdir");
    expect(() => resolveRuntimeWorkspaceRoot({ fromDir: homedir() })).toThrow(
      /unsafe workspace root/i
    );
    expect(resolveRuntimeWorkspaceRoot({ fromDir: homedir(), rootDir: project })).toBe(
      resolve(project)
    );
  });

  it("discovers the project root walking up from a nested fromDir", () => {
    const project = createTempProject("rc-fromdir-nested");
    const nested = join(project, "src", "lib");
    mkdirSync(nested, { recursive: true });

    expect(resolveRuntimeWorkspaceRoot({ fromDir: nested })).toBe(resolve(project));
  });
});
