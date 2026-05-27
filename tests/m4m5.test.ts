import { describe, expect, it } from "vitest";
import {
  resolveModelWithFallback,
  type ProviderHealthMap,
} from "../src/routing/model-router";
import { createVsCodeRuntime } from "../src/surfaces/vscode/extension";
import { FeedbackCollector } from "../src/learning/feedback-collector";
import { buildRankingSamples } from "../src/learning/sample-builder";
import { evaluateCanary } from "../src/learning/canary-gate";

describe("M4/M5 integration behavior", () => {
  it("falls back to secondary provider when preferred is unhealthy", () => {
    const health: ProviderHealthMap = {
      openai: false,
      anthropic: true,
      bailian: true,
      doubao: true,
    };

    const selection = resolveModelWithFallback("worker", health);
    expect(selection.provider).toBe("anthropic");
    expect(selection.fallbackApplied).toBe(true);
  });

  it("runs task via VS Code runtime and stores history", async () => {
    const runtime = createVsCodeRuntime(async (task) => ({
      status: "COMPLETED",
      attempts: 1,
      feedback: `done: ${task}`,
    }));

    const record = await runtime.runTask("update readme");
    const history = runtime.showRuns();

    expect(record.status).toBe("COMPLETED");
    expect(history).toHaveLength(1);
    expect(history[0]?.task).toBe("update readme");
  });

  it("builds learning samples and blocks canary on regression", () => {
    const collector = new FeedbackCollector();
    collector.add({ query: "task A", passed: true, tokenCost: 100, retries: 0 });
    collector.add({ query: "task B", passed: false, tokenCost: 300, retries: 3 });

    const samples = buildRankingSamples(collector.list());
    const decision = evaluateCanary(10, -0.1, 0.2);

    expect(samples).toHaveLength(2);
    expect(samples[0]?.label).toBe("positive");
    expect(samples[1]?.label).toBe("negative");
    expect(decision.allowNewPolicy).toBe(false);
  });
});
