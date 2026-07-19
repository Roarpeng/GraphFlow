import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  extractSkillAtoms,
  isAllStopwordPhrase,
  pruneFailedSkills,
  suggestSkillHints,
  applySkillLearning,
} from "../src/learning/skill-flywheel";
import { skillNodeId, serializeAtomic, parseSkillState } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";
import {
  sanitizeOutcomeLessons,
  shouldApplySkillLearningFromOutcome,
} from "../src/surfaces/cli/runtime/routing";
import { parseSkillInsight } from "../src/surfaces/cli/runtime/helpers";

describe("M62 skill decay and atom hygiene", () => {
  it("rejects phrases composed entirely of stopwords", () => {
    expect(isAllStopwordPhrase("update readme")).toBe(true);
    expect(isAllStopwordPhrase("update the readme")).toBe(true);
    expect(isAllStopwordPhrase("add tests")).toBe(false);
    expect(isAllStopwordPhrase("fix bug")).toBe(false);
  });

  it("does not extract stopword-only skills like update/readme", () => {
    const atoms = extractSkillAtoms("update readme");
    expect(atoms).toEqual([]);
    expect(atoms.some((s) => s.includes("update"))).toBe(false);
    expect(atoms.some((s) => s.includes("readme"))).toBe(false);

    const mixed = extractSkillAtoms("update readme and add tests and refactor architecture module");
    expect(mixed.some((s) => s.includes("update readme"))).toBe(false);
    expect(
      mixed.some((s) => s.includes("add tests") || s.includes("refactor") || s.includes("architecture"))
    ).toBe(true);
  });

  it("pruneFailedSkills soft-hides toxic atomic skills from hints and insights", async () => {
    const client = new GraphifyClient();
    const toxic: SkillState = {
      id: skillNodeId("update-readme"),
      name: "update readme",
      score: -9,
      uses: 39,
      lastOutcome: "fail",
      updatedAt: Date.now(),
    };
    const healthy: SkillState = {
      id: skillNodeId("refactor"),
      name: "refactor",
      score: 3,
      uses: 4,
      lastOutcome: "pass",
      updatedAt: Date.now(),
    };
    await client.upsertNodes([
      { id: toxic.id, type: "Skill", content: serializeAtomic(toxic) },
      { id: healthy.id, type: "Skill", content: serializeAtomic(healthy) },
    ]);

    const result = await pruneFailedSkills(client);
    expect(result.pruned).toBe(1);
    expect(result.ids).toContain(toxic.id);

    const prunedNode = client.snapshot().nodes.find((n) => n.id === toxic.id)!;
    const prunedState = parseSkillState(prunedNode.content)!;
    expect(prunedState.hidden).toBe(true);
    expect(prunedState.score).toBeLessThanOrEqual(-9);

    expect(parseSkillInsight(prunedNode)).toBeUndefined();

    const healthyNode = client.snapshot().nodes.find((n) => n.id === healthy.id)!;
    expect(parseSkillInsight(healthyNode)?.name).toBe("refactor");

    const hints = await suggestSkillHints(client, "refactor architecture module", 5);
    expect(hints).not.toContain("update readme");
    expect(hints).toContain("refactor");
  });

  it("sanitizeOutcomeLessons trims, drops empties, and caps at 4", () => {
    expect(sanitizeOutcomeLessons(["  ok  ", "", "  ", "a", "b", "c", "d", "e"])).toEqual([
      "ok",
      "a",
      "b",
      "c",
    ]);
  });

  it("shouldApplySkillLearningFromOutcome skips empty-atom and low-quality failure spam", () => {
    expect(shouldApplySkillLearningFromOutcome(true, "update readme", [])).toBe(false);
    // Failure with quality lessons still learns (lessons can seed atoms).
    expect(shouldApplySkillLearningFromOutcome(false, "update readme", ["long enough lesson"])).toBe(
      true
    );
    expect(shouldApplySkillLearningFromOutcome(true, "refactor planner and add tests", [])).toBe(
      true
    );
    expect(shouldApplySkillLearningFromOutcome(false, "refactor planner and add tests", [])).toBe(
      false
    );
    expect(
      shouldApplySkillLearningFromOutcome(false, "refactor planner and add tests", [
        "split modules carefully",
      ])
    ).toBe(true);
    // Short lessons (<8 chars) do not qualify as quality lessons on failure.
    expect(
      shouldApplySkillLearningFromOutcome(false, "refactor planner and add tests", ["short"])
    ).toBe(false);
  });

  it("applySkillLearning on stopword-only task creates no skill nodes", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(client, "update readme", {
      status: "FAILED",
      attempts: 1,
      feedback: "nope",
    });
    const skills = client.snapshot().nodes.filter((n) => n.type === "Skill");
    expect(skills).toHaveLength(0);
  });
});
