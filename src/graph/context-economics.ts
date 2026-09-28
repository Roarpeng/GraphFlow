/**
 * Context economics: the measurement axis GraphFlow did not have.
 *
 * Compressing the prompt is only half the bill. The other half is prompt-cache
 * locality: a provider caches the request prefix, so injecting a *different*
 * context package every turn invalidates the cache from the divergence point on.
 * Cutting prefill tokens while churning the prefix can cost more than it saves.
 * These helpers make prefix churn, cache reuse, real input cost and the
 * attention budget (context rot) first-class, computable quantities.
 */

export const CONTEXT_ECONOMICS_ENV = "GRAPHFLOW_CONTEXT_ECONOMICS";
/**
 * Cache economics are provider-specific, and the defaults used to be one
 * provider's numbers applied to everyone.
 *
 * That was measured, not assumed. A real-provider A/B
 * (benchmarks/cache-placement-ab.ts, DeepSeek) showed:
 *
 *  - DeepSeek charges **no cache-write premium** at all, and its cache read is
 *    ~2% of the miss price — not 10%. Charging Anthropic's 1.25x write and 0.1x
 *    read overstates the churn penalty by ~17% and understates what a cache hit
 *    is worth by 5x on that provider.
 *  - OpenAI caches automatically and, before GPT-5.6, wrote for free.
 *  - The write premium is a *choice of TTL* at Anthropic (1.25x for 5 minutes,
 *    2x for 1 hour), not a constant of nature.
 *
 * So the ratios are a property of (provider, model), not of caching. Only the
 * values verified against a vendor page or a live usage payload are listed;
 * anything else falls back to a labelled conservative default rather than an
 * invented number.
 */
export interface ProviderCacheProfile {
  id: string;
  /** Cost of reading a cached token, as a fraction of the miss price. */
  cacheReadRatio: number;
  /**
   * Effective cost of a token that must be (re)written, premium included.
   * 1.0 means "full input price, no premium" — which is most providers, and not
   * what the old default of 1.25 assumed.
   */
  cacheWriteRatio: number;
  pricePerMTokIn: number;
  /** Where the numbers came from. Surfaced so a stale table is auditable. */
  source: string;
  /** False when these are a conservative stand-in rather than a quoted rate. */
  verified: boolean;
}

export const CACHE_PROFILES: readonly ProviderCacheProfile[] = [
  {
    id: "deepseek",
    cacheReadRatio: 0.02,
    // Verified via the provider usage payload and the vendor pricing page: the
    // `cache_write` multiplier is 0, so a rewritten token costs plain input.
    cacheWriteRatio: 1.0,
    pricePerMTokIn: 0.15,
    source: "api-docs.deepseek.com pricing; model registry cacheWrite=0",
    verified: true,
  },
  {
    id: "openai",
    cacheReadRatio: 0.1,
    // GPT-5.6+ bills cache writes at 1.25x; earlier families wrote for free.
    cacheWriteRatio: 1.25,
    pricePerMTokIn: 5,
    source: "platform.openai.com prompt caching; GPT-5.6 write premium",
    verified: true,
  },
  {
    id: "anthropic",
    cacheReadRatio: 0.1,
    // 1.25x is the 5-minute TTL, which is the API default. The 1-hour TTL that
    // Claude Code itself selects costs 2x and would double the churn penalty.
    cacheWriteRatio: 1.25,
    pricePerMTokIn: 3,
    source: "platform.claude.com prompt caching multipliers",
    verified: true,
  },
];

/** Used when the provider is unknown. Labelled, not silently presented as fact. */
export const UNKNOWN_CACHE_PROFILE: ProviderCacheProfile = {
  id: "unknown",
  cacheReadRatio: 0.1,
  // Assume a write premium, because assuming its absence would understate the
  // cost of the churn this engine exists to detect.
  cacheWriteRatio: 1.25,
  pricePerMTokIn: 3,
  source: "conservative fallback — no provider profile matched; set one explicitly for real numbers",
  verified: false,
};

export function resolveCacheProfile(provider?: string): ProviderCacheProfile {
  if (!provider) return UNKNOWN_CACHE_PROFILE;
  const needle = provider.trim().toLowerCase();
  const hit = CACHE_PROFILES.find((profile) => needle.includes(profile.id));
  return hit ?? UNKNOWN_CACHE_PROFILE;
}

export const CONTEXT_ABSTAIN_ENV = "GRAPHFLOW_ABSTAIN";
/** Host-contributed prefix tokens (system + tool schemas + history) we cannot see. */
export const STATIC_PREFIX_TOKENS_ENV = "GRAPHFLOW_STATIC_PREFIX_TOKENS";
/** Host tokens rendered after our injection point — the tail our churn re-prices. */
export const SUFFIX_TOKENS_ENV = "GRAPHFLOW_SUFFIX_TOKENS";

/** Provider cache-read price as a fraction of input price (Anthropic: 0.1x). */
export const DEFAULT_CACHE_READ_RATIO = 0.1;
/** Provider cache-write price as a fraction of input price (Anthropic: 1.25x). */
export const DEFAULT_CACHE_WRITE_RATIO = 1.25;
/** Providers ignore cache breakpoints below this many tokens. */
export const DEFAULT_MIN_CACHEABLE_TOKENS = 1024;
/** Context rot sets in well before the window is full; ~70% is the working ceiling. */
export const DEFAULT_ROT_THRESHOLD = 0.7;
/** Working context window assumed when the host does not report one. */
export const DEFAULT_WINDOW_TOKENS = 200_000;
/** Input list price per million tokens, overridable by the caller. */
export const DEFAULT_INPUT_PRICE_PER_MTOK = 3;

function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return !(normalized === "" || normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no" || normalized === "disabled");
}

export function isContextEconomicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[CONTEXT_ECONOMICS_ENV]);
}

export function isAbstentionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyFlag(env[CONTEXT_ABSTAIN_ENV]);
}

/**
 * GraphFlow is not the harness, so it cannot observe the system prompt, tool
 * schemas or history that precede its injection. Those tokens decide whether a
 * provider will cache anything at all, so the caller supplies them. Invalid or
 * missing values degrade to 0 (pure-slice model) rather than guessing.
 */
export function resolveStaticPrefixTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STATIC_PREFIX_TOKENS_ENV]?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Sibling of {@link resolveStaticPrefixTokens} for the tail we invalidate. */
export function resolveSuffixTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SUFFIX_TOKENS_ENV]?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export interface PrefixChurn {
  sharedPrefix: number;
  previousLines: number;
  currentLines: number;
  /** 0..1 — share of the previous package that does NOT survive into this one. */
  churnRatio: number;
  /**
   * True when this process has not injected a package for the workspace yet.
   * Churn is not measurable then; reporting it as 100% would be a lie.
   */
  firstObservation: boolean;
}

export function computePrefixChurn(previous: readonly string[], current: readonly string[]): PrefixChurn {
  const max = Math.min(previous.length, current.length);
  let shared = 0;
  while (shared < max && previous[shared] === current[shared]) shared += 1;
  const firstObservation = previous.length === 0;
  return {
    sharedPrefix: shared,
    previousLines: previous.length,
    currentLines: current.length,
    churnRatio: firstObservation ? 1 : (previous.length - shared) / previous.length,
    firstObservation,
  };
}

export interface CacheModelInput {
  /** Tokens in the request prefix (system + tools + injected context). */
  prefixTokens: number;
  /** Tokens at/after the first divergence — these cannot be served from cache. */
  churnTokens: number;
  cacheReadRatio?: number | undefined;
  cacheWriteRatio?: number | undefined;
  minCacheableTokens?: number | undefined;
}

export interface CacheModel {
  cachedTokens: number;
  freshTokens: number;
  /** Share of prefix tokens served from cache. */
  hitRate: number;
  cacheUsable: boolean;
  note: string;
}

export function estimateCacheModel(input: CacheModelInput): CacheModel {
  const minCacheable = input.minCacheableTokens ?? DEFAULT_MIN_CACHEABLE_TOKENS;
  const prefixTokens = Math.max(0, input.prefixTokens);
  const churnTokens = Math.min(Math.max(0, input.churnTokens), prefixTokens);
  const candidate = prefixTokens - churnTokens;
  if (prefixTokens < minCacheable || candidate < minCacheable) {
    return {
      cachedTokens: 0,
      freshTokens: prefixTokens,
      hitRate: 0,
      cacheUsable: false,
      note:
        candidate < minCacheable
          ? `stable prefix ${candidate} tok is below the provider minimum ${minCacheable} — nothing cacheable`
          : "prefix below provider minimum cacheable size",
    };
  }
  return {
    cachedTokens: candidate,
    freshTokens: churnTokens,
    hitRate: candidate / prefixTokens,
    cacheUsable: true,
    note: `${candidate} of ${prefixTokens} prefix tokens are cache-reusable`,
  };
}

export interface CostInput {
  freshTokens: number;
  cachedTokens: number;
  pricePerMTokIn: number;
  cacheReadRatio?: number | undefined;
  cacheWriteRatio?: number | undefined;
}

export interface CostEstimate {
  baselineUsd: number;
  actualUsd: number;
  savedUsd: number;
  savedRatio: number;
  cacheWriteTaxUsd: number;
}

export function estimateInputCost(input: CostInput): CostEstimate {
  const readRatio = input.cacheReadRatio ?? DEFAULT_CACHE_READ_RATIO;
  const writeRatio = input.cacheWriteRatio ?? DEFAULT_CACHE_WRITE_RATIO;
  const fresh = Math.max(0, input.freshTokens);
  const cached = Math.max(0, input.cachedTokens);
  const total = fresh + cached;
  const baselineUsd = (total / 1_000_000) * input.pricePerMTokIn;
  const freshUsd = (fresh / 1_000_000) * input.pricePerMTokIn;
  const readUsd = (cached / 1_000_000) * input.pricePerMTokIn * readRatio;
  // A cache write is a full-price read plus the write premium on the cached span.
  const writeTaxUsd = (cached / 1_000_000) * input.pricePerMTokIn * (writeRatio - 1);
  const actualUsd = freshUsd + readUsd + writeTaxUsd;
  const savedUsd = baselineUsd - actualUsd;
  return {
    baselineUsd,
    actualUsd,
    savedUsd,
    savedRatio: baselineUsd > 0 ? savedUsd / baselineUsd : 0,
    cacheWriteTaxUsd: writeTaxUsd,
  };
}

export type AttentionLevel = "ok" | "watch" | "high" | "critical";

export interface AttentionBudget {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  level: AttentionLevel;
  note: string;
}

export function assessAttentionBudget(input: {
  usedTokens: number;
  windowTokens: number;
  rotThreshold?: number;
}): AttentionBudget {
  const threshold = input.rotThreshold ?? DEFAULT_ROT_THRESHOLD;
  const used = Math.max(0, input.usedTokens);
  const window = Math.max(1, input.windowTokens);
  const ratio = used / window;
  const level: AttentionLevel = ratio >= threshold ? "critical" : ratio >= threshold * 0.85 ? "high" : ratio >= threshold * 0.6 ? "watch" : "ok";
  const note =
    level === "critical"
      ? `context rot sets in before the window fills — at ${(ratio * 100).toFixed(0)}% of window, clear before you summarize`
      : level === "high"
        ? `approaching the rot threshold (${(ratio * 100).toFixed(0)}% of window)`
        : `attention budget healthy (${(ratio * 100).toFixed(0)}% of window)`;
  return { usedTokens: used, windowTokens: window, ratio, level, note };
}

export interface AbstainInput {
  /** Graph size — the crossover proxy for "can the agent just navigate this?". */
  repoNodeCount: number;
  /** Does the query name a concrete symbol/file the agent could read directly? */
  queryHasConcreteRef: boolean;
  /** Tokens the package would inject if we did not abstain. */
  estimatedPackageTokens: number;
  smallRepoNodes?: number;
  maxPackageTokens?: number;
}

export interface AbstainDecision {
  abstain: boolean;
  reason: string;
}

/**
 * Progressive disclosure buys context, not intelligence: on a small corpus a
 * capable agent locates the passage itself, so a retrieved package is redundant
 * cost *and* a cache-locality break. Abstain only in that narrow case, and say
 * why — silence here would be indistinguishable from the tool being broken.
 */
export function shouldAbstain(input: AbstainInput): AbstainDecision {
  const smallRepoNodes = input.smallRepoNodes ?? 2000;
  const maxPackageTokens = input.maxPackageTokens ?? 400;
  if (input.repoNodeCount > smallRepoNodes) {
    return { abstain: false, reason: `corpus too large to navigate by reading (${input.repoNodeCount} nodes > ${smallRepoNodes})` };
  }
  if (!input.queryHasConcreteRef) {
    return { abstain: false, reason: "query has no concrete ref — retrieval still beats blind navigation" };
  }
  if (input.estimatedPackageTokens > maxPackageTokens) {
    return {
      abstain: false,
      reason: `package ${input.estimatedPackageTokens} tok exceeds abstention ceiling ${maxPackageTokens} — too big to skip`,
    };
  }
  return {
    abstain: true,
    reason: `small corpus (${input.repoNodeCount} nodes) + concrete ref: direct read is cheaper than a ${input.estimatedPackageTokens} tok package and keeps the prefix stable`,
  };
}

export interface SensitivityPoint {
  suffixTokens: number;
  /** What this turn costs at that tail size. */
  costUsd: number;
  /** Positive means the turn pays for itself after the churn surcharge. */
  netUsd: number;
}

export interface CostSensitivity {
  /**
   * Why this exists: the host's own prefix and tail are not observable from here
   * (we are not the harness), so both come from operator-supplied numbers. A
   * conclusion that rests on one hand-filled value is not a measurement, so this
   * sweeps the plausible range and reports the break-even point instead. If the
   * sign of `netUsd` is the same across the whole sweep, the conclusion does not
   * depend on the guess.
   */
  points: SensitivityPoint[];
  /** Tail size at which churn stops paying for itself, or null if it always does. */
  breakEvenSuffixTokens: number | null;
  /** True when `netUsd` keeps the same sign across every swept point. */
  conclusionIsRobust: boolean;
  note: string;
}

export function computeCostSensitivity(input: {
  staticPrefixTokens: number;
  packageTokens: number;
  churnRatio: number;
  firstObservation: boolean;
  pricePerMTokIn: number;
  cacheReadRatio?: number;
  cacheWriteRatio?: number;
  suffixCandidates?: readonly number[];
}): CostSensitivity {
  const candidates = input.suffixCandidates ?? [0, 2_000, 8_000, 20_000, 50_000, 120_000, 250_000];
  const points: SensitivityPoint[] = candidates.map((suffixTokens) => {
    // Built from the leaf functions, not from buildContextEconomics: this is
    // called *by* buildContextEconomics, and going through the full builder here
    // recurses (each build would sweep again, forever).
    const packageTokens = Math.max(0, input.packageTokens);
    const staticPrefixTokens = Math.max(0, input.staticPrefixTokens);
    const churned = input.firstObservation ? 0 : Math.round(packageTokens * input.churnRatio);
    const cache = estimateCacheModel({
      prefixTokens: staticPrefixTokens + packageTokens,
      churnTokens: churned,
      cacheReadRatio: input.cacheReadRatio,
      cacheWriteRatio: input.cacheWriteRatio,
    });
    const cost = estimateInputCost({
      freshTokens: cache.freshTokens,
      cachedTokens: cache.cachedTokens,
      pricePerMTokIn: input.pricePerMTokIn,
      cacheReadRatio: input.cacheReadRatio,
      cacheWriteRatio: input.cacheWriteRatio,
    });
    const invalidation = estimateSuffixInvalidation({
      suffixTokens,
      churnRatio: input.churnRatio,
      firstObservation: input.firstObservation,
      savedUsd: cost.savedUsd,
      pricePerMTokIn: input.pricePerMTokIn,
      cacheReadRatio: input.cacheReadRatio,
      cacheWriteRatio: input.cacheWriteRatio,
    });
    return {
      suffixTokens,
      costUsd: cost.actualUsd,
      // Net of the churn surcharge: positive means the turn is worth its churn.
      netUsd: -invalidation.overspendUsd,
    };
  });
  const negative = points.find((point) => point.netUsd < 0);
  const positive = points.find((point) => point.netUsd > 0);
  return {
    points,
    breakEvenSuffixTokens: negative?.suffixTokens ?? null,
    conclusionIsRobust: negative === undefined || positive === undefined,
    note:
      input.firstObservation
        ? "first observation in this process — churn is not measurable yet, so every point reflects the same zero-churn turn"
        : `swept tail sizes ${candidates[0]}..${candidates[candidates.length - 1]}; ${
            negative === undefined
              ? "churn pays for itself at every size, so the verdict does not depend on the host's real tail"
              : positive === undefined
                ? "churn is a net loss at every size, so the verdict does not depend on the host's real tail"
                : `the answer flips at ${negative.suffixTokens} — the verdict depends on the host's real tail size, not on the estimate supplied`
          }`,
  };
}

export interface SuffixInvalidation {
  /**
   * Host tokens rendered AFTER our injection point — the conversation history,
   * prior tool results, everything the host will send this turn.
   */
  suffixTokens: number;
  /** Suffix tokens our churn pushed from a 0.1x cache read to a 1.25x write. */
  rewrittenTokens: number;
  /**
   * Dollars added per turn purely by our churn. This is the number that
   * matters, and it is not the package's own cost: a provider invalidates
   * everything after the first differing byte, so our churn re-prices the host's
   * whole tail, not our slice.
   */
  surchargeUsd: number;
  /**
   * What the compression actually saved this turn (uncached baseline minus
   * actual). Compared against `surchargeUsd` to decide whether net economics
   * are positive at all.
   */
  savedUsd: number;
  /** surchargeUsd - savedUsd. Positive means the turn is a net loss. */
  overspendUsd: number;
  note: string;
}

/**
 * The cost our churn imposes on the host, which is the cost everybody forgets.
 *
 * Caching is a left-to-right prefix match: a single differing byte invalidates
 * every token after it, and those tokens must then be re-written at the write
 * premium instead of read at the discount. We inject volatile content, so what
 * our churn actually costs is the re-write of everything downstream of us — the
 * conversation history — not the few hundred tokens of our own package.
 *
 * Measured on this project: a 500 tok package churning 97% per turn against a
 * 50k tok history surcharges ~$0.115/turn at Sonnet 5 pricing while saving
 * ~$0.025. Churn is not merely a lost discount; at a realistic history size it
 * is a net loss, and pricing only our own slice is what made it look harmless.
 */
export function estimateSuffixInvalidation(input: {
  suffixTokens: number;
  churnRatio: number;
  firstObservation: boolean;
  savedUsd: number;
  pricePerMTokIn: number;
  cacheReadRatio?: number | undefined;
  cacheWriteRatio?: number | undefined;
}): SuffixInvalidation {
  const cacheReadRatio = input.cacheReadRatio ?? DEFAULT_CACHE_READ_RATIO;
  const cacheWriteRatio = input.cacheWriteRatio ?? DEFAULT_CACHE_WRITE_RATIO;
  const suffixTokens = Math.max(0, Math.round(input.suffixTokens));
  // On the first observation there is nothing to invalidate: no prior prefix
  // existed to break. Reporting a surcharge there would invent a cost.
  const rewrittenTokens = input.firstObservation ? 0 : Math.round(suffixTokens * input.churnRatio);
  const premium = Math.max(0, cacheWriteRatio - cacheReadRatio);
  const surchargeUsd = (rewrittenTokens * premium * input.pricePerMTokIn) / 1_000_000;
  const savedUsd = input.savedUsd;
  const overspendUsd = surchargeUsd - savedUsd;
  return {
    suffixTokens,
    rewrittenTokens,
    surchargeUsd,
    savedUsd,
    overspendUsd,
    note:
      rewrittenTokens === 0
        ? input.firstObservation
          ? "first observation in this process — no prior prefix to invalidate, churn cost not yet measurable"
          : "no churn: the host's tail keeps its cache-read rate"
        : `our churn re-writes ${rewrittenTokens} tok of the host's tail at ${cacheWriteRatio}x instead of ${cacheReadRatio}x, costing $${surchargeUsd.toFixed(6)}/turn against $${savedUsd.toFixed(6)} saved by compressing`,
  };
}

export interface ContextEconomics {
  churn: PrefixChurn;
  cache: CacheModel;
  cost: CostEstimate;
  attention: AttentionBudget;
  /**
   * What our churn costs the HOST. Reported separately from our own cost
   * because our own cost is the small half of the bill.
   */
  invalidation: SuffixInvalidation;
  /**
   * What the verdict looks like across a range of host tail sizes, so it does
   * not rest on one operator-supplied number we cannot verify.
   */
  sensitivity: CostSensitivity;
  /** The honest headline: prefill shrank, but did the prefix survive? */
  stablePrefixTokens: number;
  /**
   * `cache-break` is the verdict that matters: compression saved less than our
   * own churn cost, so the turn is a net loss and only a stable prefix fixes it.
   */
  verdict: "cache-safe" | "prefix-churn" | "cache-break" | "cache-cold";
}

/**
 * Assemble the full economics of one injected package against the previous turn.
 * `currentLines` is the canonical package line list; `previousLines` is the last
 * one this process injected for the same workspace.
 */
export function buildContextEconomics(input: {
  previousLines: readonly string[];
  currentLines: readonly string[];
  packageTokens: number;
  /**
   * Tokens the host contributes before our injection (system prompt + tool
   * schemas + history). GraphFlow cannot observe these — it is not the harness —
   * so the caller supplies them. Default 0 keeps the pure-slice model, but a
   * realistic cost needs a real number: providers gate caching on the WHOLE
   * request prefix, not on our slice.
   */
  staticPrefixTokens?: number;
  /**
   * Host tokens rendered after our injection point (conversation history, prior
   * tool results). We cannot observe them — we are not the harness — but our
   * churn re-prices every one of them, so the caller supplies the size. Absent
   * or 0 reports only our own slice's cost, which understates the bill by the
   * size of the history.
   */
  suffixTokens?: number;
  windowTokens?: number;
  pricePerMTokIn?: number;
  /**
   * Provider whose cache pricing applies. Overrides the ratio defaults, which
   * are one provider's numbers and were measurably wrong on at least two others.
   */
  provider?: string;
  cacheReadRatio?: number | undefined;
  cacheWriteRatio?: number | undefined;
}): ContextEconomics {
  const profile = resolveCacheProfile(input.provider);
  const cacheReadRatio = input.cacheReadRatio ?? profile.cacheReadRatio;
  const cacheWriteRatio = input.cacheWriteRatio ?? profile.cacheWriteRatio;
  const churn = computePrefixChurn(input.previousLines, input.currentLines);
  const packageTokens = Math.max(0, input.packageTokens);
  const staticPrefixTokens = Math.max(0, input.staticPrefixTokens ?? 0);
  const prefixTokens = staticPrefixTokens + packageTokens;
  // Only OUR slice can churn. The host's static prefix (system + tool schemas +
  // history) precedes the insertion point and is cacheable by construction.
  const churnTokens = Math.min(prefixTokens, Math.round(packageTokens * churn.churnRatio));
  const cache = estimateCacheModel({
    prefixTokens,
    churnTokens,
    cacheReadRatio,
    cacheWriteRatio,
  });
  const pricePerMTokIn = input.pricePerMTokIn ?? profile.pricePerMTokIn;
  const cost = estimateInputCost({
    freshTokens: cache.freshTokens,
    cachedTokens: cache.cachedTokens,
    pricePerMTokIn,
    cacheReadRatio,
    cacheWriteRatio,
  });
  const attention = assessAttentionBudget({
    usedTokens: prefixTokens,
    windowTokens: input.windowTokens ?? DEFAULT_WINDOW_TOKENS,
  });
  const invalidation = estimateSuffixInvalidation({
    suffixTokens: input.suffixTokens ?? 0,
    churnRatio: churn.churnRatio,
    firstObservation: churn.firstObservation,
    savedUsd: cost.savedUsd,
    pricePerMTokIn,
    cacheReadRatio,
    cacheWriteRatio,
  });
  // Net economics first: a package that saves less than its churn costs is a
  // loss no matter how good the hit rate looks.
  const verdict: ContextEconomics["verdict"] = invalidation.overspendUsd > 0
    ? "cache-break"
    : !cache.cacheUsable
      ? "cache-cold"
      : churn.firstObservation
        ? "cache-safe"
        : churn.churnRatio === 0
          ? "cache-safe"
          : "prefix-churn";
  const sensitivity = computeCostSensitivity({
    staticPrefixTokens,
    packageTokens,
    churnRatio: churn.churnRatio,
    firstObservation: churn.firstObservation,
    pricePerMTokIn,
    cacheReadRatio,
    cacheWriteRatio,
  });

  return {
    churn,
    cache,
    cost,
    attention,
    invalidation,
    sensitivity,
    stablePrefixTokens: cache.cachedTokens,
    verdict,
  };
}
