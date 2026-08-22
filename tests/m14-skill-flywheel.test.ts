import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  cleanupNoiseSkills,
  extractSkillAtoms,
  suggestSkillHints,
} from "../src/learning/skill-flywheel";
import { skillNodeId, serializeAtomic, serializeComposite, parseSkillState } from "../src/learning/skill-store";
import type { CompositeSkillState, SkillState } from "../src/learning/skill-types";
import { admitSkillToProven } from "../src/learning/skill-admission";
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

    // Unlinked success: 无 episode 绑定的成功（uses 仅展示）不再晋升 proven——
    // 即使是 golden 词，也需要真实成功证据链（successCount）。
    await applySkillLearning(client, task, run("COMPLETED"));
    skills = client.snapshot().nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"));
    for (const node of skills) {
      const state = parseSkillState(node.content)!;
      expect(state.failStreak ?? 0).toBe(0);
      expect(state.outcomeKind).toBe("correctable");
      expect(state.successCount ?? 0).toBe(0);
    }
  });

  it("promotes episode-success atoms to proven; mentions alone never prove", async () => {
    const client = new GraphifyClient();
    const task = "refactor planner module in planner.ts and add tests";
    const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };

    // 两次成功但 0 个 pass episode 绑定（仅出现/使用计数）→ 不 proven。
    await applySkillLearning(client, task, run);
    await applySkillLearning(client, task, run);
    let skills = client
      .snapshot()
      .nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"))
      .map((n) => parseSkillState(n.content)!)
      .filter(Boolean);
    expect(skills.length).toBeGreaterThan(0);
    for (const state of skills) {
      expect(state.outcomeKind).toBe("correctable");
      expect(state.successCount ?? 0).toBe(0);
      expect(state.uses).toBe(2);
    }

    // 绑定两个 pass episode → 真实成功证据链 → proven。
    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-skill-a" });
    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-skill-b" });
    skills = client
      .snapshot()
      .nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"))
      .map((n) => parseSkillState(n.content)!)
      .filter(Boolean);
    const proven = skills.filter((s) => s.outcomeKind === "proven");
    expect(proven.length).toBeGreaterThan(0);
    for (const state of proven) {
      expect(state.successCount).toBe(2);
      expect(state.successEpisodeIds).toEqual(["ep-skill-a", "ep-skill-b"]);
      expect(state.score).toBeGreaterThan(0);
      // 有真实成功证据链的技能，即使名字不在任何静态列表也能准入：
      expect(admitSkillToProven(state.name, { successCount: state.successCount }).ok).toBe(true);
    }
    // 旧字段语义未变：uses 仍累计展示。
    for (const state of skills) {
      expect(state.uses).toBe(4);
    }
  });

  it("counts a linked successful outcome as evidence for immediate positive accrual when admitted", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(
      client,
      "refactor planner module in planner.ts and add tests",
      { status: "COMPLETED", attempts: 1, feedback: "done" },
      undefined,
      { linked: true, episodeId: "ep-skill-p0" }
    );
    const skills = client.snapshot().nodes.filter(
      (n) => n.type === "Skill" && !n.id.includes("composite")
    );
    const admitted = skills
      .map((n) => parseSkillState(n.content)!)
      .filter((s) => admitSkillToProven(s.name).ok);
    expect(admitted.length).toBeGreaterThan(0);
    for (const state of admitted) {
      expect(state.score).toBe(1);
      expect(state.linkedSuccess).toBe(true);
      expect(state.outcomeKind).toBe("proven");
      expect(state.provenance).toEqual({ source: "local", episodeId: "ep-skill-p0" });
      // linked 成功同时计入 successCount（1 个绑定 pass episode）。
      expect(state.successCount).toBe(1);
      expect(state.successEpisodeIds).toEqual(["ep-skill-p0"]);
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

  it("prunes generic/readme+update names even when hasSymbolEvidence was wrongly true", async () => {
    const client = new GraphifyClient();
    const now = Date.now();
    const lie: SkillState = {
      id: skillNodeId("readme"),
      name: "readme",
      score: 4,
      uses: 8,
      lastOutcome: "pass",
      updatedAt: now,
      hasSymbolEvidence: true,
      outcomeKind: "proven",
    };
    const fusion: CompositeSkillState = {
      id: "skill:composite:readme__update",
      name: "readme+update",
      parents: [skillNodeId("readme"), skillNodeId("update")],
      coOccurCount: 4,
      successCount: 3,
      failureCount: 0,
      score: 3,
      uses: 3,
      lastOutcome: "pass",
      updatedAt: now,
      hasSymbolEvidence: true,
      outcomeKind: "proven",
    };
    await client.upsertNodes([
      { id: lie.id, type: "Skill", content: serializeAtomic(lie) },
      { id: fusion.id, type: "Skill", content: serializeComposite(fusion) },
    ]);

    const result = await cleanupNoiseSkills(client);
    expect(result.ids).toContain(lie.id);
    expect(result.ids).toContain(fusion.id);
    const remaining = client.snapshot().nodes.filter((n) => n.type === "Skill").map((n) => n.id);
    expect(remaining).not.toContain(lie.id);
    expect(remaining).not.toContain(fusion.id);
  });

  it("prunes legacy evolution-kind readme/update skills that parseSkillState used to skip", async () => {
    const client = new GraphifyClient();
    const id = "skill:evolution:28d8e8bd";
    await client.upsertNodes([
      {
        id,
        type: "Skill",
        content: JSON.stringify({
          kind: "evolution",
          id,
          name: "构建 readme 与 update 融合高阶技能",
          score: 8,
          uses: 23,
          lastOutcome: "pass",
          updatedAt: Date.now(),
        }),
      },
    ]);
    expect(parseSkillState((await client.queryByKeyword(id))[0]?.content ?? "")?.name).toContain("readme");
    const result = await cleanupNoiseSkills(client);
    expect(result.ids).toContain(id);
    expect(client.snapshot().nodes.some((n) => n.id === id)).toBe(false);
  });

  it("does not fuse composite skills unless both parents are symbolic", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "refactor planner.ts and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    const snapshot = client.snapshot();
    expect(snapshot.edges.some((edge) => edge.relation === "co_occurs")).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === "Skill" && node.id.includes("composite"))).toBe(
      false
    );
    for (const node of snapshot.nodes.filter((n) => n.type === "Skill")) {
      const state = parseSkillState(node.content);
      if (!state) continue;
      expect(state.hasSymbolEvidence === true).toBe(false);
    }
  });

  it("injects learned skill hints into orchestrator feedback and planning", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "wire compose_skill_id in planner.ts", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });

    const hints = await suggestSkillHints(client, "wire compose_skill_id in planner.ts", 3);
    expect(hints.length).toBeGreaterThan(0);

    const run = await orchestrate(
      { task: "wire compose_skill_id in planner.ts and improve architecture module" },
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
