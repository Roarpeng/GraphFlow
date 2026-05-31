import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/routing/provider-executor", async () => {
  const actual = await vi.importActual<typeof import("../src/routing/provider-executor")>(
    "../src/routing/provider-executor"
  );
  return {
    ...actual,
    executeRolePrompt: vi.fn(),
  };
});

import {
  executeRolePrompt,
  formatPromptWithContext,
  type PromptContext,
} from "../src/routing/provider-executor";
import { orchestrate } from "../src/core/orchestrator";
import type { GraphClient } from "../src/graph/client-factory";
import { GraphifyClient } from "../src/graph/graphify-client";

const mockedExec = vi.mocked(executeRolePrompt);

const brainstormReply =
  "目标澄清: 明确目标\n实现路径: 拆分子任务\n风险提示: 注意回归";

function stripRolePrefix(prompt: string): string {
  return prompt.replace(/^\[role:[a-z]+\][\s\S]*?Task:\n/, "").replace(/^\[role:[a-z]+\]\s*/, "");
}

function plannerLikeImpl(plannerJson: string) {
  return async (role: string, prompt: string) => {
    if (role === "worker") {
      const task = stripRolePrefix(prompt);
      return `worker output covering ${task}`;
    }
    if (role === "planner") {
      if (prompt.includes("Brainstorm 3 short ideas")) {
        return brainstormReply;
      }
      if (prompt.includes("Decompose the task")) {
        return plannerJson;
      }
      return "planner draft text";
    }
    return "";
  };
}

function makeGraphClient(seed: Array<{ id: string; type: "File" | "Symbol"; content: string }>): GraphClient {
  const inner = new GraphifyClient();
  inner.upsertNodes(seed.map((n) => ({ id: n.id, type: n.type, content: n.content })));
  return {
    async upsertNodes(nodes) {
      inner.upsertNodes(nodes);
    },
    async upsertEdges(edges) {
      inner.upsertEdges(edges);
    },
    async queryByKeyword(query) {
      return inner.queryByKeyword(query);
    },
  };
}

describe("M21 prompt context injection", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("Test A: enableGraphContextInPrompt=false leaves prompts without context", async () => {
    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
    ]);
    mockedExec.mockImplementation(plannerLikeImpl(plannerJson));

    const run = await orchestrate(
      { task: "refactor module orchestrator and add tests", maxRetries: 1 },
      { enableLlmAgents: true }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.promptContextLines).toBeUndefined();
    for (const call of mockedExec.mock.calls) {
      const ctx = call[3];
      expect(
        ctx === undefined ||
          ((!ctx.summaryChannel || ctx.summaryChannel.length === 0) &&
            (!ctx.skillHints || ctx.skillHints.length === 0) &&
            (!ctx.extraInstructions || ctx.extraInstructions.length === 0))
      ).toBe(true);
    }
  });

  it("Test B: enableGraphContextInPrompt=true injects summaryChannel into prompts", async () => {
    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
    ]);
    mockedExec.mockImplementation(plannerLikeImpl(plannerJson));

    const graphClient = makeGraphClient([
      { id: "file-1", type: "File", content: "src/orchestrator.ts: orchestrator entry" },
      { id: "sym-1", type: "Symbol", content: "function orchestrator(): runs the DAG" },
      { id: "sym-2", type: "Symbol", content: "class OrchestratorRunner orchestrator helper" },
    ]);

    const run = await orchestrate(
      { task: "refactor module orchestrator and add tests", maxRetries: 1 },
      {
        enableLlmAgents: true,
        graphClient,
        enableNearLosslessMode: true,
        enableGraphContextInPrompt: true,
        maxContextTokens: 1200,
      }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.promptContextLines).toBeGreaterThan(0);
    expect(run.feedback).toMatch(/promptCtx\(lines=\d+\)/);

    const withCtx = mockedExec.mock.calls.filter(
      (call) => (call[3] as PromptContext | undefined)?.summaryChannel?.length
    );
    expect(withCtx.length).toBeGreaterThan(0);
    expect(withCtx[0]?.[3]?.summaryChannel?.[0]).toMatch(/orchestrator/);
  });

  it("Test C: formatPromptWithContext caps summary lines at 20 and skill hints at 8", () => {
    const longSummary = Array.from({ length: 30 }, (_, i) => `summary-line-${i + 1}`);
    const manySkills = Array.from({ length: 12 }, (_, i) => `skill-${i + 1}`);
    const formatted = formatPromptWithContext("worker", "do the thing", {
      summaryChannel: longSummary,
      skillHints: manySkills,
      extraInstructions: ["take care"],
    });

    expect(formatted.startsWith("[role:worker]")).toBe(true);
    expect(formatted).toContain("Knowledge graph context:");
    expect(formatted).toContain("- summary-line-1");
    expect(formatted).toContain("- summary-line-20");
    expect(formatted).not.toContain("- summary-line-21");
    expect(formatted).toContain("Skills to apply: skill-1, skill-2, skill-3, skill-4, skill-5, skill-6, skill-7, skill-8");
    expect(formatted).not.toContain("skill-9");
    expect(formatted).toContain("Notes:");
    expect(formatted).toContain("- take care");
    expect(formatted.endsWith("Task:\ndo the thing")).toBe(true);
  });

  it("Test D: formatPromptWithContext returns single-line prompt when context empty", () => {
    expect(formatPromptWithContext("planner", "hello")).toBe("[role:planner] hello");
    expect(formatPromptWithContext("planner", "hello", {})).toBe("[role:planner] hello");
    expect(
      formatPromptWithContext("planner", "hello", { summaryChannel: [], skillHints: [] })
    ).toBe("[role:planner] hello");
  });
});
