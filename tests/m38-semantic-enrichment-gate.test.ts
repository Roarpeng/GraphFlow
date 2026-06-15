import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { resolveModelForRole } from "../src/routing/model-router";
import { buildProviderHealthMap } from "../src/routing/provider-health";

function writeTempConfig(config: ReturnType<typeof validateConfig>): string {
  const root = mkdtempSync(join(tmpdir(), "graphflow-m38-"));
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

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
        exportPath: "graphflow-out/learning-dataset.jsonl",
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
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });

    const selection = resolveModelForRole("enricher");
    const health = buildProviderHealthMap(config);

    expect(health[selection.provider]).toBe(false);
  });

  it("uses explicit enrichment model or falls back to economy tier", () => {
    const withExplicit = validateConfig({
      providers: { openai: { apiKey: "test-key", baseUrl: "https://api.deepseek.com" } },
      tiers: {
        smart: { provider: "openai", model: "deepseek-v4-pro" },
        economy: { provider: "openai", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 200,
        semanticEnrichment: {
          enabled: true,
          model: "deepseek-v4-pro",
        },
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });

    const explicitPath = writeTempConfig(withExplicit);
    expect(resolveModelForRole("enricher", explicitPath).model).toBe("deepseek-v4-pro");
    rmSync(join(explicitPath, ".."), { recursive: true, force: true });

    const inherited = validateConfig({
      providers: { openai: { apiKey: "test-key", baseUrl: "https://api.deepseek.com" } },
      tiers: {
        smart: { provider: "openai", model: "deepseek-v4-pro" },
        economy: { provider: "openai", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 200,
        semanticEnrichment: { enabled: true },
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });

    const inheritedPath = writeTempConfig(inherited);
    const selection = resolveModelForRole("enricher", inheritedPath);
    expect(selection.provider).toBe("openai");
    expect(selection.model).toBe("deepseek-v4-flash");
    rmSync(join(inheritedPath, ".."), { recursive: true, force: true });
  });

  it("routes local backend to openbmb and network backend to cloud provider", () => {
    const localConfig = validateConfig({
      providers: { openai: { apiKey: "test-key" } },
      tiers: {
        smart: { provider: "openai", model: "deepseek-v4-pro" },
        economy: { provider: "openai", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 200,
        semanticEnrichment: { enabled: true, backend: "local", model: "minicpm5-1b" },
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });

    const networkConfig = validateConfig({
      providers: { openai: { apiKey: "test-key", baseUrl: "https://api.deepseek.com" } },
      tiers: {
        smart: { provider: "openai", model: "deepseek-v4-pro" },
        economy: { provider: "openai", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 200,
        semanticEnrichment: {
          enabled: true,
          backend: "network",
          provider: "openai",
          model: "deepseek-v4-pro",
        },
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });

    const localPath = writeTempConfig(localConfig);
    const networkPath = writeTempConfig(networkConfig);
    expect(resolveModelForRole("enricher", localPath).provider).toBe("openbmb");
    expect(resolveModelForRole("enricher", networkPath).provider).toBe("openai");
    expect(resolveModelForRole("enricher", networkPath).model).toBe("deepseek-v4-pro");
    rmSync(join(localPath, ".."), { recursive: true, force: true });
    rmSync(join(networkPath, ".."), { recursive: true, force: true });
  });
});
