import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/routing/provider-executor", () => ({
  executeRolePrompt: vi.fn(),
}));

import { executeRolePrompt } from "../src/routing/provider-executor";
import {
  isResearchAnalysisTask,
  isCompactAgentInsightTask,
} from "../src/agents/task-profile";
import { planInsight } from "../src/agents/insight";

const mockedExec = vi.mocked(executeRolePrompt);

beforeEach(() => {
  mockedExec.mockReset();
});

describe("task-profile research detection", () => {
  it("detects Chinese and English research/analysis tasks", () => {
    expect(isResearchAnalysisTask("调研 GraphFlow context 压缩")).toBe(true);
    expect(isResearchAnalysisTask("分析编排层架构")).toBe(true);
    expect(isResearchAnalysisTask("architecture research of GraphFlow layers")).toBe(true);
    expect(isResearchAnalysisTask("review the codebase for token savings")).toBe(true);
    expect(isResearchAnalysisTask("investigate embedding quality")).toBe(true);
  });

  it("does not flag ordinary coding tasks", () => {
    expect(isResearchAnalysisTask("fix typo in readme")).toBe(false);
    expect(isResearchAnalysisTask("add a comment to the main function")).toBe(false);
    expect(isResearchAnalysisTask("")).toBe(false);
  });

  it("compact agent mode excludes coding/refactor even with architecture wording", () => {
    expect(isCompactAgentInsightTask("refactor architecture module")).toBe(false);
    expect(isCompactAgentInsightTask("architecture research of GraphFlow layers")).toBe(true);
    expect(isCompactAgentInsightTask("调研 MCP 与 context 压缩")).toBe(true);
  });
});

describe("ATP research short-path", () => {
  function mockResearchPipeline(): void {
    mockedExec.mockImplementation(async (_role, prompt) => {
      if (prompt.includes("White Hat") || prompt.includes("Black Hat") || prompt.includes("Yellow Hat") || prompt.includes("Blue Hat")) {
        return JSON.stringify({ observation: "obs", certainty: 0.4, criticalInsight: "insight" });
      }
      if (prompt.includes("Red Hat") || prompt.includes("Green Hat")) {
        return JSON.stringify({ observation: "should-not-run", certainty: 0.4, criticalInsight: "nope" });
      }
      if (prompt.includes("Analyze the intent")) {
        return JSON.stringify({
          explicitIntent: "research architecture",
          implicitIntent: "understand layers",
          coreProblem: "map modules",
          nonGoals: [],
          successDefinition: "summary",
          complexity: "complex",
        });
      }
      if (prompt.includes("Extract requirements")) {
        return JSON.stringify({
          functional: ["document architecture"],
          nonFunctional: [],
          constraints: ["read-only"],
          priority: "High",
          scope: { included: ["architecture"], excluded: [] },
        });
      }
      if (prompt.includes("Decompose a task into a DAG")) {
        return JSON.stringify([{ id: "task-1", description: "summarize", dependencies: [] }]);
      }
      if (prompt.includes("First Principles")) {
        return JSON.stringify({
          assumptions: ["should-not-run"],
          facts: [],
          deconstructedTo: [],
          challenges: [],
        });
      }
      if (prompt.includes("Decision Matrix") || prompt.includes("score each")) {
        return JSON.stringify({
          options: [
            {
              name: "Option A",
              description: "desc",
              scores: { complexity: 5, cost: 5, risk: 5, maintainability: 5, impact: 5 },
              pros: [],
              cons: [],
            },
          ],
          recommendedOption: "Option A",
          rationale: "good",
        });
      }
      if (prompt.includes("reflecting on a generated task plan") || prompt.includes("Reflect on the quality")) {
        return JSON.stringify({
          confidence: 0.85,
          uncertainties: [],
          missingInformation: [],
          improvementDirections: [],
        });
      }
      // 5-Why prompts
      if (prompt.includes("5-Why") || prompt.includes("Why steps")) {
        return JSON.stringify({
          steps: [{ question: "Why?", answer: "should-not-run" }],
          rootCause: "should-not-run",
        });
      }
      return "";
    });
  }

  it("uses key hats only and skips First Principles / 5-Why for research tasks", async () => {
    mockResearchPipeline();

    const task = "architecture research of GraphFlow context compression layers";
    const result = await planInsight(
      task,
      { selection: { provider: "openai", model: "gpt-4o", tier: "smart" } },
      true
    );

    expect(result.atp).toBeDefined();
    expect(result.insight.hats.map((h) => h.hat.color)).toEqual([
      "white",
      "black",
      "yellow",
      "blue",
    ]);
    expect(result.insight.hats.every((h) => h.whyChain === null)).toBe(true);
    expect(result.atp!.firstPrinciples.assumptions).toEqual([]);
    expect(result.atp!.decisionMatrix.options.length).toBeGreaterThan(0);
    expect(result.atp!.reflection.confidence).toBe(0.85);

    const prompts = mockedExec.mock.calls.map((call) => String(call[1]));
    expect(prompts.some((p) => p.includes("Red Hat"))).toBe(false);
    expect(prompts.some((p) => p.includes("Green Hat"))).toBe(false);
    expect(prompts.some((p) => p.includes("performing a First Principles analysis"))).toBe(false);
    expect(prompts.some((p) => p.includes("evaluating solution options"))).toBe(true);
  });
});
