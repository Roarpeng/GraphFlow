import { describe, expect, it } from "vitest";
import {
  canaryBucket,
  createPolicyLifecycle,
  LIFECYCLE_KEY,
  type PolicyLifecycle,
} from "../src/learning/policy-lifecycle.js";
import { createPolicyStore, type KVStore } from "../src/learning/policy-store.js";
import type { PolicyUpdate } from "../src/domain.js";

const memoryStore = (): KVStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value);
    },
  };
};

const policy = (version: number, overrides?: Partial<PolicyUpdate>): PolicyUpdate => ({
  version,
  minSamples: 3,
  modelTierByCategory: { bugfix: "standard" },
  executionModeByCategory: { bugfix: "loop" },
  avoidPatterns: [],
  rationale: [`v${version}: bugfix economy -> standard`],
  ...(overrides ?? {}),
});

const runShadow = (lifecycle: PolicyLifecycle, runs: number, disagreements = 0): void => {
  for (let i = 0; i < runs; i += 1) lifecycle.recordShadow(i < disagreements);
};

const runCanary = (
  lifecycle: PolicyLifecycle,
  canary: { runs: number; successes: number },
  baseline: { runs: number; successes: number }
): void => {
  for (let i = 0; i < canary.runs; i += 1) lifecycle.recordOutcome("canary", i < canary.successes);
  for (let i = 0; i < baseline.runs; i += 1) lifecycle.recordOutcome("baseline", i < baseline.successes);
};

describe("policy lifecycle: evidence gate", () => {
  it("rejects an update with empty rationale", () => {
    const lifecycle = createPolicyLifecycle(memoryStore());
    const result = lifecycle.propose(policy(1, { rationale: [] }), 100);
    expect(result.stage).toBe("rejected");
    expect(result.history).toEqual([
      { at: 100, from: "candidate", to: "rejected", reason: expect.stringMatching(/empty rationale/) },
    ]);
    expect(lifecycle.staged()).toBeUndefined();
    expect(lifecycle.propose(policy(1, { rationale: ["   "] }), 100).stage).toBe("rejected");
  });

  it("rejects an update whose version is not above production", () => {
    const store = memoryStore();
    createPolicyStore(store).apply(policy(3));
    const lifecycle = createPolicyLifecycle(store);
    const equal = lifecycle.propose(policy(3), 1);
    expect(equal.stage).toBe("rejected");
    expect(equal.history[0]?.reason).toMatch(/version 3 <= production version 3/);
    expect(lifecycle.propose(policy(2), 1).stage).toBe("rejected");
    expect(lifecycle.propose(policy(0), 1).stage).toBe("rejected");
    expect(lifecycle.propose(policy(3.5), 1).stage).toBe("rejected");
    expect(lifecycle.staged()).toBeUndefined();
  });

  it("does not disturb an in-flight policy when a proposal is rejected", () => {
    const lifecycle = createPolicyLifecycle(memoryStore());
    lifecycle.propose(policy(1), 1);
    lifecycle.propose(policy(2, { rationale: [] }), 2);
    expect(lifecycle.staged()?.update.version).toBe(1);
  });

  it("an accepted proposal enters shadow immediately and replaces any in-flight candidate", () => {
    const lifecycle = createPolicyLifecycle(memoryStore());
    const first = lifecycle.propose(policy(1), 10);
    expect(first.stage).toBe("shadow");
    expect(first.createdAt).toBe(10);
    expect(first.history).toEqual([{ at: 10, from: "candidate", to: "shadow", reason: "evidence gate passed" }]);
    expect(first.evidence).toEqual({
      shadowRuns: 0,
      shadowDisagreements: 0,
      canaryRuns: 0,
      canarySuccesses: 0,
      baselineRuns: 0,
      baselineSuccesses: 0,
    });
    runShadow(lifecycle, 2);
    const second = lifecycle.propose(policy(2), 20);
    expect(second.history[0]?.reason).toMatch(/supersedes in-flight v1 in shadow/);
    const staged = lifecycle.staged();
    expect(staged?.update.version).toBe(2);
    expect(staged?.evidence.shadowRuns).toBe(0);
  });
});

describe("policy lifecycle: shadow -> canary -> production", () => {
  it("promotes through the policy store with a monotonic version", () => {
    const store = memoryStore();
    createPolicyStore(store).apply(policy(1));
    const lifecycle = createPolicyLifecycle(store, { minShadowRuns: 3, minCanaryRuns: 4 });
    expect(lifecycle.evaluate(0)).toEqual({ stage: "none", reason: "no staged policy" });

    lifecycle.propose(policy(2), 100);
    runShadow(lifecycle, 2, 1);
    expect(lifecycle.evaluate(110)).toEqual({ stage: "shadow", reason: "shadow 2/3 runs" });
    runShadow(lifecycle, 1);
    const toCanary = lifecycle.evaluate(120);
    expect(toCanary.stage).toBe("canary");
    expect(toCanary.reason).toMatch(/3 runs, 1 disagreements/);
    expect(lifecycle.staged()?.stage).toBe("canary");
    expect(lifecycle.staged()?.evidence.shadowDisagreements).toBe(1);

    runCanary(lifecycle, { runs: 3, successes: 3 }, { runs: 2, successes: 1 });
    expect(lifecycle.evaluate(130).stage).toBe("canary");
    runCanary(lifecycle, { runs: 1, successes: 1 }, { runs: 0, successes: 0 });

    const promoted = lifecycle.evaluate(140);
    expect(promoted.stage).toBe("production");
    expect(promoted.promoted?.version).toBe(2);
    expect(promoted.reason).toBe("proven: canary 4/4 vs baseline 1/2");
    expect(lifecycle.production()?.version).toBe(2);
    expect(createPolicyStore(store).history().map((p) => p.version)).toEqual([1, 2]);
    expect(lifecycle.staged()).toBeUndefined();
    expect(lifecycle.antiPatterns()).toEqual([]);
    expect(lifecycle.evaluate(150).stage).toBe("none");

    const history = (JSON.parse(store.data.get(LIFECYCLE_KEY)!) as { staged?: unknown }).staged;
    expect(history).toBeUndefined();
  });

  it("promotes on a tie (canary success rate == baseline)", () => {
    const lifecycle = createPolicyLifecycle(memoryStore(), { minShadowRuns: 1, minCanaryRuns: 2 });
    lifecycle.propose(policy(1), 0);
    runShadow(lifecycle, 1);
    lifecycle.evaluate(1);
    runCanary(lifecycle, { runs: 2, successes: 1 }, { runs: 4, successes: 2 });
    expect(lifecycle.evaluate(2).stage).toBe("production");
    expect(lifecycle.production()?.version).toBe(1);
  });

  it("waits for at least one baseline run before deciding", () => {
    const lifecycle = createPolicyLifecycle(memoryStore(), { minShadowRuns: 1, minCanaryRuns: 1 });
    lifecycle.propose(policy(1), 0);
    runShadow(lifecycle, 1);
    lifecycle.evaluate(1);
    runCanary(lifecycle, { runs: 10, successes: 10 }, { runs: 0, successes: 0 });
    const result = lifecycle.evaluate(2);
    expect(result.stage).toBe("canary");
    expect(result.reason).toBe("canary 10/1 runs, baseline 0/1 runs");
  });

  it("uses the documented defaults (5 shadow runs, 5 canary runs)", () => {
    const lifecycle = createPolicyLifecycle(memoryStore());
    lifecycle.propose(policy(1), 0);
    runShadow(lifecycle, 4);
    expect(lifecycle.evaluate(1).stage).toBe("shadow");
    runShadow(lifecycle, 1);
    expect(lifecycle.evaluate(2).stage).toBe("canary");
    runCanary(lifecycle, { runs: 4, successes: 4 }, { runs: 1, successes: 1 });
    expect(lifecycle.evaluate(3).stage).toBe("canary");
    runCanary(lifecycle, { runs: 1, successes: 1 }, { runs: 0, successes: 0 });
    expect(lifecycle.evaluate(4).stage).toBe("production");
  });

  it("rejects promotion when production moved past the staged version meanwhile", () => {
    const store = memoryStore();
    const lifecycle = createPolicyLifecycle(store, { minShadowRuns: 1, minCanaryRuns: 1 });
    lifecycle.propose(policy(2), 0);
    runShadow(lifecycle, 1);
    lifecycle.evaluate(1);
    createPolicyStore(store).apply(policy(5));
    runCanary(lifecycle, { runs: 1, successes: 1 }, { runs: 1, successes: 1 });
    const result = lifecycle.evaluate(2);
    expect(result.stage).toBe("rejected");
    expect(result.reason).toMatch(/promotion refused by policy store/);
    expect(lifecycle.production()?.version).toBe(5);
    expect(lifecycle.staged()).toBeUndefined();
  });
});

describe("policy lifecycle: anti-patterns", () => {
  it("rejects a canary that underperforms the baseline and keeps its patterns", () => {
    const store = memoryStore();
    createPolicyStore(store).apply(policy(1));
    const lifecycle = createPolicyLifecycle(store, { minShadowRuns: 1, minCanaryRuns: 3 });
    lifecycle.propose(policy(2, { rationale: ["refactor: one-shot -> loop", "bugfix: economy -> heavy"] }), 0);
    runShadow(lifecycle, 1);
    lifecycle.evaluate(1);
    runCanary(lifecycle, { runs: 3, successes: 1 }, { runs: 3, successes: 3 });
    const result = lifecycle.evaluate(2);
    expect(result).toEqual({ stage: "rejected", reason: "anti-pattern: canary 1/3 vs baseline 3/3" });
    expect(result.promoted).toBeUndefined();
    expect(lifecycle.antiPatterns()).toEqual(["refactor: one-shot -> loop", "bugfix: economy -> heavy"]);
    expect(lifecycle.production()?.version).toBe(1);
    expect(lifecycle.staged()).toBeUndefined();

    // Anti-patterns accumulate (deduplicated) across rejections.
    lifecycle.propose(policy(3, { rationale: ["bugfix: economy -> heavy", "docs: standard -> economy"] }), 3);
    runShadow(lifecycle, 1);
    lifecycle.evaluate(4);
    runCanary(lifecycle, { runs: 3, successes: 0 }, { runs: 1, successes: 1 });
    expect(lifecycle.evaluate(5).stage).toBe("rejected");
    expect(lifecycle.antiPatterns()).toEqual([
      "refactor: one-shot -> loop",
      "bugfix: economy -> heavy",
      "docs: standard -> economy",
    ]);
  });
});

describe("policy lifecycle: canary bucketing", () => {
  it("is deterministic per task id and only active during canary", () => {
    const lifecycle = createPolicyLifecycle(memoryStore(), { minShadowRuns: 1 });
    expect(lifecycle.inCanary("task-1")).toBe(false);
    lifecycle.propose(policy(1), 0);
    const ids = Array.from({ length: 1000 }, (_, i) => `task-${i}`);
    expect(ids.some((id) => lifecycle.inCanary(id))).toBe(false); // shadow: nobody in canary
    runShadow(lifecycle, 1);
    lifecycle.evaluate(1);
    const first = ids.map((id) => lifecycle.inCanary(id));
    const second = ids.map((id) => lifecycle.inCanary(id));
    expect(first).toEqual(second);
    ids.forEach((id, i) => expect(first[i]).toBe(canaryBucket(id) < 0.2));
    const share = first.filter(Boolean).length / ids.length;
    expect(share).toBeGreaterThan(0.16);
    expect(share).toBeLessThan(0.24);
  });

  it("honours a custom canary fraction", () => {
    const lifecycle = createPolicyLifecycle(memoryStore(), { minShadowRuns: 1, canaryFraction: 0.5 });
    lifecycle.propose(policy(1), 0);
    runShadow(lifecycle, 1);
    lifecycle.evaluate(1);
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    const share = ids.filter((id) => lifecycle.inCanary(id)).length / ids.length;
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
  });

  it("canaryBucket is a stable value in [0, 1)", () => {
    expect(canaryBucket("abc")).toBe(canaryBucket("abc"));
    for (let i = 0; i < 200; i += 1) {
      const bucket = canaryBucket(`x${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(1);
    }
  });
});

describe("policy lifecycle: rollback", () => {
  it("restores the previous production policy and clears the staged policy", () => {
    const store = memoryStore();
    const lifecycle = createPolicyLifecycle(store, { minShadowRuns: 1, minCanaryRuns: 1 });
    const promote = (version: number, rationale: string): void => {
      lifecycle.propose(policy(version, { rationale: [rationale] }), version);
      runShadow(lifecycle, 1);
      lifecycle.evaluate(version);
      runCanary(lifecycle, { runs: 1, successes: 1 }, { runs: 1, successes: 1 });
      expect(lifecycle.evaluate(version).stage).toBe("production");
    };
    promote(1, "first");
    promote(2, "second");
    lifecycle.propose(policy(3), 3);
    expect(lifecycle.staged()).toBeDefined();

    const restored = lifecycle.rollback();
    expect(restored?.version).toBe(3);
    expect(restored?.rationale).toEqual(["first"]);
    expect(lifecycle.production()).toEqual(restored);
    expect(lifecycle.staged()).toBeUndefined();
  });

  it("returns undefined when there is nothing to roll back to", () => {
    const lifecycle = createPolicyLifecycle(memoryStore());
    lifecycle.propose(policy(1), 0);
    expect(lifecycle.rollback()).toBeUndefined();
    expect(lifecycle.staged()).toBeUndefined();
  });
});

describe("policy lifecycle: robustness", () => {
  it("treats corrupt lifecycle JSON as no staged policy without throwing", () => {
    const store = memoryStore();
    store.set(LIFECYCLE_KEY, "{not json");
    const lifecycle = createPolicyLifecycle(store);
    expect(lifecycle.staged()).toBeUndefined();
    expect(lifecycle.antiPatterns()).toEqual([]);
    expect(lifecycle.evaluate(0).stage).toBe("none");
    expect(() => lifecycle.recordShadow(true)).not.toThrow();
    expect(() => lifecycle.recordOutcome("canary", true)).not.toThrow();
    expect(lifecycle.inCanary("t")).toBe(false);
    expect(lifecycle.propose(policy(1), 1).stage).toBe("shadow");
    expect(lifecycle.staged()?.update.version).toBe(1);
  });

  it("ignores malformed staged entries but keeps valid anti-patterns", () => {
    const store = memoryStore();
    store.set(
      LIFECYCLE_KEY,
      JSON.stringify({ staged: { stage: "canary", update: { version: "x" } }, antiPatterns: ["keep", 7] })
    );
    const lifecycle = createPolicyLifecycle(store);
    expect(lifecycle.staged()).toBeUndefined();
    expect(lifecycle.antiPatterns()).toEqual(["keep"]);
    store.set(LIFECYCLE_KEY, "null");
    expect(lifecycle.staged()).toBeUndefined();
    store.set(LIFECYCLE_KEY, "[1,2]");
    expect(lifecycle.antiPatterns()).toEqual([]);
  });

  it("recordShadow and recordOutcome are no-ops in the wrong stage", () => {
    const store = memoryStore();
    const lifecycle = createPolicyLifecycle(store, { minShadowRuns: 1 });
    lifecycle.recordShadow(true);
    lifecycle.recordOutcome("canary", true);
    expect(store.data.has(LIFECYCLE_KEY)).toBe(false);

    lifecycle.propose(policy(1), 0);
    lifecycle.recordOutcome("canary", true);
    lifecycle.recordOutcome("baseline", false);
    expect(lifecycle.staged()?.evidence.canaryRuns).toBe(0);
    expect(lifecycle.staged()?.evidence.baselineRuns).toBe(0);

    lifecycle.recordShadow(false);
    lifecycle.evaluate(1);
    expect(lifecycle.staged()?.stage).toBe("canary");
    lifecycle.recordShadow(true);
    expect(lifecycle.staged()?.evidence.shadowRuns).toBe(1);
    expect(lifecycle.staged()?.evidence.shadowDisagreements).toBe(0);
  });

  it("state survives a fresh lifecycle instance over the same store", () => {
    const store = memoryStore();
    const a = createPolicyLifecycle(store, { minShadowRuns: 2 });
    a.propose(policy(1), 0);
    a.recordShadow(true);
    const b = createPolicyLifecycle(store, { minShadowRuns: 2 });
    b.recordShadow(false);
    expect(b.evaluate(1).stage).toBe("canary");
    expect(a.staged()?.stage).toBe("canary");
    expect(a.staged()?.evidence).toMatchObject({ shadowRuns: 2, shadowDisagreements: 1 });
    expect(a.staged()?.history.map((h) => `${h.from}->${h.to}`)).toEqual(["candidate->shadow", "shadow->canary"]);
  });
});
