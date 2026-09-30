/**
 * P4 Policy store (2.x plan §18): append-only persistence for PolicyUpdate
 * over an injected key-value port. No fs, no runtime deps — tests (and any
 * host) inject a Map-backed KVStore or an MCP/localStorage adapter.
 *
 * P4 策略存储：注入式 KV 端口上的 append-only 策略历史。
 *
 * Semantics:
 *  - `current()` returns undefined when no policy was ever applied. The
 *    "version 0 default policy" is that absence: learnPolicy treats a missing
 *    current as version 0 with inherited defaults (economy tier, one-shot).
 *  - `apply(update)` bumps nothing itself — it TRUSTS update.version and only
 *    refuses non-monotonic writes (version <= current version → Error). The
 *    applied update is appended to the history under a second key.
 *  - `rollback()` re-applies the second-to-last history entry with version =
 *    current version + 1 (monotonic append-only), so history never rewrites.
 *    Returns undefined when there is nothing to roll back to (no current
 *    policy, or fewer than two history entries).
 */

import type { PolicyUpdate } from "../domain.js";

/** Minimal persistence port, local to this file. */
export interface KVStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface PolicyStore {
  /** The live policy; undefined when nothing was ever applied. */
  current(): PolicyUpdate | undefined;
  /**
   * Persist `update` as the live policy and append it to history. Throws when
   * update.version <= the current version (stale or replayed write).
   */
  apply(update: PolicyUpdate): PolicyUpdate;
  /** Every applied policy in order, oldest first ([] when none). */
  history(): PolicyUpdate[];
  /**
   * Re-apply the previous history entry with version = current + 1; the
   * restored entry's content is byte-for-byte the previous policy except the
   * version. undefined when a rollback is impossible.
   */
  rollback(): PolicyUpdate | undefined;
}

const CURRENT_KEY = "policy-current";
const HISTORY_KEY = "policy-history";

const parsePolicy = (raw: string, key: string): PolicyUpdate => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${key}: corrupt policy JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { version?: unknown }).version !== "number"
  ) {
    throw new Error(`${key}: stored policy is malformed`);
  }
  return parsed as PolicyUpdate;
};

export function createPolicyStore(store: KVStore): PolicyStore {
  const readCurrent = (): PolicyUpdate | undefined => {
    const raw = store.get(CURRENT_KEY);
    return raw === undefined ? undefined : parsePolicy(raw, CURRENT_KEY);
  };

  const readHistory = (): PolicyUpdate[] => {
    const raw = store.get(HISTORY_KEY);
    if (raw === undefined) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${HISTORY_KEY}: corrupt history JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${HISTORY_KEY}: history must be an array`);
    }
    return parsed.map((entry, index) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { version?: unknown }).version !== "number"
      ) {
        throw new Error(`${HISTORY_KEY}[${index}]: malformed history entry`);
      }
      return entry as PolicyUpdate;
    });
  };

  const writeHistory = (entries: readonly PolicyUpdate[]): void => {
    store.set(HISTORY_KEY, JSON.stringify(entries));
  };

  return {
    current: readCurrent,
    apply(update: PolicyUpdate): PolicyUpdate {
      const currentVersion = readCurrent()?.version ?? 0;
      if (!Number.isInteger(update.version) || update.version < 1) {
        throw new Error(
          `policy-store: version must be a positive integer, got ${String(update.version)}`
        );
      }
      if (update.version <= currentVersion) {
        throw new Error(
          `policy-store: refusing version ${String(update.version)} <= current ${String(currentVersion)}`
        );
      }
      store.set(CURRENT_KEY, JSON.stringify(update));
      writeHistory([...readHistory(), update]);
      // Read back through the same port so callers see exactly what persists
      // (and hostile KV fakes cannot alias the input object).
      return readCurrent() ?? update;
    },
    history(): PolicyUpdate[] {
      return readHistory();
    },
    rollback(): PolicyUpdate | undefined {
      const current = readCurrent();
      if (current === undefined) {
        return undefined;
      }
      const entries = readHistory();
      const previous = entries[entries.length - 2];
      if (previous === undefined) {
        return undefined;
      }
      const restored: PolicyUpdate = {
        ...previous,
        version: current.version + 1,
      };
      store.set(CURRENT_KEY, JSON.stringify(restored));
      writeHistory([...entries, restored]);
      return readCurrent() ?? restored;
    },
  };
}
