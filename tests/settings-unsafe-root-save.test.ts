import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getGraphFlowSettings, saveGraphFlowSettings } from "../src/surfaces/cli/runtime/settings";

/**
 * Regression: `graphflow config ui` opened fine but SAVING threw
 * "Refusing to use unsafe workspace root from projectWorkspaceRoot: <home>"
 * — a missing explicit config inherits cwd(home) as workspaceRoot and the
 * runtime bind asserted on it. Global settings never need a project
 * workspace; saving from the home directory must succeed and must never pin
 * an unsafe root into any config file.
 */
describe("settings save from an unsafe (home) working directory", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "gf-settings-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "gf-settings-project-"));
  const previousHome = process.env.GRAPHFLOW_CONFIG_HOME;
  const previousUserHome = process.env.HOME;

  afterAll(() => {
    if (previousHome === undefined) delete process.env.GRAPHFLOW_CONFIG_HOME;
    else process.env.GRAPHFLOW_CONFIG_HOME = previousHome;
    if (previousUserHome !== undefined) process.env.HOME = previousUserHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const sampleInput = {
    provider: "deepseek",
    smartModel: "deepseek-v4-pro",
    economyModel: "deepseek-v4-flash",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    maxContextTokens: 16000,
    layerQuota: { l1: 6, l2: 4, l3: 3 },
    enableNearLosslessMode: true,
    autoIndexOnPreview: true,
    autoIndexOnRun: true,
    autoIndexOnSave: false,
    transport: "sqlite",
    graphStorePath: "graphflow-out/graphflow-graph.sqlite",
    enrichmentBackend: "inherit",
    enrichmentProvider: "",
    enrichmentModel: "",
  } as never;

  it("saves GLOBAL settings while cwd is the home directory (no throw)", () => {
    process.env.GRAPHFLOW_CONFIG_HOME = fakeHome;
    const previousCwd = process.cwd();
    process.chdir(fakeHome); // the user's exact launch point: home, no project config
    try {
      const saved = saveGraphFlowSettings(sampleInput, "graphflow.config.json");
      expect(saved.provider).toBe("deepseek");
      const globalPath = join(fakeHome, ".graphflow.config.json");
      expect(existsSync(globalPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(globalPath, "utf8"));
      // The unsafe root must never be pinned into the file.
      expect(persisted.graphPolicy?.workspaceRoot).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("reads settings back from the home directory without throwing", () => {
    process.env.GRAPHFLOW_CONFIG_HOME = fakeHome;
    const previousCwd = process.cwd();
    process.chdir(fakeHome);
    try {
      const settings = getGraphFlowSettings("graphflow.config.json");
      expect(settings.provider).toBe("deepseek");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("never persists an unsafe workspaceRoot into a PROJECT config either", () => {
    process.env.HOME = fakeHome; // make the project dir's "unsafe" detection see home as home
    const projectConfig = join(projectDir, "graphflow.config.json");
    writeFileSync(
      projectConfig,
      JSON.stringify({
        providers: {},
        tiers: {
          smart: { provider: "deepseek", model: "deepseek-v4-pro" },
          economy: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        // A pre-existing unsafe pin (written by an older buggy version):
        graphPolicy: {
          transport: "file",
          graphStorePath: "graphflow-out/graphflow-graph.json",
          workspaceRoot: fakeHome,
          maxContextTokens: 400,
        },
        learningPolicy: { enableFlywheel: true, trainingCadence: "nightly", exportPath: "graphflow-out/l.jsonl" },
      }),
      "utf8"
    );
    const saved = saveGraphFlowSettings(sampleInput, projectConfig);
    expect(saved.provider).toBe("deepseek");
    const persisted = JSON.parse(readFileSync(projectConfig, "utf8"));
    expect(persisted.graphPolicy.workspaceRoot).toBeUndefined();
  });
});
