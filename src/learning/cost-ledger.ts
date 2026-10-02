import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import { logger } from "../utils/logger";
import { estimateCostMgc, lookupPrice } from "../routing/model-prices";

/**
 * U1 — cost ledger.
 *
 * One JSONL line per billable event (LLM call or artifact delivery) under
 * `graphflow-out/cost-ledger.jsonl`, so cost is measured from real traffic
 * instead of being reconstructed after the fact. Summaries price each event
 * through the model price table (`model-prices.ts`); events whose
 * provider/model matches no price count as `unpricedCalls` at 0 cost rather
 * than silently skewing the estimate.
 *
 * Governance: the ledger is append-only until it exceeds
 * MAX_LEDGER_LINES_BEFORE_TRIM (4000) lines, then it is read-rewritten once
 * keeping the newest LEDGER_KEEP_LINES (2000) — the same trim-on-write shape
 * as token-savings, so a long-lived workspace cannot grow the file unbounded.
 */

export interface CostEvent {
  /** ISO timestamp of the event. */
  ts: string;
  kind: "llm" | "deliver";
  /** Agent role that triggered the call (llm events). */
  role?: string;
  /** Model tier used (smart/economy). */
  tier?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheWriteTokens?: number;
  sessionId?: string;
  turnSeq?: number;
  /** deliver events: bytes handed to the consumer. */
  deliveredBytes?: number;
  /** Prompt-prefix stability proxy (0..1) when measurable. */
  prefixStability?: number;
}

/** See header — trim once the ledger grows past this many lines. */
export const MAX_LEDGER_LINES_BEFORE_TRIM = 4000;
/** See header — lines kept (newest) after a trim. */
export const LEDGER_KEEP_LINES = 2000;

export interface CostSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  estCostMgc: number;
  /** LLM events with no matching price entry (costed at 0). */
  unpricedCalls: number;
}

export interface SummarizeCostOptions {
  /** Only events at/after now - sinceMs. */
  sinceMs?: number;
  kind?: "llm" | "deliver";
}

/** Test hook: pinned ledger path (see resetCostLedgerForTests). */
let ledgerPathOverride: string | undefined;

function resolveLedgerPath(config: GraphFlowConfig): string {
  if (ledgerPathOverride) return ledgerPathOverride;
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  return join(root, "graphflow-out", "cost-ledger.jsonl");
}

/**
 * Read raw lines; a torn final line (crash mid-append) or any malformed row
 * is skipped, not fatal — the ledger must never take a run down with it.
 */
function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function parseLine(line: string): CostEvent | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<CostEvent>;
    if (
      !parsed ||
      typeof parsed.ts !== "string" ||
      (parsed.kind !== "llm" && parsed.kind !== "deliver")
    ) {
      return undefined;
    }
    return parsed as CostEvent;
  } catch {
    return undefined;
  }
}

/**
 * Append one event to the ledger. Governance (same trim-on-write pattern as
 * token-savings): when the resulting line count exceeds
 * MAX_LEDGER_LINES_BEFORE_TRIM, the file is rewritten keeping only the newest
 * LEDGER_KEEP_LINES lines; the truncation is logged once per occurrence.
 */
export function appendCostEvent(config: GraphFlowConfig, event: CostEvent): void {
  const path = resolveLedgerPath(config);
  const lines = readLines(path);
  lines.push(JSON.stringify(event));
  if (lines.length > MAX_LEDGER_LINES_BEFORE_TRIM) {
    const dropped = lines.length - LEDGER_KEEP_LINES;
    const kept = lines.slice(lines.length - LEDGER_KEEP_LINES);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${kept.join("\n")}\n`, "utf8");
    logger.info(
      `cost-ledger: capped to the newest ${LEDGER_KEEP_LINES} lines ` +
        `(dropped ${dropped} oldest event(s))`
    );
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

/** Read all events; malformed lines are skipped (see readLines). */
export function readCostEvents(config: GraphFlowConfig): CostEvent[] {
  const path = resolveLedgerPath(config);
  const events: CostEvent[] = [];
  for (const line of readLines(path)) {
    const parsed = parseLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

/**
 * Aggregate the ledger. estCostMgc prices each llm event individually via
 * lookupPrice (env overrides included); events with no matching price cost 0
 * and are counted in unpricedCalls. deliver events carry no tokens and are
 * excluded from the cost estimate.
 */
export function summarizeCost(config: GraphFlowConfig, options?: SummarizeCostOptions): CostSummary {
  const events = readCostEvents(config).filter((event) => {
    if (options?.kind && event.kind !== options.kind) return false;
    if (options?.sinceMs !== undefined) {
      const at = Date.parse(event.ts);
      if (!Number.isFinite(at) || at < Date.now() - options.sinceMs) return false;
    }
    return true;
  });

  let promptTokens = 0;
  let completionTokens = 0;
  let cacheHitTokens = 0;
  let estCostMgc = 0;
  let unpricedCalls = 0;

  for (const event of events) {
    promptTokens += event.promptTokens ?? 0;
    completionTokens += event.completionTokens ?? 0;
    cacheHitTokens += event.cacheHitTokens ?? 0;
    if (event.kind !== "llm" || !event.provider || !event.model) continue;
    const price = lookupPrice(event.provider, event.model);
    if (!price) {
      unpricedCalls += 1;
      continue;
    }
    estCostMgc += estimateCostMgc(
      event.promptTokens ?? 0,
      event.completionTokens ?? 0,
      event.cacheHitTokens ?? 0,
      price
    );
  }

  return {
    calls: events.length,
    promptTokens,
    completionTokens,
    cacheHitTokens,
    estCostMgc: Math.round(estCostMgc * 10000) / 10000,
    unpricedCalls,
  };
}

/**
 * Test hook: pin the ledger to `path` (removing any existing file there) so
 * suites are hermetic; call without arguments to restore config-based
 * resolution. Exported for tests only — never call from runtime code.
 */
export function resetCostLedgerForTests(path?: string): void {
  ledgerPathOverride = path;
  if (path && existsSync(path)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // best effort
    }
  }
}
