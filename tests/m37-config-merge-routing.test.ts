import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { mergeGraphFlowConfig } from "../src/config/merge";
import { validateConfig } from "../src/config/loader";
import { resolveModelForRole } from "../src/routing/model-router";

describe("M37 config merge and routing", () => {
  const baseConfig = validateConfig({
    providers: {
      openai: {
        apiKey: "sk-root",
        baseUrl: "https://api.deepseek.com",
      },
    },
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
  });

  it("inherits root tiers when overlay only contains scaffold defaults", () => {
    const overlay = validateConfig({
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
        semanticEnrichment: { sleepMs: 0 },
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });

    const merged = mergeGraphFlowConfig(baseConfig, overlay);
    expect(merged.tiers.smart.model).toBe("deepseek-v4-pro");
    expect(merged.tiers.economy.model).toBe("deepseek-v4-flash");
    expect(merged.providers.openai?.apiKey).toBe("sk-root");
  });

  it("resolveModelForRole reads merged tiers from project configs", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "graphflow-m37-"));
    const overlayDir = join(projectRoot, ".graphflow");
    mkdirSync(overlayDir, { recursive: true });

    writeFileSync(
      join(projectRoot, "graphflow.config.json"),
      `${JSON.stringify(baseConfig, null, 2)}\n`,
      "utf8"
    );
    writeFileSync(
      join(overlayDir, "config.json"),
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

    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      expect(resolveModelForRole("planner").model).toBe("deepseek-v4-pro");
      expect(resolveModelForRole("worker").model).toBe("deepseek-v4-flash");
      expect(resolveModelForRole("validator").model).toBe("deepseek-v4-pro");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("defaults embeddingPolicy to hash provider", () => {
    const merged = mergeGraphFlowConfig(baseConfig, validateConfig({
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
    }));

    expect(merged.embeddingPolicy?.provider).toBe("hash");
    expect(merged.embeddingPolicy?.model).toBe("Xenova/bge-base-zh-v1.5");
    expect(merged.embeddingPolicy?.enabled).toBe(true);
  });
});
