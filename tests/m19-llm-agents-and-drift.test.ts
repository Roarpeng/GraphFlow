import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/routing/provider-executor", () => ({
  executeRolePrompt: vi.fn(),
}));

import { executeRolePrompt } from "../src/routing/provider-executor";
import { orchestrate } from "../src/core/orchestrator";
import { planTasksLlm } from "../src/agents/planner";
import { brainstormTaskLlm } from "../src/agents/brainstormer";
import { validateTaskResultLlm } from "../src/agents/validator";
import { resolveModelForRole } from "../src/routing/model-router";

const mockedExec = vi.mocked(executeRolePrompt);

const brainstormReply =
  "目标澄清: 明确目标\n实现路径: 拆分子任务\n风险提示: 注意回归";

function stripRolePrefix(prompt: string): string {
  return prompt.replace(/^\[role:[a-z]+\]\s*/, "");
}

describe("M19 LLM-driven agents and drift re-planning", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("uses LLM planner and brainstormer when enableLlmAgents=true", async () => {
    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
      { id: "task-2", description: "beta", dependencies: ["task-1"] },
    ]);

    mockedExec.mockImplementation(async (role, prompt) => {
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
    });

    const run = await orchestrate(
      { task: "refactor module orchestrator and add tests", maxRetries: 1 },
      { enableLlmAgents: true }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.brainstormIdeas).toBeDefined();
    expect(run.brainstormIdeas?.length).toBeGreaterThanOrEqual(3);
    expect(run.brainstormIdeas?.[0]).toContain("目标澄清");
    expect(run.attempts).toBe(2);
    expect(run.replanRounds).toBe(0);
  });

  it("triggers mid-DAG drift re-planning after a failed task", async () => {
    const failingPlan = JSON.stringify([
      { id: "task-fail", description: "FAIL_TASK_XYZ marker", dependencies: [] },
    ]);
    const recoveryPlan = JSON.stringify([
      { id: "task-1", description: "alpha recovery", dependencies: [] },
    ]);

    let plannerCalls = 0;
    mockedExec.mockImplementation(async (role, prompt) => {
      if (role === "worker") {
        const task = stripRolePrefix(prompt);
        if (task.includes("FAIL_TASK_XYZ")) {
          return "";
        }
        return `worker output covering ${task}`;
      }
      if (role === "planner") {
        if (prompt.includes("Brainstorm 3 short ideas")) {
          return brainstormReply;
        }
        if (prompt.includes("Decompose the task")) {
          plannerCalls += 1;
          return plannerCalls === 1 ? failingPlan : recoveryPlan;
        }
        return "planner draft text";
      }
      return "";
    });

    const run = await orchestrate(
      { task: "refactor module orchestrator and add tests", maxRetries: 1 },
      {
        enableLlmAgents: true,
        enableDriftReplan: true,
        maxReplanRounds: 1,
      }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.replanRounds).toBe(1);
    expect(plannerCalls).toBe(2);
  });

  it("falls back to deterministic planner when LLM returns invalid JSON", async () => {
    mockedExec.mockResolvedValue("not a json response at all");

    const plan = await planTasksLlm("refactor module foo and add tests", {
      selection: resolveModelForRole("planner"),
    });

    expect(plan.length).toBeGreaterThanOrEqual(1);
    expect(plan[0]?.id).toBe("task-1");
  });

  it("brainstormTaskLlm falls back to deterministic on empty LLM output", async () => {
    mockedExec.mockResolvedValue("");
    const ideas = await brainstormTaskLlm("refactor planner", resolveModelForRole("planner"));
    expect(ideas.length).toBeGreaterThanOrEqual(3);
  });

  it("validateTaskResultLlm parses JSON verdict", async () => {
    mockedExec.mockResolvedValue(
      JSON.stringify({
        passed: true,
        feedback: "ok",
        matchedCriteria: ["alpha"],
        missingCriteria: [],
        riskTags: [],
      })
    );

    const result = await validateTaskResultLlm(
      "alpha task",
      "alpha output",
      resolveModelForRole("validator")
    );

    expect(result.passed).toBe(true);
    expect(result.matchedCriteria).toContain("alpha");
  });
});
