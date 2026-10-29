/**
 * GraphFlow — flywheel journal hygiene (`src/flywheel.ts`)
 *
 * `.graphflow/session-journal.jsonl` (one JSON object per line) accumulates
 * `kind:"pending-episode"` entries that host hooks / `graphflow_report_outcome`
 * are supposed to backfill. When a host never calls back (session killed,
 * hosts without hooks), entries stay in the journal forever: the topic-resume
 * reader in `src/mcp-tools.ts` scans every line on each resume, so a stale
 * backlog is pure read cost. `inspectFlywheel` reports the backlog health;
 * `pruneFlywheel` drops only expired pending episodes and rewrites the journal
 * atomically (sibling temp file + rename, same convention as the installer
 * store writes). Every other line — other kinds, fresh pendings, unparsable
 * rows — is preserved verbatim.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Journal location, relative to the workspace root. */
export const FLYWHEEL_JOURNAL_RELATIVE_PATH = join(".graphflow", "session-journal.jsonl");

/** Default backlog TTL (days) used by the `graphflow flywheel` CLI. */
export const DEFAULT_FLYWHEEL_TTL_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface FlywheelReport {
  /** Absolute journal path that was inspected. */
  journalPath: string;
  /** False when the journal does not exist (report is all zeros). */
  exists: boolean;
  /** Non-empty lines in the journal (all kinds). */
  totalLines: number;
  /** Lines that are not valid JSON objects; prune keeps them as-is. */
  parseErrors: number;
  /** Lines with `kind === "pending-episode"`. */
  pendingTotal: number;
  /** Status distribution across pending episodes (`"(missing)"` when a line has no status). */
  statusCounts: Record<string, number>;
  /** Age in days of the oldest pending episode; null when there is none with a readable `createdAt`. */
  oldestPendingAgeDays: number | null;
  /** TTL (days) this report scored `overTtl` against. */
  ttlDays: number;
  /** Pending episodes whose `createdAt` is older than now - ttlDays days. */
  overTtl: number;
}

export interface PruneResult {
  journalPath: string;
  /** False when the journal did not exist (nothing was written). */
  existed: boolean;
  /** Expired pending episodes removed. */
  pruned: number;
  /** Lines kept in the rewritten journal (all kinds + parse errors). */
  kept: number;
  /** Unparsable lines that were kept verbatim. */
  parseErrors: number;
  ttlDays: number;
}

interface JournalLine {
  /** Original line text (verbatim, without the `\n` separator). */
  text: string;
  /** Parsed object, or null when the line is not a JSON object. */
  entry: Record<string, unknown> | null;
}

function journalPathFor(rootDir: string): string {
  return join(rootDir, FLYWHEEL_JOURNAL_RELATIVE_PATH);
}

/** Read and parse the journal; empty lines are skipped, bad lines become `entry: null`. */
function readJournalLines(journalPath: string): JournalLine[] {
  const raw = readFileSync(journalPath, "utf8");
  const lines: JournalLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        entry = parsed as Record<string, unknown>;
      }
    } catch {
      entry = null;
    }
    lines.push({ text: line, entry });
  }
  return lines;
}

/** `createdAt` in epoch ms, or undefined when absent/non-numeric. */
function createdAtOf(entry: Record<string, unknown>): number | undefined {
  const value = entry.createdAt;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Backlog health report for `.graphflow/session-journal.jsonl`.
 * A missing journal is a zero-value report, not an error.
 */
export function inspectFlywheel(
  rootDir: string,
  ttlDays: number = DEFAULT_FLYWHEEL_TTL_DAYS
): FlywheelReport {
  const journalPath = journalPathFor(rootDir);
  const now = Date.now();
  const cutoff = now - ttlDays * MS_PER_DAY;

  if (!existsSync(journalPath)) {
    return {
      journalPath,
      exists: false,
      totalLines: 0,
      parseErrors: 0,
      pendingTotal: 0,
      statusCounts: {},
      oldestPendingAgeDays: null,
      ttlDays,
      overTtl: 0,
    };
  }

  const lines = readJournalLines(journalPath);
  let parseErrors = 0;
  let pendingTotal = 0;
  let overTtl = 0;
  let oldestCreatedAt: number | null = null;
  const statusCounts: Record<string, number> = {};

  for (const { entry } of lines) {
    if (entry === null) {
      parseErrors += 1;
      continue;
    }
    if (entry.kind !== "pending-episode") continue;
    pendingTotal += 1;
    const status =
      typeof entry.status === "string" && entry.status ? entry.status : "(missing)";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const createdAt = createdAtOf(entry);
    if (createdAt === undefined) continue; // age unknown — never counted as over-TTL
    if (oldestCreatedAt === null || createdAt < oldestCreatedAt) oldestCreatedAt = createdAt;
    if (createdAt < cutoff) overTtl += 1;
  }

  return {
    journalPath,
    exists: true,
    totalLines: lines.length,
    parseErrors,
    pendingTotal,
    statusCounts,
    oldestPendingAgeDays:
      oldestCreatedAt === null ? null : (now - oldestCreatedAt) / MS_PER_DAY,
    ttlDays,
    overTtl,
  };
}

/**
 * Remove `pending-episode` journal lines older than `ttlDays` and rewrite the
 * file in place (temp file + rename, so the journal is never observed
 * half-written). Other kinds, fresh pendings and unparsable lines are kept
 * verbatim; parse failures are counted, never dropped. A missing journal is a
 * no-op. `ttlDays` must be a positive finite number, or this throws.
 */
export function pruneFlywheel(rootDir: string, ttlDays: number): PruneResult {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error(`flywheel ttlDays must be a positive number of days (got ${String(ttlDays)})`);
  }

  const journalPath = journalPathFor(rootDir);
  if (!existsSync(journalPath)) {
    return {
      journalPath,
      existed: false,
      pruned: 0,
      kept: 0,
      parseErrors: 0,
      ttlDays,
    };
  }

  const cutoff = Date.now() - ttlDays * MS_PER_DAY;
  const keptLines: string[] = [];
  let pruned = 0;
  let parseErrors = 0;

  for (const { text, entry } of readJournalLines(journalPath)) {
    if (entry === null) {
      parseErrors += 1;
      keptLines.push(text);
      continue;
    }
    const createdAt = createdAtOf(entry);
    // Only an unambiguously expired pending episode is dropped; entries without
    // a readable createdAt cannot be proven stale, so they stay.
    if (entry.kind === "pending-episode" && createdAt !== undefined && createdAt < cutoff) {
      pruned += 1;
      continue;
    }
    keptLines.push(text);
  }

  const content = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
  const tmpPath = `${journalPath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, journalPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }

  return {
    journalPath,
    existed: true,
    pruned,
    kept: keptLines.length,
    parseErrors,
    ttlDays,
  };
}
