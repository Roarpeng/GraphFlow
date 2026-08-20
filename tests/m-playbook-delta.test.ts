import { describe, expect, it } from "vitest";
import { applyPlaybookDelta, seedPlaybookFromGuidance } from "../src/learning/skill-opt-lite";
import { serializePlaybookGuidance } from "../src/learning/skill-types";
import type { PlaybookBullet } from "../src/learning/skill-types";
import { GraphifyClient } from "../src/graph/graphify-client";
import { applySkillLearning } from "../src/learning/skill-flywheel";
import { parseSkillState } from "../src/learning/skill-store";

function bullet(partial: Partial<PlaybookBullet> & { text: string }): PlaybookBullet {
  return {
    id: partial.id ?? `pb:${partial.text}`,
    helpful: partial.helpful ?? 0,
    harmful: partial.harmful ?? 0,
    text: partial.text,
  };
}

describe("applyPlaybookDelta", () => {
  it("appends a new lesson without rewriting existing bullets", () => {
    const original: PlaybookBullet[] = [
      bullet({ id: "pb:keep", text: "Keep compose_skill_id stable", helpful: 2 }),
    ];
    const snapshot = original.map((item) => ({ ...item }));
    const next = applyPlaybookDelta(original, ["Prefer applySkillLearning after report_outcome"], true);

    expect(next).toHaveLength(2);
    expect(next[0]?.id).toBe("pb:keep");
    expect(next[0]?.text).toBe("Keep compose_skill_id stable");
    expect(next[0]?.helpful).toBe(2);
    expect(next.some((item) => item.text.includes("applySkillLearning"))).toBe(true);
    expect(snapshot[0]?.text).toBe("Keep compose_skill_id stable");
    expect(serializePlaybookGuidance(next)).toContain("- Keep compose_skill_id stable");
  });

  it("increments helpful on pass and harmful on fail for matching text", () => {
    const playbook = [bullet({ id: "pb:a", text: "Touch only planner.ts", helpful: 1, harmful: 0 })];
    const pass = applyPlaybookDelta(playbook, ["Touch only planner.ts"], true);
    expect(pass).toHaveLength(1);
    expect(pass[0]?.helpful).toBe(2);
    expect(pass[0]?.harmful).toBe(0);

    const fail = applyPlaybookDelta(pass, ["- touch only planner.ts"], false);
    expect(fail).toHaveLength(1);
    expect(fail[0]?.helpful).toBe(2);
    expect(fail[0]?.harmful).toBe(1);
    expect(fail[0]?.text).toBe("Touch only planner.ts");
  });

  it("dedups similar texts and never replaces the whole array unless empty", () => {
    const empty = applyPlaybookDelta([], ["First lesson about planner.ts"], true);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.text).toContain("planner.ts");

    const next = applyPlaybookDelta(empty, ["First lesson about planner.ts"], true);
    expect(next).toHaveLength(1);
    expect(next[0]?.helpful).toBe(2);
    expect(next[0]?.id).toBe(empty[0]?.id);
  });

  it("caps around 8 bullets by dropping the worst counter, not rewriting survivors", () => {
    const seeded = Array.from({ length: 8 }, (_, i) =>
      bullet({ id: `pb:${i}`, text: `Keep bullet ${i} in skill-flywheel.ts`, helpful: 4 - (i === 0 ? 4 : 0) })
    );
    const next = applyPlaybookDelta(seeded, ["Brand new lesson for applySkillLearning"], true);
    expect(next.length).toBeLessThanOrEqual(8);
    expect(next.some((item) => item.text.includes("applySkillLearning"))).toBe(true);
    expect(next.some((item) => item.id === "pb:0")).toBe(false);
    expect(next.filter((item) => item.id.startsWith("pb:") && item.id !== "pb:0").length).toBeGreaterThan(0);
  });

  it("seeds from legacy guidance then applies incremental lessons", () => {
    const seeded = seedPlaybookFromGuidance("- keep goal-anchor.ts checks\n- avoid blind rewrite");
    expect(seeded).toHaveLength(2);
    const next = applyPlaybookDelta(seeded, ["keep goal-anchor.ts checks"], true);
    expect(next).toHaveLength(2);
    expect(next.find((item) => item.text.includes("goal-anchor.ts"))?.helpful).toBe(1);
  });
});

describe("applySkillLearning playbook wiring", () => {
  it("writes playbook and derived guidance from lessons instead of wholesale rewrite", async () => {
    const client = new GraphifyClient();
    await applySkillLearning(
      client,
      "refactor planner.ts and add tests",
      { status: "COMPLETED", attempts: 1, feedback: "done" },
      ["Prefer surgical edits in planner.ts with symbol evidence"],
      { linked: true }
    );
    const skills = client
      .snapshot()
      .nodes.filter((node) => node.type === "Skill" && !node.id.includes("composite"))
      .map((node) => parseSkillState(node.content))
      .filter((state): state is NonNullable<typeof state> => Boolean(state));

    expect(skills.some((state) => (state.playbook?.length ?? 0) > 0)).toBe(true);
    const withPlaybook = skills.find((state) => (state.playbook?.length ?? 0) > 0)!;
    expect(withPlaybook.guidance).toContain("planner.ts");
    expect(withPlaybook.guidance).toContain("- ");
    expect(withPlaybook.playbook?.every((item) => item.text.includes("Prefer surgical") || item.helpful >= 0)).toBe(
      true
    );

    await applySkillLearning(
      client,
      "refactor planner.ts and add tests",
      { status: "COMPLETED", attempts: 1, feedback: "done" },
      ["Prefer surgical edits in planner.ts with symbol evidence"],
      { linked: true }
    );
    const again = parseSkillState(
      client.snapshot().nodes.find((node) => node.id === withPlaybook.id)?.content ?? "{}"
    );
    expect(again?.playbook?.[0]?.text).toBe(withPlaybook.playbook?.[0]?.text);
    expect(again?.playbook?.[0]?.helpful).toBeGreaterThan(withPlaybook.playbook?.[0]?.helpful ?? 0);
  });
});
