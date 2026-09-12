/**
 * Pure helpers for the "plugin ON vs plugin OFF" token A/B.
 *
 * Two measurement sources feed the same paired-efficiency report
 * (src/learning/efficiency-report.ts):
 *
 *  - micro mode: first-insertion tokens of one tool result with and without
 *    the ObservationPack projection — deterministic, offline, no API key;
 *  - session mode: a real DSH session's provider-reported token usage, read
 *    from the session projection cache, for one run per arm.
 *
 * Nothing here calls a model or the network, so it is safe in CI.
 */

export type UsageTokenMetric = "total" | "input" | "uncached";

export interface TokenUsageTotals {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SessionStatsSample {
  turns?: number;
  steps?: number;
}

export interface SessionUsageSample {
  sessionId?: string;
  totals: Required<TokenUsageTotals>;
  stats: SessionStatsSample;
}

/** Structural mirror of EfficiencyArm, kept local so this file has no runtime deps. */
export interface AbArm {
  tokens: number;
  turns?: number;
  toolCalls?: number;
  responseCount?: number;
  score?: number;
}

export const ZERO_TOTALS: Required<TokenUsageTotals> = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeTotals(input: TokenUsageTotals | undefined): Required<TokenUsageTotals> {
  return {
    uncachedInputTokens: nonNegative(input?.uncachedInputTokens),
    outputTokens: nonNegative(input?.outputTokens),
    cacheReadTokens: nonNegative(input?.cacheReadTokens),
    cacheWriteTokens: nonNegative(input?.cacheWriteTokens),
  };
}

/**
 * Parse DSH's `dsh-session-projection-cache` record
 * (`<home>/storages/session_projcache/sessions/<id>.json`).
 * Returns undefined for anything that is not a session projection; never throws.
 */
export function parseDshProjcacheUsage(projection: unknown, sessionId?: string): SessionUsageSample | undefined {
  if (!projection || typeof projection !== "object") return undefined;
  const record = (projection as { record?: unknown }).record;
  if (!record || typeof record !== "object") return undefined;
  const rows = (record as { rows?: unknown }).rows;
  if (!rows || typeof rows !== "object") return undefined;
  const row = rows as Record<string, unknown>;
  const usage = row.tokenUsage as { val?: { totals?: TokenUsageTotals } } | undefined;
  if (!usage?.val) return undefined;
  const statsVal = (row.sessionStats as { val?: SessionStatsSample } | undefined)?.val ?? {};
  return {
    ...(sessionId ? { sessionId } : {}),
    totals: normalizeTotals(usage.val.totals),
    stats: {
      ...(typeof statsVal.turns === "number" ? { turns: statsVal.turns } : {}),
      ...(typeof statsVal.steps === "number" ? { steps: statsVal.steps } : {}),
    },
  };
}

/** The DSH projection-cache path for one session id (accepts with or without the `session-` prefix). */
export function dshProjcachePath(home: string, sessionId: string): string {
  const bare = sessionId.startsWith("session-") ? sessionId : "session-" + sessionId;
  return [home, "storages", "session_projcache", "sessions", bare + ".json"].join("/");
}

/**
 * The one number the paired report compares.
 *  - total:    all input + output tokens (the honest "token consumption" figure)
 *  - input:    every input token, cached reads included
 *  - uncached: cache-miss input + output (the provider-bill-sensitive floor)
 */
export function computeTokenMetric(totals: TokenUsageTotals, metric: UsageTokenMetric): number {
  const t = normalizeTotals(totals);
  if (metric === "input") return t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (metric === "uncached") return t.uncachedInputTokens + t.outputTokens;
  return t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;
}

/**
 * Turn one session's usage into a paired arm. DSH's `steps` counts assistant
 * steps inside the run; a token drop that also drops steps is "doing less" and
 * the capability floor rejects it.
 */
export function usageToArm(sample: SessionUsageSample, metric: UsageTokenMetric, score?: number): AbArm {
  return {
    tokens: computeTokenMetric(sample.totals, metric),
    ...(sample.stats.turns !== undefined ? { turns: sample.stats.turns } : {}),
    ...(sample.stats.steps !== undefined ? { responseCount: sample.stats.steps } : {}),
    ...(score !== undefined ? { score } : {}),
  };
}

export function savingsRatio(baselineTokens: number, packagedTokens: number): number {
  if (!(baselineTokens > 0)) return 0;
  return (baselineTokens - packagedTokens) / baselineTokens;
}

/** Files that appeared between two directory snapshots (used to find one run's session). */
export function newFiles(before: Iterable<string>, after: Iterable<string>): string[] {
  const seen = new Set(before);
  return [...after].filter((path) => !seen.has(path));
}

export interface AbSummary {
  baselineTokens: number;
  packagedTokens: number;
  savedTokens: number;
  savingsRatio: number;
  /** How many full handle recalls would erase the saving (null when unknown). */
  breakEvenFullRecalls: number | null;
}

export function summarizeAb(
  baselineTokens: number,
  packagedTokens: number,
  originalTokensPerRecall?: number
): AbSummary {
  const savedTokens = baselineTokens - packagedTokens;
  const ratio = savingsRatio(baselineTokens, packagedTokens);
  const perRecall = originalTokensPerRecall ?? 0;
  return {
    baselineTokens,
    packagedTokens,
    savedTokens,
    savingsRatio: ratio,
    breakEvenFullRecalls: perRecall > 0 ? savedTokens / perRecall : null,
  };
}
