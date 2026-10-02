import { CACHE_SCHEMA_VERSION } from "../version.js";
import type { KVStore } from "./context-cache.js";

/**
 * Cache namespaces (spec §4 / §24). Every cache key is prefixed with
 * `<schema>.g<generation>`; `invalidateCaches` bumps the generation so all
 * earlier entries become unreachable at once (the "cache rollback" switch)
 * without rewriting or trusting their contents.
 */

const GENERATION_KEY = "__eff_cache_generation";

export function cacheGeneration(store: KVStore): number {
  const raw = store.get(GENERATION_KEY);
  const n = raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function cacheNamespace(store: KVStore): string {
  return `${CACHE_SCHEMA_VERSION}.g${cacheGeneration(store)}`;
}

export function invalidateCaches(store: KVStore): { previous: string; current: string } {
  const previous = cacheNamespace(store);
  store.set(GENERATION_KEY, String(cacheGeneration(store) + 1));
  return { previous, current: cacheNamespace(store) };
}

export function namespacedStore(store: KVStore, namespace: string): KVStore {
  const prefix = `${namespace}::`;
  return {
    get: (key) => store.get(prefix + key),
    set: (key, value) => store.set(prefix + key, value),
  };
}
