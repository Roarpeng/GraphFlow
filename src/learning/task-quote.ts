/**
 * Task budget quote (M93): turn the paired efficiency history into an
 * ex-ante decision tool.
 *
 * Before accepting a task, an agent/engineer asks: how many tokens will this
 * cost, and how much of it can GraphFlow absorb? quoteTask answers with the
 * same honesty rule as efficiency-report: only qualifying paired comparisons
 * with a strictly positive saving ratio may price the quote. When samples are
 * insufficient the quote says so explicitly, halves the mean ratio
 * conservatively, and never invents precision.
 *
 * Pure function, no IO: callers pass the report (plus optionally the reinvest
 * ledger) and get a serializable, honest quote.
 */
import type { EfficiencyReport } from "./efficiency-report";
import type { ReinvestLedger } from "./efficiency-reinvest";

/** Default minimum qualifying samples before a quote is trusted un-halved. */
export const DEFAULT_MIN_SAMPLES = 3;

/** Conservative factor applied to the mean saving ratio when samples are insufficient. */
export const INSUFFICIENT_SAMPLE_RATIO_FACTOR = 0.5;

export interface TaskQuoteOptions {
  /** Estimated size of the task in tokens (without assistance). */
  estimatedTaskTokens: number;
  /** Minimum qualifying samples for an un-halved quote. Default 3. */
  minSamples?: number;
}

export interface TaskQuote {
  /** Sanitized task size; negative or non-finite input is quoted as 0 (never throws). */
  estimatedTaskTokens: number;
  /** Count of qualifying records with tokenSavingRatio > 0. */
  qualifyingSamples: number;
  /** Mean tokenSavingRatio over those records; 0 when there are none. */
  averageSavingRatio: number;
  confidence: "sufficient" | "insufficient-samples";
  /**
   * estimatedTaskTokens x pricing ratio, where the pricing ratio is the mean
   * halved (x 0.5) when confidence is insufficient-samples.
   */
  estimatedAssistedTokens: number;
  /** estimatedTaskTokens x averageSavingRatio (nominal saving, never halved). */
  estimatedSavingTokens: number;
  /** Unspent search budget from the reinvest ledger; present only when passed with a positive balance. */
  reinvestBudgetAvailable?: number;
  /** Chinese advisory: what the quote is based on, or why it is conservative. */
  advisory: string;
}

function toQuoteTokens(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

export function quoteTask(
  report: EfficiencyReport,
  options: TaskQuoteOptions & { ledger?: ReinvestLedger }
): TaskQuote {
  // 负数 / 非有限输入按 0 处理，绝不抛错。
  const estimatedTaskTokens = toQuoteTokens(options.estimatedTaskTokens);
  const minSamples =
    typeof options.minSamples === "number" && Number.isFinite(options.minSamples) && options.minSamples >= 1
      ? options.minSamples
      : DEFAULT_MIN_SAMPLES;

  // 诚实定价集：只有 qualifying 且节省比例严格为正（且有限）的记录参与定价。
  // 不合格臂（能力回退/响应数下降）与零节省臂不得抬高报价。
  const pricingSamples = report.recentRecords.filter(
    (record) =>
      record.qualifies &&
      typeof record.tokenSavingRatio === "number" &&
      Number.isFinite(record.tokenSavingRatio) &&
      record.tokenSavingRatio > 0
  );
  const qualifyingSamples = pricingSamples.length;
  const averageSavingRatio =
    qualifyingSamples > 0
      ? pricingSamples.reduce((sum, record) => sum + record.tokenSavingRatio, 0) / qualifyingSamples
      : 0;

  const sufficient = qualifyingSamples >= minSamples;
  const confidence: TaskQuote["confidence"] = sufficient ? "sufficient" : "insufficient-samples";
  const pricingRatio = sufficient
    ? averageSavingRatio
    : averageSavingRatio * INSUFFICIENT_SAMPLE_RATIO_FACTOR;

  const estimatedAssistedTokens = estimatedTaskTokens * pricingRatio;
  const estimatedSavingTokens = estimatedTaskTokens * averageSavingRatio;

  const advisory = sufficient
    ? `报价基于 ${qualifyingSamples} 条合格配对样本（平均节省比例 ${pct(averageSavingRatio)}）：` +
      `预计任务 ${estimatedTaskTokens} token 中约 ${Math.round(estimatedAssistedTokens)} token 可由 GraphFlow 吸收` +
      `（名义节省约 ${Math.round(estimatedSavingTokens)} token）。以上为统计估计，非承诺值。`
    : `样本不足（N=${qualifyingSamples} < ${minSamples}）：合格配对样本不足以支撑精确报价，` +
      `节省比例按保守折半（均值 ${pct(averageSavingRatio)} × ${INSUFFICIENT_SAMPLE_RATIO_FACTOR}）执行，` +
      `建议先积累 mechanism trial 配对样本后再复估。`;

  const quote: TaskQuote = {
    estimatedTaskTokens,
    qualifyingSamples,
    averageSavingRatio,
    confidence,
    estimatedAssistedTokens,
    estimatedSavingTokens,
    advisory,
  };

  // exactOptionalPropertyTypes：仅在显式传入且余额为正时挂载，不写 undefined。
  if (options.ledger !== undefined && options.ledger.appliedBudgetTokens > 0) {
    quote.reinvestBudgetAvailable = options.ledger.appliedBudgetTokens;
  }
  return quote;
}
