import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { applySkillLearning, extractSkillAtoms, suggestSkillHints } from "../src/learning/skill-flywheel";
import { orchestrate } from "../src/core/orchestrator";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";

describe("M14 skill flywheel", () => {
  it("extracts reusable skill atoms from task text", () => {
    const skills = extractSkillAtoms("update readme and add tests and refactor architecture module");
    expect(skills.length).toBeGreaterThan(1);
    // Stopword-only phrases like "update readme" must not become skill atoms.
    expect(skills.some((skill) => skill.includes("update readme"))).toBe(false);
    expect(skills.some((skill) => skill.includes("add tests") || skill.includes("architecture"))).toBe(
      true
    );
  });

  it("filters standalone stopword tokens while keeping meaningful phrases", () => {
    const skills = extractSkillAtoms("fix bug in readme");
    expect(skills).not.toContain("readme");
    expect(skills).not.toContain("fix");
    expect(skills.some((skill) => skill.includes("fix bug"))).toBe(true);
  });

  it("filters path-like tokens from raw token extraction", () => {
    const skills = extractSkillAtoms("refactor src/learning/skill-flywheel.ts");
    expect(skills.every((skill) => !skill.includes(".ts"))).toBe(true);
    expect(skills.every((skill) => !skill.includes("/"))).toBe(true);
  });

  it("learns skill nodes and co-occurrence edges from task outcomes", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "refactor planner and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });

    const snapshot = client.snapshot();
    expect(snapshot.nodes.some((node) => node.type === "Skill")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.relation === "co_occurs")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.relation === "improves")).toBe(true);
    // No stopword-only atoms from legacy demo phrasing.
    expect(
      snapshot.nodes.some((node) => node.type === "Skill" && node.content.includes("update readme"))
    ).toBe(false);
  });

  it("injects learned skill hints into orchestrator feedback and planning", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "refactor planner and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });

    const hints = await suggestSkillHints(client, "refactor planner and add tests", 3);
    expect(hints.length).toBeGreaterThan(0);

    const run = await orchestrate(
      { task: "refactor planner and add tests and improve architecture module" },
      {
        graphClient: client,
        enableSkillFlywheel: true,
        skillHintsLimit: 3,
        executionMode: "bridge",
        configPath: createNoLlmConfigPath(),
      }
    );

    expect(run.status).toBe("DELEGATED");
    expect(run.feedback).toContain("skills(hints=");
    expect(run.executionDescriptor).toBeDefined();
  });
});
