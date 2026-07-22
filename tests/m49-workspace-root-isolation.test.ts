import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { resolveGraphStorePath } from "../src/config/paths";
import { resolveConfig } from "../src/config/resolve";
import { saveGraphFlowSettings } from "../src/surfaces/cli/runtime";

const tempRoots: string[] = [];
let previousCwd = process.cwd();
let previousHome = process.env.USERPROFILE ?? process.env.HOME;
let previousWorkspaceEnv = process.env.GRAPHFLOW_WORKSPACE_ROOT;
let previousConfigHome = process.env.GRAPHFLOW_CONFIG_HOME;

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const resolved = realpathSync(root);
  tempRoots.push(resolved);
  return resolved;
}

function useTempHome(home: string): void {
  process.env.GRAPHFLOW_CONFIG_HOME = home;
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
  } else {
    process.env.HOME = home;
  }
}

function writeGlobalConfig(globalPath: string, workspaceRoot: string): void {
  writeFileSync(
    globalPath,
    `${JSON.stringify(
      validateConfig({
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-4.1" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          transport: "file",
          graphStorePath: "graphflow-out/graphflow-graph.json",
          maxContextTokens: 400,
          workspaceRoot,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: "graphflow-out/learning-dataset.jsonl",
        },
      }),
      null,
      2
    )}\n`,
    "utf8"
  );
}

afterEach(() => {
  process.chdir(previousCwd);
  if (previousWorkspaceEnv) {
    process.env.GRAPHFLOW_WORKSPACE_ROOT = previousWorkspaceEnv;
  } else {
    delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
  }
  if (previousConfigHome) {
    process.env.GRAPHFLOW_CONFIG_HOME = previousConfigHome;
  } else {
    delete process.env.GRAPHFLOW_CONFIG_HOME;
  }
  if (process.platform === "win32") {
    if (previousHome) {
      process.env.USERPROFILE = previousHome;
    } else {
      delete process.env.USERPROFILE;
    }
  } else if (previousHome) {
    process.env.HOME = previousHome;
  } else {
    delete process.env.HOME;
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("M49 runtime workspace root isolation", () => {
  it("ignores stale workspaceRoot from global config and uses process.cwd()", () => {
    const fakeHome = createTempRoot("graphflow-m49-home");
    const projectA = createTempRoot("graphflow-m49-project-a");
    const projectB = createTempRoot("graphflow-m49-project-b");
    useTempHome(fakeHome);
    delete process.env.GRAPHFLOW_WORKSPACE_ROOT;

    const globalPath = join(fakeHome, ".graphflow.config.json");
    writeGlobalConfig(globalPath, projectA);

    previousCwd = process.cwd();
    process.chdir(projectB);

    const config = resolveConfig();
    expect(resolveGraphStorePath(config)).toBe(join(projectB, "graphflow-out", "graphflow-graph.json"));
  });

  it("does not persist workspaceRoot when saving global settings", () => {
    const fakeHome = createTempRoot("graphflow-m49-save-home");
    const workspaceRoot = createTempRoot("graphflow-m49-save-workspace");
    useTempHome(fakeHome);

    const globalPath = join(fakeHome, ".graphflow.config.json");
    writeGlobalConfig(globalPath, workspaceRoot);

    previousCwd = process.cwd();
    process.chdir(workspaceRoot);

    saveGraphFlowSettings({
      provider: "openai",
      smartModel: "deepseek-v4-pro",
      economyModel: "deepseek-v4-flash",
      apiKeyEnvVar: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      maxContextTokens: 400,
      layerQuota: { l1: 6, l2: 4, l3: 3 },
      enableNearLosslessMode: true,
      autoIndexOnPreview: true,
      autoIndexOnRun: true,
      autoIndexOnSave: false,
      transport: "file",
      graphStorePath: "graphflow-out/graphflow-graph.json",
      enrichmentBackend: "inherit",
      enrichmentProvider: "",
      enrichmentModel: "",
    });

    const saved = JSON.parse(readFileSync(globalPath, "utf8")) as {
      graphPolicy?: { workspaceRoot?: string };
    };
    expect(saved.graphPolicy?.workspaceRoot).toBeUndefined();
  });

  it("honors GRAPHFLOW_WORKSPACE_ROOT for MCP launchers", () => {
    const fakeHome = createTempRoot("graphflow-m49-env-home");
    const pinnedProject = createTempRoot("graphflow-m49-env-project");
    const otherCwd = createTempRoot("graphflow-m49-env-other");
    useTempHome(fakeHome);

    const globalPath = join(fakeHome, ".graphflow.config.json");
    writeGlobalConfig(globalPath, otherCwd);

    previousCwd = process.cwd();
    process.chdir(otherCwd);
    process.env.GRAPHFLOW_WORKSPACE_ROOT = pinnedProject;

    const config = resolveConfig();
    expect(resolveGraphStorePath(config)).toBe(join(pinnedProject, "graphflow-out", "graphflow-graph.json"));
  });
});
