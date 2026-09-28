import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_CACHEABLE_TOKENS,
  assessAttentionBudget,
  buildContextEconomics,
  computePrefixChurn,
  estimateCacheModel,
  estimateInputCost,
  isAbstentionEnabled,
  isContextEconomicsEnabled,
  resolveStaticPrefixTokens,
  resolveSuffixTokens,
  shouldAbstain,
} from "../src/graph/context-economics";

describe("context economics", () => {
  it("measures prefix churn and labels the first observation", () => {
    expect(computePrefixChurn(["a", "b"], ["a", "b"]).churnRatio).toBe(0);
    expect(computePrefixChurn(["a", "b"], ["a", "b"]).firstObservation).toBe(false);
    const diverged = computePrefixChurn(["a", "b", "c"], ["a", "x", "c"]);
    expect(diverged.sharedPrefix).toBe(1);
    expect(diverged.churnRatio).toBeCloseTo(2 / 3);
    const first = computePrefixChurn([], ["a"]);
    expect(first.churnRatio).toBe(1);
    expect(first.firstObservation).toBe(true);
  });

  it("refuses to model a cache below the provider minimum", () => {
    const tooSmall = estimateCacheModel({ prefixTokens: 500, churnTokens: 10 });
    expect(tooSmall.cacheUsable).toBe(false);
    expect(tooSmall.cachedTokens).toBe(0);
    expect(tooSmall.note).toContain(String(DEFAULT_MIN_CACHEABLE_TOKENS));
  });

  it("splits cacheable prefix from post-divergence tokens", () => {
    const model = estimateCacheModel({ prefixTokens: 20_000, churnTokens: 4_000 });
    expect(model.cacheUsable).toBe(true);
    expect(model.cachedTokens).toBe(16_000);
    expect(model.freshTokens).toBe(4_000);
    expect(model.hitRate).toBeCloseTo(0.8);
  });

  it("prices a cache hit and charges the write premium", () => {
    const cost = estimateInputCost({ freshTokens: 4_000, cachedTokens: 16_000, pricePerMTokIn: 3 });
    expect(cost.baselineUsd).toBeCloseTo(0.06);
    // 4k fresh + 16k*0.1 read + 16k*(1.25-1) write premium
    expect(cost.actualUsd).toBeCloseTo(0.012 + 0.0048 + 0.012);
    expect(cost.cacheWriteTaxUsd).toBeCloseTo(0.012);
    expect(cost.savedUsd).toBeGreaterThan(0);
  });

  it("grades the attention budget against the rot threshold", () => {
    expect(assessAttentionBudget({ usedTokens: 1_000, windowTokens: 100_000 }).level).toBe("ok");
    expect(assessAttentionBudget({ usedTokens: 50_000, windowTokens: 100_000 }).level).toBe("watch");
    expect(assessAttentionBudget({ usedTokens: 65_000, windowTokens: 100_000 }).level).toBe("high");
    const critical = assessAttentionBudget({ usedTokens: 90_000, windowTokens: 100_000 });
    expect(critical.level).toBe("critical");
    expect(critical.note).toContain("clear before you summarize");
  });

  it("abstains only on a small corpus with a concrete ref and a small package", () => {
    const base = { repoNodeCount: 800, queryHasConcreteRef: true, estimatedPackageTokens: 200 };
    expect(shouldAbstain(base).abstain).toBe(true);
    expect(shouldAbstain({ ...base, repoNodeCount: 50_000 }).abstain).toBe(false);
    expect(shouldAbstain({ ...base, queryHasConcreteRef: false }).abstain).toBe(false);
    expect(shouldAbstain({ ...base, estimatedPackageTokens: 2_000 }).abstain).toBe(false);
    expect(shouldAbstain(base).reason).toContain("keeps the prefix stable");
  });

  it("reads opt-in switches", () => {
    expect(isContextEconomicsEnabled({})).toBe(false);
    expect(isContextEconomicsEnabled({ GRAPHFLOW_CONTEXT_ECONOMICS: "1" })).toBe(true);
    expect(isAbstentionEnabled({ GRAPHFLOW_ABSTAIN: "yes" })).toBe(true);
    expect(isAbstentionEnabled({ GRAPHFLOW_ABSTAIN: "0" })).toBe(false);
  });
});

describe("buildContextEconomics", () => {
  it("calls a stable prefix cache-safe and a churning one not", () => {
    const lines = ["summary-1", "anchor:file:a.ts", "anchor:symbol:b.ts"];
    const stable = buildContextEconomics({
      previousLines: lines,
      currentLines: lines,
      packageTokens: 8_000,
    });
    expect(stable.churn.churnRatio).toBe(0);
    expect(stable.verdict).toBe("cache-safe");
    expect(stable.stablePrefixTokens).toBe(8_000);

    const churned = buildContextEconomics({
      previousLines: ["summary-1", "anchor:file:old.ts"],
      currentLines: ["summary-1", "anchor:file:new.ts"],
      packageTokens: 8_000,
    });
    expect(churned.churn.churnRatio).toBeGreaterThan(0);
    expect(churned.verdict).toBe("prefix-churn");
    // A real savings number must not be able to hide a cold prefix.
    expect(churned.stablePrefixTokens).toBeLessThan(8_000);
  });

  it("marks a sub-minimum package cache-cold only when it IS the whole prefix", () => {
    const cold = buildContextEconomics({ previousLines: ["a"], currentLines: ["a"], packageTokens: 200 });
    expect(cold.verdict).toBe("cache-cold");
    expect(cold.cache.cacheUsable).toBe(false);
    expect(cold.attention.level).toBe("ok");

    // A real harness prefix (system + tools) puts us above the provider minimum,
    // so the cache IS usable even though our slice alone is tiny.
    const hosted = buildContextEconomics({
      previousLines: ["a"],
      currentLines: ["a"],
      packageTokens: 529,
      staticPrefixTokens: 8_000,
    });
    expect(hosted.cache.cacheUsable).toBe(true);
    expect(hosted.verdict).toBe("cache-safe");
    // The whole prefix survives: 8000 static + 529 unchurned package.
    expect(hosted.stablePrefixTokens).toBe(8_529);
    expect(hosted.cache.hitRate).toBe(1);
  });

  it("reads the static-prefix estimate and ignores invalid values", () => {
    expect(resolveStaticPrefixTokens({})).toBe(0);
    expect(resolveStaticPrefixTokens({ GRAPHFLOW_STATIC_PREFIX_TOKENS: "8000" })).toBe(8_000);
    expect(resolveStaticPrefixTokens({ GRAPHFLOW_STATIC_PREFIX_TOKENS: "abc" })).toBe(0);
    expect(resolveStaticPrefixTokens({ GRAPHFLOW_STATIC_PREFIX_TOKENS: "-5" })).toBe(0);
  });

  it("prices the host's tail, not just our own slice, when we churn it", () => {
    // Our slice is 500 tok churning 97%; the host sends 50k tok of history
    // after us. The premium is 1.25x - 0.1x = 1.15x on the rewritten tail.
    const econ = buildContextEconomics({
      previousLines: Array.from({ length: 36 }, (_, i) => `a${i}`),
      currentLines: Array.from({ length: 36 }, (_, i) => (i === 0 ? "a0" : `b${i}`)),
      packageTokens: 500,
      staticPrefixTokens: 8_000,
      suffixTokens: 50_000,
      pricePerMTokIn: 2,
    });
    const expectedRewritten = econ.invalidation.rewrittenTokens;
    expect(expectedRewritten).toBeGreaterThan(48_000);
    expect(econ.churn.churnRatio).toBeCloseTo(35 / 36, 5);
    expect(econ.invalidation.surchargeUsd).toBeCloseTo((expectedRewritten * 1.15 * 2) / 1_000_000, 8);
    expect(econ.invalidation.surchargeUsd).toBeGreaterThan(econ.invalidation.savedUsd);
    expect(econ.invalidation.overspendUsd).toBeGreaterThan(0);
    expect(econ.verdict).toBe("cache-break");
  });

  it("does not invent a churn surcharge on the first observation", () => {
    const econ = buildContextEconomics({
      previousLines: [],
      currentLines: ["a", "b"],
      packageTokens: 500,
      suffixTokens: 50_000,
    });
    expect(econ.invalidation.rewrittenTokens).toBe(0);
    expect(econ.invalidation.surchargeUsd).toBe(0);
    expect(econ.invalidation.note).toContain("first observation");
    expect(econ.verdict).not.toBe("cache-break");
  });

  it("stays net-positive when the tail is small or the slice is stable", () => {
    const stable = buildContextEconomics({
      previousLines: ["a"],
      currentLines: ["a"],
      packageTokens: 500,
      staticPrefixTokens: 8_000,
      suffixTokens: 50_000,
    });
    expect(stable.invalidation.rewrittenTokens).toBe(0);
    // Static prefix clears the provider minimum, so the stable case is a real
    // hit, not the cache-cold no-op the 500 tok slice alone would report.
    expect(stable.cache.cacheUsable).toBe(true);
    expect(stable.verdict).toBe("cache-safe");

    // A tail too small to notice, but compression still has to pay for itself:
    // with no static prefix the package saves nothing, so any surcharge is a
    // loss. Churn only stays `prefix-churn` when compression actually won.
    const tinyTail = buildContextEconomics({
      previousLines: ["a", "b"],
      currentLines: ["a", "z"],
      packageTokens: 500,
      staticPrefixTokens: 8_000,
      suffixTokens: 200,
    });
    expect(tinyTail.invalidation.rewrittenTokens).toBe(100);
    expect(tinyTail.invalidation.overspendUsd).toBeLessThan(0);
    expect(tinyTail.verdict).toBe("prefix-churn");
  });

  it("sweeps the unknown host size so the verdict is not one hand-filled number", () => {
    // The host's tail is not observable from here. Reporting a verdict derived
    // from one operator-supplied value is a claim, not a measurement — so the
    // economics sweep the plausible range and say whether the answer holds.
    const stable = buildContextEconomics({
      previousLines: ["a"],
      currentLines: ["a"],
      packageTokens: 500,
      staticPrefixTokens: 8_000,
      suffixTokens: 50_000,
    });
    expect(stable.sensitivity.points.length).toBeGreaterThanOrEqual(5);
    // No churn: net is positive (or zero) at every size, so the answer holds.
    expect(stable.sensitivity.breakEvenSuffixTokens).toBeNull();
    expect(stable.sensitivity.conclusionIsRobust).toBe(true);

    const churning = buildContextEconomics({
      previousLines: Array.from({ length: 36 }, (_, i) => `a${i}`),
      currentLines: Array.from({ length: 36 }, (_, i) => (i === 0 ? "a0" : `b${i}`)),
      packageTokens: 500,
      staticPrefixTokens: 8_000,
      suffixTokens: 50_000,
    });
    // With churn the small tails are fine and the large ones are not: that is a
    // genuine flip, and the report has to say so rather than pick a side.
    expect(churning.sensitivity.breakEvenSuffixTokens).not.toBeNull();
    expect(churning.sensitivity.conclusionIsRobust).toBe(false);
    expect(churning.sensitivity.note).toContain("flips");
  });

  it("reads the suffix estimate and ignores invalid values", () => {
    expect(resolveSuffixTokens({})).toBe(0);
    expect(resolveSuffixTokens({ GRAPHFLOW_SUFFIX_TOKENS: "50000" })).toBe(50_000);
    expect(resolveSuffixTokens({ GRAPHFLOW_SUFFIX_TOKENS: "abc" })).toBe(0);
    expect(resolveSuffixTokens({ GRAPHFLOW_SUFFIX_TOKENS: "-1" })).toBe(0);
  });
});
