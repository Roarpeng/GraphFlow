import type { CacheVerdict, ResultSafeCategory, TaskFingerprint } from "../domain.js";

/**
 * Result cache (2.x plan §7): the ONLY cache allowed to skip execution
 * entirely, and only for result-safe categories ("query" | "docs" | "config").
 * Write categories (bugfix, refactor, ...) can never replay a result —
 * `put` refuses to store them at all, so a stale write result cannot exist.
 * 结果缓存：仅结果安全类目（query/docs/config）可回放；写类目在 put 时即被
 * 拒绝（reason "category-not-result-safe"），从根本上排除旧写入结果回放。
 *
 * Hit requires FULL reuseKey equality (all four tracks) AND an entry no older
 * than `ttlMs` (miss reason "ttl-expired"), mirroring the context cache.
 * A replayed result skips execution and validation entirely, so its staleness
 * budget is tighter than the context cache's (default 6 h vs 24 h): the
 * fingerprint covers repo state, but not state outside it (installed tools,
 * remote docs, the agent's model) that a read-only answer may depend on.
 * 结果回放跳过执行与验证，TTL 默认 6 小时，严于上下文缓存的 24 小时。
 */

export const DEFAULT_RESULT_TTL_MS = 6 * 60 * 60_000;

/** Minimal key-value store abstraction; 注入式 KV 存储，包内不碰 fs。 */
export interface KVStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

interface CacheEntry {
  version: "1.0";
  fingerprint: TaskFingerprint;
  createdAt: number;
  payload: unknown;
}

export interface ResultCacheLookup {
  verdict: CacheVerdict;
  payload?: unknown;
}

export interface ResultCache {
  get(fingerprint: TaskFingerprint, category: string, now: number): ResultCacheLookup;
  put(fingerprint: TaskFingerprint, category: string, payload: unknown, now: number): CacheVerdict;
}

const RESULT_SAFE_CATEGORIES: readonly ResultSafeCategory[] = ["query", "docs", "config"];

function isResultSafeCategory(category: string): category is ResultSafeCategory {
  return (RESULT_SAFE_CATEGORIES as readonly string[]).includes(category);
}

function entryKey(fingerprint: TaskFingerprint, category: string): string {
  return `result:${category}:${fingerprint.semanticTaskHash}`;
}

/** Defensively parse a stored entry; malformed JSON counts as "no-entry". */
function readEntry(raw: string | undefined): CacheEntry | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    const fingerprint = candidate["fingerprint"];
    if (
      candidate["version"] !== "1.0" ||
      typeof candidate["createdAt"] !== "number" ||
      typeof fingerprint !== "object" ||
      fingerprint === null ||
      typeof (fingerprint as Record<string, unknown>)["reuseKey"] !== "string"
    ) {
      return undefined;
    }
    return parsed as CacheEntry;
  } catch {
    return undefined;
  }
}

function notResultSafeVerdict(): CacheVerdict {
  return {
    kind: "result",
    hit: false,
    reason: "category-not-result-safe",
    fingerprintMatch: false,
  };
}

export function createResultCache(store: KVStore, opts: { ttlMs?: number } = {}): ResultCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_RESULT_TTL_MS;
  function get(
    fingerprint: TaskFingerprint,
    category: string,
    now: number
  ): ResultCacheLookup {
    if (!isResultSafeCategory(category)) {
      return { verdict: notResultSafeVerdict() };
    }
    const entry = readEntry(store.get(entryKey(fingerprint, category)));
    if (entry === undefined) {
      return {
        verdict: { kind: "result", hit: false, reason: "no-entry", fingerprintMatch: false },
      };
    }
    const entryAgeMs = Math.max(0, now - entry.createdAt);
    if (entry.fingerprint.reuseKey !== fingerprint.reuseKey) {
      return {
        verdict: {
          kind: "result",
          hit: false,
          reason: "fingerprint-mismatch",
          fingerprintMatch: false,
          entryAgeMs,
        },
      };
    }
    if (entryAgeMs > ttlMs) {
      return {
        verdict: {
          kind: "result",
          hit: false,
          reason: "ttl-expired",
          fingerprintMatch: true,
          entryAgeMs,
        },
      };
    }
    return {
      verdict: {
        kind: "result",
        hit: true,
        reason: "hit",
        fingerprintMatch: true,
        entryAgeMs,
      },
      ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
    };
  }

  function put(
    fingerprint: TaskFingerprint,
    category: string,
    payload: unknown,
    now: number
  ): CacheVerdict {
    if (!isResultSafeCategory(category)) {
      return notResultSafeVerdict();
    }
    const entry: CacheEntry = { version: "1.0", fingerprint, createdAt: now, payload };
    store.set(entryKey(fingerprint, category), JSON.stringify(entry));
    return { kind: "result", hit: true, reason: "stored", fingerprintMatch: true };
  }

  return { get, put };
}
