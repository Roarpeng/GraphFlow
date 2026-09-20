/**
 * GF-3 boundary-aware budget + compaction signal (Online Context Compact analog).
 *
 * Self-contained, pure, deterministic: no I/O, no randomness, no Date/process
 * access. Two responsibilities:
 *
 * 1. `deriveAdaptiveBudget` — resolve the effective context-token budget from a
 *    configured value ("auto" scales the default by observed window pressure).
 * 2. `evaluateCompaction` / `buildCompactionSignal` — an economic check for
 *    online compaction: replaying a long prefix for the remaining turns costs
 *    ~remainingTurns * prefixTokens * CACHE_READ_FACTOR, while compacting
 *    costs a one-time summarize read + compact write (the COMPACTED size at
 *    the cache-write premium) + remainingTurns * compacted * CACHE_READ_FACTOR.
 *    Compaction is recommended only when the projected saving clears
 *    `minSavingRatio` AND the window is actually under pressure (> 0.5), so
 *    we never pay the rewrite cost early.
 */

export interface ContextPressure {
  usedTokens: number;
  maxTokens: number;
  pressureRatio: number;
}

export interface AdaptiveBudgetInput {
  configuredMax: number | "auto";
  defaultMax: number;
  observed?: ContextPressure;
}

export interface CompactionInput {
  prefixTokens: number;
  remainingTurnsEstimate: number;
  cacheWriteReadRatio: number;
  windowPressure: number;
  minSavingRatio?: number;
}

export interface CompactionEvaluation {
  recommend: boolean;
  projectedSaving: number;
  /** Keep-side cost: replaying the original prefix for the remaining turns. */
  replayCost?: number;
  /** Compact-side cost: summarize read + compact write + post-compact replay. */
  compactCost?: number;
  reason: string;
}

export interface CompactionSignalInput {
  boundaryLabel: string;
  continuationContext: string;
  prefixTokens: number;
  remainingTurnsEstimate: number;
  cacheWriteReadRatio: number;
  windowPressure: number;
  /** Override the default minimum projected-saving ratio (0.2). */
  minSavingRatio?: number;
}

export interface CompactionSignal {
  recommend: boolean;
  boundaryLabel: string;
  continuationContext: string;
  projectedSaving: number;
  replayCost?: number;
  compactCost?: number;
  reason: string;
}

/**
 * Caller-supplied observation of the host's context window. Every field is
 * optional: GraphFlow never fabricates pressure. A usable signal is either a
 * finite `pressureRatio`, or `usedTokens` + `maxTokens` with maxTokens > 0.
 */
export interface ObservedContextUsage {
  usedTokens?: number;
  maxTokens?: number;
  pressureRatio?: number;
  /** Projected number of turns still to run; enables the compaction signal. */
  remainingTurnsEstimate?: number;
}

/**
 * Convert an optional caller observation into a {@link ContextPressure}, or
 * `undefined` when the observation carries no usable signal.
 */
export function toContextPressure(usage?: ObservedContextUsage): ContextPressure | undefined {
  if (!usage) return undefined;
  const ratio = Number.isFinite(usage.pressureRatio) ? (usage.pressureRatio as number) : Number.NaN;
  const usedTokens = Number.isFinite(usage.usedTokens) ? (usage.usedTokens as number) : Number.NaN;
  const maxTokens = Number.isFinite(usage.maxTokens) ? (usage.maxTokens as number) : Number.NaN;
  // A usable signal is an explicit ratio, or BOTH token counts — never a
  // defaulted zero standing in for an unobserved value.
  const hasRatio = Number.isFinite(ratio);
  const hasTokens = Number.isFinite(usedTokens) && Number.isFinite(maxTokens) && maxTokens > 0;
  if (!hasRatio && !hasTokens) return undefined;

  const resolved = resolvePressureRatio({
    usedTokens: Number.isFinite(usedTokens) ? usedTokens : 0,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0,
    pressureRatio: ratio,
  });
  if (!Number.isFinite(resolved)) return undefined;
  return {
    usedTokens: Number.isFinite(usedTokens) ? usedTokens : 0,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0,
    pressureRatio: resolved,
  };
}

/** GraphFlow default context budget (graphPolicy.maxContextTokens). */
const FALLBACK_DEFAULT_MAX = 1500;
/** Auto budget floor: never drop below 25% of the default. */
const AUTO_BUDGET_MIN_RATIO = 0.25;
/** Auto budget ceiling: never exceed 2x the default. */
const AUTO_BUDGET_MAX_MULTIPLIER = 2;
/** Cached-prefix replay is priced at the cache-read discount (0.1x base). */
const CACHE_READ_FACTOR = 0.1;
/**
 * Assumed shrink of an online compact: the rewritten prefix is ~25% of the
 * original (4:1). The rewrite cost must price the COMPACTED output — pricing
 * the full original prefix at the cache-write premium once produced absurd
 * projections (e.g. -1.43M tokens for a 120K prefix).
 */
const DEFAULT_COMPACTION_OUTPUT_RATIO = 0.25;
/** Default minimum projected-saving ratio required to recommend compaction. */
const DEFAULT_MIN_SAVING_RATIO = 0.2;
/** Compaction is only considered once the window is more than half full. */
const WINDOW_PRESSURE_THRESHOLD = 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Coerce to a finite number >= 0, else `fallback`. Guards NaN/Infinity/negatives. */
function toFiniteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sanitizeDefaultMax(defaultMax: number): number {
  return Number.isFinite(defaultMax) && defaultMax > 0
    ? Math.round(defaultMax)
    : FALLBACK_DEFAULT_MAX;
}

/**
 * Resolve the observed pressure ratio to [0, 1]. Prefers the reported ratio;
 * recomputes from used/max tokens when the ratio is not finite. Returns NaN
 * when the observation carries no usable signal at all.
 */
function resolvePressureRatio(observed: ContextPressure): number {
  if (Number.isFinite(observed.pressureRatio)) {
    return clamp(observed.pressureRatio, 0, 1);
  }
  if (
    Number.isFinite(observed.usedTokens) &&
    Number.isFinite(observed.maxTokens) &&
    observed.maxTokens > 0
  ) {
    return clamp(observed.usedTokens / observed.maxTokens, 0, 1);
  }
  return Number.NaN;
}

/**
 * Resolve the effective token budget. A numeric `configuredMax` passes through
 * (rounded; invalid values fall back to the default). `"auto"` scales
 * `defaultMax` by the observed pressure ratio, clamped to
 * [25% of default, 2x default]; without a usable observation it returns
 * `defaultMax`. The result is always a finite integer >= 1.
 */
export function deriveAdaptiveBudget(input: AdaptiveBudgetInput): number {
  const defaultMax = sanitizeDefaultMax(input.defaultMax);

  if (typeof input.configuredMax === "number") {
    return Number.isFinite(input.configuredMax) && input.configuredMax > 0
      ? Math.max(1, Math.round(input.configuredMax))
      : defaultMax;
  }

  if (!input.observed) {
    return defaultMax;
  }

  const ratio = resolvePressureRatio(input.observed);
  if (!Number.isFinite(ratio)) {
    return defaultMax;
  }

  const min = Math.max(1, Math.round(defaultMax * AUTO_BUDGET_MIN_RATIO));
  const max = Math.max(defaultMax, Math.round(defaultMax * AUTO_BUDGET_MAX_MULTIPLIER));
  return clamp(Math.round(defaultMax * ratio), min, max);
}

/**
 * Economic check for online compaction at a boundary.
 *
 * KEEP (do nothing): each remaining turn replays the prefix at the
 * cache-read discount → `remainingTurns * prefixTokens * CACHE_READ_FACTOR`.
 *
 * COMPACT (once): read the prefix once (cache-hit), write the COMPACTED
 * prefix (`~prefixTokens * COMPACTION_OUTPUT_RATIO`) at the cache-write
 * premium, then replay only the compacted prefix for the remaining turns:
 * `prefixTokens * CACHE_READ_FACTOR + compacted * writeReadRatio
 *   + remainingTurns * compacted * CACHE_READ_FACTOR`.
 *
 * Compaction is recommended when the projected saving — normalized by the
 * keep/replay cost — exceeds `minSavingRatio` (default 0.2) AND
 * windowPressure > 0.5, so we never pay the rewrite cost early. All inputs
 * are sanitized; outputs are always finite.
 */
export function evaluateCompaction(input: CompactionInput): CompactionEvaluation {
  const prefixTokens = toFiniteNonNegative(input.prefixTokens, 0);
  const remainingTurns = toFiniteNonNegative(input.remainingTurnsEstimate, 0);
  const writeReadRatio = toFiniteNonNegative(input.cacheWriteReadRatio, 0);
  const windowPressure = clamp(toFiniteNonNegative(input.windowPressure, 0), 0, 1);
  const minSavingRatio =
    input.minSavingRatio !== undefined
      ? clamp(toFiniteNonNegative(input.minSavingRatio, DEFAULT_MIN_SAVING_RATIO), 0, 1)
      : DEFAULT_MIN_SAVING_RATIO;

  const compactedTokens = prefixTokens * DEFAULT_COMPACTION_OUTPUT_RATIO;
  const replayCost = remainingTurns * prefixTokens * CACHE_READ_FACTOR;
  const summarizeRead = prefixTokens * CACHE_READ_FACTOR;
  const compactWrite = compactedTokens * writeReadRatio;
  const postCompactReplay = remainingTurns * compactedTokens * CACHE_READ_FACTOR;
  const compactCost = summarizeRead + compactWrite + postCompactReplay;
  const projectedSaving = replayCost - compactCost;
  const savingRatio = replayCost > 0 ? projectedSaving / replayCost : 0;
  const costBreakdown = `replay ${Math.round(replayCost)} vs compact ${Math.round(compactCost)} (write ${Math.round(compactWrite)} + read ${Math.round(summarizeRead)} + post-compact replay ${Math.round(postCompactReplay)})`;

  if (windowPressure <= WINDOW_PRESSURE_THRESHOLD) {
    return {
      recommend: false,
      projectedSaving,
      replayCost,
      compactCost,
      reason: `window pressure ${windowPressure.toFixed(2)} <= ${WINDOW_PRESSURE_THRESHOLD.toFixed(2)}; compaction deferred until the window is under pressure`,
    };
  }
  if (replayCost <= 0) {
    return {
      recommend: false,
      projectedSaving,
      replayCost,
      compactCost,
      reason: "no future replay cost to amortize (empty prefix or no remaining turns)",
    };
  }
  if (savingRatio <= minSavingRatio) {
    return {
      recommend: false,
      projectedSaving,
      replayCost,
      compactCost,
      reason: `projected saving ${Math.round(projectedSaving)} tokens (${(savingRatio * 100).toFixed(1)}% of replay cost) does not clear minSavingRatio ${minSavingRatio.toFixed(2)} — ${costBreakdown}`,
    };
  }
  return {
    recommend: true,
    projectedSaving,
    replayCost,
    compactCost,
    reason: `projected saving ${Math.round(projectedSaving)} tokens (${(savingRatio * 100).toFixed(1)}% of replay cost) clears minSavingRatio ${minSavingRatio.toFixed(2)} at window pressure ${windowPressure.toFixed(2)} — ${costBreakdown}`,
  };
}

/**
 * Pair a boundary's compaction economics with its handoff payload
 * (`boundaryLabel` + `continuationContext`), so callers can attach the
 * recommendation directly to the boundary record.
 */
export function buildCompactionSignal(input: CompactionSignalInput): CompactionSignal {
  const evaluation = evaluateCompaction({
    prefixTokens: input.prefixTokens,
    remainingTurnsEstimate: input.remainingTurnsEstimate,
    cacheWriteReadRatio: input.cacheWriteReadRatio,
    windowPressure: input.windowPressure,
    ...(input.minSavingRatio !== undefined ? { minSavingRatio: input.minSavingRatio } : {}),
  });
  return {
    recommend: evaluation.recommend,
    boundaryLabel: input.boundaryLabel,
    continuationContext: input.continuationContext,
    projectedSaving: evaluation.projectedSaving,
    ...(evaluation.replayCost !== undefined ? { replayCost: evaluation.replayCost } : {}),
    ...(evaluation.compactCost !== undefined ? { compactCost: evaluation.compactCost } : {}),
    reason: evaluation.reason,
  };
}
