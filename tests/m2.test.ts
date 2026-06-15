import { describe, expect, it } from "vitest";
import { triageTask } from "../src/core/triage";
import { planTasks } from "../src/agents/planner";
import { executeDag } from "../src/core/dag-engine";
import { GraphifyClient } from "../src/graph/graphify-client";
import { indexChanges } from "../src/graph/graph-indexer";
import { buildContextSlice } from "../src/graph/context-slicer";

describe("M2/M3 baseline behavior", () => {
  it("triages complex task from multi-step wording", () => {
    expect(triageTask("Refactor module A and update module B")).toBe("complex");
  });

  it("creates dependent plan nodes for multi-part task", () => {
    const plan = planTasks("update readme and add tests");
    expect(plan.length).toBe(3);
    expect(plan[0]?.dependencies).toEqual([]);
    expect(plan[1]?.dependencies).toEqual([]);
    expect(plan[2]?.dependencies).toEqual(["task-1", "task-2"]);
  });

  it("executes dag with dependency order", async () => {
    const events: string[] = [];
    const plan = [
      {
        id: "task-1",
        description: "one",
        dependencies: [],
        status: "PENDING" as const,
        contextQuery: "one",
        retryCount: 0,
      },
      {
        id: "task-2",
        description: "two",
        dependencies: ["task-1"],
        status: "PENDING" as const,
        contextQuery: "two",
        retryCount: 0,
      },
    ];

    const result = await executeDag(plan, async (node) => {
      events.push(node.id);
      return true;
    });

    expect(result.failed).toHaveLength(0);
    expect(events).toEqual(["task-1", "task-2"]);
    expect(result.rounds).toEqual([["task-1"], ["task-2"]]);
  });

  it("builds graph index and slices context by token budget", async () => {
    const client = new GraphifyClient();
    await indexChanges(client, [{ filePath: "README.md", summary: "updated overview" }]);
    const slice = await buildContextSlice(client, "README", 20);
    expect(slice.items.length).toBeGreaterThan(0);
    expect(slice.tokenEstimate).toBeLessThanOrEqual(20);
  });
});
