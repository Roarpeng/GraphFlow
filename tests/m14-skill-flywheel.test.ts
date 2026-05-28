import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { applySkillLearning, extractSkillAtoms, suggestSkillHints } from "../src/learning/skill-flywheel";
import { orchestrate } from "../src/core/orchestrator";

describe("M14 skill flywheel", () => {
  it("extracts reusable skill atoms from task text", () => {
    const skills = extractSkillAtoms("update readme and add tests and refactor architecture module");
    expect(skills.length).toBeGreaterThan(2);
    expect(skills.some((skill) => skill.includes("update readme"))).toBe(true);
  });

  it("learns skill nodes and co-occurrence edges from task outcomes", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "update readme and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });

    const snapshot = client.snapshot();
    expect(snapshot.nodes.some((node) => node.type === "Skill")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.relation === "co_occurs")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.relation === "improves")).toBe(true);
  });

  it("injects learned skill hints into orchestrator feedback and planning", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "update readme and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });

    const hints = await suggestSkillHints(client, "update readme and add tests", 3);
    expect(hints.length).toBeGreaterThan(0);

    const run = await orchestrate(
      { task: "update readme and add tests and refactor architecture module" },
      {
        graphClient: client,
        enableSkillFlywheel: true,
        skillHintsLimit: 3,
      }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.feedback).toContain("skills(hints=");
  });
});
