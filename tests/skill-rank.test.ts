import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Passthrough spy on applySkillConsolidation: real behavior everywhere, but
// the scheduled-consolidation trigger tests can assert exact call counts.
vi.mock("../src/learning/skill-consolidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/learning/skill-consolidate")>();
  return { ...actual, applySkillConsolidation: vi.fn(actual.applySkillConsolidation) };
});

import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  maybeRunScheduledSkillConsolidation,
  readSkillLibraryMeta,
  SKILL_LIBRARY_META_NODE_ID,
  suggestSkillConditionHints,
  suggestSkillHints,
} from "../src/learning/skill-flywheel";
import {
  SKILL_CONSOLIDATION_MIN_INTERVAL_MS,
  SKILL_LIBRARY_META_KIND,
  applySkillConsolidation,
  ensureSkillLibraryMeta,
  writeSkillLibraryMeta,
} from "../src/learning/skill-consolidate";
import { parseSkillState, serializeAtomic, skillNodeId } from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";
import {
  dedupLessons,
  rankSkillStates,
  skillStateWilsonLB,
  wilsonLowerBound,
} from "../src/learning/skill-rank";

const applySpy = vi.mocked(applySkillConsolidation);

function state(partial: Partial<SkillState> & { id: string; name: string }): SkillState {
  return { score: 0, uses: 0, lastOutcome: "pass", updatedAt: 0, ...partial };
}

beforeEach(() => {
  applySpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wilsonLowerBound", () => {
  it("returns 0 without evidence", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(5, 0)).toBe(0);
    expect(wilsonLowerBound(5, -3)).toBe(0);
    expect(wilsonLowerBound(Number.NaN, 10)).toBe(0);
  });

  it("gives a 46/50 skill a higher confidence bound than a 2/2 skill", () => {
    const largeSample = wilsonLowerBound(46, 50);
    const smallSample = wilsonLowerBound(2, 2);
    expect(largeSample).toBeGreaterThan(0.8);
    expect(smallSample).toBeCloseTo(0.3424, 3);
    expect(largeSample).toBeGreaterThan(smallSample);
  });

  it("never rewards zero successes and stays in [0, 1]", () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(10, 10)).toBeLessThanOrEqual(1);
    expect(wilsonLowerBound(9, 10)).toBeLessThan(wilsonLowerBound(10, 10));
  });
});

describe("rankSkillStates", () => {
  it("ranks by Wilson lower bound: 46/50 beats 2/2 despite a lower raw score", () => {
    const largeSample = state({
      id: "skill:large-sample",
      name: "large sample",
      uses: 50,
      successCount: 46,
      successEpisodeIds: Array.from({ length: 46 }, (_, i) => `ep-${i}`),
      score: 3,
      outcomeKind: "proven",
      updatedAt: 100,
    });
    const smallSample = state({
      id: "skill:small-sample",
      name: "small sample",
      uses: 2,
      successCount: 2,
      score: 9, // higher heuristic score must NOT outweigh weaker evidence
      outcomeKind: "proven",
      updatedAt: 900,
    });
    const ranked = rankSkillStates([smallSample, largeSample]);
    expect(ranked.map((s) => s.id)).toEqual(["skill:large-sample", "skill:small-sample"]);
  });

  it("sorts 0-uses skills last, deterministically by score then updatedAt then id", () => {
    const zeroUsesHighScore = state({
      id: "skill:zero-high",
      name: "zero high",
      uses: 0,
      score: 20,
      updatedAt: 500,
    });
    const zeroUsesLowScore = state({
      id: "skill:zero-low",
      name: "zero low",
      uses: 0,
      score: 1,
      updatedAt: 500,
    });
    const zeroUsesSameScoreOlder = state({
      id: "skill:zero-old",
      name: "zero old",
      uses: 0,
      score: 20,
      updatedAt: 100,
    });
    const zeroUsesSameScoreSameTime = state({
      id: "skill:zero-aaa",
      name: "zero aaa",
      uses: 0,
      score: 20,
      updatedAt: 500,
    });
    const withEvidence = state({
      id: "skill:evidence",
      name: "evidence",
      uses: 20,
      successCount: 10,
      score: 1,
      updatedAt: 1,
    });

    const ranked = rankSkillStates([
      zeroUsesLowScore,
      zeroUsesSameScoreSameTime,
      zeroUsesHighScore,
      withEvidence,
      zeroUsesSameScoreOlder,
    ]);
    // Any positive evidence outranks every 0-uses skill.
    expect(ranked[0]?.id).toBe("skill:evidence");
    // 0-uses tier: score desc → updatedAt desc → id asc.
    expect(ranked.slice(1).map((s) => s.id)).toEqual([
      "skill:zero-aaa", // score 20, updatedAt 500, id sorts before zero-high
      "skill:zero-high",
      "skill:zero-old", // score 20 but older
      "skill:zero-low", // score 1
    ]);
  });

  it("tie-breaks equal-evidence skills by score desc, updatedAt desc, id asc and does not mutate input", () => {
    const a = state({ id: "skill:b", name: "b", uses: 10, successCount: 5, score: 4, updatedAt: 10 });
    const b = state({ id: "skill:a", name: "a", uses: 10, successCount: 5, score: 4, updatedAt: 10 });
    const c = state({ id: "skill:c", name: "c", uses: 10, successCount: 5, score: 7, updatedAt: 1 });
    const input = [a, b, c];
    const ranked = rankSkillStates(input);
    expect(ranked.map((s) => s.id)).toEqual(["skill:c", "skill:a", "skill:b"]);
    // Input order untouched.
    expect(input.map((s) => s.id)).toEqual(["skill:b", "skill:a", "skill:c"]);
  });

  it("counts legacy linkedSuccess + provenance.episodeId as one success", () => {
    const legacy = state({
      id: "skill:legacy",
      name: "legacy",
      uses: 4,
      linkedSuccess: true,
      provenance: { source: "local", episodeId: "ep-1" },
      score: 2,
    });
    expect(skillStateWilsonLB(legacy)).toBeCloseTo(wilsonLowerBound(1, 4), 12);
  });
});

describe("recall ordering through collectTaskSkillCandidates", () => {
  it("suggestSkillConditionHints puts the higher-evidence skill first", async () => {
    const client = new GraphifyClient();
    const smallSample = state({
      id: skillNodeId("refactor planner"),
      name: "refactor planner",
      uses: 2,
      successCount: 2,
      score: 5,
      outcomeKind: "proven",
      hasSymbolEvidence: true,
    });
    const largeSample = state({
      id: skillNodeId("add tests"),
      name: "add tests",
      uses: 50,
      successCount: 46,
      score: 3,
      outcomeKind: "proven",
      hasSymbolEvidence: true,
    });
    await client.upsertNodes([
      { id: smallSample.id, type: "Skill", content: serializeAtomic(smallSample) },
      { id: largeSample.id, type: "Skill", content: serializeAtomic(largeSample) },
    ]);

    const hints = await suggestSkillConditionHints(client, "refactor planner and add tests", 3);
    expect(hints.skillRefs).toContain("refactor planner");
    expect(hints.skillRefs).toContain("add tests");
    expect(hints.skillRefs[0]).toBe("add tests");
  });
});

describe("dedupLessons", () => {
  it("collapses exact duplicates after normalization (case, whitespace, bullets)", () => {
    expect(
      dedupLessons(["Keep planner.ts small", "keep planner.ts  small ", "- KEEP PLANNER.TS SMALL"])
    ).toEqual(["Keep planner.ts small"]);
  });

  it("collapses near-duplicates: word-order change and added stopword", () => {
    expect(
      dedupLessons([
        "run tests before deploy in planner.ts",
        "deploy in planner.ts before tests run",
      ])
    ).toEqual(["run tests before deploy in planner.ts"]);

    expect(dedupLessons(["Keep planner steps small", "keep the planner steps small"])).toEqual([
      "Keep planner steps small",
    ]);
  });

  it("keeps distinct lessons and preserves input order; drops empties", () => {
    const lessons = [
      "Keep planner.ts small",
      "Wire compose_skill_id through skill-store.ts",
      "   ",
      "",
      "Cache tokenizeForIndex results",
    ];
    expect(dedupLessons(lessons)).toEqual([
      "Keep planner.ts small",
      "Wire compose_skill_id through skill-store.ts",
      "Cache tokenizeForIndex results",
    ]);
  });

  it("keeps the earliest occurrence of a near-duplicate family", () => {
    const kept = dedupLessons([
      "keep planner.ts checks small before deploy",
      "before deploy, keep planner.ts checks small", // same token set, reordered
      "Keep PLANNER.TS checks small before deploy!", // exact after normalization
    ]);
    expect(kept).toEqual(["keep planner.ts checks small before deploy"]);
  });

  it("is wired into applySkillLearning playbook guidance", async () => {
    const client = new GraphifyClient();
    const task = "refactor planner.ts and add tests";
    await applySkillLearning(client, task, { status: "COMPLETED", attempts: 1, feedback: "done" }, [
      "Keep planner.ts small",
      "keep the planner.ts small", // near-dup — must not become a second bullet
      "Wire compose_skill_id through skill-store.ts",
    ]);
    // Every learned skill that got a playbook sees the SAME deduped lessons:
    // the near-duplicate collapses before any bullet is appended.
    const playbooks = client
      .snapshot()
      .nodes.filter((n) => n.type === "Skill")
      .map((n) => parseSkillState(n.content)?.playbook)
      .filter((p): p is NonNullable<SkillState["playbook"]> => p !== undefined);
    expect(playbooks.length).toBeGreaterThan(0);
    for (const playbook of playbooks) {
      expect(playbook.length).toBe(2);
      const texts = playbook.map((b) => b.text.toLowerCase());
      expect(texts.some((t) => t.includes("keep the planner.ts small"))).toBe(false);
    }
  });
});

// ── Lazy scheduled consolidation ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedDuplicateSkills(client: GraphifyClient): Promise<void> {
  const survivor = state({
    id: skillNodeId("refactor planner"),
    name: "refactor planner",
    uses: 5,
    score: 3,
    outcomeKind: "proven",
    updatedAt: 100,
  });
  const duplicate = state({
    id: skillNodeId("Refactor-Planner"), // normalizes to the same name key
    name: "Refactor-Planner",
    uses: 1,
    score: 1,
    updatedAt: 50,
  });
  await client.upsertNodes([
    { id: survivor.id, type: "Skill", content: serializeAtomic(survivor) },
    { id: duplicate.id, type: "Skill", content: serializeAtomic(duplicate) },
  ]);
}

describe("lazy scheduled skill consolidation", () => {
  it("an 8-day-old meta triggers consolidation exactly once and merges duplicates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new GraphifyClient();
    await seedDuplicateSkills(client);
    const now = Date.now();
    await writeSkillLibraryMeta(client, {
      kind: SKILL_LIBRARY_META_KIND,
      lastConsolidatedAt: now - 8 * DAY_MS,
      episodesSinceConsolidation: 0,
      updatedAt: now - 8 * DAY_MS,
    });

    const first = await maybeRunScheduledSkillConsolidation(client);
    expect(first.ran).toBe(true);
    expect(first.reason).toBe("interval");
    expect(applySpy).toHaveBeenCalledTimes(1);

    // Duplicate merged away: only the survivor node remains, uses summed.
    const skills = client
      .snapshot()
      .nodes.filter((n) => n.type === "Skill")
      .map((n) => parseSkillState(n.content))
      .filter((s): s is SkillState => s !== undefined);
    expect(skills.length).toBe(1);
    expect(skills[0]?.name).toBe("refactor planner");
    expect(skills[0]?.uses).toBe(6);

    // Meta refreshed: schedule resets, last run recorded.
    const meta = await readSkillLibraryMeta(client);
    expect(meta?.lastConsolidatedAt).toBe(now);
    expect(meta?.episodesSinceConsolidation).toBe(0);
    expect(meta?.lastRun?.reason).toBe("interval");
    expect(meta?.lastRun?.applied).toBeGreaterThan(0);

    // Second check on the fresh meta does not run again.
    const second = await maybeRunScheduledSkillConsolidation(client);
    expect(second.ran).toBe(false);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  it("a fresh meta does not trigger consolidation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new GraphifyClient();
    await seedDuplicateSkills(client);
    const now = Date.now();
    await ensureSkillLibraryMeta(client, now);

    const result = await maybeRunScheduledSkillConsolidation(client);
    expect(result.ran).toBe(false);
    expect(applySpy).not.toHaveBeenCalled();

    // Nothing merged — both duplicate skills are still there.
    const skills = client
      .snapshot()
      .nodes.filter((n) => n.type === "Skill")
      .map((n) => parseSkillState(n.content))
      .filter((s): s is SkillState => s !== undefined);
    expect(skills.length).toBe(2);
  });

  it("a missing meta node is created lazily and does not consolidate on first contact", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new GraphifyClient();
    const now = Date.now();
    const result = await maybeRunScheduledSkillConsolidation(client);
    expect(result.ran).toBe(false);
    expect(applySpy).not.toHaveBeenCalled();

    const meta = await readSkillLibraryMeta(client);
    expect(meta).toBeDefined();
    expect(meta?.lastConsolidatedAt).toBe(now);
    expect(client.snapshot().nodes.some((n) => n.id === SKILL_LIBRARY_META_NODE_ID)).toBe(true);
  });

  it("fires on the episodes-since-consolidation counter exceeding 50", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new GraphifyClient();
    const now = Date.now();
    await writeSkillLibraryMeta(client, {
      kind: SKILL_LIBRARY_META_KIND,
      lastConsolidatedAt: now, // interval NOT elapsed
      episodesSinceConsolidation: 51,
      updatedAt: now,
    });

    const result = await maybeRunScheduledSkillConsolidation(client);
    expect(result.ran).toBe(true);
    expect(result.reason).toBe("episodes");
    expect(applySpy).toHaveBeenCalledTimes(1);
    const meta = await readSkillLibraryMeta(client);
    expect(meta?.episodesSinceConsolidation).toBe(0);
  });

  it("applySkillLearning increments the new-episode counter on the meta node", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new GraphifyClient();
    await ensureSkillLibraryMeta(client, Date.now());

    // No learning without skills extracted → counter stays 0.
    await applySkillLearning(client, "update readme", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    let meta = await readSkillLibraryMeta(client);
    expect(meta?.episodesSinceConsolidation).toBe(0);

    // A real learning run counts as one new episode.
    await applySkillLearning(client, "refactor planner.ts and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    meta = await readSkillLibraryMeta(client);
    expect(meta?.episodesSinceConsolidation).toBe(1);
  });

  it("a consolidation failure never breaks the recall read path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new GraphifyClient();
    await seedDuplicateSkills(client);
    const now = Date.now();
    await writeSkillLibraryMeta(client, {
      kind: SKILL_LIBRARY_META_KIND,
      lastConsolidatedAt: now - (SKILL_CONSOLIDATION_MIN_INTERVAL_MS + 1000),
      episodesSinceConsolidation: 0,
      updatedAt: now,
    });

    // applySkillConsolidation throws on every call: the trigger must swallow
    // it and suggestSkillHints (which re-checks the schedule) must still
    // return its hints without refreshing the meta.
    const actual = await vi.importActual<typeof import("../src/learning/skill-consolidate")>(
      "../src/learning/skill-consolidate"
    );
    applySpy.mockImplementation(() => {
      throw new Error("consolidation storage failure");
    });
    try {
      const result = await maybeRunScheduledSkillConsolidation(client);
      expect(result.ran).toBe(false); // failed run reports not-run, never throws
      expect(applySpy).toHaveBeenCalledTimes(1);

      const hints = await suggestSkillHints(client, "refactor planner", 3);
      expect(Array.isArray(hints)).toBe(true);
      expect(hints.length).toBeGreaterThan(0);
      expect(applySpy).toHaveBeenCalledTimes(2); // retried once, failed again, still safe

      // Meta refresh never happened (the write after apply was skipped).
      const meta = await readSkillLibraryMeta(client);
      expect(meta?.lastRun).toBeUndefined();
      expect(meta?.episodesSinceConsolidation).toBe(0);
    } finally {
      applySpy.mockImplementation(actual.applySkillConsolidation);
    }
  });

  it("a storage failure inside apply (deleteNode throwing) survives the read path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    class ExplodingDeleteClient extends GraphifyClient {
      public override async deleteNode(): Promise<void> {
        throw new Error("delete backend down");
      }
    }
    const client = new ExplodingDeleteClient();
    await seedDuplicateSkills(client);
    const now = Date.now();
    await writeSkillLibraryMeta(client, {
      kind: SKILL_LIBRARY_META_KIND,
      lastConsolidatedAt: now - 9 * DAY_MS,
      episodesSinceConsolidation: 0,
      updatedAt: now,
    });

    const hints = await suggestSkillHints(client, "refactor planner", 3);
    expect(Array.isArray(hints)).toBe(true);
    // The failed consolidation did not refresh the schedule.
    const meta = await readSkillLibraryMeta(client);
    expect(meta?.lastRun).toBeUndefined();
  });
});
