/**
 * Query-intent routing — a LightRAG-style "dual-level" analog.
 *
 * LightRAG separates low-level (entity/symbol) retrieval from high-level
 * (topic/module) retrieval; here the same idea is expressed as a deterministic
 * intent classification over the query text that MAY rewrite retrieval knobs
 * the caller left unset:
 *
 * - `"impact"`        → multi-hop neighborhood need → `expansionStrategy: "ppr"`
 *                       (Personalized PageRank expansion surfaces indirect
 *                       callers/dependents plain BFS misses).
 * - `"module-overview"` → architecture/map need → boosted L2 module quota
 *                       (through the existing `layerQuota` plumbing).
 * - `"symbol"`        → keep L1 priority — keyword recall already ranks exact
 *                       symbol matches first, so routing is a deliberate no-op.
 *
 * Routing only fires at confidence >= {@link INTENT_ROUTE_CONFIDENCE_THRESHOLD}
 * (0.6). Below that — and for any knob the caller set explicitly — behavior is
 * EXACTLY today's. That gate is what keeps the retrieval golden baseline
 * (`tests/retrieval-golden.test.ts`) stable: broad English words like "impact"
 * or a lone "module" score below the threshold and never reroute anything.
 */

import type { LayeredPackageOptions } from "./context-slicer-types.js";

export type QueryIntent = "symbol" | "module-overview" | "impact" | "general";

export interface QueryIntentClassification {
  intent: QueryIntent;
  /** 0..1 match strength; only classifications >= INTENT_ROUTE_CONFIDENCE_THRESHOLD reroute. */
  confidence: number;
  /** Signal ids that fired, most specific first (debugging / tests). */
  signals: string[];
}

/** Routing gate: below this confidence the caller's (or default) options are returned untouched. */
export const INTENT_ROUTE_CONFIDENCE_THRESHOLD = 0.6;

/**
 * L2 quota floor applied by module-overview routing. Under the packer's
 * default quotas (all `Infinity`) the floor can never bind — routing is a
 * no-op by construction — but it guarantees L2 stays generous the moment any
 * caller profile introduces finite default quotas.
 */
export const MODULE_OVERVIEW_L2_QUOTA_FLOOR = 8;

/** Combining rule: strongest signal + a step per additional distinct signal, capped. */
const EXTRA_SIGNAL_STEP = 0.1;
const CONFIDENCE_CAP = 0.9;

interface IntentSignal {
  id: string;
  pattern: RegExp;
  weight: number;
}

/** Single-token queries made only of these generic words are never "symbol" intents. */
const GENERIC_SINGLE_WORDS = new Set([
  "what", "where", "when", "why", "how", "who", "this", "that", "these", "those",
  "help", "please", "find", "show", "list", "overview", "error", "bug", "test",
  "fix", "issue", "usage", "example", "docs", "readme", "todo", "main", "index",
]);

const SYMBOL_SIGNALS: readonly IntentSignal[] = [
  { id: "quoted-identifier", pattern: /["'`][^"'`\s]{2,64}["'`]/, weight: 0.8 },
  { id: "definition", pattern: /定义|definition|where[^.?;]{0,40}declared|符号/i, weight: 0.65 },
];

const MODULE_OVERVIEW_SIGNALS: readonly IntentSignal[] = [
  { id: "which-files-cjk", pattern: /涉及哪些|哪些文件/, weight: 0.75 },
  { id: "architecture-cjk", pattern: /架构/, weight: 0.65 },
  { id: "module-cjk", pattern: /模块/, weight: 0.6 },
  { id: "architecture-en", pattern: /\barchitectures?\b/i, weight: 0.55 },
  { id: "module-en", pattern: /\bmodules?\b/i, weight: 0.5 },
  { id: "overview-en", pattern: /\boverview\b/i, weight: 0.5 },
];

const IMPACT_SIGNALS: readonly IntentSignal[] = [
  { id: "who-calls-cjk", pattern: /谁调用|被谁调/, weight: 0.75 },
  { id: "references-of", pattern: /references\s+of/i, weight: 0.7 },
  { id: "used-by", pattern: /\bused\s+by\b/i, weight: 0.65 },
  { id: "callers", pattern: /\bcallers?\b/i, weight: 0.65 },
  { id: "refs-cjk", pattern: /引用/, weight: 0.6 },
  { id: "impact-cjk", pattern: /影响/, weight: 0.6 },
  { id: "impact-en", pattern: /\bimpact\b/i, weight: 0.55 },
  { id: "depends", pattern: /\bdepends\b/i, weight: 0.55 },
];

/** Tie-break priority when several intents score equally: most specific retrieval need first. */
const INTENT_PRIORITY: readonly QueryIntent[] = ["symbol", "impact", "module-overview"];

function scoreSignals(
  signals: readonly IntentSignal[],
  haystack: string
): { confidence: number; matched: string[] } {
  let max = 0;
  const matched: string[] = [];
  for (const signal of signals) {
    if (signal.pattern.test(haystack)) {
      matched.push(signal.id);
      if (signal.weight > max) max = signal.weight;
    }
  }
  if (matched.length === 0) return { confidence: 0, matched };
  return {
    confidence: Math.min(CONFIDENCE_CAP, max + (matched.length - 1) * EXTRA_SIGNAL_STEP),
    matched,
  };
}

/**
 * True when the whole string is ONE distinctive identifier token — e.g.
 * `expandSubgraph`, `bm25_search`, `context-slicer`, `logger.warn`. Generic
 * English words ("what", "overview", "index") do not count.
 */
function isDistinctiveIdentifierToken(text: string): boolean {
  const token = text.trim();
  if (token.length < 3 || token.length > 64 || /\s/.test(token)) return false;
  if (!/^[A-Za-z_$][A-Za-z0-9_$.#@-]*$/.test(token)) return false;
  if (GENERIC_SINGLE_WORDS.has(token.toLowerCase())) return false;
  // Distinctive = shaped like an identifier (case boundary / separator / dotted
  // member access) or a plain word that is at least 4 chars and not generic.
  return (
    /[\p{Ll}][\p{Lu}]/u.test(token) ||
    /[_$.-]/.test(token) ||
    /^[a-z]{4,}$/i.test(token)
  );
}

/**
 * Classify a retrieval query into one of four intents using deterministic
 * heuristics (regex signals + identifier shape). Pure function: same input,
 * same output, no graph access.
 *
 * Confidence scales with match strength: one strong phrase (e.g. 谁调用, a
 * quoted identifier) reaches 0.75–0.8 on its own; weak/ambiguous words
 * (English "impact", "module", "overview") stay at 0.5–0.55 and need a second
 * signal before they cross the routing threshold. Multi-signal queries gain
 * +0.1 per additional distinct signal, capped at 0.9.
 *
 * "general" (no signal fired) reports 0.5 for a non-empty query — below the
 * routing threshold, so low-confidence classification never changes defaults.
 */
export function classifyQueryIntent(
  query: string,
  englishQuery?: string
): QueryIntentClassification {
  const primary = query.trim();
  const secondary = englishQuery?.trim() ?? "";
  if (!primary && !secondary) {
    return { intent: "general", confidence: 0, signals: [] };
  }

  // Pattern signals scan the combined text (a CJK query plus its translated
  // English terms), exactly like composeContextQuery downstream.
  const haystack = `${primary}\n${secondary}`;
  const symbol = scoreSignals(SYMBOL_SIGNALS, haystack);
  const moduleOverview = scoreSignals(MODULE_OVERVIEW_SIGNALS, haystack);
  const impact = scoreSignals(IMPACT_SIGNALS, haystack);

  // The single-identifier shape rule applies per field (a translated term list
  // is never "one token"), whichever field satisfies it.
  if (isDistinctiveIdentifierToken(primary) || isDistinctiveIdentifierToken(secondary)) {
    if (!symbol.matched.includes("single-identifier")) {
      symbol.matched.push("single-identifier");
    }
    symbol.confidence = Math.min(CONFIDENCE_CAP, Math.max(symbol.confidence, 0.6) + EXTRA_SIGNAL_STEP);
  }

  const scored: Array<{ intent: QueryIntent; confidence: number; matched: string[] }> = [
    { intent: "symbol", confidence: symbol.confidence, matched: symbol.matched },
    { intent: "impact", confidence: impact.confidence, matched: impact.matched },
    { intent: "module-overview", confidence: moduleOverview.confidence, matched: moduleOverview.matched },
  ];
  scored.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      INTENT_PRIORITY.indexOf(a.intent) - INTENT_PRIORITY.indexOf(b.intent)
  );

  const best = scored[0]!;
  if (best.confidence <= 0) {
    return { intent: "general", confidence: primary || secondary ? 0.5 : 0, signals: [] };
  }
  return { intent: best.intent, confidence: best.confidence, signals: best.matched };
}

/**
 * Raise an L2 quota without ever lowering it (module-overview boost).
 * Pure helper; `Infinity` stays `Infinity`.
 */
export function boostL2Quota(
  quota: { l1: number; l2: number; l3: number },
  floor: number = MODULE_OVERVIEW_L2_QUOTA_FLOOR
): { l1: number; l2: number; l3: number } {
  return { l1: quota.l1, l2: Math.max(quota.l2, floor), l3: quota.l3 };
}

/** Effective per-layer quotas when the caller sets none (mirrors `createPackState` defaults). */
const DEFAULT_EFFECTIVE_QUOTA = {
  l1: Number.POSITIVE_INFINITY,
  l2: Number.POSITIVE_INFINITY,
  l3: Number.POSITIVE_INFINITY,
};

/**
 * Apply classified intent to packaging options. Behavior contract:
 *
 * - Returns the SAME options reference (possibly `undefined`) when nothing
 *   routed: general intent, confidence below
 *   {@link INTENT_ROUTE_CONFIDENCE_THRESHOLD}, `"symbol"` intent (deliberate
 *   no-op — L1 exact-symbol priority is already the default), or the relevant
 *   knob was set explicitly by the caller (caller always wins).
 * - `"impact"` (>= 0.6) + no explicit `expansionStrategy` → `expansionStrategy: "ppr"`.
 * - `"module-overview"` (>= 0.6) + no explicit `layerQuota` → L2-boosted quota.
 *   Under today's default infinite quotas this is provably a no-op (the floor
 *   cannot exceed `Infinity`); it exists so overview queries keep a generous
 *   L2 allocation the moment any caller profile introduces finite quotas.
 */
export function routeLayeredOptions(
  query: string,
  englishQuery: string | undefined,
  options: LayeredPackageOptions | undefined
): LayeredPackageOptions | undefined {
  const { intent, confidence } = classifyQueryIntent(query, englishQuery);
  if (confidence < INTENT_ROUTE_CONFIDENCE_THRESHOLD) {
    return options;
  }
  if (intent === "impact" && options?.expansionStrategy === undefined) {
    return { ...(options ?? {}), expansionStrategy: "ppr" };
  }
  if (intent === "module-overview" && options?.layerQuota === undefined) {
    return { ...(options ?? {}), layerQuota: boostL2Quota(DEFAULT_EFFECTIVE_QUOTA) };
  }
  return options;
}
