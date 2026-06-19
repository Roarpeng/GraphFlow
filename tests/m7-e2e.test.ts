import { describe, expect, it } from "vitest";
import { orchestrate } from "../src/core/orchestrator";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { buildContextSlice } from "../src/graph/context-slicer";

describe("M7 e2e run -> graph sync -> context slice", () => {
  it("indexes completed task and can retrieve it with token budget", async () => {
    const config = validateConfig({
      providers: {},
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
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });

    const graphClient = createGraphClient(config);

    // Pre-populate graph with a task node for context retrieval testing
    await graphClient.upsertNodes([
      { id: "task:update-readme", type: "TaskRun", content: "Task completed: update readme and add tests" },
    ]);

    const run = await orchestrate(
      { task: "update readme and add tests" },
      { graphClient, enableAutoGraphSync: true, executionMode: "bridge" }
    );

    const slice = await buildContextSlice(graphClient, "Task completed", 100);

    // Bridge mode delegates execution, returning HUMAN_REVIEW_REQUIRED with executionDescriptor
    expect(run.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(run.feedback).toContain("[DELEGATED]");
    expect(run.executionDescriptor).toBeDefined();
    expect(slice.items.length).toBeGreaterThan(0);
    expect(slice.tokenEstimate).toBeLessThanOrEqual(100);
  });
});
