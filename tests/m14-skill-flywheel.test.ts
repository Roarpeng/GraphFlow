import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  cleanupNoiseSkills,
  extractSkillAtoms,
  suggestSkillHints,
} from "../src/learning/skill-flywheel";
import { skillNodeId, serializeAtomic, parseSkillState } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";
import { orchestrate } from "../src/core/orchestrator";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";

describe("M14 skill flywheel", () => {
  it("extracts reusable skill atoms from task text with symbol evidence", () => {
    const skills = extractSkillAtoms("update readme and add tests and refactor goal-anchor.ts");
    expect(skills.length).toBeGreaterThan(1);
    // Stopword-only phrases like "update readme" must not become skill atoms.
    expect(skills.some((skill) => skill.includes("update readme"))).toBe(false);
    expect(skills.some((skill) => skill.includes("add tests") || skill.includes("refactor"))).toBe(
      true
    );
  });

  it("rejects generic corpora without project-symbol evidence at extraction", () => {
    // P0-2 quality gate: bare generic tokens (update/readme/create/fix) without
    // file/function/class references are noise — never extracted.
    expect(extractSkillAtoms("update readme and add tests")).toEqual([]);
    expect(extractSkillAtoms("create fix")).toEqual([]);
    expect(extractSkillAtoms("update readme")).toEqual([]);
    // A single project-symbol reference unlocks extraction for the corpus.
    expect(extractSkillAtoms("fix build for cache-layer.ts").length).toBeGreaterThan(0);
  });

  it("filters standalone stopword tokens while keeping meaningful phrases", () => {
    const skills = extractSkillAtoms("fix bug in readme and refactor cache-layer.ts");
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
    await applySkillLearning(client, "refactor planner.ts and add tests", {
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

  it("requires evidence before positive score accrues; negative only for anti-pattern", async () => {
    const client = new GraphifyClient();
    const task = "refactor planner.ts and add tests";
    const run = (status: "COMPLETED" | "FAILED") => ({
      status,
      attempts: 1,
      feedback: "done",
    });

    // First failure: correctable — no negative score.
    await applySkillLearning(client, task, run("FAILED"));
    let skills = client.snapshot().nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"));
    expect(skills.length).toBeGreaterThan(0);
    for (const node of skills) {
      const state = parseSkillState(node.content)!;
      expect(state.score).toBe(0);
      expect(state.failStreak).toBe(1);
      expect(state.outcomeKind).toBe("correctable");
    }

    // Second consecutive failure: anti-pattern — negative score applies.
    await applySkillLearning(client, task, run("FAILED"));
    skills = client.snapshot().nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"));
    for (const node of skills) {
      const state = parseSkillState(node.content)!;
      expect(state.score).toBe(-1);
      expect(state.outcomeKind).toBe("anti-pattern");
    }

    // Unlinked success: still only 2 uses — proven, +1 from -1 → 0.
    await applySkillLearning(client, task, run("COMPLETED"));
    skills = client.snapshot().nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"));
    for (const node of skills) {
      const state = parseSkillState(node.content)!;
      expect(state.score).toBe(0);
      expect(state.outcomeKind).toBe("proven");
    }

    // Second success: proven again, +1 → 1.
    await applySkillLearning(client, task, run("COMPLETED"));
    skills = client.snapshot().nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"));
    for (const node of skills) {
      const state = parseSkillState(node.content)!;
      expect(state.score).toBe(1);
    }
  });

  it("counts a linked successful outcome as evidence for immediate positive accrual", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(
      client,
      "refactor planner.ts and add tests",
      { status: "COMPLETED", attempts: 1, feedback: "done" },
      undefined,
      { linked: true }
    );
    const skills = client.snapshot().nodes.filter(
      (n) => n.type === "Skill" && !n.id.includes("composite")
    );
    for (const node of skills) {
      const state = parseSkillState(node.content)!;
      expect(state.score).toBe(1);
      expect(state.linkedSuccess).toBe(true);
      expect(state.outcomeKind).toBe("proven");
    }
  });

  it("load-time cleanup prunes pure-noise nodes while keeping seeds and symbolic names", async () => {
    const client = new GraphifyClient();
    const now = Date.now();
    const noiseStates: Array<[string, SkillState]> = [
      [
        "update",
        { id: skillNodeId("update"), name: "update", score: -2, uses: 39, lastOutcome: "fail", updatedAt: now },
      ],
      [
        "readme",
        { id: skillNodeId("readme"), name: "readme", score: -2, uses: 17, lastOutcome: "fail", updatedAt: now },
      ],
      [
        "create",
        { id: skillNodeId("create"), name: "create", score: -1, uses: 9, lastOutcome: "fail", updatedAt: now },
      ],
    ];
    const seed: SkillState = {
      id: skillNodeId("refactor"),
      name: "refactor",
      score: 2,
      uses: 0,
      lastOutcome: "pass",
      updatedAt: now,
      seeded: true,
      hasSymbolEvidence: true,
      outcomeKind: "proven",
    };
    const symbolic: SkillState = {
      id: skillNodeId("compose_skill_id"),
      name: "compose_skill_id",
      score: 3,
      uses: 4,
      lastOutcome: "pass",
      updatedAt: now,
    };
    await client.upsertNodes([
      ...noiseStates.map(([, s]) => ({ id: s.id, type: "Skill" as const, content: serializeAtomic(s) })),
      { id: seed.id, type: "Skill", content: serializeAtomic(seed) },
      { id: symbolic.id, type: "Skill", content: serializeAtomic(symbolic) },
    ]);

    const result = await cleanupNoiseSkills(client);
    expect(result.pruned).toBe(3);
    expect(result.ids).toContain(skillNodeId("update"));
    expect(result.ids).toContain(skillNodeId("readme"));
    expect(result.ids).toContain(skillNodeId("create"));

    const remaining = client.snapshot().nodes.filter((n) => n.type === "Skill").map((n) => n.id);
    expect(remaining).not.toContain(skillNodeId("update"));
    expect(remaining).not.toContain(skillNodeId("readme"));
    expect(remaining).not.toContain(skillNodeId("create"));
    expect(remaining).toContain(skillNodeId("refactor"));
    expect(remaining).toContain(skillNodeId("compose_skill_id"));

    // Idempotent: nothing left to prune.
    const second = await cleanupNoiseSkills(client);
    expect(second.pruned).toBe(0);
  });

  it("injects learned skill hints into orchestrator feedback and planning", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "refactor planner.ts and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });

    const hints = await suggestSkillHints(client, "refactor planner.ts and add tests", 3);
    expect(hints.length).toBeGreaterThan(0);

    const run = await orchestrate(
      { task: "refactor planner.ts and add tests and improve architecture module" },
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
