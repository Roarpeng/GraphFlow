import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { hasUsableLlmProvider } from "../src/config/llm-availability";
import {
  buildAgentDelegatedPlanInsight,
  buildAgentInsightWorkItems,
} from "../src/core/agent-delegation";
import { orchestrate } from "../src/core/orchestrator";
import { GraphifyClient } from "../src/graph/graphify-client";
import { planInsightResult } from "../src/surfaces/cli/runtime/routing";

function writeNoApiConfig(): string {
  const config = getDefaultConfig();
  const path = join(tmpdir(), `graphflow-no-api-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ ...config, providers: {} }), "utf8");
  return path;
}

describe("M56 agent-delegated LLM (no API key)", () => {
  it("detects no usable LLM when provider credentials are absent", () => {
    const config = getDefaultConfig();
    expect(hasUsableLlmProvider(config)).toBe(false);
  });

  it("builds six-hats work items for the connected coding agent", () => {
    const items = buildAgentInsightWorkItems("refactor architecture module");
    expect(items.length).toBe(13);
    expect(items.filter((item) => item.kind === "six-hats").length).toBe(6);
    const fiveWhys = items.filter((item) => item.kind === "five-whys");
    expect(fiveWhys.length).toBe(6);
    expect(fiveWhys.every((item) => item.optional === true)).toBe(true);
    expect(items.filter((item) => item.kind === "plan-refinement").length).toBe(1);
    expect(items[0]?.prompt).toContain("Task:");
  });

  it("returns agent-delegated plan_insight without external API", async () => {
    const configPath = writeNoApiConfig();
    try {
      const result = await planInsightResult(
        "refactor module and add tests across graph layer",
        configPath
      );
      expect(result.mode).toBe("agent-delegated");
      expect(result.agentWorkItems?.length).toBeGreaterThan(0);
      expect(result.agentInstructions).toContain("AGENT-DELEGATED LLM");
      expect(result.plan.length).toBeGreaterThan(0);
    } finally {
      unlinkSync(configPath);
    }
  });

  it("includes agentWorkItems in bridge executionDescriptor for complex tasks", async () => {
    const client = new GraphifyClient();
    const configPath = writeNoApiConfig();
    try {
      buildAgentDelegatedPlanInsight("refactor orchestrator architecture module and add tests");

      const run = await orchestrate(
        { task: "refactor orchestrator architecture module and add tests" },
        {
          graphClient: client,
          executionMode: "bridge",
          enableNearLosslessMode: false,
          configPath,
        }
      );

      expect(run.status).toBe("DELEGATED");
      expect(run.executionDescriptor?.agentMode).toBe("delegated-llm");
      expect(run.executionDescriptor?.agentWorkItems?.length).toBeGreaterThan(0);
      expect(run.feedback).toContain("[AGENT-LLM]");
    } finally {
      unlinkSync(configPath);
    }
  });
});
