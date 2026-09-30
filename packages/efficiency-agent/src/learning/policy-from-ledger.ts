import { learnPolicy } from "./policy-learner.js";
import {
  summarizeTrajectories,
  type CategoryStats,
  type TrajectoryRecord,
} from "./trajectory.js";
import type { PolicyUpdate } from "../domain.js";

/**
 * §21 closed loop, writer side: turn a substrate decision ledger
 * (graphflow-out/decision-ledger.jsonl) into trajectory records the policy
 * learner can consume, learn a PolicyUpdate, and hand it to the caller to
 * persist as graphflow-out/efficiency-policy.json — which graphflow_run then
 * applies to future advisories.
 *
 * Ledger records are decision-shaped, not run-shaped: rounds/success are not
 * recorded there. The honest mapping below treats each decision as a
 * 1-round trajectory whose `success` is unknown-but-neutral (true) — good
 * enough for tier/execution-mode hysteresis to react to reuse mix, and the
 * docblock says so. When the broker arms land in production, records should
 * carry real rounds/success and this mapping tightens.
 * 账本记录是"决策形"而非"运行形"：轮次/成败不在账本里。诚实映射把每个
 * 决策当作 1 轮、成败未知但中性（true）处理——足以让档位/执行模式的滞回
 * 对复用结构起反应；broker 臂进入生产后应携带真实轮次/成败并收紧此映射。
 */

export interface LedgerDecisionRecord {
  kind?: string;
  taskId?: string;
  taskCategory?: string;
  reuseMode?: string;
  modelTier?: string;
  llmCalls?: number;
  durationMs?: number;
}

export function trajectoryFromLedger(records: LedgerDecisionRecord[]): TrajectoryRecord[] {
  const out: TrajectoryRecord[] = [];
  for (const record of records) {
    if (record.kind !== "decision" || typeof record.taskId !== "string") continue;
    out.push({
      taskId: record.taskId,
      taskCategory: record.taskCategory ?? "unknown",
      startedAt: "1970-01-01T00:00:00.000Z",
      decision: {
        reuseMode: normalizeReuse(record.reuseMode),
        modelTier: normalizeTier(record.modelTier),
      },
      rounds: 1,
      llmCalls: record.llmCalls ?? 0,
      toolCalls: 0,
      cacheHits: record.reuseMode === "ADAPT" || record.reuseMode === "REUSE" ? 1 : 0,
      cacheMisses: record.reuseMode === "FRESH" ? 1 : 0,
      validationPassed: true,
      success: true,
      costMs: record.durationMs ?? 0,
      costTokens: 0,
    });
  }
  return out;
}

function normalizeReuse(value: string | undefined): TrajectoryRecord["decision"]["reuseMode"] {
  return value === "REUSE" || value === "ADAPT" || value === "FRESH" ? value : "FRESH";
}

function normalizeTier(value: string | undefined): TrajectoryRecord["decision"]["modelTier"] {
  return value === "economy" || value === "standard" || value === "heavy" ? value : "economy";
}

/** Ledger text → trajectories → category stats (the learner's input). */
export function summarizeLedger(records: LedgerDecisionRecord[]): CategoryStats[] {
  return summarizeTrajectories(trajectoryFromLedger(records));
}

/** Learn a policy update from ledger records; undefined = no change worth making. */
export function learnPolicyFromLedger(
  records: LedgerDecisionRecord[],
  current?: PolicyUpdate,
  opts?: { minSamples?: number }
): PolicyUpdate | undefined {
  return learnPolicy(summarizeLedger(records), current, opts);
}
