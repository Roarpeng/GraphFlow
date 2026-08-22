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

export interface ContextFidelityRecordInput {
  timestamp?: string;
  query?: string;
  expectedAnchorIds: string[];
  returnedAnchorIds: string[];
  /** Anchor id to the authoritative/source body that should have been packaged. */
  expectedBodies?: Record<string, string>;
  /** Anchor id to the body actually placed into the context package. */
  packagedBodies?: Record<string, string>;
  source?: "preview_context" | "run" | "evaluation";
}

export interface ContextFidelityRecord extends Required<Pick<
  ContextFidelityRecordInput,
  "timestamp" | "query" | "expectedAnchorIds" | "returnedAnchorIds"
>> {
  expectedBodies?: Record<string, string>;
  packagedBodies?: Record<string, string>;
  anchorRecallAtK: number;
  missingAnchorIds: string[];
  /** Normalized LCS similarity over supplied bodies; undefined when no pair is measurable. */
  bodyCoverage?: number;
  source: NonNullable<ContextFidelityRecordInput["source"]>;
}

export interface ContextFidelityStats {
  sampleCount: number;
  averageAnchorRecallPercent: number;
  averageBodyCoveragePercent: number;
  totalExpectedAnchors: number;
  totalReturnedAnchors: number;
  totalMissingAnchors: number;
  bodyCoverageSampleCount: number;
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  recentRecords: ContextFidelityRecord[];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Longest-common-subsequence similarity. Unlike equality or a byte-length
 * ratio, this measures how much of the normalized source survives while
 * allowing reordering-free edits and never rewards unrelated padding.
 */
function calculateBodyCoverage(expected: string, packaged: string): number {
  const left = normalizeText(expected);
  const right = normalizeText(packaged);
  if (!left) return !right ? 1 : 0;
  if (!right) return 0;

  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
    current = new Array<number>(right.length + 1).fill(0);
  }
  return previous[right.length]! / left.length;
}

function emptyContextFidelityStats(): ContextFidelityStats {
  return {
    sampleCount: 0,
    averageAnchorRecallPercent: 0,
    averageBodyCoveragePercent: 0,
    totalExpectedAnchors: 0,
    totalReturnedAnchors: 0,
    totalMissingAnchors: 0,
    bodyCoverageSampleCount: 0,
    firstRecordAt: null,
    lastRecordAt: null,
    recentRecords: [],
  };
}

function resolveFidelityPath(config: GraphFlowConfig): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  return join(root, "graphflow-out", "context-fidelity.json");
}

function loadContextFidelityStats(fidelityPath: string): ContextFidelityStats {
  if (!existsSync(fidelityPath)) return emptyContextFidelityStats();
  try {
    const parsed = JSON.parse(readFileSync(fidelityPath, "utf8")) as Partial<ContextFidelityStats>;
    if (!Array.isArray(parsed.recentRecords)) return emptyContextFidelityStats();
    return { ...emptyContextFidelityStats(), ...parsed, recentRecords: parsed.recentRecords };
  } catch {
    return emptyContextFidelityStats();
  }
}

function saveContextFidelityStats(fidelityPath: string, stats: ContextFidelityStats): void {
  mkdirSync(dirname(fidelityPath), { recursive: true });
  writeFileSync(fidelityPath, JSON.stringify(stats, null, 2), "utf8");
}

function normalizeAnchorIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function recordContextFidelity(
  config: GraphFlowConfig,
  input: ContextFidelityRecordInput
): ContextFidelityRecord {
  const expectedAnchorIds = normalizeAnchorIds(input.expectedAnchorIds);
  const returnedAnchorIds = normalizeAnchorIds(input.returnedAnchorIds);
  const returnedSet = new Set(returnedAnchorIds);
  const missingAnchorIds = expectedAnchorIds.filter((id) => !returnedSet.has(id));
  const anchorRecallAtK =
    expectedAnchorIds.length === 0
      ? 1
      : (expectedAnchorIds.length - missingAnchorIds.length) / expectedAnchorIds.length;

  let bodyCoverageSum = 0;
  let bodyCoverageCount = 0;
  const expectedBodies = input.expectedBodies ?? {};
  const packagedBodies = input.packagedBodies ?? {};
  for (const [anchorId, expectedBody] of Object.entries(expectedBodies)) {
    const packagedBody = packagedBodies[anchorId];
    if (typeof packagedBody !== "string") continue;
    bodyCoverageSum += calculateBodyCoverage(expectedBody, packagedBody);
    bodyCoverageCount += 1;
  }

  const stored: ContextFidelityRecord = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    query: input.query ?? "",
    expectedAnchorIds,
    returnedAnchorIds,
    ...(input.expectedBodies ? { expectedBodies } : {}),
    ...(input.packagedBodies ? { packagedBodies } : {}),
    anchorRecallAtK,
    missingAnchorIds,
    ...(bodyCoverageCount > 0 ? { bodyCoverage: bodyCoverageSum / bodyCoverageCount } : {}),
    source: input.source ?? "evaluation",
  };

  const fidelityPath = resolveFidelityPath(config);
  const stats = loadContextFidelityStats(fidelityPath);
  const nextRecallTotal =
    stats.averageAnchorRecallPercent * stats.sampleCount + anchorRecallAtK * 100;
  const nextCoverageTotal =
    stats.averageBodyCoveragePercent * stats.bodyCoverageSampleCount +
    (stored.bodyCoverage ?? 0) * 100;
  const nextSampleCount = stats.sampleCount + 1;
  const nextCoverageSampleCount = stats.bodyCoverageSampleCount + (bodyCoverageCount > 0 ? 1 : 0);

  stats.sampleCount = nextSampleCount;
  stats.averageAnchorRecallPercent = Math.round(nextRecallTotal / nextSampleCount);
  stats.bodyCoverageSampleCount = nextCoverageSampleCount;
  stats.averageBodyCoveragePercent =
    nextCoverageSampleCount === 0 ? 0 : Math.round(nextCoverageTotal / nextCoverageSampleCount);
  stats.totalExpectedAnchors += expectedAnchorIds.length;
  stats.totalReturnedAnchors += returnedAnchorIds.length;
  stats.totalMissingAnchors += missingAnchorIds.length;
  stats.firstRecordAt = stats.firstRecordAt ?? stored.timestamp;
  stats.lastRecordAt = stored.timestamp;
  stats.recentRecords.unshift(stored);
  if (stats.recentRecords.length > MAX_RECENT_RECORDS) {
    stats.recentRecords = stats.recentRecords.slice(0, MAX_RECENT_RECORDS);
  }
  saveContextFidelityStats(fidelityPath, stats);
  return stored;
}

export function listContextFidelityRecords(config: GraphFlowConfig): ContextFidelityRecord[] {
  return loadContextFidelityStats(resolveFidelityPath(config)).recentRecords;
}

export function getContextFidelityStats(config: GraphFlowConfig): ContextFidelityStats {
  return loadContextFidelityStats(resolveFidelityPath(config));
}

export function resetContextFidelityStats(config: GraphFlowConfig): {
  path: string;
  reset: boolean;
} {
  const fidelityPath = resolveFidelityPath(config);
  if (!existsSync(fidelityPath)) return { path: fidelityPath, reset: false };
  saveContextFidelityStats(fidelityPath, emptyContextFidelityStats());
  return { path: fidelityPath, reset: true };
}
