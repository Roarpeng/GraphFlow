import { describe, expect, it } from "vitest";
import { orchestrate } from "../src/core/orchestrator";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";

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
        exportPath: "graphflow-out/learning-dataset.jsonl",
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
        executionMode: "bridge",
        configPath: createNoLlmConfigPath(),
        onContextPackage: (pkg) => {
          capturedAnchors = pkg.anchorChannel.length;
        },
      }
    );

    expect(run.status).toBe("DELEGATED");
    expect(run.feedback).toContain("context(summary=");
    expect(run.routeDecisions?.length).toBe(3);
    expect(run.executionDescriptor).toBeDefined();
    expect(capturedAnchors).toBeGreaterThan(0);
  });

  it("packages complex tasks for delegation in bridge mode", async () => {
    const run = await orchestrate(
      {
        task: "update readme and add tests and refactor architecture module",
      },
      { executionMode: "bridge", configPath: createNoLlmConfigPath() }
    );

    expect(run.status).toBe("DELEGATED");
    expect(run.feedback).toContain("[DELEGATED]");
    expect(run.executionDescriptor).toBeDefined();
    expect(run.executionDescriptor?.task).toContain("update readme");
  });
});
