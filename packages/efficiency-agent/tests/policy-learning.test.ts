import { describe, expect, it } from "vitest";
import {
  summarizeTrajectories,
  validateTrajectory,
  type CategoryStats,
  type TrajectoryRecord,
} from "../src/learning/trajectory.js";
import { learnPolicy } from "../src/learning/policy-learner.js";
import { createPolicyStore, type KVStore } from "../src/learning/policy-store.js";
import type { PolicyUpdate } from "../src/domain.js";

const record = (overrides?: Partial<TrajectoryRecord>): TrajectoryRecord => ({
  taskId: "task-1",
  taskCategory: "bugfix",
  startedAt: "2026-09-30T00:00:00.000Z",
  decision: { reuseMode: "FRESH", modelTier: "economy" },
  rounds: 1,
  llmCalls: 2,
  toolCalls: 3,
  cacheHits: 1,
  cacheMisses: 1,
  validationPassed: true,
  success: true,
  costMs: 1000,
  costTokens: 2000,
  ...(overrides ?? {}),
});

const stat = (category: string, overrides?: Partial<CategoryStats>): CategoryStats => ({
  category,
  samples: 10,
  successRate: 1,
  avgRounds: 1,
  avgCostMs: 1000,
  cacheHitRate: 0.5,
  failureStages: [],
  ...(overrides ?? {}),
});

const policy = (overrides?: Partial<PolicyUpdate>): PolicyUpdate => ({
  version: 1,
  minSamples: 5,
  modelTierByCategory: {},
  executionModeByCategory: {},
  avoidPatterns: [],
  rationale: [],
  ...(overrides ?? {}),
});

const mapStore = (): KVStore => {
  const map = new Map<string, string>();
  return {
    get: (key: string): string | undefined => map.get(key),
    set: (key: string, value: string): void => {
      map.set(key, value);
    },
  };
};

describe("trajectory validation (P4 gate)", () => {
  it("accepts a clean record", () => {
    expect(validateTrajectory(record())).toEqual([]);
  });

  it("flags missing ids and timestamps", () => {
    const violations = validateTrajectory(
      record({ taskId: "", taskCategory: " ", startedAt: "" })
    );
    expect(violations).toContain("taskId: non-empty string required");
    expect(violations).toContain("taskCategory: non-empty string required");
    expect(violations).toContain("startedAt: non-empty string required");
  });

  it("flags rounds < 1 and negative counts", () => {
    const violations = validateTrajectory(
      record({
        rounds: 0,
        llmCalls: -1,
        toolCalls: -2,
        cacheHits: -3,
        cacheMisses: -4,
        costMs: -5,
        costTokens: -6,
      })
    );
    expect(violations).toContain("rounds: must be >= 1");
    expect(violations).toContain("llmCalls: must be >= 0");
    expect(violations).toContain("toolCalls: must be >= 0");
    expect(violations).toContain("cacheHits: must be >= 0");
    expect(violations).toContain("cacheMisses: must be >= 0");
    expect(violations).toContain("costMs: must be >= 0");
    expect(violations).toContain("costTokens: must be >= 0");
  });

  it("flags non-finite numbers and bad decision enums", () => {
    expect(validateTrajectory(record({ rounds: Number.NaN }))).toContain(
      "rounds: finite number required"
    );
    expect(
      validateTrajectory(
        record({ decision: { reuseMode: "maybe" as "FRESH", modelTier: "economy" } })
      )
    ).toContain("decision.reuseMode: REUSE|ADAPT|FRESH required");
    expect(
      validateTrajectory(
        record({ decision: { reuseMode: "REUSE", modelTier: "ultra" as "heavy" } })
      )
    ).toContain("decision.modelTier: economy|standard|heavy required");
  });
});

describe("summarizeTrajectories (invalid records skipped, deterministic)", () => {
  it("computes rates and averages per category", () => {
    const stats = summarizeTrajectories([
      record({
        taskCategory: "bugfix",
        success: true,
        rounds: 2,
        costMs: 1000,
        cacheHits: 2,
        cacheMisses: 0,
      }),
      record({
        taskCategory: "bugfix",
        success: false,
        rounds: 4,
        costMs: 3000,
        cacheHits: 0,
        cacheMisses: 2,
      }),
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({
      category: "bugfix",
      samples: 2,
      successRate: 0.5,
      avgRounds: 3,
      avgCostMs: 2000,
      cacheHitRate: 0.5,
      failureStages: [],
    });
  });

  it("skips invalid records instead of failing the batch", () => {
    const stats = summarizeTrajectories([
      record({ taskCategory: "docs", rounds: 0 }), // invalid: excluded
      record({ taskCategory: "docs", success: true, costMs: 500 }),
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.samples).toBe(1);
    expect(stats[0]?.avgCostMs).toBe(500);
  });

  it("sorts failure stages by count desc then name, and categories by name", () => {
    const mk = (stage: string): TrajectoryRecord =>
      record({ taskCategory: "refactor", failureStage: stage });
    const stats = summarizeTrajectories([
      mk("z"),
      mk("z"),
      mk("a"),
      mk("a"),
      mk("b"),
      record({ taskCategory: "aaa", success: true }),
    ]);
    expect(stats.map((s) => s.category)).toEqual(["aaa", "refactor"]);
    expect(stats[1]?.failureStages).toEqual([
      { stage: "a", count: 2 },
      { stage: "z", count: 2 },
      { stage: "b", count: 1 },
    ]);
  });

  it("cacheHitRate is 0 with no cache traffic; empty input yields empty output", () => {
    const stats = summarizeTrajectories([
      record({ taskCategory: "query", cacheHits: 0, cacheMisses: 0 }),
    ]);
    expect(stats[0]?.cacheHitRate).toBe(0);
    expect(summarizeTrajectories([])).toEqual([]);
  });

  it("is deterministic across calls", () => {
    const input = [
      record({ taskCategory: "bugfix", success: false, failureStage: "build" }),
      record({ taskCategory: "bugfix", success: true }),
      record({ taskCategory: "docs", rounds: 3 }),
    ];
    expect(summarizeTrajectories(input)).toEqual(summarizeTrajectories(input));
  });
});

describe("learnPolicy: model tier escalation", () => {
  it("escalates economy→standard below 0.7 with minSamples met", () => {
    const update = learnPolicy([stat("bugfix", { successRate: 0.5 })]);
    expect(update).toBeDefined();
    expect(update?.version).toBe(1);
    expect(update?.modelTierByCategory["bugfix"]).toBe("standard");
    expect(
      update?.rationale.some((line) => line.includes("escalate model tier economy→standard"))
    ).toBe(true);
  });

  it("escalates standard→heavy when the current policy pins standard", () => {
    const update = learnPolicy(
      [stat("bugfix", { successRate: 0.6 })],
      policy({ version: 4, modelTierByCategory: { bugfix: "standard" } })
    );
    expect(update?.version).toBe(5);
    expect(update?.modelTierByCategory["bugfix"]).toBe("heavy");
  });

  it("heavy stays heavy even below 0.7", () => {
    const update = learnPolicy(
      [stat("bugfix", { successRate: 0.5 })],
      policy({ modelTierByCategory: { bugfix: "heavy" } })
    );
    expect(update).toBeUndefined();
  });

  it("does NOT escalate with samples < minSamples (default 5)", () => {
    expect(learnPolicy([stat("bugfix", { samples: 4, successRate: 0 })])).toBeUndefined();
  });

  it("honors a lower minSamples override", () => {
    const update = learnPolicy(
      [stat("bugfix", { samples: 2, successRate: 0 })],
      undefined,
      { minSamples: 2 }
    );
    expect(update?.modelTierByCategory["bugfix"]).toBe("standard");
    expect(update?.minSamples).toBe(2);
  });
});

describe("learnPolicy: de-escalation hysteresis", () => {
  const heavy = policy({ modelTierByCategory: { bugfix: "heavy" } });

  it("a single good batch (samples = minSamples) does not flip-flop", () => {
    expect(
      learnPolicy([stat("bugfix", { successRate: 0.95, samples: 5 })], heavy)
    ).toBeUndefined();
  });

  it("de-escalates heavy→standard at >= 0.9 with >= 2×minSamples", () => {
    const update = learnPolicy(
      [stat("bugfix", { successRate: 0.95, samples: 10 })],
      heavy
    );
    expect(update?.modelTierByCategory["bugfix"]).toBe("standard");
    expect(
      update?.rationale.some((line) => line.includes("de-escalate model tier heavy→standard"))
    ).toBe(true);
  });

  it("de-escalates standard→economy under the same hysteresis", () => {
    const update = learnPolicy(
      [stat("bugfix", { successRate: 1, samples: 12 })],
      policy({ modelTierByCategory: { bugfix: "standard" } })
    );
    expect(update?.modelTierByCategory["bugfix"]).toBe("economy");
  });

  it("high sample count alone is not enough below 0.9", () => {
    expect(
      learnPolicy([stat("bugfix", { successRate: 0.85, samples: 20 })], heavy)
    ).toBeUndefined();
  });
});

describe("learnPolicy: execution mode", () => {
  it("switches to loop above 1.5 avg rounds", () => {
    const update = learnPolicy([stat("bugfix", { avgRounds: 2 })]);
    expect(update?.executionModeByCategory["bugfix"]).toBe("loop");
  });

  it("exactly 1.5 is the dead zone (strictly greater wins)", () => {
    expect(learnPolicy([stat("bugfix", { avgRounds: 1.5 })])).toBeUndefined();
  });

  it("reverts loop→one-shot at <= 1.2 with >= 2×minSamples", () => {
    const update = learnPolicy(
      [stat("bugfix", { avgRounds: 1, samples: 10 })],
      policy({ executionModeByCategory: { bugfix: "loop" } })
    );
    expect(update?.executionModeByCategory["bugfix"]).toBe("one-shot");
  });

  it("revert needs 2×minSamples — a compact batch keeps loop", () => {
    const update = learnPolicy(
      [stat("bugfix", { avgRounds: 1, samples: 5 })],
      policy({ executionModeByCategory: { bugfix: "loop" } })
    );
    expect(update).toBeUndefined();
  });

  it("the 1.2–1.5 dead zone keeps the current mode untouched", () => {
    expect(
      learnPolicy(
        [stat("bugfix", { avgRounds: 1.3, samples: 20 })],
        policy({ executionModeByCategory: { bugfix: "loop" } })
      )
    ).toBeUndefined();
  });
});

describe("learnPolicy: avoid patterns", () => {
  it("adds a pattern when a failure stage covers >= 30% of samples", () => {
    const update = learnPolicy([
      stat("bugfix", {
        successRate: 0.6,
        failureStages: [
          { stage: "validate", count: 3 },
          { stage: "plan", count: 2 },
        ],
      }),
    ]);
    expect(update?.avoidPatterns).toEqual(["avoid:bugfix:validate"]);
    expect(update?.rationale.some((line) => line.includes("avoid pattern avoid:bugfix:validate"))).toBe(
      true
    );
  });

  it("ignores stages below 30% and unions + dedups + sorts with current", () => {
    const update = learnPolicy(
      [
        stat("bugfix", {
          successRate: 0.5,
          failureStages: [
            { stage: "validate", count: 3 },
            { stage: "plan", count: 2 },
          ],
        }),
      ],
      policy({
        avoidPatterns: ["avoid:bugfix:validate", "avoid:docs:lint"],
      })
    );
    expect(update?.avoidPatterns).toEqual([
      "avoid:bugfix:validate",
      "avoid:docs:lint",
    ]);
    // already-known pattern adds no avoid line; "plan" at 20% never joins.
    expect(update?.rationale.some((line) => line.includes("avoid pattern"))).toBe(false);
    expect(update?.rationale.some((line) => line.includes("escalate"))).toBe(true);
  });

  it("patterns ride along from current even when the category is absent now", () => {
    const update = learnPolicy(
      [stat("bugfix", { successRate: 0.5 })],
      policy({ avoidPatterns: ["avoid:docs:lint"] })
    );
    expect(update?.avoidPatterns).toEqual(["avoid:docs:lint"]);
  });
});

describe("learnPolicy: no-change and copying", () => {
  it("returns undefined for empty stats", () => {
    expect(learnPolicy([])).toBeUndefined();
  });

  it("returns undefined when a healthy category warrants nothing", () => {
    expect(learnPolicy([stat("docs")])).toBeUndefined();
  });

  it("copies unchanged entries from current and bumps version by 1", () => {
    const current = policy({
      version: 7,
      minSamples: 5,
      modelTierByCategory: { docs: "heavy", bugfix: "standard" },
      executionModeByCategory: { docs: "loop" },
      avoidPatterns: ["avoid:docs:lint"],
      rationale: ["old line"],
    });
    const update = learnPolicy([stat("bugfix", { successRate: 0.5 })], current);
    expect(update?.version).toBe(8);
    expect(update?.modelTierByCategory["docs"]).toBe("heavy");
    expect(update?.modelTierByCategory["bugfix"]).toBe("heavy"); // standard→heavy
    expect(update?.executionModeByCategory["docs"]).toBe("loop");
    expect(update?.avoidPatterns).toEqual(["avoid:docs:lint"]);
    expect(update?.rationale).toHaveLength(1);
  });

  it("records a minSamples change when the override differs from current", () => {
    const update = learnPolicy(
      [stat("bugfix", { successRate: 0.5 })],
      policy({ minSamples: 5 }),
      { minSamples: 3 }
    );
    expect(update?.minSamples).toBe(3);
    expect(update?.rationale.some((line) => line.includes("minSamples: 5→3"))).toBe(true);
  });
});

describe("learnPolicy: determinism", () => {
  it("same inputs produce deep-equal outputs", () => {
    const stats = [
      stat("bugfix", { successRate: 0.4, avgRounds: 2, failureStages: [{ stage: "build", count: 4 }] }),
      stat("docs", { successRate: 0.95, samples: 20 }),
      stat("query", { samples: 2, successRate: 0 }),
    ];
    const current = policy({
      modelTierByCategory: { docs: "heavy" },
      executionModeByCategory: { query: "loop" },
      avoidPatterns: ["avoid:query:plan"],
    });
    expect(learnPolicy(stats, current)).toEqual(learnPolicy(stats, current));
  });
});

describe("policy store (append-only, versioned)", () => {
  it("current() is undefined before any apply (documented default)", () => {
    expect(createPolicyStore(mapStore()).current()).toBeUndefined();
    expect(createPolicyStore(mapStore()).history()).toEqual([]);
  });

  it("applies monotonic versions and refuses stale or equal ones", () => {
    const store = createPolicyStore(mapStore());
    store.apply(policy({ version: 1 }));
    store.apply(policy({ version: 2 }));
    expect(store.current()?.version).toBe(2);
    expect(() => store.apply(policy({ version: 1 }))).toThrow(/<= current 2/);
    expect(() => store.apply(policy({ version: 2 }))).toThrow(/refusing version 2/);
    store.apply(policy({ version: 3 }));
    expect(store.current()?.version).toBe(3);
  });

  it("refuses non-positive-integer versions outright", () => {
    const store = createPolicyStore(mapStore());
    expect(() => store.apply(policy({ version: 0 }))).toThrow(/positive integer/);
  });

  it("history grows in apply order", () => {
    const store = createPolicyStore(mapStore());
    store.apply(policy({ version: 1, rationale: ["one"] }));
    store.apply(policy({ version: 2, rationale: ["two"] }));
    expect(store.history().map((p) => p.version)).toEqual([1, 2]);
    expect(store.history()[1]?.rationale).toEqual(["two"]);
  });

  it("rollback restores the previous content with version bumped by 1", () => {
    const store = createPolicyStore(mapStore());
    const v1 = policy({
      version: 1,
      modelTierByCategory: { bugfix: "standard" },
      rationale: ["one"],
    });
    const v2 = policy({
      version: 2,
      modelTierByCategory: { bugfix: "heavy" },
      rationale: ["two"],
    });
    store.apply(v1);
    store.apply(v2);

    const rolled = store.rollback();
    expect(rolled).toBeDefined();
    expect(rolled?.version).toBe(3);
    expect(rolled?.modelTierByCategory).toEqual({ bugfix: "standard" });
    expect(rolled?.rationale).toEqual(["one"]);
    expect(store.current()?.version).toBe(3);
    // rollback is itself an append; history never rewrites.
    expect(store.history().map((p) => p.version)).toEqual([1, 2, 3]);
    // a second rollback restores v2's content, again bumped.
    expect(store.rollback()?.modelTierByCategory).toEqual({ bugfix: "heavy" });
    expect(store.current()?.version).toBe(4);
  });

  it("rollback returns undefined when there is nothing to roll back to", () => {
    const empty = createPolicyStore(mapStore());
    expect(empty.rollback()).toBeUndefined();
    const store = createPolicyStore(mapStore());
    store.apply(policy({ version: 1 }));
    expect(store.rollback()).toBeUndefined();
  });

  it("round-trips through the injected KV port (no aliasing)", () => {
    const kv = mapStore();
    const store = createPolicyStore(kv);
    const input = policy({
      version: 1,
      modelTierByCategory: { bugfix: "heavy" },
      executionModeByCategory: { bugfix: "loop" },
      avoidPatterns: ["avoid:bugfix:build"],
      rationale: ["line"],
    });
    const applied = store.apply(input);
    expect(applied).toEqual(input);
    expect(applied).not.toBe(input);
    expect(kv.get("policy-current")).toBeDefined();
    expect(kv.get("policy-history")).toBeDefined();
  });
});

describe("pipeline: trajectories → stats → policy → store", () => {
  it("a struggling category escalates, persists, and stays deterministic", () => {
    const records: TrajectoryRecord[] = [
      ...Array.from({ length: 6 }, (_, i): TrajectoryRecord =>
        record({
          taskId: `t-${i}`,
          taskCategory: "bugfix",
          success: i < 3,
          rounds: 2,
          failureStage: i < 3 ? "validate" : undefined,
        })
      ),
    ];
    const stats = summarizeTrajectories(records);
    expect(stats[0]?.samples).toBe(6);
    expect(stats[0]?.successRate).toBe(0.5);

    const update = learnPolicy(stats);
    expect(update?.modelTierByCategory["bugfix"]).toBe("standard");
    expect(update?.executionModeByCategory["bugfix"]).toBe("loop");
    expect(update?.avoidPatterns).toEqual(["avoid:bugfix:validate"]);

    const store = createPolicyStore(mapStore());
    if (update === undefined) {
      throw new Error("expected learnPolicy to produce an update");
    }
    store.apply(update);
    expect(store.current()).toEqual(update);
    expect(learnPolicy(summarizeTrajectories(records))).toEqual(update);
  });
});
