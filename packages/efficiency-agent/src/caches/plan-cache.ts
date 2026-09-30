import type { CacheVerdict, TaskFingerprint } from "../domain.js";

/**
 * Plan cache (2.x plan §7): replay a cached execution plan only after state
 * validation — the project track must be unchanged even if the rest of the
 * key matches, because a plan encodes concrete file/tool decisions.
 * 计划缓存：命中前先做状态校验 —— 即使其余轨道一致，项目轨（git/文件/锁）
 * 变了也必须重规划；miss 原因 "project-state-changed" 专用于此。
 *
 * Miss reasons:
 *   "no-entry"              — this task text was never cached
 *   "project-state-changed" — project track diverged (state validation failed)
 *   "fingerprint-mismatch"  — project track matches but context/env drifted
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

export interface PlanCacheLookup {
  verdict: CacheVerdict;
  payload?: unknown;
}

export interface PlanCache {
  get(fingerprint: TaskFingerprint, now: number): PlanCacheLookup;
  put(fingerprint: TaskFingerprint, payload: unknown, now: number): void;
}

function entryKey(fingerprint: TaskFingerprint): string {
  return `plan:${fingerprint.semanticTaskHash}`;
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

export function createPlanCache(store: KVStore): PlanCache {
  function get(fingerprint: TaskFingerprint, now: number): PlanCacheLookup {
    const entry = readEntry(store.get(entryKey(fingerprint)));
    if (entry === undefined) {
      return {
        verdict: { kind: "plan", hit: false, reason: "no-entry", fingerprintMatch: false },
      };
    }
    const entryAgeMs = Math.max(0, now - entry.createdAt);
    // State validation BEFORE any plan hit: the project track alone decides.
    if (entry.fingerprint.projectStateHash !== fingerprint.projectStateHash) {
      return {
        verdict: {
          kind: "plan",
          hit: false,
          reason: "project-state-changed",
          fingerprintMatch: false,
          entryAgeMs,
        },
      };
    }
    if (entry.fingerprint.reuseKey !== fingerprint.reuseKey) {
      return {
        verdict: {
          kind: "plan",
          hit: false,
          reason: "fingerprint-mismatch",
          fingerprintMatch: false,
          entryAgeMs,
        },
      };
    }
    return {
      verdict: {
        kind: "plan",
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
