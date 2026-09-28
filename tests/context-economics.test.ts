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
  shouldAbstain,
} from "../src/graph/context-economics";

describe("context economics", () => {
  it("measures prefix churn", () => {
    expect(computePrefixChurn(["a", "b"], ["a", "b"]).churnRatio).toBe(0);
    expect(computePrefixChurn(["a", "b", "c"], ["a", "b", "c", "d"]).churnRatio).toBe(0);
    const diverged = computePrefixChurn(["a", "b", "c"], ["a", "x", "c"]);
    expect(diverged.sharedPrefix).toBe(1);
    expect(diverged.churnRatio).toBeCloseTo(2 / 3);
    expect(computePrefixChurn([], ["a"]).churnRatio).toBe(1);
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

  it("marks a sub-minimum package cache-cold", () => {
    const cold = buildContextEconomics({ previousLines: ["a"], currentLines: ["a"], packageTokens: 200 });
    expect(cold.verdict).toBe("cache-cold");
    expect(cold.cache.cacheUsable).toBe(false);
    expect(cold.attention.level).toBe("ok");
  });
});
