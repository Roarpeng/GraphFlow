/**
 * Content-addressed observation store.
 *
 * Layout under `<rootDir>/.graphflow/observations/`:
 *   <sha[0:2]>/<sha>.txt   — archived bytes (sha256 of the stored, possibly redacted, content)
 *   index.jsonl            — one JSON entry per line: { handle, sha, sizeBytes, lines, createdAt, origin? }
 *
 * Same stored bytes => same sha => same handle (`gfo:<sha256[:16]>`), so packs
 * are naturally deduplicated. The store is append-mostly; TTL expiry is
 * enforced lazily (checked on recall, purged on pack) and a maxStoreBytes cap
 * evicts oldest entries first. All entry points fail open.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { redactSecrets } from "../learning/dialogue-thread.js";
import type { ResolvedObservationPolicy } from "./policy.js";
import type { PackResult, RecallResult } from "./types.js";

export const OBSERVATIONS_DIR = join(".graphflow", "observations");
/** Fixed page size for paged recall (0-based pages). */
export const PAGE_LINES = 200;

const HANDLE_RE = /^gfo:([0-9a-f]{16})$/;
const MS_PER_DAY = 86_400_000;

export interface ObservationIndexEntry {
  handle: string;
  sha: string;
  sizeBytes: number;
  lines: number;
  createdAt: number;
  origin?: string;
}

export interface PackObservationInput {
  rootDir: string;
  content: string;
  origin?: string;
  policy: ResolvedObservationPolicy;
}

export interface RecallObservationInput {
  rootDir: string;
  handle: string;
  page?: number;
  range?: [number, number];
  policy: ResolvedObservationPolicy;
}

export function observationsDir(rootDir: string): string {
  return join(rootDir, OBSERVATIONS_DIR);
}

export function blobPath(rootDir: string, sha: string): string {
  return join(observationsDir(rootDir), sha.slice(0, 2), `${sha}.txt`);
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Split into logical lines. A single trailing newline is a terminator, not an
 * extra empty line: "a\nb\n" => ["a", "b"], "" => [], "a" => ["a"].
 */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Byte-bounded head/tail of stored content. Small contents come back whole (tail empty). */
export function headTail(content: string, headBytes: number, tailBytes: number): { head: string; tail: string } {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= headBytes + tailBytes) {
    return { head: content, tail: "" };
  }
  return {
    head: buf.subarray(0, headBytes).toString("utf8"),
    tail: buf.subarray(buf.length - tailBytes).toString("utf8"),
  };
}

/** Bounded "head ... tail" excerpt used as the safe stand-in on fallback paths. */
export function boundedExcerpt(content: string, policy: ResolvedObservationPolicy): string {
  const { head, tail } = headTail(content, policy.headBytes, policy.tailBytes);
  if (tail === "") return head;
  const total = Buffer.byteLength(content, "utf8");
  return `${head}\n... [truncated ${total} bytes] ...\n${tail}`;
}

export async function readObservationIndex(rootDir: string): Promise<ObservationIndexEntry[]> {
  const entries: ObservationIndexEntry[] = [];
  let raw: string;
  try {
    raw = await readFile(join(observationsDir(rootDir), "index.jsonl"), "utf8");
  } catch {
    return entries; // no index yet
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ObservationIndexEntry>;
      if (
        typeof parsed.handle === "string" &&
        typeof parsed.sha === "string" &&
        typeof parsed.sizeBytes === "number" &&
        typeof parsed.lines === "number" &&
        typeof parsed.createdAt === "number"
      ) {
        entries.push({
          handle: parsed.handle,
          sha: parsed.sha,
          sizeBytes: parsed.sizeBytes,
          lines: parsed.lines,
          createdAt: parsed.createdAt,
          ...(typeof parsed.origin === "string" ? { origin: parsed.origin } : {}),
        });
      }
    } catch {
      // skip corrupt line; fail open
    }
  }
  return entries;
}

async function writeObservationIndex(rootDir: string, entries: ObservationIndexEntry[]): Promise<void> {
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(join(observationsDir(rootDir), "index.jsonl"), body, "utf8");
}

/** Drop TTL-expired entries, then evict oldest-first until `incomingBytes` fits under maxStoreBytes. */
async function purgeAndEvict(
  rootDir: string,
  entries: ObservationIndexEntry[],
  policy: ResolvedObservationPolicy,
  incomingBytes: number
): Promise<ObservationIndexEntry[]> {
  const now = Date.now();
  const ttlMs = policy.ttlDays * MS_PER_DAY;
  const kept: ObservationIndexEntry[] = [];
  for (const entry of entries) {
    if (now - entry.createdAt > ttlMs) {
      await rm(blobPath(rootDir, entry.sha), { force: true }).catch(() => undefined);
    } else {
      kept.push(entry);
    }
  }
  kept.sort((a, b) => a.createdAt - b.createdAt);
  let total = kept.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  while (kept.length > 0 && total + incomingBytes > policy.maxStoreBytes) {
    const oldest = kept.shift();
    if (!oldest) break;
    total -= oldest.sizeBytes;
    await rm(blobPath(rootDir, oldest.sha), { force: true }).catch(() => undefined);
  }
  return kept;
}

export async function packObservationImpl(opts: PackObservationInput): Promise<PackResult> {
  try {
    const stored = opts.policy.redactOnStore ? redactSecrets(opts.content) : opts.content;
    const buf = Buffer.from(stored, "utf8");
    const sha = sha256Hex(buf);
    const handle = `gfo:${sha.slice(0, 16)}`;
    const sizeBytes = buf.length;
    const lines = splitLines(stored).length;
    const dir = observationsDir(opts.rootDir);
    await mkdir(dir, { recursive: true });

    let entries = await readObservationIndex(opts.rootDir);
    const existing = entries.find((entry) => entry.handle === handle);
    let blobExists = false;
    if (existing) {
      try {
        await stat(blobPath(opts.rootDir, sha));
        blobExists = true;
      } catch {
        blobExists = false; // index entry without blob: self-heal by rewriting below
      }
    }

    if (!existing || !blobExists) {
      if (sizeBytes > opts.policy.maxStoreBytes) {
        return { fallback: true, reason: "content-too-large" };
      }
      entries = await purgeAndEvict(opts.rootDir, entries, opts.policy, sizeBytes);
      await mkdir(join(dir, sha.slice(0, 2)), { recursive: true });
      await writeFile(blobPath(opts.rootDir, sha), buf);
      if (!existing) {
        entries.push({
          handle,
          sha,
          sizeBytes,
          lines,
          createdAt: Date.now(),
          ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        });
      }
      await writeObservationIndex(opts.rootDir, entries);
    }

    const { head, tail } = headTail(stored, opts.policy.headBytes, opts.policy.tailBytes);
    return { fallback: false, handle, sha, sizeBytes, lines, head, tail };
  } catch (error) {
    logger.warn({ error }, "packObservation failed");
    return { fallback: true, reason: "store-io" };
  }
}

export async function recallObservationImpl(opts: RecallObservationInput): Promise<RecallResult> {
  try {
    if (!HANDLE_RE.test(opts.handle)) {
      return { expired: true };
    }
    const entries = await readObservationIndex(opts.rootDir);
    const entry = [...entries].reverse().find((candidate) => candidate.handle === opts.handle);
    if (!entry) {
      return { expired: true };
    }
    if (Date.now() - entry.createdAt > opts.policy.ttlDays * MS_PER_DAY) {
      return { expired: true };
    }
    let raw: Buffer;
    try {
      raw = await readFile(blobPath(opts.rootDir, entry.sha));
    } catch {
      return { expired: true }; // index entry without blob — treat as gone
    }
    const content = raw.toString("utf8");
    const all = splitLines(content);
    const total = all.length;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_LINES));

    let page = 0;
    let sliced: string;
    if (opts.range) {
      const [startRaw, endRaw] = opts.range;
      const start = Math.max(1, Math.floor(startRaw));
      const end = Math.min(total, Math.floor(endRaw));
      sliced = start > end || start > total ? "" : all.slice(start - 1, end).join("\n");
    } else if (opts.page !== undefined) {
      page = Math.max(0, Math.floor(opts.page));
      sliced = all.slice(page * PAGE_LINES, (page + 1) * PAGE_LINES).join("\n");
    } else {
      sliced = content; // full recall: exact archived bytes, untouched
    }

    return {
      expired: false,
      handle: entry.handle,
      sha: entry.sha,
      content: sliced,
      sizeBytes: entry.sizeBytes,
      lines: total,
      page,
      pageCount,
      pageLines: PAGE_LINES,
    };
  } catch (error) {
    logger.warn({ error }, "recallObservation failed");
    return { expired: true };
  }
}
