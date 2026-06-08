import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { resolveModelForRole } from "../src/routing/model-router";
import { buildProviderHealthMap } from "../src/routing/provider-health";

describe("M38 semantic enrichment provider gate", () => {
  it("uses enricher economy provider health instead of openbmb", () => {
    const config = validateConfig({
      providers: {
        openai: { apiKey: "test-key" },
      },
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 200,
        semanticEnrichment: {
          enabled: true,
          mode: "post-index",
          autoRunOnIndex: true,
        },
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "tmp/learning-dataset.jsonl",
      },
    });

    const selection = resolveModelForRole("enricher");
    const health = buildProviderHealthMap(config);

    expect(selection.provider).toBe("openai");
    expect(selection.tier).toBe("economy");
    expect(health.openbmb).toBe(false);
    expect(health[selection.provider]).toBe(true);
  });

  it("skips enrichment when enricher provider is unhealthy", () => {
    const config = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 200,
        semanticEnrichment: {
          enabled: true,
          mode: "post-index",
          autoRunOnIndex: true,
        },
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "tmp/learning-dataset.jsonl",
      },
    });

    const selection = resolveModelForRole("enricher");
    const health = buildProviderHealthMap(config);

    expect(health[selection.provider]).toBe(false);
  });
});
