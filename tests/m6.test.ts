import { describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { computeLearningMetrics, exportLearningDataset } from "../src/learning/exporter";
import { readFileSync } from "node:fs";

const baseConfig = {
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-5.3-codex" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: {
    runTokenCap: 4000,
  },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory" as const,
    maxContextTokens: 1200,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly" as const,
    canaryRatio: 10,
    exportPath: "tmp/learning-dataset.jsonl",
  },
};

describe("M6 config + graph + learning", () => {
  it("fails fast when mcp-http has no endpoint", () => {
    expect(() =>
      validateConfig({
        ...baseConfig,
        graphPolicy: {
          ...baseConfig.graphPolicy,
          transport: "mcp-http",
        },
      })
    ).toThrow(/mcpEndpoint/);
  });

  it("creates in-memory graph client and supports query", async () => {
    const client = createGraphClient(validateConfig(baseConfig));
    await client.upsertNodes([{ id: "file:readme", type: "File", content: "README.md" }]);
    const hits = await client.queryByKeyword("README");
    expect(hits.length).toBe(1);
  });

  it("exports learning dataset with metrics", () => {
    const metrics = computeLearningMetrics([
      { query: "a", passed: true, tokenCost: 100, retries: 0 },
      { query: "b", passed: false, tokenCost: 300, retries: 2 },
    ]);

    const outFile = "tmp/learning-dataset.jsonl";
    exportLearningDataset(
      outFile,
      [
        { prompt: "a", label: "positive" },
        { prompt: "b", label: "negative" },
      ],
      metrics
    );

    const content = readFileSync(outFile, "utf8");
    expect(content).toContain("#metrics");
    expect(metrics.totalEvents).toBe(2);
    expect(metrics.passRate).toBe(0.5);
  });

  it("mcp client path calls fetch through factory", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { nodes: [{ id: "s1", type: "Symbol", content: "x" }] } }),
    }));

    vi.stubGlobal("fetch", fetchMock);
    const client = createGraphClient(
      validateConfig({
        ...baseConfig,
        graphPolicy: {
          ...baseConfig.graphPolicy,
          transport: "mcp-http",
          mcpEndpoint: "http://localhost:8787/mcp",
        },
      })
    );

    const result = await client.queryByKeyword("x");
    expect(result[0]?.id).toBe("s1");
    vi.unstubAllGlobals();
  });
});
