import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import {
  buildAgentDelegatedSimplePlan,
  SIMPLE_PLAN_BRIDGE_REQUIRED_IDS,
} from "../src/core/agent-delegation";
import { mergeAgentInsights, mergeAgentInsightsFromGraph } from "../src/core/merge-agent-insight";
import { submitAgentInsight } from "../src/core/submit-agent-insight";
import { GraphifyClient } from "../src/graph/graphify-client";
import { planAndBrainstormResult } from "../src/surfaces/cli/runtime/routing";
import { createMcpServer, executeToolCall } from "../src/surfaces/mcp/server";

function parseToolText(response: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = response.content[0]?.text;
  if (text === undefined) {
    throw new Error("MCP response missing text");
  }
  return JSON.parse(text);
}

function writeProvidersConfig(providers: Record<string, unknown>): string {
  const path = join(tmpdir(), `gf-m80-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...getDefaultConfig(),
      providers,
    }),
    "utf8"
  );
  return path;
}

describe("M80 simple plan agent bridge", () => {
  const task =
    "Critically evaluate reliability of look-down-init curriculum for copper tube FOV acquisition: assumptions、failure modes、validation gates";

  it("buildAgentDelegatedSimplePlan returns suggested DAG + required work items + optional alignment-check", () => {
    const result = buildAgentDelegatedSimplePlan(task);
    expect(result.mode).toBe("agent-delegated");
    expect(result.requiresAgentBridge).toBe(true);
    expect(result.nodesStatus).toBe("suggested");
    expect(result.suggestedNodes.length).toBeGreaterThan(0);
    expect(result.nodes).toEqual(result.suggestedNodes);
    const required = result.agentWorkItems.filter((item) => !item.optional);
    expect(required.map((item) => item.id)).toEqual([...SIMPLE_PLAN_BRIDGE_REQUIRED_IDS]);
    // P2: execution-time alignment check rides along as an optional item.
    const optionalIds = result.agentWorkItems.filter((item) => item.optional).map((i) => i.id);
    expect(optionalIds).toEqual(["alignment-check"]);
    expect(result.agentInstructions).toContain("simple-plan-decomposition");
    expect(result.agentInstructions).toContain("alignment-check");
    expect(result.agentWorkItems[1]?.prompt).toContain("Suggested local plan");
  });

  it("planAndBrainstormResult bridges when no usable LLM", async () => {
    const configPath = writeProvidersConfig({});
    try {
      const result = await planAndBrainstormResult(task, configPath);
      expect(result.mode).toBe("agent-delegated");
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.status).toBe("awaiting-agent");
      expect(result.complete).toBe(false);
      expect(result.suggestedNodes?.length).toBeGreaterThan(0);
      expect(result.agentWorkItems?.filter((item) => !item.optional).length).toBe(2);
    } finally {
      unlinkSync(configPath);
    }
  });

  it("planAndBrainstormResult stays local when LLM credentials exist", async () => {
    const configPath = writeProvidersConfig({
      openai: { apiKey: "sk-test-not-empty", baseUrl: "https://api.openai.com/v1" },
    });
    try {
      const result = await planAndBrainstormResult("update readme and add tests", configPath);
      expect(result.mode === "simple" || result.mode === "complex").toBe(true);
      expect(result.requiresAgentBridge).toBe(false);
      expect(result.complete).toBe(true);
      expect(result.agentWorkItems).toBeUndefined();
      expect(result.nodes.length).toBeGreaterThan(0);
    } finally {
      unlinkSync(configPath);
    }
  });

  it("MCP graphflow_plan simple mode bridges without API credentials", async () => {
    const configPath = writeProvidersConfig({});
    try {
      const response = await executeToolCall(
        {
          name: "graphflow_plan",
          arguments: { task, configPath },
        },
        createMcpServer()
      );
      const result = parseToolText(response) as {
        mode: string;
        requiresAgentBridge?: boolean;
        suggestedNodes?: unknown[];
        agentWorkItems?: Array<{ id: string; optional?: boolean }>;
        nodesStatus?: string;
      };
      expect(result.mode).toBe("agent-delegated");
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.nodesStatus).toBe("suggested");
      expect(result.suggestedNodes?.length).toBeGreaterThan(0);
      const required = result.agentWorkItems?.filter((item) => !item.optional);
      expect(required?.map((item) => item.id)).toEqual([...SIMPLE_PLAN_BRIDGE_REQUIRED_IDS]);
    } finally {
      unlinkSync(configPath);
    }
  });

  it("merge completes after simple-plan intent + decomposition submits", async () => {
    const client = new GraphifyClient();
    await submitAgentInsight(client, {
      task,
      workItemId: "simple-plan-intent",
      response: JSON.stringify({
        explicitIntent: "evaluate curriculum reliability",
        implicitIntent: "decide if look-down-init is trustworthy",
        coreProblem: "FOV acquisition reliability",
        nonGoals: ["implement new curriculum"],
        successDefinition: "ranked alternatives with gates",
      }),
    });
    const second = await submitAgentInsight(client, {
      task,
      workItemId: "simple-plan-decomposition",
      response: JSON.stringify([
        { id: "task-1", description: "Clarify reliability assumptions", dependencies: [] },
        {
          id: "task-2",
          description: "Enumerate failure modes and validation gates",
          dependencies: ["task-1"],
        },
        {
          id: "task-3",
          description: "Rank alternatives and write recommendation",
          dependencies: ["task-2"],
        },
      ]),
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.merge?.complete).toBe(true);
      expect(second.merge?.plan).toHaveLength(3);
    }

    const merged = await mergeAgentInsightsFromGraph(client, task);
    expect(merged.complete).toBe(true);
    expect(merged.missing).toEqual([]);
    expect(merged.submittedCount).toBe(2);
    expect(merged.plan.map((node) => node.description).join("\n")).toContain("Rank alternatives");
  });

  it("partial simple-plan submit does not mark insight-protocol complete", () => {
    const merged = mergeAgentInsights(task, [
      {
        workItemId: "simple-plan-intent",
        parsed: { coreProblem: "x" },
        nodeId: "n1",
      },
    ]);
    expect(merged.complete).toBe(false);
    expect(merged.missing).toEqual(["simple-plan-decomposition"]);
  });
});
