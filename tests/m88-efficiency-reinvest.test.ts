import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateEfficiencyComparison,
  type EfficiencyComparisonRecord,
  type EfficiencyReport,
} from "../src/learning/efficiency-report";
import {
  applyReinvestment,
  loadReinvestLedger,
  pendingFingerprints,
  planReinvestment,
  recordFingerprint,
  resolveReinvestLedgerPath,
} from "../src/learning/efficiency-reinvest";
import { getDefaultConfig } from "../src/config/defaults";
import type { GraphFlowConfig } from "../src/config/schema";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeConfig(root: string): GraphFlowConfig {
  const config = getDefaultConfig();
  config.graphPolicy.workspaceRoot = root;
  return config;
}

function qualifyingRecord(query: string, baselineTokens: number, packagedTokens: number): EfficiencyComparisonRecord {
  return evaluateEfficiencyComparison(
    { query, baseline: { tokens: baselineTokens }, packaged: { tokens: packagedTokens } },
    { now: `2026-09-14T00:00:00.${query.length}Z` }
  );
}

function reportOf(records: EfficiencyComparisonRecord[]): EfficiencyReport {
  return {
    totalComparisons: records.length,
    qualifying: records.filter((r) => r.qualifies).length,
    disqualified: records.filter((r) => !r.qualifies).length,
    averageTokenSavingRatio: 0.5,
    responseCountMeasured: 0,
    averageResponseCountDeltaRatio: null,
    capabilityRegressions: 0,
    recentRecords: records,
  };
}

describe("M88 efficiency-for-efficiency reinvestment (R6 closeout)", () => {
  it("derives budget from qualifying savings only, after the ratio and cap", () => {
    const good = qualifyingRecord("q1", 10_000, 4_000); // 6000 saved, qualifies
    const bad = evaluateEfficiencyComparison(
      { query: "q2", baseline: { tokens: 10_000 }, packaged: { tokens: 11_000 } },
      { now: "2026-09-14T00:00:00.2Z" }
    );
    expect(bad.qualifies).toBe(false);
    const plan = planReinvestment(reportOf([good, bad]), { schemaVersion: 1, consumedFingerprints: [], appliedBudgetTokens: 0 });
    expect(plan.qualifyingSavingsTokens).toBe(6_000);
    expect(plan.newSavingsTokens).toBe(6_000);
    expect(plan.grossBudgetTokens).toBe(3_000);
    expect(plan.budgetTokens).toBe(3_000);
    expect(plan.cappedBy).toBe("ratio");
    expect(plan.estimatedTrials).toBe(Math.floor(3_000 / 4_000)); // 0 — too small to fund a trial
  });

  it("caps the budget at maxBudgetTokens", () => {
    const records = [qualifyingRecord("q1", 1_000_000, 100_000)];
    const plan = planReinvestment(
      reportOf(records),
      { schemaVersion: 1, consumedFingerprints: [], appliedBudgetTokens: 0 },
      { config: { ratio: 0.5, maxBudgetTokens: 50_000 } }
    );
    expect(plan.grossBudgetTokens).toBe(450_000);
    expect(plan.budgetTokens).toBe(50_000);
    expect(plan.cappedBy).toBe("max-budget");
    expect(plan.estimatedTrials).toBe(12);
  });

  it("disabled config yields zero budget and no suggestions", () => {
    const records = [qualifyingRecord("q1", 10_000, 2_000)];
    const mechanisms = {
      mechanisms: [
        { id: "mechanism:frozen-one", name: "frozen-one", family: "context" as const, status: "frozen" as const, trials: 3, heldOutTrials: 0, updatedAt: "2026-09-14T00:00:00Z" },
      ],
    };
    const plan = planReinvestment(reportOf(records), { schemaVersion: 1, consumedFingerprints: [], appliedBudgetTokens: 0 }, {
      config: { enabled: false },
      mechanismReport: mechanisms,
    });
    expect(plan.enabled).toBe(false);
    expect(plan.budgetTokens).toBe(0);
    expect(plan.suggestions).toEqual([]);
  });

  it("suggests frozen (held-out) before in-trajectory before proposed, never terminal", () => {
    const records = [qualifyingRecord("q1", 100_000, 0)]; // 100k saved → 50k budget → 12 trials
    const mechanisms = {
      mechanisms: [
        { id: "mechanism:proposed-a", name: "proposed-a", family: "tools" as const, status: "proposed" as const, trials: 0, heldOutTrials: 0, updatedAt: "2026-09-14T00:00:00Z" },
        { id: "mechanism:admitted-x", name: "admitted-x", family: "tools" as const, status: "admitted" as const, trials: 5, heldOutTrials: 2, updatedAt: "2026-09-14T00:00:00Z" },
        { id: "mechanism:in-trajectory-b", name: "in-trajectory-b", family: "context" as const, status: "in-trajectory" as const, trials: 2, heldOutTrials: 0, updatedAt: "2026-09-14T00:00:00Z" },
        { id: "mechanism:frozen-c", name: "frozen-c", family: "observation" as const, status: "frozen" as const, trials: 3, heldOutTrials: 0, updatedAt: "2026-09-14T00:00:00Z" },
        { id: "mechanism:rejected-y", name: "rejected-y", family: "prompt" as const, status: "rejected" as const, trials: 1, heldOutTrials: 1, updatedAt: "2026-09-14T00:00:00Z" },
      ],
    };
    const plan = planReinvestment(reportOf(records), { schemaVersion: 1, consumedFingerprints: [], appliedBudgetTokens: 0 }, {
      mechanismReport: mechanisms,
    });
    expect(plan.suggestions.map((s) => s.mechanismId)).toEqual([
      "mechanism:frozen-c",
      "mechanism:in-trajectory-b",
      "mechanism:proposed-a",
    ]);
    expect(plan.suggestions[0]?.phase).toBe("held-out");
    expect(plan.suggestions[1]?.phase).toBe("in-trajectory");
  });

  it("consumes each record's funding exactly once (idempotent apply)", () => {
    const root = makeTempRoot("gf-reinvest-");
    const config = makeConfig(root);
    const records = [qualifyingRecord("q1", 10_000, 4_000)];

    const first = applyReinvestment(config, reportOf(records), { apply: true, now: "2026-09-14T01:00:00Z" });
    expect(first.appliedBudgetTokens).toBe(3_000);
    expect(first.ledger.consumedFingerprints).toEqual([recordFingerprint(records[0]!)]);
    expect(first.ledger.appliedBudgetTokens).toBe(3_000);

    // Second apply: the same record cannot fund the budget twice.
    const second = applyReinvestment(config, reportOf(records), { apply: true, now: "2026-09-14T02:00:00Z" });
    expect(second.appliedBudgetTokens).toBe(0);
    expect(second.plan.newSavingsTokens).toBe(0);
    expect(second.ledger.appliedBudgetTokens).toBe(3_000);
    expect(second.ledger.lastAppliedAt).toBe("2026-09-14T01:00:00Z");

    const ledgerPath = resolveReinvestLedgerPath(config);
    expect(ledgerPath).toBe(join(root, "graphflow-out", "efficiency-reinvest.json"));
    const persisted = loadReinvestLedger(ledgerPath);
    expect(persisted.consumedFingerprints).toHaveLength(1);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("dry-run never writes the ledger", () => {
    const root = makeTempRoot("gf-reinvest-dry-");
    const config = makeConfig(root);
    const records = [qualifyingRecord("q1", 10_000, 4_000)];
    const dry = applyReinvestment(config, reportOf(records), { apply: false });
    expect(dry.appliedBudgetTokens).toBe(0);
    expect(dry.dryRun).toBe(true);
    expect(pendingFingerprints(reportOf(records), dry.ledger)).toHaveLength(1);
    // No ledger file was created.
    expect(loadReinvestLedger(resolveReinvestLedgerPath(config)).consumedFingerprints).toEqual([]);
  });

  it("corrupt ledger files fail open to an empty ledger", () => {
    const root = makeTempRoot("gf-reinvest-corrupt-");
    const config = makeConfig(root);
    const path = resolveReinvestLedgerPath(config);
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "graphflow-out"), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    const ledger = loadReinvestLedger(path);
    expect(ledger.consumedFingerprints).toEqual([]);
    expect(ledger.appliedBudgetTokens).toBe(0);
  });
});
