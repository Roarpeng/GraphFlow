/**
 * Skill consolidation (QM-style UPDATE/DELETE/ADD) unit tests.
 */
import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphClient } from "../src/graph/client-factory";
import {
  applySkillConsolidation,
  normalizeSkillNameKey,
  planFromRequest,
  planSkillConsolidation,
  toConsolidateResult,
  type ConsolidateSkillInput,
} from "../src/learning/skill-consolidate";
import { parseSkillState, serializeAtomic, skillNodeId } from "../src/learning/skill-store";
import { shouldHardDeleteAntiPattern } from "../src/learning/canary-gate";
import type { SkillState } from "../src/learning/skill-types";

function skill(
  partial: Partial<ConsolidateSkillInput> & { id: string; name: string }
): ConsolidateSkillInput {
  return {
    score: 0,
    uses: 0,
    ...partial,
  };
}

describe("normalizeSkillNameKey", () => {
  it("lowercases and hyphenates near-duplicates", () => {
    expect(normalizeSkillNameKey("Cache Layer")).toBe("cache-layer");
    expect(normalizeSkillNameKey("cache_layer")).toBe("cache-layer");
    expect(normalizeSkillNameKey("CACHE-LAYER")).toBe("cache-layer");
  });
});

describe("planSkillConsolidation", () => {
  it("merges near-duplicate names into UPDATE survivor + DELETE duplicate", () => {
    const skills = [
      skill({
        id: "skill:cache-layer",
        name: "Cache Layer",
        score: 4,
        uses: 3,
        outcomeKind: "proven",
        guidance: "keep cache keys stable",
      }),
      skill({
        id: "skill:cache_layer",
        name: "cache_layer",
        score: 1,
        uses: 1,
        outcomeKind: "correctable",
        guidance: "invalidate on write",
      }),
    ];

    const actions = planSkillConsolidation(skills);
    const update = actions.find((a) => a.action === "UPDATE");
    const deletes = actions.filter((a) => a.action === "DELETE");

    expect(update?.skillId).toBe("skill:cache-layer");
    expect(update?.patch?.uses).toBe(4);
    expect(update?.patch?.score).toBe(4);
    expect(update?.patch?.guidance).toContain("keep cache keys stable");
    expect(update?.patch?.guidance).toContain("invalidate on write");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.skillId).toBe("skill:cache_layer");
    expect(actions.some((a) => a.action === "ADD")).toBe(false);
  });

  it("does not hard-delete anti-patterns while shouldHardDeleteAntiPattern is false", () => {
    expect(shouldHardDeleteAntiPattern()).toBe(false);
    const skills = [
      skill({
        id: "skill:bad-pattern",
        name: "bad-pattern.ts",
        score: -4,
        uses: 2,
        outcomeKind: "anti-pattern",
      }),
    ];
    const actions = planSkillConsolidation(skills);
    expect(actions.filter((a) => a.action === "DELETE")).toHaveLength(0);
  });

  it("deletes unused skills with very low score", () => {
    const skills = [
      skill({
        id: "skill:stale-noise",
        name: "stale-noise",
        score: -12,
        uses: 0,
        outcomeKind: "noise",
      }),
      skill({
        id: "skill:kept",
        name: "kept-skill.ts",
        score: -12,
        uses: 1,
        outcomeKind: "correctable",
      }),
    ];
    const actions = planSkillConsolidation(skills);
    const deletes = actions.filter((a) => a.action === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.skillId).toBe("skill:stale-noise");
  });

  it("suggests ADD only when candidates are provided", () => {
    const skills = [
      skill({ id: "skill:existing", name: "existing.ts", score: 2, uses: 2, outcomeKind: "proven" }),
    ];
    expect(planSkillConsolidation(skills).some((a) => a.action === "ADD")).toBe(false);

    const withAdd = planSkillConsolidation(skills, {
      candidates: [{ name: "new-helper.ts", guidance: "prefer small helpers", score: 1 }],
    });
    const add = withAdd.find((a) => a.action === "ADD");
    expect(add?.name).toBe("new-helper.ts");
    expect(add?.skillId).toBe(skillNodeId("new-helper.ts"));
  });

  it("prefers UPDATE over ADD when candidate matches an existing name", () => {
    const skills = [
      skill({
        id: "skill:planner-module",
        name: "Planner Module",
        score: 2,
        uses: 2,
        outcomeKind: "correctable",
      }),
    ];
    const actions = planSkillConsolidation(skills, {
      candidates: [{ name: "planner-module", guidance: "keep steps small", score: 5 }],
    });
    expect(actions.some((a) => a.action === "ADD")).toBe(false);
    const update = actions.find((a) => a.action === "UPDATE");
    expect(update?.skillId).toBe("skill:planner-module");
    expect(update?.patch?.score).toBe(5);
    expect(update?.patch?.guidance).toContain("keep steps small");
  });

  it("planFromRequest wraps summary counts", () => {
    const result = planFromRequest({
      skills: [
        skill({ id: "a", name: "Foo Bar", score: 1, uses: 1 }),
        skill({ id: "b", name: "foo-bar", score: 0, uses: 0 }),
      ],
    });
    expect(result.summary.updates).toBe(1);
    expect(result.summary.deletes).toBe(1);
    expect(toConsolidateResult(result.actions).summary).toEqual(result.summary);
  });
});

describe("applySkillConsolidation", () => {
  it("applies UPDATE/DELETE and skips unknown ids", async () => {
    const client = new GraphifyClient() as GraphClient;
    const survivor: SkillState = {
      id: "skill:cache-layer",
      name: "Cache Layer",
      score: 2,
      uses: 2,
      lastOutcome: "pass",
      updatedAt: 1,
      outcomeKind: "proven",
      guidance: "keep keys",
    };
    const duplicate: SkillState = {
      id: "skill:cache_layer",
      name: "cache_layer",
      score: 1,
      uses: 1,
      lastOutcome: "pass",
      updatedAt: 1,
      outcomeKind: "correctable",
      guidance: "invalidate",
    };
    await client.upsertNodes([
      { id: survivor.id, type: "Skill", content: serializeAtomic(survivor) },
      { id: duplicate.id, type: "Skill", content: serializeAtomic(duplicate) },
    ]);

    const plan = planSkillConsolidation([
      {
        id: survivor.id,
        name: survivor.name,
        score: survivor.score,
        uses: survivor.uses,
        outcomeKind: survivor.outcomeKind,
        guidance: survivor.guidance,
      },
      {
        id: duplicate.id,
        name: duplicate.name,
        score: duplicate.score,
        uses: duplicate.uses,
        outcomeKind: duplicate.outcomeKind,
        guidance: duplicate.guidance,
      },
      skill({ id: "skill:missing", name: "missing", score: -20, uses: 0 }),
    ]);

    const { applied, skipped } = await applySkillConsolidation(client, plan);
    expect(applied.some((a) => a.action === "UPDATE" && a.skillId === survivor.id)).toBe(true);
    expect(applied.some((a) => a.action === "DELETE" && a.skillId === duplicate.id)).toBe(true);
    expect(skipped.some((s) => s.action.skillId === "skill:missing")).toBe(true);

    const snapshot = client.readSnapshot?.();
    expect(snapshot?.nodes.find((n) => n.id === duplicate.id)).toBeUndefined();
    const updated = parseSkillState(
      snapshot?.nodes.find((n) => n.id === survivor.id)?.content ?? "{}"
    );
    expect(updated?.uses).toBe(3);
    expect(updated?.guidance).toContain("invalidate");
  });
});
