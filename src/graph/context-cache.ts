import type { ContextPreviewResult } from "../surfaces/cli/runtime/types";

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  /**
   * U2 (host prefix cacheability): ordered digest of the entry's anchor ids
   * (`computeAnchorIdSignature`). Populated by `cacheContextResult` for
   * ContextPreviewResult entries; two results with the same signature carry
   * the same anchor set in the same (layer, id) order, so their stable text
   * copy is byte-identical and a host prefix cache survives the round-trip.
   */
  anchorIdSignature?: string;
  /**
   * U2: the stable-face text copy rendered from `data` when it was cached.
   * Kept beside the signature so a rebuild with an unchanged anchor set can
   * hand back the exact previous bytes instead of re-serializing.
   */
  textCopy?: string;
}

export class LRUCache<T> {
  cache: Map<string, CacheEntry<T>> = new Map();
  private maxSize: number;
  private defaultTTL: number;

  constructor(maxSize: number = 100, defaultTTL: number = 30000) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.timestamp + entry.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.data;
  }

  set(key: string, data: T, ttl?: number, meta?: { anchorIdSignature?: string; textCopy?: string }): void {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTTL,
      ...(meta?.anchorIdSignature !== undefined ? { anchorIdSignature: meta.anchorIdSignature } : {}),
      ...(meta?.textCopy !== undefined ? { textCopy: meta.textCopy } : {}),
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }
    if (Date.now() > entry.timestamp + entry.ttl) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }
}

const contextCache = new LRUCache<ContextPreviewResult>(50, 30000);

export function getContextCache(): LRUCache<ContextPreviewResult> {
  return contextCache;
}

export function cacheContextResult(
  query: string,
  rootDir: string,
  result: ContextPreviewResult,
  ttl?: number
): void {
  const key = `${rootDir}:${query}`;
  contextCache.set(key, result, ttl, {
    anchorIdSignature: computeAnchorIdSignature(result.anchors),
  });
}

export function getCachedContext(
  query: string,
  rootDir: string
): ContextPreviewResult | undefined {
  const key = `${rootDir}:${query}`;
  return contextCache.get(key);
}

export function invalidateContextCache(rootDir?: string): void {
  if (rootDir) {
    const keysToDelete: string[] = [];
    for (const key of Array.from(contextCache.cache.keys())) {
      if (key.startsWith(rootDir)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      contextCache.delete(key);
    }
  } else {
    contextCache.clear();
  }
}

// ───────────────── U2: byte-stable text copy reuse across TTL-expired rounds ─────────────────

/**
 * FNV-1a over the ordered, length-prefixed anchor ids. Deterministic across
 * processes and platforms (charCode + imul — no locale collation, no hash
 * seed), which `localeCompare`-based joins cannot promise.
 */
export function computeAnchorIdSignature(anchors: ReadonlyArray<{ id: string }>): string {
  let hash = 0x811c9dc5;
  for (const anchor of anchors) {
    // Length prefix so ["a:bc", "d"] and ["a", "bcd"] cannot collide.
    const piece = `${anchor.id.length}:${anchor.id}|`;
    for (let i = 0; i < piece.length; i += 1) {
      hash ^= piece.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

interface StableCopyTrailEntry {
  anchorIdSignature: string;
  textCopy: string;
}

/**
 * Last stable text copy per cache key, deliberately NOT TTL-bound: the reuse
 * question is "the runtime cache expired and recomputed — is the fresh anchor
 * set the same as the previous round's?", and `LRUCache.get` deletes expired
 * entries on sight, so the trail must outlive the entry it describes.
 */
const stableCopyTrail = new Map<string, StableCopyTrailEntry>();
const STABLE_COPY_TRAIL_MAX = 64;

function stableCopyTrailKey(query: string, rootDir: string): string {
  return `${rootDir}:${query}`;
}

/**
 * Previous round's stable text copy when the fresh anchor set has the same
 * signature (same ids, same order) — byte-for-byte what was served before.
 * `undefined` when nothing was recorded or the anchor set moved.
 */
export function reuseStableContextTextCopy(
  query: string,
  rootDir: string,
  anchors: ReadonlyArray<{ id: string }>
): string | undefined {
  const trail = stableCopyTrail.get(stableCopyTrailKey(query, rootDir));
  if (!trail) return undefined;
  return trail.anchorIdSignature === computeAnchorIdSignature(anchors)
    ? trail.textCopy
    : undefined;
}

/** Record the stable text copy served for this (query, rootDir) round. */
export function recordStableContextTextCopy(
  query: string,
  rootDir: string,
  anchors: ReadonlyArray<{ id: string }>,
  textCopy: string
): void {
  const key = stableCopyTrailKey(query, rootDir);
  if (!stableCopyTrail.has(key) && stableCopyTrail.size >= STABLE_COPY_TRAIL_MAX) {
    const oldest = stableCopyTrail.keys().next().value;
    if (oldest !== undefined) {
      stableCopyTrail.delete(oldest);
    }
  }
  stableCopyTrail.set(key, {
    anchorIdSignature: computeAnchorIdSignature(anchors),
    textCopy,
  });
}

/** Test seam: drop the trail so cases cannot see each other's copies. */
export function resetStableCopyTrail(): void {
  stableCopyTrail.clear();
}
