import { describe, expect, it } from "vitest";
import { orchestrate } from "../src/core/orchestrator";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";

describe("M9 orchestrator near-lossless integration", () => {
  it("attaches context package metrics in feedback when enabled", async () => {
    const config = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-5.3-codex" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        enableNearLosslessMode: true,
        transport: "memory",
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "tmp/learning-dataset.jsonl",
      },
    });

    const graphClient = createGraphClient(config);
    await graphClient.upsertNodes([
      { id: "symbol:orchestrate", type: "Symbol", content: "orchestrate handles routing" },
      { id: "decision:context", type: "Decision", content: "context package budgeting" },
    ]);

    let capturedAnchors = 0;
    const run = await orchestrate(
      { task: "update readme" },
      {
        graphClient,
        enableNearLosslessMode: true,
        nearLosslessQuery: "orchestrate",
        maxContextTokens: 120,
        layerQuota: { l1: 2, l2: 1, l3: 1 },
        onContextPackage: (pkg) => {
          capturedAnchors = pkg.anchorChannel.length;
        },
      }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.feedback).toContain("context(summary=");
    expect(capturedAnchors).toBeGreaterThan(0);
  });
});
