import { describe, expect, it } from "vitest";
import type { EfficiencyComparisonRecord, EfficiencyReport } from "../src/learning/efficiency-report";
import type { ReinvestLedger } from "../src/learning/efficiency-reinvest";
import {
  DEFAULT_MIN_SAMPLES,
  INSUFFICIENT_SAMPLE_RATIO_FACTOR,
  quoteTask,
} from "../src/learning/task-quote";

// 构造一条配对记录：ratio 为节省比例（基于 10000 token 基线），qualifies 默认 true。
function record(ratio: number, qualifies = true): EfficiencyComparisonRecord {
  const baseline = 10_000;
  return {
    query: `q-${ratio}-${qualifies ? "ok" : "bad"}`,
    baseline: { tokens: baseline },
    packaged: { tokens: Math.max(0, Math.round(baseline * (1 - ratio))) },
    timestamp: "2026-09-14T00:00:00.000Z",
    tokenSavingRatio: ratio,
    qualifies,
    reasons: qualifies ? [] : ["capability-regression"],
  };
}

// 只填 EfficiencyReport 的必填字段；quoteTask 只依赖 recentRecords 的定性。
function reportOf(records: EfficiencyComparisonRecord[]): EfficiencyReport {
  return {
    totalComparisons: records.length,
    qualifying: records.filter((r) => r.qualifies).length,
    disqualified: records.filter((r) => !r.qualifies).length,
    averageTokenSavingRatio: 0,
    responseCountMeasured: 0,
    averageResponseCountDeltaRatio: null,
    capabilityRegressions: 0,
    recentRecords: records,
  };
}

function ledgerOf(appliedBudgetTokens: number): ReinvestLedger {
  return { schemaVersion: 1, consumedFingerprints: [], appliedBudgetTokens };
}

describe("M93 task budget quote", () => {
  it("quotes from the mean of qualifying positive-ratio samples when samples are sufficient", () => {
    // 4 条合格样本：0.2 / 0.4 / 0.6 / 0.8，均值 0.5。
    const quote = quoteTask(reportOf([record(0.2), record(0.4), record(0.6), record(0.8)]), {
      estimatedTaskTokens: 10_000,
    });
    expect(quote.estimatedTaskTokens).toBe(10_000);
    expect(quote.qualifyingSamples).toBe(4);
    expect(quote.averageSavingRatio).toBeCloseTo(0.5, 10);
    expect(quote.confidence).toBe("sufficient");
    expect(quote.estimatedAssistedTokens).toBeCloseTo(5_000, 6);
    expect(quote.estimatedSavingTokens).toBeCloseTo(5_000, 6);
    expect(quote.advisory).toContain("4");
  });

  it("treats exactly minSamples qualifying samples as sufficient (boundary)", () => {
    const quote = quoteTask(reportOf([record(0.3), record(0.5), record(0.7)]), {
      estimatedTaskTokens: 1_000,
    });
    expect(quote.qualifyingSamples).toBe(DEFAULT_MIN_SAMPLES);
    expect(quote.confidence).toBe("sufficient");
    // 边界上不折半：1_000 × 0.5 = 500。
    expect(quote.estimatedAssistedTokens).toBeCloseTo(500, 6);
  });

  it("halves the ratio conservatively and spells out sample count when samples are insufficient", () => {
    // 2 条样本（均值 0.5）< 默认 minSamples=3 → 保守折半 0.25。
    const quote = quoteTask(reportOf([record(0.4), record(0.6)]), { estimatedTaskTokens: 10_000 });
    expect(quote.confidence).toBe("insufficient-samples");
    expect(quote.qualifyingSamples).toBe(2);
    expect(quote.averageSavingRatio).toBeCloseTo(0.5, 10);
    expect(quote.estimatedAssistedTokens).toBeCloseTo(2_500, 6);
    // advisory 必须写明样本数与折半策略。
    expect(quote.advisory).toContain("样本不足");
    expect(quote.advisory).toContain("N=2");
    expect(quote.advisory).toContain("折半");
    expect(quote.advisory).toContain("mechanism trial");
  });

  it("returns ratio 0 and zero savings for a report with no usable samples", () => {
    const quote = quoteTask(reportOf([]), { estimatedTaskTokens: 8_000 });
    expect(quote.qualifyingSamples).toBe(0);
    expect(quote.averageSavingRatio).toBe(0);
    expect(quote.estimatedAssistedTokens).toBe(0);
    expect(quote.estimatedSavingTokens).toBe(0);
    expect(quote.confidence).toBe("insufficient-samples");
    expect(quote.advisory).toContain("N=0");
  });

  it("sanitizes invalid estimatedTaskTokens to 0 without throwing", () => {
    const report = reportOf([record(0.2), record(0.4), record(0.6)]);
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const quote = quoteTask(report, { estimatedTaskTokens: bad });
      expect(quote.estimatedTaskTokens).toBe(0);
      expect(quote.estimatedAssistedTokens).toBe(0);
      expect(quote.estimatedSavingTokens).toBe(0);
    }
  });

  it("exposes reinvestBudgetAvailable when a ledger with positive balance is passed", () => {
    const quote = quoteTask(reportOf([record(0.5), record(0.5), record(0.5)]), {
      estimatedTaskTokens: 1_000,
      ledger: ledgerOf(4_200),
    });
    expect(quote.reinvestBudgetAvailable).toBe(4_200);
  });

  it("omits reinvestBudgetAvailable when no ledger is passed", () => {
    const quote = quoteTask(reportOf([record(0.5), record(0.5), record(0.5)]), {
      estimatedTaskTokens: 1_000,
    });
    expect(quote.reinvestBudgetAvailable).toBeUndefined();
    expect("reinvestBudgetAvailable" in quote).toBe(false);
  });

  it("omits reinvestBudgetAvailable when the ledger balance is not positive", () => {
    const quote = quoteTask(reportOf([record(0.5)]), {
      estimatedTaskTokens: 1_000,
      ledger: ledgerOf(0),
    });
    expect(quote.reinvestBudgetAvailable).toBeUndefined();
  });

  it("excludes qualifying records with zero saving ratio from the mean", () => {
    // 0 节省的合格记录不参与定价：均值只来自 0.3 / 0.6 / 0.6。
    const quote = quoteTask(
      reportOf([record(0), record(0.3), record(0.6), record(0.6)]),
      { estimatedTaskTokens: 10_000 }
    );
    expect(quote.qualifyingSamples).toBe(3);
    expect(quote.averageSavingRatio).toBeCloseTo(0.5, 10);
    expect(quote.estimatedAssistedTokens).toBeCloseTo(5_000, 6);
  });

  it("excludes disqualified records from pricing even with a high ratio", () => {
    // 0.9 的不合格臂不得抬高报价：均值只来自 0.4 / 0.6 / 0.4。
    const quote = quoteTask(
      reportOf([record(0.9, false), record(0.4), record(0.6), record(0.4)]),
      { estimatedTaskTokens: 10_000 }
    );
    expect(quote.qualifyingSamples).toBe(3);
    // 均值 = (0.4 + 0.6 + 0.4) / 3 ≈ 0.4667
    expect(quote.averageSavingRatio).toBeCloseTo(14 / 30, 10);
  });

  it("honors a higher minSamples override with the conservative halving", () => {
    // 4 条样本在默认阈值下充足，但 minSamples=5 触发保守折半。
    const records = [record(0.2), record(0.4), record(0.6), record(0.8)];
    const quote = quoteTask(reportOf(records), { estimatedTaskTokens: 10_000, minSamples: 5 });
    expect(quote.confidence).toBe("insufficient-samples");
    expect(quote.estimatedAssistedTokens).toBeCloseTo(
      10_000 * 0.5 * INSUFFICIENT_SAMPLE_RATIO_FACTOR,
      6
    );
  });
});
