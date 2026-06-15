import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { resolveConfig, resolveConfigPath, resolveWritableConfigPath } from "../src/config/resolve";
import { saveGraphFlowSettings } from "../src/surfaces/cli/runtime";

const tempRoots: string[] = [];
let previousCwd = process.cwd();
let previousHome = process.env.USERPROFILE ?? process.env.HOME;

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function useTempHome(home: string): void {
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
  } else {
    process.env.HOME = home;
  }
}

afterEach(() => {
  process.chdir(previousCwd);
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

describe("M40 global-first config resolution", () => {
  it("prefers global config over scaffold workspace overlay when reading", () => {
    const fakeHome = createTempRoot("graphflow-global-read-home");
    const workspaceRoot = createTempRoot("graphflow-global-read-workspace");
    useTempHome(fakeHome);

    const globalPath = join(fakeHome, ".graphflow.config.json");
    writeFileSync(
      globalPath,
      `${JSON.stringify(
        validateConfig({
          providers: { openai: { apiKey: "sk-global" } },
          tiers: {
            smart: { provider: "openai", model: "deepseek-v4-pro" },
            economy: { provider: "openai", model: "deepseek-v4-flash" },
          },
          budgetPolicy: { runTokenCap: 2000 },
          graphPolicy: {
            enableAutoBuild: true,
            transport: "file",
            graphStorePath: "graphflow-out/graphflow-graph.json",
            maxContextTokens: 400,
          },
          learningPolicy: {
            enableFlywheel: true,
            trainingCadence: "nightly",
            canaryRatio: 10,
            exportPath: "graphflow-out/learning-dataset.jsonl",
          },
        }),
        null,
        2
      )}\n`,
      "utf8"
    );

    const overlayDir = join(workspaceRoot, ".graphflow");
    mkdirSync(overlayDir, { recursive: true });
    writeFileSync(join(overlayDir, "config.json"), `${readFileSync(globalPath, "utf8")}`, "utf8");

    previousCwd = process.cwd();
    process.chdir(workspaceRoot);

    const resolved = resolveConfig();
    expect(resolved.providers.openai?.apiKey).toBe("sk-global");
    expect(resolved.tiers.smart.model).toBe("deepseek-v4-pro");
    expect(resolveConfigPath()).toBe(globalPath);
  });

  it("writes settings to global config when no project config exists", () => {
    const fakeHome = createTempRoot("graphflow-global-write-home");
    const workspaceRoot = createTempRoot("graphflow-global-write-workspace");
    useTempHome(fakeHome);

    const globalPath = join(fakeHome, ".graphflow.config.json");
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
          },
          learningPolicy: {
            enableFlywheel: true,
            trainingCadence: "nightly",
            canaryRatio: 10,
            exportPath: "graphflow-out/learning-dataset.jsonl",
          },
        }),
        null,
        2
      )}\n`,
      "utf8"
    );

    previousCwd = process.cwd();
    process.chdir(workspaceRoot);

    expect(resolveWritableConfigPath()).toBe(globalPath);

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
      openbmbMode: "embedded",
      openbmbEngine: "command",
      openbmbModel: "",
      openbmbAutoDownload: false,
    });

    const saved = JSON.parse(readFileSync(globalPath, "utf8")) as {
      providers?: { openai?: { apiKey?: string; baseUrl?: string } };
      tiers?: { smart?: { model?: string } };
    };
    expect(saved.providers?.openai?.apiKey).toBe("${DEEPSEEK_API_KEY}");
    expect(saved.providers?.openai?.baseUrl).toBe("https://api.deepseek.com");
    expect(saved.tiers?.smart?.model).toBe("deepseek-v4-pro");
    expect(existsSync(join(workspaceRoot, ".graphflow", "config.json"))).toBe(false);
  });
});
