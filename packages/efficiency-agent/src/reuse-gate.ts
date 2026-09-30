import type { CacheVerdict, ReuseDecision } from "./domain.js";

/**
 * Reuse gate (2.x plan §7): conservative ladder from cache verdicts to one
 * execution decision. Result replay is the strongest outcome and is gated on
 * BOTH a result-cache hit AND a result-safe category — a hit verdict for a
 * write category (bugfix, refactor, ...) can NEVER produce REUSE.
 * 复用门：由各缓存判定收敛为一个保守决策。回放（REUSE）为最强结论，必须
 * 同时满足"结果缓存命中 + 结果安全类目"；写类目即使结果缓存命中也绝不回放。
 *
 * Ladder (first match wins):
 *   1. result hit  + result-safe category          → REUSE   (0.75)
 *   2. context hit + plan hit                      → ADAPT   (0.65)
 *   3. exactly one of context/plan hit             → ADAPT   (0.55)
 *   4. none                                        → FRESH   (0.50)
 */

export interface DecideReuseInput {
  verdicts: CacheVerdict[];
  category: string;
}

const RESULT_SAFE_CATEGORIES: ReadonlySet<string> = new Set(["query", "docs", "config"]);

function firstOfKind(verdicts: CacheVerdict[], kind: CacheVerdict["kind"]): CacheVerdict | undefined {
  return verdicts.find((verdict) => verdict.kind === kind);
}

export function decideReuse(input: DecideReuseInput): ReuseDecision {
  const { verdicts, category } = input;
  const resultVerdict = firstOfKind(verdicts, "result");
  const contextHit = firstOfKind(verdicts, "context")?.hit === true;
  const planHit = firstOfKind(verdicts, "plan")?.hit === true;
  const rationale: string[] = [];

  // Rule 1 — result replay, defensively re-checking the category whitelist:
  // a result verdict alone must never authorize REUSE for write categories.
  if (resultVerdict?.hit === true && RESULT_SAFE_CATEGORIES.has(category)) {
    return {
      reuseMode: "REUSE",
      confidence: 0.75,
      verdicts,
      rationale: [
        `result cache hit and category "${category}" is result-safe → replay cached result`,
      ],
    };
  }
  if (resultVerdict?.hit === true) {
    rationale.push(
      `result verdict hit but category "${category}" is not result-safe → REUSE refused`
    );
  }

  // Rule 2 — both supporting caches hit: adapt the cached context + plan.
  if (contextHit && planHit) {
    return {
      reuseMode: "ADAPT",
      confidence: 0.65,
      verdicts,
      rationale: [
        ...rationale,
        "context and plan caches both hit → adapt cached context/plan",
      ],
    };
  }

  // Rule 3 — partial support: adapt with whichever single cache still hits.
  if (contextHit || planHit) {
    const which = contextHit ? "context" : "plan";
    return {
      reuseMode: "ADAPT",
      confidence: 0.55,
      verdicts,
      rationale: [
        ...rationale,
        `only the ${which} cache hit → adapt with partial cache support`,
      ],
    };
  }

  // Rule 4 — nothing reusable: fresh execution.
  return {
    reuseMode: "FRESH",
    confidence: 0.5,
    verdicts,
    rationale: [...rationale, "no cache hit → fresh execution"],
  };
}
