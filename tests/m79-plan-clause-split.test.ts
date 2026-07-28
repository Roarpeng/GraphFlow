import { describe, expect, it } from "vitest";
import { planTasks } from "../src/agents/planner";
import { brainstormTask } from "../src/agents/brainstormer";

/**
 * Heuristic planner must not treat English/Chinese list punctuation inside one
 * analytical request as independent work items.
 */
describe("planTasks clause splitting", () => {
  it("keeps colon-introduced evaluation dimensions as one task (not parallel DAG)", () => {
    const task =
      "Critically evaluate reliability of look-down-init curriculum for copper tube FOV acquisition: assumptions、failure modes、validation gates、alternatives ranking.";
    const plan = planTasks(task);

    // Single-intent analysis → design / implement / verify chain (3 nodes),
    // not parallel noun-phrase tasks like "failure modes".
    expect(plan).toHaveLength(3);
    expect(plan.map((node) => node.description).join("\n")).not.toMatch(/^failure modes$/m);
    expect(plan.map((node) => node.description).join("\n")).not.toMatch(/^validation gates$/m);
    expect(plan[0]?.description).toContain("分析与设计");
    expect(plan[2]?.dependencies).toEqual(["task-2"]);
  });

  it("still splits independent work joined by and", () => {
    const plan = planTasks("update readme and add tests");
    expect(plan).toHaveLength(3);
    expect(plan[0]?.description).toContain("update readme");
    expect(plan[1]?.description).toContain("add tests");
    expect(plan[2]?.dependencies).toEqual(["task-1", "task-2"]);
  });

  it("splits actionable clauses joined by Chinese enumeration when both sides are tasks", () => {
    const plan = planTasks("更新 README，添加单元测试");
    expect(plan.length).toBeGreaterThanOrEqual(3);
    expect(plan.some((node) => node.description.includes("更新 README"))).toBe(true);
    expect(plan.some((node) => node.description.includes("添加单元测试"))).toBe(true);
  });

  it("brainstorm keeps full analytical task in 目标澄清 instead of noun fragments", () => {
    const task =
      "Critically evaluate reliability of look-down-init curriculum for copper tube FOV acquisition: assumptions, failure modes, validation gates";
    const ideas = brainstormTask(task);
    expect(ideas[0]).toContain("目标澄清");
    expect(ideas[0]).toContain("look-down-init");
    expect(ideas[0]).not.toMatch(/目标澄清: 明确要完成 assumptions/);
  });
});
