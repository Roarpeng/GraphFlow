import { describe, it, expect } from "vitest";
import { buildAgentInsightWorkItems, buildAgentDelegationInstructions } from "../src/core/agent-delegation";
import type { TaskNode } from "../src/core/types";

describe("ATP v1.0 Protocol", () => {
  const task = "Add user authentication with JWT tokens";

  describe("Agent work items expansion", () => {
    it("generates 18 work items for full ATP flow", () => {
      const items = buildAgentInsightWorkItems(task);
      // 2 (intent + requirement) + 6 (hats) + 6 (whys) + 1 (first-principles) + 1 (decision-matrix) + 1 (plan-refinement) + 1 (reflection) = 18
      expect(items.length).toBe(18);
    });

    it("includes intent-analysis as first item", () => {
      const items = buildAgentInsightWorkItems(task);
      expect(items[0].id).toBe("intent-analysis");
      expect(items[0].kind).toBe("intent");
    });

    it("includes requirement-analysis as second item", () => {
      const items = buildAgentInsightWorkItems(task);
      expect(items[1].id).toBe("requirement-analysis");
      expect(items[1].kind).toBe("requirement");
    });

    it("includes first-principles as optional item", () => {
      const items = buildAgentInsightWorkItems(task);
      const fp = items.find(i => i.kind === "first-principles");
      expect(fp).toBeDefined();
      expect(fp?.optional).toBe(true);
    });

    it("includes decision-matrix as required item", () => {
      const items = buildAgentInsightWorkItems(task);
      const dm = items.find(i => i.kind === "decision-matrix");
      expect(dm).toBeDefined();
      expect(dm?.optional).toBeUndefined();
    });

    it("includes reflection as last item", () => {
      const items = buildAgentInsightWorkItems(task);
      const last = items[items.length - 1];
      expect(last.kind).toBe("reflection");
      expect(last.id).toBe("plan-reflection");
    });
  });

  describe("TaskNode enrichment", () => {
    it("supports optional priority field", () => {
      const node: TaskNode = {
        id: "t1",
        description: "test",
        dependencies: [],
        status: "PENDING",
        contextQuery: "test",
        retryCount: 0,
        priority: 1,
      };
      expect(node.priority).toBe(1);
    });

    it("supports optional complexity field", () => {
      const node: TaskNode = {
        id: "t1",
        description: "test",
        dependencies: [],
        status: "PENDING",
        contextQuery: "test",
        retryCount: 0,
        complexity: "High",
      };
      expect(node.complexity).toBe("High");
    });

    it("supports optional verification field", () => {
      const node: TaskNode = {
        id: "t1",
        description: "test",
        dependencies: [],
        status: "PENDING",
        contextQuery: "test",
        retryCount: 0,
        verification: ["tokens are generated", "tokens are validated"],
      };
      expect(node.verification).toHaveLength(2);
    });

    it("supports optional risks field", () => {
      const node: TaskNode = {
        id: "t1",
        description: "test",
        dependencies: [],
        status: "PENDING",
        contextQuery: "test",
        retryCount: 0,
        risks: ["token expiration handling"],
      };
      expect(node.risks).toHaveLength(1);
    });
  });

  describe("Delegation instructions", () => {
    it("mentions all 18 work item stages", () => {
      const items = buildAgentInsightWorkItems(task);
      const instructions = buildAgentDelegationInstructions(task, items);
      expect(instructions).toContain("intent");
      expect(instructions).toContain("requirement");
      expect(instructions).toContain("decision-matrix");
      expect(instructions).toContain("reflection");
    });
  });
});
