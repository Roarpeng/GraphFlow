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
export const CONTEXT_ABSTAIN_ENV = "GRAPHFLOW_ABSTAIN";
/** Host-contributed prefix tokens (system + tool schemas + history) we cannot see. */
export const STATIC_PREFIX_TOKENS_ENV = "GRAPHFLOW_STATIC_PREFIX_TOKENS";

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
  cacheReadRatio?: number;
  cacheWriteRatio?: number;
  minCacheableTokens?: number;
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
  cacheReadRatio?: number;
  cacheWriteRatio?: number;
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

export interface ContextEconomics {
  churn: PrefixChurn;
  cache: CacheModel;
  cost: CostEstimate;
  attention: AttentionBudget;
  /** The honest headline: prefill shrank, but did the prefix survive? */
  stablePrefixTokens: number;
  verdict: "cache-safe" | "prefix-churn" | "cache-cold";
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
  windowTokens?: number;
  pricePerMTokIn?: number;
}): ContextEconomics {
  const churn = computePrefixChurn(input.previousLines, input.currentLines);
  const packageTokens = Math.max(0, input.packageTokens);
  const staticPrefixTokens = Math.max(0, input.staticPrefixTokens ?? 0);
  const prefixTokens = staticPrefixTokens + packageTokens;
  // Only OUR slice can churn. The host's static prefix (system + tool schemas +
  // history) precedes the insertion point and is cacheable by construction.
  const churnTokens = Math.min(prefixTokens, Math.round(packageTokens * churn.churnRatio));
  const cache = estimateCacheModel({ prefixTokens, churnTokens });
  const cost = estimateInputCost({
    freshTokens: cache.freshTokens,
    cachedTokens: cache.cachedTokens,
    pricePerMTokIn: input.pricePerMTokIn ?? DEFAULT_INPUT_PRICE_PER_MTOK,
  });
  const attention = assessAttentionBudget({
    usedTokens: prefixTokens,
    windowTokens: input.windowTokens ?? DEFAULT_WINDOW_TOKENS,
  });
  const verdict: ContextEconomics["verdict"] = !cache.cacheUsable
    ? "cache-cold"
    : churn.firstObservation
      ? "cache-safe"
      : churn.churnRatio === 0
        ? "cache-safe"
        : "prefix-churn";
  return { churn, cache, cost, attention, stablePrefixTokens: cache.cachedTokens, verdict };
}
