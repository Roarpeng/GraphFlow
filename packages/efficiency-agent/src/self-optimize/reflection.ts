import type {
  BrokerResult,
  ReflectionFinding,
  ReuseDecision,
} from "../domain.js";

/** Inputs to one post-run reflection pass (2.x plan §21). */
export interface ReflectInput {
  taskCategory: string;
  decision: ReuseDecision;
  /** Brokered execution result, when the cycle actually ran a worker. */
  result?: BrokerResult;
  totalDurationMs: number;
  budgetMs: number;
}

/**
 * Deterministic reflection rules over one finished task (2.x plan §21).
 * 对一次已结束任务的确定性复盘，无时钟、无随机，同输入同结论。
 *
 * Rules (independent except where noted, emitted in this order):
 *  (a) any cache verdict hit AND (no result or result "completed")
 *      → "cache-win" listing the hit layers;
 *  (b) taskCategory "repetition" AND at least one verdict, all misses
 *      → "cache-miss" listing the missed kinds;
 *  (c) totalDurationMs > budgetMs → "over-budget";
 *  (d) result status "failed" → "quality-floor-miss";
 *  (e) no verdicts at all → "cache-miss" with detail "no-cache-layer"
 *      (regardless of category — the cache layer itself was absent).
 *
 * (a), (b) and (e) are mutually exclusive by construction: a hit excludes
 * all-miss and empty. A hit followed by a non-completed run yields no cache
 * finding at all — the hit did not convert into a win.
 *
 * Every finding's `detail` is one machine-parsable line with a kebab-case
 * prefix ("cache-hit-layers=context,result", "no-cache-layer", ...).
 */
export function reflect(input: ReflectInput): ReflectionFinding[] {
  const findings: ReflectionFinding[] = [];
  const verdicts = input.decision.verdicts;
  const hasVerdicts = verdicts.length > 0;
  const hitKinds = verdicts.filter((verdict) => verdict.hit).map((verdict) => verdict.kind);
  const resultCompleted = input.result === undefined || input.result.status === "completed";

  if (hitKinds.length > 0 && resultCompleted) {
    findings.push({
      kind: "cache-win",
      detail: `cache-hit-layers=${hitKinds.join(",")}`,
    });
  } else if (hasVerdicts && hitKinds.length === 0 && input.taskCategory === "repetition") {
    findings.push({
      kind: "cache-miss",
      detail: `missed-kinds=${verdicts.map((verdict) => verdict.kind).join(",")}`,
    });
  } else if (!hasVerdicts) {
    findings.push({
      kind: "cache-miss",
      detail: "no-cache-layer",
    });
  }

  if (input.totalDurationMs > input.budgetMs) {
    findings.push({
      kind: "over-budget",
      detail: `duration-ms=${input.totalDurationMs};budget-ms=${input.budgetMs}`,
    });
  }

  if (input.result !== undefined && input.result.status === "failed") {
    findings.push({
      kind: "quality-floor-miss",
      detail: `rounds=${input.result.rounds}`,
    });
  }

  return findings;
}
