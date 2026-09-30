/**
 * P4 Policy learner (2.x plan §18): pure, deterministic statistics over
 * CategoryStats → one PolicyUpdate step. NO model training.
 *
 * P4 策略学习器：对分类统计做确定性规则推导，每次只走一步（one step at a
 * time），并带迟滞（hysteresis）——升级容易、降级难，避免单批好数据让
 * 策略来回翻转（flip-flop）。
 *
 * Rules (all thresholds inclusive/exclusive exactly as written):
 *  - Sample gate: stats with samples < minSamples never drive ANY change.
 *  - Escalate model tier when successRate < 0.7: economy→standard,
 *    standard→heavy; heavy stays heavy. One step per learn call.
 *  - De-escalate only when successRate >= 0.9 AND samples >= 2 × minSamples:
 *    heavy→standard, standard→economy.
 *  - executionMode "loop" when avgRounds > 1.5; back to "one-shot" when
 *    avgRounds <= 1.2 AND samples >= 2 × minSamples (dead zone 1.2–1.5 keeps
 *    the current mode).
 *  - avoidPatterns: failure stages covering >= 30% of a category's samples
 *    join as "avoid:<category>:<stage>" — union with the current policy,
 *    deduped and sorted. Patterns are never removed by the learner.
 *  - Unchanged entries are copied from `current`; rationale lines exist only
 *    for actual changes; zero changes → undefined (caller keeps the policy).
 *  - Version is always current version + 1 (version 0 base when no current).
 */

import type { PolicyUpdate } from "../domain.js";
import type { CategoryStats } from "./trajectory.js";

export interface LearnPolicyOptions {
  /**
   * Per-call override of the sample gate. Default: the current policy's
   * minSamples, or 5 when there is no current policy. When the effective
   * value differs from the current policy's stored minSamples, the resulting
   * policy carries the new value and records a rationale line.
   */
  minSamples?: number;
}

type ModelTier = PolicyUpdate["modelTierByCategory"][string];
type ExecutionMode = PolicyUpdate["executionModeByCategory"][string];

const DEFAULT_MIN_SAMPLES = 5;
const ESCALATE_BELOW = 0.7;
const DEESCALATE_AT = 0.9;
const DEESCALATE_SAMPLE_MULTIPLE = 2;
const LOOP_ABOVE_AVG_ROUNDS = 1.5;
const ONESHOT_AT_AVG_ROUNDS = 1.2;
const AVOID_SHARE = 0.3;

const TIER_UP: Record<ModelTier, ModelTier> = {
  economy: "standard",
  standard: "heavy",
  heavy: "heavy",
};
const TIER_DOWN: Record<ModelTier, ModelTier> = {
  economy: "economy",
  standard: "economy",
  heavy: "standard",
};

/** Round to 2 decimals so rationale lines (and tests) stay stable. */
const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Learn one policy step. Returns the next PolicyUpdate, or undefined when the
 * stats justify no change (the caller then keeps the current policy as is).
 */
export function learnPolicy(
  stats: readonly CategoryStats[],
  current?: PolicyUpdate,
  opts?: LearnPolicyOptions
): PolicyUpdate | undefined {
  const minSamples =
    opts?.minSamples !== undefined
      ? Math.max(1, Math.floor(opts.minSamples))
      : (current?.minSamples ?? DEFAULT_MIN_SAMPLES);

  // Copies of the current policy's entries; only actual changes get written
  // back, so unchanged categories survive verbatim.
  const modelTierByCategory: Record<string, ModelTier> = {
    ...(current?.modelTierByCategory ?? {}),
  };
  const executionModeByCategory: Record<string, ExecutionMode> = {
    ...(current?.executionModeByCategory ?? {}),
  };
  const avoidPatterns = new Set<string>(current?.avoidPatterns ?? []);
  const rationale: string[] = [];

  // Iterate categories in name order so output is order-independent.
  const ordered = [...stats].sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : 0
  );

  for (const s of ordered) {
    if (s.samples < minSamples) {
      continue;
    }

    // ── model tier: escalate below 0.7, de-escalate at 0.9 with 2× samples ──
    const tier: ModelTier = modelTierByCategory[s.category] ?? "economy";
    if (s.successRate < ESCALATE_BELOW && tier !== "heavy") {
      const next = TIER_UP[tier];
      modelTierByCategory[s.category] = next;
      rationale.push(
        `${s.category}: successRate ${fmt(s.successRate)} < ${ESCALATE_BELOW} over ${s.samples} samples — escalate model tier ${tier}→${next}`
      );
    } else if (
      s.successRate >= DEESCALATE_AT &&
      s.samples >= DEESCALATE_SAMPLE_MULTIPLE * minSamples &&
      tier !== "economy"
    ) {
      const next = TIER_DOWN[tier];
      modelTierByCategory[s.category] = next;
      rationale.push(
        `${s.category}: successRate ${fmt(s.successRate)} >= ${DEESCALATE_AT} over ${s.samples} samples (>= ${DEESCALATE_SAMPLE_MULTIPLE}×${minSamples}) — de-escalate model tier ${tier}→${next}`
      );
    }

    // ── execution mode: loop above 1.5 avg rounds; one-shot back at <= 1.2 ──
    const mode: ExecutionMode = executionModeByCategory[s.category] ?? "one-shot";
    if (s.avgRounds > LOOP_ABOVE_AVG_ROUNDS) {
      if (mode !== "loop") {
        executionModeByCategory[s.category] = "loop";
        rationale.push(
          `${s.category}: avgRounds ${fmt(s.avgRounds)} > ${LOOP_ABOVE_AVG_ROUNDS} — execution mode loop`
        );
      }
    } else if (
      s.avgRounds <= ONESHOT_AT_AVG_ROUNDS &&
      s.samples >= DEESCALATE_SAMPLE_MULTIPLE * minSamples
    ) {
      if (mode === "loop") {
        executionModeByCategory[s.category] = "one-shot";
        rationale.push(
          `${s.category}: avgRounds ${fmt(s.avgRounds)} <= ${ONESHOT_AT_AVG_ROUNDS} over ${s.samples} samples (>= ${DEESCALATE_SAMPLE_MULTIPLE}×${minSamples}) — execution mode one-shot`
        );
      }
    }

    // ── avoid patterns: any failure stage covering >= 30% of samples ──
    for (const { stage, count } of s.failureStages) {
      if (count / s.samples >= AVOID_SHARE) {
        const pattern = `avoid:${s.category}:${stage}`;
        if (!avoidPatterns.has(pattern)) {
          avoidPatterns.add(pattern);
          rationale.push(
            `${s.category}: failure stage "${stage}" in ${count}/${s.samples} samples (${fmt(count / s.samples)}) — avoid pattern ${pattern}`
          );
        }
      }
    }
  }

  if (
    current !== undefined &&
    minSamples !== current.minSamples
  ) {
    rationale.unshift(
      `minSamples: ${current.minSamples}→${minSamples} (learn options override)`
    );
  }

  if (rationale.length === 0) {
    return undefined;
  }

  return {
    version: (current?.version ?? 0) + 1,
    minSamples,
    modelTierByCategory,
    executionModeByCategory,
    avoidPatterns: [...avoidPatterns].sort(),
    rationale,
  };
}
