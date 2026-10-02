import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import { logger } from "../utils/logger";

/**
 * Cumulative token savings tracker.
 *
 * Records each context compression / task run and provides aggregate
 * statistics so users can quantify ROI (return on investment) of using
 * GraphFlow's context compression.
 *
 * Stats are persisted to graphflow-out/token-savings.json as a ring-capped
 * record log (`records`, newest MAX_SAVINGS_RECORDS entries, plus the capped
 * `recentRecords` view) with aggregate counters recomputed from that log.
 * The counted contribution of detail records dropped by the ring cap is
 * folded into the persisted `truncatedPrefix` summary, so cumulative totals
 * stay authoritative across truncation.
 *
 * Probe exclusion rule / 探针排除规则：cumulative fields (`totalRuns`,
 * `totalRawTokens`, `totalCompressedTokens`, `totalSavedTokens`,
 * `averageSavingsPercent`, and derived `firstRunAt`/`lastRunAt`) EXCLUDE
 * records with `rawTokens < MIN_COUNTED_RAW_TOKENS` (1000) — noise-level
 * queries such as repeated demo/orchestrator smoke probes that water down the
 * ROI; real code questions never come in below that magnitude. The raw
 * records themselves are kept within the ring window (`records` capped at
 * MAX_SAVINGS_RECORDS, `recentRecords` capped at 50); detail records dropped
 * by the ring cap still count toward the aggregates through the persisted
 * `truncatedPrefix` summary. Aggregates are recomputed on load (read-side),
 * so legacy files without the full log are re-derived from the retained
 * `recentRecords` window — the stats self-heal from probe pollution on read.
 * 累计口径排除 rawTokens < 1000 的噪声级探针记录；原始记录在环形窗口内保留
 * （records 上限 MAX_SAVINGS_RECORDS）；被丢弃的明细经 truncatedPrefix 折算
 * 继续计入聚合计数；聚合在读取侧重算，旧文件（无全量日志）从保留的
 * recentRecords 窗口重算自愈。
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
 * Minimum `rawTokens` for a record to count toward the cumulative stats.
 * Below this magnitude a query is a smoke/probe (demo, orchestrator liveness
 * checks) rather than a real code question, and counting it waters down the
 * ROI. / 计入累计统计的 rawTokens 下限：低于该量级的是冒烟/探针查询。
 */
export const MIN_COUNTED_RAW_TOKENS = 1000;

/**
 * Cap on the persisted `records` detail log (ring retention: keep the newest
 * MAX_SAVINGS_RECORDS entries). Without it every preview appends one record
 * and rewrites the whole file, growing token-savings.json without bound.
 * Truncation only affects the detail log: the counted contribution of the
 * dropped records is folded into the persisted `truncatedPrefix` summary, so
 * the cumulative aggregates (totalRuns / totalRawTokens / ...) stay
 * authoritative. Loading an over-cap legacy file also truncates once, so
 * existing oversized files self-heal on the next write.
 * 明细日志环形保留最新 2000 条；被丢弃记录的累计贡献折入 truncatedPrefix，
 * 聚合计数不受影响；加载超限存量文件即截一次，下次写入自愈。
 */
export const MAX_SAVINGS_RECORDS = 2000;

/** The cumulative fields derived from counted records (probe rule applied). */
type CountedAggregates = Pick<
  SavingsStats,
  | "totalRuns"
  | "totalRawTokens"
  | "totalCompressedTokens"
  | "totalSavedTokens"
  | "averageSavingsPercent"
  | "firstRunAt"
  | "lastRunAt"
>;

/** Persisted shape: the public stats plus the full record log. */
interface PersistedSavingsStats extends SavingsStats {
  records: SavingsRecord[];
  /**
   * Counted-aggregate contribution of detail records already dropped by the
   * MAX_SAVINGS_RECORDS ring cap. Absent when nothing has been dropped.
   */
  truncatedPrefix?: CountedAggregates;
}

function zeroCountedAggregates(): CountedAggregates {
  return {
    totalRuns: 0,
    totalRawTokens: 0,
    totalCompressedTokens: 0,
    totalSavedTokens: 0,
    averageSavingsPercent: 0,
    firstRunAt: null,
    lastRunAt: null,
  };
}

/** Defensive parse of the persisted `truncatedPrefix` (garbage → zeros). */
function normalizeCountedAggregates(value: unknown): CountedAggregates {
  if (typeof value !== "object" || value === null) return zeroCountedAggregates();
  const raw = value as Partial<CountedAggregates>;
  const count = (input: unknown): number =>
    typeof input === "number" && Number.isFinite(input) && input > 0 ? input : 0;
  const stamp = (input: unknown): string | null =>
    typeof input === "string" && input.length > 0 ? input : null;
  // totalSavedTokens / averageSavingsPercent are always re-derived on merge.
  return {
    totalRuns: count(raw.totalRuns),
    totalRawTokens: count(raw.totalRawTokens),
    totalCompressedTokens: count(raw.totalCompressedTokens),
    totalSavedTokens: 0,
    averageSavingsPercent: 0,
    firstRunAt: stamp(raw.firstRunAt),
    lastRunAt: stamp(raw.lastRunAt),
  };
}

function hasCountedContribution(prefix: CountedAggregates): boolean {
  return prefix.totalRuns > 0 || prefix.totalRawTokens > 0;
}

/**
 * Combine two counted-aggregate blocks (e.g. the truncated-out prefix with
 * the retained ring window). Sums are additive; derived fields and the
 * ISO-timestamp extremes are recomputed, so the result equals what
 * computeCountedAggregates would produce over the un-truncated log.
 */
function mergeCountedAggregates(left: CountedAggregates, right: CountedAggregates): CountedAggregates {
  const totalRawTokens = left.totalRawTokens + right.totalRawTokens;
  const totalCompressedTokens = left.totalCompressedTokens + right.totalCompressedTokens;
  const totalSavedTokens = totalRawTokens - totalCompressedTokens;
  const firsts = [left.firstRunAt, right.firstRunAt]
    .filter((value): value is string => typeof value === "string")
    .sort();
  const lasts = [left.lastRunAt, right.lastRunAt]
    .filter((value): value is string => typeof value === "string")
    .sort();
  return {
    totalRuns: left.totalRuns + right.totalRuns,
    totalRawTokens,
    totalCompressedTokens,
    totalSavedTokens,
    averageSavingsPercent:
      totalRawTokens > 0 ? Math.round((totalSavedTokens / totalRawTokens) * 100) : 0,
    firstRunAt: firsts[0] ?? null,
    lastRunAt: lasts[lasts.length - 1] ?? null,
  };
}

function emptySavingsStats(): SavingsStats {
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

/**
 * Recompute the cumulative fields from the record log, EXCLUDING probe-level
 * records (`rawTokens < MIN_COUNTED_RAW_TOKENS` — see the header rule).
 * 从记录日志重算累计字段，排除 rawTokens < 1000 的探针记录。
 */
function computeCountedAggregates(records: readonly SavingsRecord[]): CountedAggregates {
  const counted = records.filter((record) => record.rawTokens >= MIN_COUNTED_RAW_TOKENS);
  const totalRawTokens = counted.reduce((sum, record) => sum + record.rawTokens, 0);
  const totalCompressedTokens = counted.reduce((sum, record) => sum + record.compressedTokens, 0);
  const totalSavedTokens = totalRawTokens - totalCompressedTokens;
  // ISO timestamps sort lexicographically; order-independent so a legacy
  // newest-first seeded window derives the same first/last as the log.
  // ISO 时间戳可按字典序排序：与记录顺序无关（旧窗口按新到旧也能算对）。
  const timestamps = counted
    .map((record) => (typeof record.timestamp === "string" ? record.timestamp : ""))
    .filter((value) => value.length > 0)
    .sort();
  return {
    totalRuns: counted.length,
    totalRawTokens,
    totalCompressedTokens,
    totalSavedTokens,
    averageSavingsPercent:
      totalRawTokens > 0 ? Math.round((totalSavedTokens / totalRawTokens) * 100) : 0,
    firstRunAt: timestamps[0] ?? null,
    lastRunAt: timestamps[timestamps.length - 1] ?? null,
  };
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

function loadStats(statsPath: string): PersistedSavingsStats {
  if (!existsSync(statsPath)) {
    return { ...emptySavingsStats(), records: [] };
  }

  try {
    const raw = readFileSync(statsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSavingsStats>;
    // 读取侧过滤 + 重算聚合：探针记录（rawTokens < 1000）不进累计口径。
    // 旧文件没有全量 records 日志 → 从保留的 recentRecords 窗口重算（自愈）。
    // Read-side filter + recompute: probes never reach the cumulative fields;
    // legacy files without the full log re-derive from the retained window.
    let records = Array.isArray(parsed.records)
      ? parsed.records
      : Array.isArray(parsed.recentRecords)
        ? parsed.recentRecords
        : [];
    let truncatedPrefix = normalizeCountedAggregates(parsed.truncatedPrefix);
    if (records.length > MAX_SAVINGS_RECORDS) {
      // 加载即截：超限存量文件在下一次写入时自愈为环形窗口；被丢弃明细的
      // 累计贡献折入 truncatedPrefix，聚合计数不受影响。
      // Load-time cap: a legacy over-cap file self-heals on the next write;
      // dropped detail keeps counting through the prefix summary.
      const dropped = records.slice(0, records.length - MAX_SAVINGS_RECORDS);
      records = records.slice(records.length - MAX_SAVINGS_RECORDS);
      truncatedPrefix = mergeCountedAggregates(
        truncatedPrefix,
        computeCountedAggregates(dropped)
      );
      logger.info(
        `token-savings: capped detail records to the newest ${MAX_SAVINGS_RECORDS} ` +
          `(folded ${dropped.length} dropped records into the cumulative aggregates)`
      );
    }
    return {
      ...mergeCountedAggregates(truncatedPrefix, computeCountedAggregates(records)),
      records,
      ...(hasCountedContribution(truncatedPrefix) ? { truncatedPrefix } : {}),
      recentRecords: Array.isArray(parsed.recentRecords) ? parsed.recentRecords : [],
    };
  } catch {
    return { ...emptySavingsStats(), records: [] };
  }
}

function saveStats(statsPath: string, stats: PersistedSavingsStats): void {
  mkdirSync(dirname(statsPath), { recursive: true });
  writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");
}

/**
 * Record a single savings event and update cumulative stats.
 *
 * Every record is appended to the persisted log, which is ring-capped at
 * MAX_SAVINGS_RECORDS (the oldest detail records are dropped once the cap is
 * reached; their counted contribution is folded into `truncatedPrefix` so the
 * cumulative counters through the probe exclusion rule keep covering the full
 * history). The cumulative counters are recomputed via
 * `rawTokens >= MIN_COUNTED_RAW_TOKENS`.
 * 每条记录完整落盘；明细日志环形保留最新 MAX_SAVINGS_RECORDS 条，被丢弃记录
 * 经 truncatedPrefix 折算继续计入累计口径（rawTokens ≥ 1000 才计入）。
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

  let records = [...stats.records, stored];
  let truncatedPrefix = stats.truncatedPrefix ?? zeroCountedAggregates();
  if (records.length > MAX_SAVINGS_RECORDS) {
    // 环形保留最新记录：最旧的明细折入累计口径后丢弃。
    // Ring retention: fold the oldest detail records into the cumulative
    // aggregates, then drop them from the persisted log.
    const dropped = records.slice(0, records.length - MAX_SAVINGS_RECORDS);
    records = records.slice(records.length - MAX_SAVINGS_RECORDS);
    truncatedPrefix = mergeCountedAggregates(
      truncatedPrefix,
      computeCountedAggregates(dropped)
    );
    logger.info(
      `token-savings: records ring cap reached; dropped ${dropped.length} oldest ` +
        `detail record(s), cumulative aggregates preserved`
    );
  }

  stats.recentRecords.unshift(stored);
  if (stats.recentRecords.length > MAX_RECENT_RECORDS) {
    stats.recentRecords = stats.recentRecords.slice(0, MAX_RECENT_RECORDS);
  }

  saveStats(statsPath, {
    ...mergeCountedAggregates(truncatedPrefix, computeCountedAggregates(records)),
    records,
    ...(hasCountedContribution(truncatedPrefix) ? { truncatedPrefix } : {}),
    recentRecords: stats.recentRecords,
  });
}

/**
 * Get cumulative savings statistics (probe-filtered; see the header rule).
 * The full record log stays internal — callers get the capped
 * `recentRecords` view plus the recomputed cumulative fields.
 *
 * @param config GraphFlow config
 */
export function getSavingsStats(config: GraphFlowConfig): SavingsStats {
  const persisted = loadStats(resolveStatsPath(config));
  return {
    totalRuns: persisted.totalRuns,
    totalRawTokens: persisted.totalRawTokens,
    totalCompressedTokens: persisted.totalCompressedTokens,
    totalSavedTokens: persisted.totalSavedTokens,
    averageSavingsPercent: persisted.averageSavingsPercent,
    firstRunAt: persisted.firstRunAt,
    lastRunAt: persisted.lastRunAt,
    recentRecords: persisted.recentRecords,
  };
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

  saveStats(statsPath, { ...emptySavingsStats(), records: [] });
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
