import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphFlowConfig } from "../config/schema";

/**
 * Cumulative token savings tracker.
 *
 * Records each context compression / task run and provides aggregate
 * statistics so users can quantify ROI (return on investment) of using
 * GraphFlow's context compression.
 *
 * Stats are persisted to graphflow-out/token-savings.json as a simple
 * append-only log with aggregate counters.
 *
 * `savingsPercent` is packaging ROI (estimated-raw vs compressed tokens).
 * It is not retrieval Hit@k, body coverage, or lossless source fidelity —
 * see `explainSavings()` and record `kind: "tokens-not-fidelity"`.
 */

export const SAVINGS_NOT_FIDELITY_NOTE =
  "savings is not body fidelity; expand File for full source";

export interface SavingsRecord {
  timestamp: string;
  query: string;
  rawTokens: number;
  compressedTokens: number;
  savingsPercent: number;
  source: "preview_context" | "run";
  /** Distinguishes token ROI from information fidelity (Hit@k / body coverage). */
  kind?: "tokens-not-fidelity";
}

export interface SavingsStats {
  totalRuns: number;
  totalRawTokens: number;
  totalCompressedTokens: number;
  totalSavedTokens: number;
  /** Packaging ROI only — not retrieval Hit@k or source-body coverage. */
  averageSavingsPercent: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  recentRecords: SavingsRecord[];
}

/**
 * Explain that token savings is not information fidelity.
 * Preview summaries are pointers; expand File (or Read) for full source.
 */
export function explainSavings(): string {
  return (
    "savingsPercent is token packaging ROI (estimated-raw vs compressed), " +
    "not retrieval Hit@k or source-body coverage. Preview is pointers; " +
    `${SAVINGS_NOT_FIDELITY_NOTE}.`
  );
}

const MAX_RECENT_RECORDS = 50;

function resolveStatsPath(config: GraphFlowConfig): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  return join(root, "graphflow-out", "token-savings.json");
}

function loadStats(statsPath: string): SavingsStats {
  if (!existsSync(statsPath)) {
    return {
      totalRuns: 0,
      totalRawTokens: 0,
      totalCompressedTokens: 0,
      totalSavedTokens: 0,
      averageSavingsPercent: 0,
      firstRunAt: null,
      lastRunAt: null,
      recentRecords: [],
    };
  }

  try {
    const raw = readFileSync(statsPath, "utf8");
    const parsed = JSON.parse(raw) as SavingsStats;
    return {
      totalRuns: parsed.totalRuns ?? 0,
      totalRawTokens: parsed.totalRawTokens ?? 0,
      totalCompressedTokens: parsed.totalCompressedTokens ?? 0,
      totalSavedTokens: parsed.totalSavedTokens ?? 0,
      averageSavingsPercent: parsed.averageSavingsPercent ?? 0,
      firstRunAt: parsed.firstRunAt ?? null,
      lastRunAt: parsed.lastRunAt ?? null,
      recentRecords: parsed.recentRecords ?? [],
    };
  } catch {
    return {
      totalRuns: 0,
      totalRawTokens: 0,
      totalCompressedTokens: 0,
      totalSavedTokens: 0,
      averageSavingsPercent: 0,
      firstRunAt: null,
      lastRunAt: null,
      recentRecords: [],
    };
  }
}

function saveStats(statsPath: string, stats: SavingsStats): void {
  mkdirSync(dirname(statsPath), { recursive: true });
  writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");
}

/**
 * Record a single savings event and update cumulative stats.
 *
 * @param config GraphFlow config
 * @param record The savings record to append
 */
export function recordSavings(config: GraphFlowConfig, record: SavingsRecord): void {
  const statsPath = resolveStatsPath(config);
  const stats = loadStats(statsPath);
  const stored: SavingsRecord = {
    ...record,
    kind: record.kind ?? "tokens-not-fidelity",
  };

  stats.totalRuns += 1;
  stats.totalRawTokens += stored.rawTokens;
  stats.totalCompressedTokens += stored.compressedTokens;
  stats.totalSavedTokens += stored.rawTokens - stored.compressedTokens;
  stats.averageSavingsPercent =
    stats.totalRawTokens > 0
      ? Math.round((stats.totalSavedTokens / stats.totalRawTokens) * 100)
      : 0;
  stats.firstRunAt = stats.firstRunAt ?? stored.timestamp;
  stats.lastRunAt = stored.timestamp;

  stats.recentRecords.unshift(stored);
  if (stats.recentRecords.length > MAX_RECENT_RECORDS) {
    stats.recentRecords = stats.recentRecords.slice(0, MAX_RECENT_RECORDS);
  }

  saveStats(statsPath, stats);
}

/**
 * Get cumulative savings statistics.
 *
 * @param config GraphFlow config
 */
export function getSavingsStats(config: GraphFlowConfig): SavingsStats {
  return loadStats(resolveStatsPath(config));
}

/**
 * Reset all savings statistics.
 *
 * @param config GraphFlow config
 */
export function resetSavingsStats(config: GraphFlowConfig): { path: string; reset: boolean } {
  const statsPath = resolveStatsPath(config);
  if (!existsSync(statsPath)) {
    return { path: statsPath, reset: false };
  }

  const empty: SavingsStats = {
    totalRuns: 0,
    totalRawTokens: 0,
    totalCompressedTokens: 0,
    totalSavedTokens: 0,
    averageSavingsPercent: 0,
    firstRunAt: null,
    lastRunAt: null,
    recentRecords: [],
  };
  saveStats(statsPath, empty);
  return { path: statsPath, reset: true };
}
