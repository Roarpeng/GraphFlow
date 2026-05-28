import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { buildFallbackChain, buildProviderHealthMap } from "../src/routing/provider-health";
import { runTask } from "../src/surfaces/cli/runtime";

describe("M12 dynamic routing", () => {
  it("marks providers unhealthy without api key in strict mode", () => {
    const config = validateConfig({
      providers: {
        openai: {},
        anthropic: { apiKey: "test-key" },
      },
      tiers: {
        smart: { provider: "openai", model: "gpt-5.3-codex" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "tmp/learning-dataset.jsonl",
      },
      routingPolicy: {
        enableDynamicRouting: true,
        requireApiKeyForHealthy: true,
        providerPriority: ["anthropic", "openai", "bailian", "doubao"],
      },
    });

    const health = buildProviderHealthMap(config);
    expect(health.openai).toBe(false);
    expect(health.anthropic).toBe(true);

    const chain = buildFallbackChain(config);
    expect(chain[0]).toBe("anthropic");
  });

  it("falls back from openai to anthropic when strict health marks openai unhealthy", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-routing-"));
    const configPath = join(root, "graphflow.config.json");

    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            providers: {
              openai: {},
              anthropic: { apiKey: "anthropic-key" },
              bailian: {},
              doubao: {},
            },
            tiers: {
              smart: { provider: "openai", model: "gpt-5.3-codex" },
              economy: { provider: "openai", model: "gpt-4.1-mini" },
            },
            budgetPolicy: { runTokenCap: 2000 },
            graphPolicy: {
              enableAutoBuild: true,
              enableNearLosslessMode: false,
              autoIndexOnRun: false,
              transport: "memory",
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: join(root, "learning.jsonl"),
            },
            routingPolicy: {
              enableDynamicRouting: true,
              requireApiKeyForHealthy: true,
              providerPriority: ["anthropic", "openai", "bailian", "doubao"],
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const output = await runTask("health check", configPath);
      expect(output).toContain("status=COMPLETED");
      expect(output).toContain("routes(planner=anthropic/");
      expect(output).toContain(",worker=anthropic/");
      expect(output).toContain(",validator=anthropic/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
