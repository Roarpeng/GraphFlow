import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { hasUsableLlmProvider } from "../src/config/llm-availability";
import {
  buildAgentDelegatedPlanInsight,
  buildAgentInsightWorkItems,
  isCompactAgentInsightTask,
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

  it("builds full 18-item set for coding/refactor tasks", () => {
    expect(isCompactAgentInsightTask("refactor architecture module")).toBe(false);
    const items = buildAgentInsightWorkItems("refactor architecture module");
    expect(items.length).toBe(18);
    expect(items.filter((item) => !item.optional).length).toBe(11);
    expect(items.filter((item) => item.kind === "six-hats").length).toBe(6);
    const fiveWhys = items.filter((item) => item.kind === "five-whys");
    expect(fiveWhys.length).toBe(6);
    expect(fiveWhys.every((item) => item.optional === true)).toBe(true);
    expect(items.filter((item) => item.kind === "plan-refinement").length).toBe(1);
    expect(items[0]?.prompt).toContain("Task:");
  });

  it("builds compact required set for research/architecture analysis", () => {
    expect(isCompactAgentInsightTask("architecture research of GraphFlow layers")).toBe(true);
    expect(isCompactAgentInsightTask("调研 MCP 与 context 压缩")).toBe(true);
    expect(isCompactAgentInsightTask("analyze orchestration design")).toBe(true);

    const items = buildAgentInsightWorkItems("architecture research of GraphFlow layers");
    const required = items.filter((item) => !item.optional);
    expect(required.map((item) => item.id)).toEqual([
      "intent-analysis",
      "hat-1-white",
      "hat-3-black",
      "hat-4-yellow",
      "hat-6-blue",
      "decision-matrix",
      "plan-refinement",
    ]);
    expect(items.length).toBe(8);
    expect(items.find((item) => item.id === "plan-reflection")?.optional).toBe(true);
    expect(items.some((item) => item.id === "requirement-analysis")).toBe(false);
    expect(items.some((item) => item.kind === "five-whys")).toBe(false);
  });

  it("returns agent-delegated plan_insight without external API", async () => {
    const configPath = writeNoApiConfig();
    try {
      const result = await planInsightResult(
        "refactor module and add tests across graph layer",
        configPath
      );
      expect(result.mode).toBe("agent-delegated");
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.status).toBe("awaiting-agent");
      expect(result.insight.placeholder).toBe(true);
      expect(result.plan).toEqual([]);
      expect(result.agentWorkItems?.length).toBe(18);
      expect(result.agentInstructions).toContain("AGENT-BRIDGE REQUIRED");
      expect(result.agentInstructions).toContain("MUST submit");
      expect(result.agentInstructions).toContain("PLACEHOLDERS");
      expect(result.agentInstructions).toContain('graphflow_insight({ mode: "submit"');
      expect(result.agentInstructions).toContain('graphflow_insight({ mode: "merge"');
      expect(result.agentInstructions).not.toContain("graphflow_submit_insight");
      expect(result.insight.hats.every((hat) => hat.observation.includes("PLACEHOLDER"))).toBe(
        true
      );
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
      expect(run.executionDescriptor?.requiresAgentBridge).toBe(true);
      expect(run.executionDescriptor?.agentWorkItems?.length).toBe(18);
      expect(run.executionDescriptor?.agentInstructions).toContain("graphflow_insight");
      expect(run.executionDescriptor?.agentInstructions).toContain("MUST");
      expect(run.feedback).toContain("[AGENT-BRIDGE]");
    } finally {
      unlinkSync(configPath);
    }
  });
});
