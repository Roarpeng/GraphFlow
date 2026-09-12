import { describe, expect, it } from "vitest";
import {
  buildCompactionSignal,
  deriveAdaptiveBudget,
  evaluateCompaction,
  toContextPressure,
  type ContextPressure,
} from "../src/graph/context-pressure";

describe("deriveAdaptiveBudget", () => {
  it("passes a numeric configuredMax through (rounded to an integer)", () => {
    expect(deriveAdaptiveBudget({ configuredMax: 2000, defaultMax: 1500 })).toBe(2000);
    expect(deriveAdaptiveBudget({ configuredMax: 2000.6, defaultMax: 1500 })).toBe(2001);
  });

  it("falls back to defaultMax for invalid numeric configuredMax", () => {
    expect(deriveAdaptiveBudget({ configuredMax: Number.NaN, defaultMax: 1500 })).toBe(1500);
    expect(deriveAdaptiveBudget({ configuredMax: -10, defaultMax: 1500 })).toBe(1500);
    expect(deriveAdaptiveBudget({ configuredMax: 0, defaultMax: 1500 })).toBe(1500);
    expect(
      deriveAdaptiveBudget({ configuredMax: Number.POSITIVE_INFINITY, defaultMax: 1500 })
    ).toBe(1500);
  });

  it("returns defaultMax for 'auto' without an observation", () => {
    expect(deriveAdaptiveBudget({ configuredMax: "auto", defaultMax: 1500 })).toBe(1500);
  });

  it("falls back to the GraphFlow default when defaultMax itself is invalid", () => {
    expect(deriveAdaptiveBudget({ configuredMax: "auto", defaultMax: Number.NaN })).toBe(1500);
    expect(deriveAdaptiveBudget({ configuredMax: -1, defaultMax: -5 })).toBe(1500);
  });

  it("scales defaultMax by observed pressure under 'auto'", () => {
    const observed: ContextPressure = { usedTokens: 1350, maxTokens: 1500, pressureRatio: 0.9 };
    // 1500 * 0.9 = 1350, inside [375, 3000].
    expect(deriveAdaptiveBudget({ configuredMax: "auto", defaultMax: 1500, observed })).toBe(1350);
  });

  it("clamps the auto budget to the 25% floor under low pressure", () => {
    const observed: ContextPressure = { usedTokens: 100, maxTokens: 1500, pressureRatio: 0.1 };
    // 1500 * 0.1 = 150 -> clamped to floor 375.
    expect(deriveAdaptiveBudget({ configuredMax: "auto", defaultMax: 1500, observed })).toBe(375);
  });

  it("clamps an over-1 pressure ratio to the full default budget", () => {
    const observed: ContextPressure = { usedTokens: 3000, maxTokens: 1500, pressureRatio: 2 };
    expect(deriveAdaptiveBudget({ configuredMax: "auto", defaultMax: 1500, observed })).toBe(1500);
  });

  it("recomputes pressure from used/max tokens when pressureRatio is not finite", () => {
    const observed: ContextPressure = {
      usedTokens: 1200,
      maxTokens: 1500,
      pressureRatio: Number.NaN,
    };
    // 1200 / 1500 = 0.8 -> 1200.
    expect(deriveAdaptiveBudget({ configuredMax: "auto", defaultMax: 1500, observed })).toBe(1200);
  });

  it("returns defaultMax when the observation carries no usable signal", () => {
    const observed: ContextPressure = {
      usedTokens: Number.NaN,
      maxTokens: 0,
      pressureRatio: Number.NaN,
    };
    expect(deriveAdaptiveBudget({ configuredMax: "auto", defaultMax: 1500, observed })).toBe(1500);
  });

  it("accepts an optional observation via conditional spread", () => {
    const maybeObserved: ContextPressure | undefined = {
      usedTokens: 750,
      maxTokens: 1500,
      pressureRatio: 0.5,
    };
    const budget = deriveAdaptiveBudget({
      configuredMax: "auto",
      defaultMax: 1500,
      ...(maybeObserved ? { observed: maybeObserved } : {}),
    });
    expect(budget).toBe(750);
  });
});

describe("evaluateCompaction", () => {
  it("recommends when projected saving clears minSavingRatio under pressure", () => {
    // replay = 10000 * 10 * 0.1 = 10000; rewrite = 10000 * 0.5 = 5000.
    const result = evaluateCompaction({
      prefixTokens: 10000,
      remainingTurnsEstimate: 10,
      cacheWriteReadRatio: 0.5,
      windowPressure: 0.8,
    });
    expect(result.recommend).toBe(true);
    expect(result.projectedSaving).toBeCloseTo(5000, 6);
    expect(result.reason).toContain("clears minSavingRatio");
  });

  it("does not recommend when the rewrite costs more than future replay", () => {
    // replay = 10000 * 3 * 0.1 = 3000; rewrite = 10000 * 0.5 = 5000.
    const result = evaluateCompaction({
      prefixTokens: 10000,
      remainingTurnsEstimate: 3,
      cacheWriteReadRatio: 0.5,
      windowPressure: 0.8,
    });
    expect(result.recommend).toBe(false);
    expect(result.projectedSaving).toBeLessThan(0);
    expect(result.reason).toContain("does not clear minSavingRatio");
  });

  it("does not recommend below the window-pressure gate even with good economics", () => {
    const result = evaluateCompaction({
      prefixTokens: 10000,
      remainingTurnsEstimate: 10,
      cacheWriteReadRatio: 0.5,
      windowPressure: 0.4,
    });
    expect(result.recommend).toBe(false);
    expect(result.reason).toContain("window pressure");
  });

  it("honours a custom minSavingRatio", () => {
    const input = {
      prefixTokens: 10000,
      remainingTurnsEstimate: 10,
      cacheWriteReadRatio: 0.5,
      windowPressure: 0.8,
    };
    // savingRatio 0.5 clears 0.2 but not 0.6.
    expect(evaluateCompaction({ ...input, minSavingRatio: 0.6 }).recommend).toBe(false);
    expect(evaluateCompaction({ ...input, minSavingRatio: 0.2 }).recommend).toBe(true);
  });

  it("never recommends when there is no replay cost to amortize", () => {
    const result = evaluateCompaction({
      prefixTokens: 0,
      remainingTurnsEstimate: 10,
      cacheWriteReadRatio: 0.5,
      windowPressure: 0.9,
    });
    expect(result.recommend).toBe(false);
    expect(result.projectedSaving).toBe(0);
    expect(result.reason).toContain("no future replay cost");
  });

  it("sanitizes NaN/negative inputs to finite, non-negative outputs", () => {
    const result = evaluateCompaction({
      prefixTokens: Number.NaN,
      remainingTurnsEstimate: -3,
      cacheWriteReadRatio: Number.POSITIVE_INFINITY,
      windowPressure: Number.NaN,
      minSavingRatio: -1,
    });
    expect(result.recommend).toBe(false);
    expect(Number.isFinite(result.projectedSaving)).toBe(true);
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("buildCompactionSignal", () => {
  it("returns the boundary handoff payload with the compaction economics", () => {
    const economics = {
      prefixTokens: 10000,
      remainingTurnsEstimate: 10,
      cacheWriteReadRatio: 0.5,
      windowPressure: 0.8,
    };
    const signal = buildCompactionSignal({
      boundaryLabel: "turn-42-boundary",
      continuationContext: "Continue from the refactored planner module.",
      ...economics,
    });
    const evaluation = evaluateCompaction(economics);

    expect(signal.recommend).toBe(true);
    expect(signal.boundaryLabel).toBe("turn-42-boundary");
    expect(signal.continuationContext).toBe("Continue from the refactored planner module.");
    expect(signal.projectedSaving).toBe(evaluation.projectedSaving);
    expect(signal.reason).toBe(evaluation.reason);
  });

  it("propagates a negative recommendation without dropping the payload", () => {
    const signal = buildCompactionSignal({
      boundaryLabel: "turn-7-boundary",
      continuationContext: "Resume after tests.",
      prefixTokens: 10000,
      remainingTurnsEstimate: 2,
      cacheWriteReadRatio: 0.5,
      windowPressure: 0.9,
    });
    expect(signal.recommend).toBe(false);
    expect(signal.boundaryLabel).toBe("turn-7-boundary");
    expect(signal.continuationContext).toBe("Resume after tests.");
    expect(Number.isFinite(signal.projectedSaving)).toBe(true);
  });

  it("honors a caller-supplied minSavingRatio", () => {
    const base = {
      boundaryLabel: "b",
      continuationContext: "c",
      prefixTokens: 10000,
      remainingTurnsEstimate: 5,
      cacheWriteReadRatio: 0.05,
      windowPressure: 0.9,
    };
    // futureReplay = 5 * 10000 * 0.1 = 5000; rewrite = 500; saving ratio = 0.9
    expect(buildCompactionSignal({ ...base }).recommend).toBe(true);
    expect(buildCompactionSignal({ ...base, minSavingRatio: 0.95 }).recommend).toBe(false);
  });
});

describe("toContextPressure", () => {
  it("returns undefined without a usable signal", () => {
    expect(toContextPressure(undefined)).toBeUndefined();
    expect(toContextPressure({})).toBeUndefined();
    expect(toContextPressure({ usedTokens: 100 })).toBeUndefined();
    expect(toContextPressure({ maxTokens: 100 })).toBeUndefined();
  });

  it("resolves the ratio from used/max tokens and clamps to [0, 1]", () => {
    expect(toContextPressure({ usedTokens: 50, maxTokens: 200 })?.pressureRatio).toBeCloseTo(0.25);
    expect(toContextPressure({ usedTokens: 400, maxTokens: 200 })?.pressureRatio).toBe(1);
  });

  it("prefers an explicit finite pressureRatio", () => {
    const pressure = toContextPressure({ usedTokens: 10, maxTokens: 100, pressureRatio: 0.9 });
    expect(pressure?.pressureRatio).toBeCloseTo(0.9);
    expect(pressure?.usedTokens).toBe(10);
    expect(pressure?.maxTokens).toBe(100);
  });
});
