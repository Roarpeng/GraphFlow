import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendEfficiencyRecord,
  evaluateEfficiencyComparison,
  evaluateEfficiencyFloor,
  evaluateFidelityFloor,
  getEfficiencyReport,
  recordEfficiencyComparison,
  resetEfficiencyReport,
  resolveEfficiencyReportPath,
} from "../src/learning/efficiency-report";
import { validateConfig } from "../src/config/loader";

const root = mkdtempSync(join(tmpdir(), "graphflow-efficiency-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function config() {
  return validateConfig({
    providers: {},
    tiers: { smart: { provider: "openai" }, economy: { provider: "openai" } },
    budgetPolicy: { runTokenCap: 1000 },
    graphPolicy: { enableAutoBuild: true, transport: "memory", workspaceRoot: root, maxContextTokens: 1000 },
    learningPolicy: { enableFlywheel: true, trainingCadence: "nightly", exportPath: join(root, "l.jsonl") },
  });
}

describe("evaluateEfficiencyComparison", () => {
  const base = { query: "task", baseline: { tokens: 1000 }, packaged: { tokens: 600 } };

  it("qualifies when tokens improve and capability is unmeasured", () => {
    const record = evaluateEfficiencyComparison(base, { now: "2026-01-01T00:00:00.000Z" });
    expect(record.qualifies).toBe(true);
    expect(record.reasons).toEqual([]);
    expect(record.tokenSavingRatio).toBeCloseTo(0.4);
  });

  it("disqualifies a token drop that came from doing less (response count regression)", () => {
    const record = evaluateEfficiencyComparison({
      ...base,
      baseline: { tokens: 1000, responseCount: 10 },
      packaged: { tokens: 600, responseCount: 6 },
    });
    expect(record.qualifies).toBe(false);
    expect(record.reasons).toContain("capability-regression:response-count");
  });

  it("disqualifies a score regression beyond tolerance", () => {
    const record = evaluateEfficiencyComparison({
      ...base,
      baseline: { tokens: 1000, score: 1 },
      packaged: { tokens: 600, score: 0.8 },
    });
    expect(record.qualifies).toBe(false);
    expect(record.reasons).toContain("capability-regression:score");
  });

  it("tolerates a small score dip within tolerance", () => {
    const record = evaluateEfficiencyComparison({
      ...base,
      baseline: { tokens: 1000, score: 1, responseCount: 4 },
      packaged: { tokens: 600, score: 0.97, responseCount: 4 },
    });
    expect(record.qualifies).toBe(true);
  });

  it("disqualifies when tokens do not improve", () => {
    const record = evaluateEfficiencyComparison({ query: "t", baseline: { tokens: 500 }, packaged: { tokens: 600 } });
    expect(record.qualifies).toBe(false);
    expect(record.reasons).toContain("no-efficiency-gain");
  });
});

describe("efficiency report persistence and floor", () => {
  it("persists paired comparisons, aggregates, and resets", () => {
    const cfg = config();
    expect(resolveEfficiencyReportPath(cfg).replace(/\\/g, "/").endsWith("graphflow-out/efficiency.json")).toBe(true);
    expect(getEfficiencyReport(cfg).totalComparisons).toBe(0);

    recordEfficiencyComparison(cfg, { query: "a", baseline: { tokens: 1000, responseCount: 5 }, packaged: { tokens: 500, responseCount: 5 } });
    const second = recordEfficiencyComparison(cfg, {
      query: "b",
      baseline: { tokens: 1000, score: 1 },
      packaged: { tokens: 700, score: 0.5 },
    });
    expect(second.report.totalComparisons).toBe(2);
    expect(second.report.qualifying).toBe(1);
    expect(second.report.disqualified).toBe(1);
    expect(second.report.capabilityRegressions).toBe(1);
    expect(second.report.responseCountMeasured).toBe(1);
    expect(second.report.averageResponseCountDeltaRatio).toBe(0);

    const floor = evaluateEfficiencyFloor(second.report, { minQualifying: 1, maxCapabilityRegressions: 0 });
    expect(floor.ok).toBe(false);
    expect(floor.failures.some((f) => f.includes("capability-regressions"))).toBe(true);

    expect(resetEfficiencyReport(cfg).reset).toBe(true);
    expect(getEfficiencyReport(cfg).totalComparisons).toBe(0);
  });

  it("passes the floor when thresholds are met", () => {
    const report = {
      totalComparisons: 3,
      qualifying: 3,
      disqualified: 0,
      averageTokenSavingRatio: 0.4,
      responseCountMeasured: 3,
      averageResponseCountDeltaRatio: 0,
      capabilityRegressions: 0,
      recentRecords: [],
    };
    expect(evaluateEfficiencyFloor(report, { minQualifying: 3, maxCapabilityRegressions: 0 }).ok).toBe(true);
    expect(evaluateEfficiencyFloor(report, { minQualifying: 4 }).ok).toBe(false);
  });

  it("persists a precomputed record verbatim instead of re-scoring it", () => {
    const cfg = config();
    appendEfficiencyRecord(cfg, {
      query: "mechanism:custom-tolerance",
      baseline: { tokens: 1000, score: 1, responseCount: 4 },
      packaged: { tokens: 600, score: 0.9, responseCount: 4 },
      source: "benchmark",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenSavingRatio: 0.4,
      scoreDeltaRatio: -0.1,
      responseCountDeltaRatio: 0,
      qualifies: true,
      reasons: [],
      mechanismId: "mechanism:custom-tolerance",
    });
    const persisted = getEfficiencyReport(cfg).recentRecords.find(
      (record) => record.query === "mechanism:custom-tolerance"
    );
    // A re-evaluation with the default 0.05 tolerance would flip this to false.
    expect(persisted?.qualifies).toBe(true);
    expect(persisted?.reasons).toEqual([]);
    expect(persisted?.mechanismId).toBe("mechanism:custom-tolerance");
  });
});

describe("evaluateFidelityFloor", () => {
  const stats = {
    sampleCount: 4,
    averageAnchorRecallPercent: 90,
    averageBodyCoveragePercent: 75,
    totalExpectedAnchors: 10,
    totalReturnedAnchors: 10,
    totalMissingAnchors: 0,
    bodyCoverageSampleCount: 4,
    firstRecordAt: null,
    lastRecordAt: null,
    recentRecords: [],
  };

  it("passes when recall and coverage clear the thresholds", () => {
    expect(evaluateFidelityFloor(stats, { minAnchorRecallPercent: 80, minBodyCoveragePercent: 70 }).ok).toBe(true);
  });

  it("fails when body coverage regresses", () => {
    const result = evaluateFidelityFloor(stats, { minBodyCoveragePercent: 80 });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("fidelity-body-coverage");
  });

  it("adds no checks when there are no samples or body measurements", () => {
    const empty = { ...stats, sampleCount: 0, bodyCoverageSampleCount: 0 };
    const result = evaluateFidelityFloor(empty, { minAnchorRecallPercent: 100 });
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([]);
  });
});
