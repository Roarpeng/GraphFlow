import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_OUTPUT_DIR } from "../config/defaults";
import { resolveWorkspacePath } from "../config/paths";
import type { GraphFlowConfig } from "../config/schema";
import type { ReuseMode } from "../core/efficiency-advisory";

/**
 * Decision-cost ledger (2.x groundwork, item 5): the efficiency layer's own
 * bill. Every advisory/contract production appends one record so Shadow-mode
 * acceptance can measure the decision's cost share — "did advising pay for
 * itself?" — from real data instead of assumption.
 *
 * Records follow the measurement contract used by the benchmark trace schema:
 * cost-bearing fields carry provenance, and a `deterministic` decision is
 * billed at zero LLM cost by construction (the marker is trusted because the
 * deterministic layer cannot make model calls).
 */

export interface DecisionLedgerRecord {
  kind: "decision";
  /** ISO timestamp of the decision. */
  at: string;
  /** Advisory task hash (advisoryTaskId) — joins back to the advisory. */
  taskId: string;
  /** Producing surface; v0 only graphflow_run emits advisories. */
  tool: "graphflow_run";
  mode: "shadow";
  reuseMode: ReuseMode;
  modelTier: string;
  /** Measured wall-clock decision cost. */
  durationMs: number;
  /** LLM calls spent on the decision itself (0 when provenance=deterministic). */
  llmCalls: number;
  /** Token cost of the decision itself (0 when provenance=deterministic). */
  tokenCost: number;
  provenance: "deterministic" | "llm";
  /** Free-form context: why this verdict (kept short; details live in advisory). */
  reason?: string;
}

export function resolveDecisionLedgerPath(config: GraphFlowConfig): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  return resolveWorkspacePath(root, `${DEFAULT_OUTPUT_DIR}/decision-ledger.jsonl`);
}

export function decisionLedgerEnabled(): boolean {
  return process.env.GRAPHFLOW_DECISION_LEDGER?.trim() !== "0";
}

/** Append one record. Best-effort by design: ledger IO must never break a run. */
export function appendDecisionLedgerRecord(
  config: GraphFlowConfig,
  record: DecisionLedgerRecord
): { path: string; appended: true } | { path: string; skipped: "disabled" } {
  const path = resolveDecisionLedgerPath(config);
  if (!decisionLedgerEnabled()) {
    return { path, skipped: "disabled" };
  }
  // Cold start: graphflow-out/ may not exist yet on a fresh project.
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return { path, appended: true };
}

export function readDecisionLedger(path: string): DecisionLedgerRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const records: DecisionLedgerRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as DecisionLedgerRecord;
      if (parsed && parsed.kind === "decision") {
        records.push(parsed);
      }
    } catch {
      // A torn final line (crash mid-append) is skipped, not fatal.
    }
  }
  return records;
}

export interface DecisionLedgerSummary {
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalLlmCalls: number;
  totalTokenCost: number;
  byReuseMode: Record<ReuseMode, number>;
}

export function summarizeDecisionLedger(records: DecisionLedgerRecord[]): DecisionLedgerSummary {
  const byReuseMode: Record<ReuseMode, number> = { REUSE: 0, ADAPT: 0, FRESH: 0 };
  let totalDurationMs = 0;
  let totalLlmCalls = 0;
  let totalTokenCost = 0;
  for (const record of records) {
    byReuseMode[record.reuseMode] += 1;
    totalDurationMs += record.durationMs;
    totalLlmCalls += record.llmCalls;
    totalTokenCost += record.tokenCost;
  }
  return {
    count: records.length,
    totalDurationMs,
    avgDurationMs: records.length === 0 ? 0 : Math.round(totalDurationMs / records.length),
    totalLlmCalls,
    totalTokenCost,
    byReuseMode,
  };
}
