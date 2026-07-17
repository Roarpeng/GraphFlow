import type { ContextPreviewResult } from "../surfaces/cli/runtime/types";

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
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

  set(key: string, data: T, ttl?: number): void {
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
  contextCache.set(key, result, ttl);
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
