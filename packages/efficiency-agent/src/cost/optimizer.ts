import type {
  ActionCandidate,
  CostFloor,
  OptimizerDecision,
} from "../domain.js";

/**
 * Deterministic cost-aware action choice (2.x plan §20).
 *
 * 先过地板，再比价格：
 *  - Floor gate, checked in a fixed order (success-rate → fidelity → safety →
 *    evidence). The FIRST violated floor names the rejection reason, one
 *    reason per candidate, no pile-on. Undefined floor entries behave as 0,
 *    and a value exactly at the floor passes (>=).
 *  - Among survivors: argmin cost.value; tie → higher expectedSuccessRate;
 *    tie → lexically smaller id. Fully deterministic, order of input only
 *    matters for the rejected list, which preserves input order.
 *
 * The function never mutates its inputs and returns a copy of the chosen
 * candidate, so callers may treat the decision as owned data.
 */
export function chooseAction(
  candidates: readonly ActionCandidate[],
  floor: CostFloor
): OptimizerDecision {
  const rejected: Array<{ id: string; reason: string }> = [];
  const survivors: ActionCandidate[] = [];

  for (const candidate of candidates) {
    const reason = firstFloorViolation(candidate, floor);
    if (reason === undefined) {
      survivors.push(candidate);
    } else {
      rejected.push({ id: candidate.id, reason });
    }
  }

  const chosen = cheapest(survivors);
  return {
    ...(chosen !== undefined ? { chosen } : {}),
    rejected,
  };
}

/** First violated floor for one candidate, in the fixed check order. */
function firstFloorViolation(
  candidate: ActionCandidate,
  floor: CostFloor
): string | undefined {
  if (candidate.expectedSuccessRate < (floor.minSuccessRate ?? 0)) {
    return "success-rate-below-floor";
  }
  if (candidate.expectedFidelity < (floor.minFidelity ?? 0)) {
    return "fidelity-below-floor";
  }
  if (candidate.safety < (floor.minSafety ?? 0)) {
    return "safety-below-floor";
  }
  if (candidate.evidence < (floor.minEvidence ?? 0)) {
    return "evidence-below-floor";
  }
  return undefined;
}

/** argmin cost.value with success-rate and id tie-breaks; returns a copy. */
function cheapest(survivors: readonly ActionCandidate[]): ActionCandidate | undefined {
  let best: ActionCandidate | undefined = undefined;
  for (const candidate of survivors) {
    if (best === undefined || beats(candidate, best)) {
      best = candidate;
    }
  }
  return best === undefined ? undefined : { ...best, cost: { ...best.cost } };
}

/** Strict preference: cheaper cost, then higher success, then smaller id. */
function beats(candidate: ActionCandidate, incumbent: ActionCandidate): boolean {
  if (candidate.cost.value !== incumbent.cost.value) {
    return candidate.cost.value < incumbent.cost.value;
  }
  if (candidate.expectedSuccessRate !== incumbent.expectedSuccessRate) {
    return candidate.expectedSuccessRate > incumbent.expectedSuccessRate;
  }
  return candidate.id < incumbent.id;
}
