import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { planTasks } from "../src/agents/planner";
import { GraphifyClient } from "../src/graph/graphify-client";
import { planAndBrainstormResult } from "../src/surfaces/cli/runtime/routing";
import { createMcpServer, executeToolCall } from "../src/surfaces/mcp/server";

// Fake LLM provider injection (same technique as m19): mock the provider
// executor so planAndBrainstormResult exercises its LLM-first branch without
// real network calls. The no-LLM bridge paths never reach this mock.
vi.mock("../src/routing/provider-executor", () => ({
  executeRolePrompt: vi.fn(),
}));

import { executeRolePrompt } from "../src/routing/provider-executor";

const mockedExec = vi.mocked(executeRolePrompt);

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
      // 流程用例：保持 text 副本全量（序列化契约另测）。
      // Flow cases keep the full text copy (serialization covered elsewhere).
      mcp: { textCopy: "full" },
    }),
    "utf8"
  );
  return path;
}

describe("M80 simple plan agent bridge", () => {
  const task =
    "Critically evaluate reliability of look-down-init curriculum for copper tube FOV acquisition: assumptions、failure modes、validation gates";

  beforeEach(() => {
    mockedExec.mockReset();
  });

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

  it("planAndBrainstormResult produces final LLM plan when the provider call succeeds", async () => {
    const configPath = writeProvidersConfig({
      openai: { apiKey: "sk-test-not-empty", baseUrl: "https://api.openai.com/v1" },
    });
    const llmPlan = JSON.stringify([
      { id: "llm-1", description: "Clarify evaluation scope and success criteria", dependencies: [] },
      { id: "llm-2", description: "Enumerate failure modes with evidence", dependencies: ["llm-1"] },
      { id: "llm-3", description: "Rank alternatives and write recommendation", dependencies: ["llm-2"] },
    ]);
    mockedExec.mockImplementation(async (_role, prompt) => {
      if (prompt.includes("Reply with exactly")) {
        return "ok";
      }
      if (prompt.includes("Brainstorm 3 short ideas")) {
        return "目标澄清: LLM 澄清了评估边界\n实现路径: LLM 给出三步走路径\n风险提示: LLM 提示数据偏差风险";
      }
      if (prompt.includes("Decompose the task")) {
        return llmPlan;
      }
      return "";
    });
    try {
      const result = await planAndBrainstormResult("update readme and add tests", configPath);
      expect(result.mode === "simple" || result.mode === "complex").toBe(true);
      expect(result.nodesStatus).toBe("final");
      expect(result.requiresAgentBridge).toBe(false);
      expect(result.complete).toBe(true);
      expect(result.agentWorkItems).toBeUndefined();
      // Ideas and nodes must come from the LLM, not the local template.
      expect(mockedExec).toHaveBeenCalled();
      expect(result.ideas[0]).toContain("LLM 澄清了评估边界");
      expect(result.nodes.map((node) => node.id)).toEqual(["llm-1", "llm-2", "llm-3"]);
      expect(result.nodes[0]?.description).not.toContain("分析与设计");
      expect(result.nodes.map((node) => node.description).join("\n")).toContain(
        "Clarify evaluation scope"
      );
    } finally {
      unlinkSync(configPath);
    }
  });

  it("planAndBrainstormResult bridges immediately when the connectivity probe fails", async () => {
    const configPath = writeProvidersConfig({
      openai: { apiKey: "sk-test-not-empty", baseUrl: "https://api.openai.com/v1" },
    });
    // Every provider call rejects — the pre-flight probe is the first one, so
    // the plan must bridge WITHOUT ever attempting the brainstorm/decomposition
    // calls (no wasted 15s wait).
    mockedExec.mockRejectedValue(new Error("401 invalid api key"));
    try {
      const result = await planAndBrainstormResult("update readme and add tests", configPath);
      expect(result.mode).toBe("agent-delegated");
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.nodesStatus).toBe("suggested");
      expect(result.agentInstructions).toContain("connectivity probe failed");
      expect(result.agentInstructions).toContain("401 invalid api key");
      // Probe only: exactly ONE provider call, proving the LLM plan was
      // never attempted.
      expect(mockedExec).toHaveBeenCalledTimes(1);
    } finally {
      unlinkSync(configPath);
    }
  });

  it("planAndBrainstormResult rejects echo/placeholder probe replies as masked failures", async () => {
    const configPath = writeProvidersConfig({
      openai: { apiKey: "sk-test-not-empty", baseUrl: "https://api.openai.com/v1" },
    });
    // Non-strict adapters mask failures by returning the PROMPT back as a
    // fake completion. Even without the `[provider:model]` bracket prefix,
    // a reply still containing the probe instruction is an echo, not a real
    // completion — connectivity must be judged as broken and the plan must
    // bridge instead of proceeding to a doomed LLM attempt.
    mockedExec.mockImplementation(async (_role, prompt) => {
      if (prompt.includes("Reply with exactly")) {
        return "Reply with exactly: ok";
      }
      return "should never be reached";
    });
    try {
      const result = await planAndBrainstormResult("update readme and add tests", configPath);
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.nodesStatus).toBe("suggested");
      expect(result.agentInstructions).toContain("connectivity probe failed");
      expect(result.agentInstructions).toContain("placeholder/echo fallback");
      expect(mockedExec).toHaveBeenCalledTimes(1);
    } finally {
      unlinkSync(configPath);
    }
  });

  it("planAndBrainstormResult degrades honestly when the probe passes but the plan calls fail", async () => {
    const configPath = writeProvidersConfig({
      openai: { apiKey: "sk-test-not-empty", baseUrl: "https://api.openai.com/v1" },
    });
    // Probe ("Reply with exactly: ok") succeeds; brainstorm/plan fail.
    mockedExec.mockImplementation(async (_role, prompt) => {
      if (prompt.includes("Reply with exactly")) {
        return "ok";
      }
      throw new Error("500 provider overloaded");
    });
    try {
      const result = await planAndBrainstormResult("update readme and add tests", configPath);
      // Template content survives …
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.map((node) => node.description)).toEqual(
        planTasks("update readme and add tests").map((node) => node.description)
      );
      expect(result.ideas[0]).toContain("目标澄清");
      // … but it must never pose as a final decomposition.
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.nodesStatus).toBe("suggested");
      expect(result.complete).toBe(false);
      expect(result.status).toBe("awaiting-agent");
      expect(result.suggestedNodes).toEqual(result.nodes);
      const required = result.agentWorkItems?.filter((item) => !item.optional);
      expect(required?.map((item) => item.id)).toEqual([...SIMPLE_PLAN_BRIDGE_REQUIRED_IDS]);
      expect(result.agentInstructions).toContain("FAILED");
      expect(result.agentInstructions).toContain("Reason:");
    } finally {
      unlinkSync(configPath);
    }
  });

  it("planAndBrainstormResult degrades to the honest bridge when the LLM call times out", async () => {
    const configPath = writeProvidersConfig({
      openai: { apiKey: "sk-test-not-empty", baseUrl: "https://api.openai.com/v1" },
    });
    const previousTimeout = process.env.GRAPHFLOW_PLAN_LLM_TIMEOUT_MS;
    process.env.GRAPHFLOW_PLAN_LLM_TIMEOUT_MS = "25";
    // Probe answers instantly; the brainstorm/plan calls hang past the 25ms cap.
    mockedExec.mockImplementation((_role, prompt) => {
      if (prompt.includes("Reply with exactly")) {
        return Promise.resolve("ok");
      }
      return new Promise<string>(() => {});
    });
    try {
      const result = await planAndBrainstormResult("update readme and add tests", configPath);
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.nodesStatus).toBe("suggested");
      expect(result.complete).toBe(false);
      expect(result.nodes.map((node) => node.description)).toEqual(
        planTasks("update readme and add tests").map((node) => node.description)
      );
      const required = result.agentWorkItems?.filter((item) => !item.optional);
      expect(required?.map((item) => item.id)).toEqual([...SIMPLE_PLAN_BRIDGE_REQUIRED_IDS]);
      expect(result.agentInstructions).toContain("timed out");
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.GRAPHFLOW_PLAN_LLM_TIMEOUT_MS;
      } else {
        process.env.GRAPHFLOW_PLAN_LLM_TIMEOUT_MS = previousTimeout;
      }
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
