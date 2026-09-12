import { describe, expect, it } from "vitest";

import {
  computeTokenMetric,
  dshProjcachePath,
  newFiles,
  normalizeTotals,
  parseDshProjcacheUsage,
  savingsRatio,
  summarizeAb,
  usageToArm,
} from "../benchmarks/plugin-ab-lib";

/**
 * The plugin A/B harness turns provider token usage into the same paired arms
 * the governance capability floor reads. These tests pin the conversion so a
 * future projection-format change cannot silently make tokens look lower.
 */

function projcache(totals: Record<string, number>, stats: Record<string, number> = {}) {
  return {
    version: 7,
    record: {
      rows: {
        tokenUsage: { ver: 2, seq: 10, val: { totals } },
        sessionStats: { ver: 1, seq: 10, val: { turns: 2, steps: 9, ...stats } },
      },
    },
  };
}

describe("parseDshProjcacheUsage", () => {
  it("reads totals and stats from a real projection shape", () => {
    const sample = parseDshProjcacheUsage(
      projcache(
        { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 10 },
        { steps: 7 }
      ),
      "session-1"
    );
    expect(sample?.sessionId).toBe("session-1");
    expect(sample?.totals).toEqual({
      uncachedInputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 10,
    });
    expect(sample?.stats).toEqual({ turns: 2, steps: 7 });
  });

  it("returns undefined for non-projections and never throws", () => {
    expect(parseDshProjcacheUsage(null)).toBeUndefined();
    expect(parseDshProjcacheUsage({})).toBeUndefined();
    expect(parseDshProjcacheUsage({ record: {} })).toBeUndefined();
    expect(parseDshProjcacheUsage({ record: { rows: {} } })).toBeUndefined();
  });

  it("treats missing or negative counters as zero rather than NaN", () => {
    const sample = parseDshProjcacheUsage(projcache({ uncachedInputTokens: -5, outputTokens: Number.NaN }));
    expect(sample?.totals).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe("computeTokenMetric", () => {
  const totals = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 10 };
  it("total counts every token", () => {
    expect(computeTokenMetric(totals, "total")).toBe(1060);
  });
  it("input excludes output", () => {
    expect(computeTokenMetric(totals, "input")).toBe(1010);
  });
  it("uncached is the bill-sensitive cache-miss floor", () => {
    expect(computeTokenMetric(totals, "uncached")).toBe(150);
  });
});

describe("usageToArm", () => {
  it("maps DSH steps to responseCount so a 'doing less' drop is caught", () => {
    const sample = parseDshProjcacheUsage(projcache({ uncachedInputTokens: 1, outputTokens: 1 }))!;
    const arm = usageToArm(sample, "total", 0.9);
    expect(arm.responseCount).toBe(9);
    expect(arm.turns).toBe(2);
    expect(arm.score).toBe(0.9);
    expect(arm.tokens).toBe(2);
  });
});

describe("savings and break-even", () => {
  it("reports a positive ratio when the packaged arm is cheaper", () => {
    expect(savingsRatio(1000, 400)).toBeCloseTo(0.6);
  });
  it("never divides by zero", () => {
    expect(savingsRatio(0, 0)).toBe(0);
  });
  it("computes how many full recalls would erase the saving", () => {
    const summary = summarizeAb(1000, 400, 500);
    expect(summary.savedTokens).toBe(600);
    expect(summary.breakEvenFullRecalls).toBeCloseTo(1.2);
  });
  it("leaves break-even unknown without a recall size", () => {
    expect(summarizeAb(1000, 400).breakEvenFullRecalls).toBeNull();
  });
});

describe("normalizeTotals and path helpers", () => {
  it("normalizes a partial totals object", () => {
    expect(normalizeTotals({ outputTokens: 3 })).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
  it("builds the DSH projection-cache path idempotently", () => {
    expect(dshProjcachePath("/home/u/.dsh", "abc")).toBe(
      "/home/u/.dsh/storages/session_projcache/sessions/session-abc.json"
    );
    expect(dshProjcachePath("/home/u/.dsh", "session-abc")).toBe(
      "/home/u/.dsh/storages/session_projcache/sessions/session-abc.json"
    );
  });
  it("finds only files that appeared between two snapshots", () => {
    expect(newFiles(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
  });
});
