import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  computeAdaptiveDecayAmount,
  maybeDecaySkills,
} from "../src/learning/skill-flywheel";
import { parseSkillState, serializeAtomic } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";

const DAY = 24 * 60 * 60 * 1000;

function skill(overrides: Partial<SkillState> & { id: string }): SkillState {
  return {
    name: overrides.id,
    score: 5,
    uses: 1,
    lastOutcome: "pass",
    updatedAt: Date.now() - 29 * DAY,
    ...overrides,
  };
}

async function seedSkill(state: SkillState): Promise<GraphifyClient> {
  const client = new GraphifyClient();
  await client.upsertNodes([
    { id: state.id, type: "Skill", content: serializeAtomic(state) },
  ]);
  return client;
}

describe("adaptive skill decay", () => {
  it("decays stale skills with no success evidence faster than proven skills", () => {
    const now = Date.now();
    const stale = skill({ id: "skill:stale", score: 3, uses: 0 });
    const proven = skill({
      id: "skill:proven",
      score: 10,
      uses: 12,
      successCount: 4,
      successEpisodeIds: ["ep-a", "ep-b", "ep-c", "ep-d"],
      outcomeKind: "proven",
    });

    expect(computeAdaptiveDecayAmount(stale, now)).toBe(1.75);
    expect(computeAdaptiveDecayAmount(proven, now)).toBeLessThan(
      computeAdaptiveDecayAmount(stale, now) / 4
    );
  });

  it("moves repeated failures toward zero without deleting them", async () => {
    const failing = skill({
      id: "skill:failing",
      name: "failing approach.ts",
      score: -5,
      uses: 9,
      lastOutcome: "fail",
      updatedAt: Date.now() - 8 * DAY,
      failStreak: 3,
      outcomeKind: "anti-pattern",
    });
    const client = await seedSkill(failing);

    const result = await maybeDecaySkills(client);
    expect(result.decayed).toBe(1);

    const node = client.snapshot().nodes.find((item) => item.id === failing.id)!;
    expect(parseSkillState(node.content)?.score).toBe(-3.25);
    expect(node).toBeDefined();
  });

  it("keeps decayed scores inside the existing score bound", async () => {
    const extreme = skill({
      id: "skill:extreme",
      name: "extreme score.ts",
      score: 100,
      uses: 2,
    });
    const client = await seedSkill(extreme);

    await maybeDecaySkills(client);
    const node = client.snapshot().nodes.find((item) => item.id === extreme.id)!;
    const state = parseSkillState(node.content);

    expect(state?.score).toBe(18.25);
    expect(state?.score).toBeGreaterThanOrEqual(-20);
    expect(state?.score).toBeLessThanOrEqual(20);
  });

  it("does not decay before a full seven-day period", async () => {
    const fresh = skill({
      id: "skill:fresh",
      name: "fresh skill.ts",
      score: 4,
      updatedAt: Date.now(),
    });
    const client = await seedSkill(fresh);

    const result = await maybeDecaySkills(client);
    const node = client.snapshot().nodes.find((item) => item.id === fresh.id)!;
    const state = parseSkillState(node.content);

    expect(result.decayed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(state?.score).toBe(4);
    expect(state?.lastDecayedAt).toBeUndefined();
  });
});
