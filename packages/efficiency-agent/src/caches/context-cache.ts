import type { CacheVerdict, TaskFingerprint } from "../domain.js";

/**
 * Context cache (2.x plan §7): replay compressed context for a task whose
 * semantics AND full state fingerprint are unchanged and fresh enough.
 * 上下文缓存：语义相同且四轨指纹一致、未超 TTL 时，直接回放压缩上下文。
 *
 * Injected KV store — no fs in package code (tests use a Map-based fake).
 * Entries are found by semantic task hash, then validated against the FULL
 * reuseKey, so every miss reason is reachable and meaningful:
 *   "no-entry"            — this task text was never cached
 *   "ttl-expired"         — same task, same state, too old
 *   "fingerprint-mismatch"— same task text, but some state track changed
 */

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

export interface ContextCacheLookup {
  verdict: CacheVerdict;
  payload?: unknown;
}

export interface ContextCache {
  get(fingerprint: TaskFingerprint, now: number): ContextCacheLookup;
  put(fingerprint: TaskFingerprint, payload: unknown, now: number): void;
}

function entryKey(fingerprint: TaskFingerprint): string {
  return `context:${fingerprint.semanticTaskHash}`;
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

export function createContextCache(
  store: KVStore,
  opts: { ttlMs: number }
): ContextCache {
  function get(fingerprint: TaskFingerprint, now: number): ContextCacheLookup {
    const entry = readEntry(store.get(entryKey(fingerprint)));
    if (entry === undefined) {
      return {
        verdict: { kind: "context", hit: false, reason: "no-entry", fingerprintMatch: false },
      };
    }
    const entryAgeMs = Math.max(0, now - entry.createdAt);
    if (entry.fingerprint.reuseKey !== fingerprint.reuseKey) {
      return {
        verdict: {
          kind: "context",
          hit: false,
          reason: "fingerprint-mismatch",
          fingerprintMatch: false,
          entryAgeMs,
        },
      };
    }
    if (entryAgeMs > opts.ttlMs) {
      return {
        verdict: {
          kind: "context",
          hit: false,
          reason: "ttl-expired",
          fingerprintMatch: true,
          entryAgeMs,
        },
      };
    }
    return {
      verdict: {
        kind: "context",
        hit: true,
        reason: "hit",
        fingerprintMatch: true,
        entryAgeMs,
      },
      ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
    };
  }

  function put(fingerprint: TaskFingerprint, payload: unknown, now: number): void {
    const entry: CacheEntry = { version: "1.0", fingerprint, createdAt: now, payload };
    store.set(entryKey(fingerprint), JSON.stringify(entry));
  }

  return { get, put };
}
