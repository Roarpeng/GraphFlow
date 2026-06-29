/**
 * file-indexer-cache.ts — Cache management
 *
 * Handles reading, writing, and querying the index-state cache
 * used for incremental indexing decisions.
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "../utils/logger.js";
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_MAX_FILE_SIZE,
  walkScannableFiles,
} from "./file-indexer-walker.js";
import type { FileIndexerOptions } from "./file-indexer-walker.js";

export interface CacheState {
  [path: string]: {
    mtimeMs: number;
    hash: string;
    numNodes: number;
  };
}

export const CACHE_DIR = ".graphflow-cache";
export const CACHE_FILE = "index-state.json";

/**
 * Load cache state from disk. Returns empty object on missing or invalid cache.
 */
export function loadCacheState(cachePath: string, forceReindex: boolean): CacheState {
  if (forceReindex) {
    return {};
  }

  try {
    const raw = readFileSync(cachePath, "utf8");
    const parsedCache = JSON.parse(raw);
    if (parsedCache.version === 2 && parsedCache.state) {
      return parsedCache.state as CacheState;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      logger.warn({ error: err.message }, "Failed to read index cache");
    }
  }

  return {};
}

/**
 * Persist cache state to disk.
 */
export function saveCacheState(cachePath: string, cacheState: CacheState): void {
  try {
    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ version: 2, state: cacheState }, null, 2), "utf8");
  } catch (error) {
    logger.warn({ error }, "Failed to write index cache");
  }
}

/** Remove graph store, index cache, and vector DB for a full rebuild. */
export function clearGraphIndexArtifacts(rootDir: string, graphStorePath: string): void {
  const cachePath = join(rootDir, CACHE_DIR, CACHE_FILE);
  const vectorsPath = join(rootDir, CACHE_DIR, "vectors.db");
  rmSync(graphStorePath, { force: true });
  rmSync(cachePath, { force: true });
  rmSync(vectorsPath, { force: true });
}

/** Returns true when workspace files changed since last index (or cache is empty). */
export function hasPendingGraphIndexWork(
  rootDir: string,
  options?: Pick<FileIndexerOptions, "includeExtensions" | "maxFileSizeBytes" | "forceReindex">
): boolean {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const forceReindex = options?.forceReindex ?? false;
  if (forceReindex) {
    return true;
  }

  const cachePath = join(rootDir, CACHE_DIR, CACHE_FILE);
  const cacheState = loadCacheState(cachePath, false);
  const scanned = walkScannableFiles(rootDir, includeExtensions, maxFileSizeBytes);
  const currentRelPaths = new Set(scanned.map((file) => file.relPath));

  for (const relPath of Object.keys(cacheState)) {
    if (!currentRelPaths.has(relPath)) {
      return true;
    }
  }

  for (const file of scanned) {
    const prev = cacheState[file.relPath];
    if (!prev || prev.mtimeMs !== file.mtimeMs) {
      return true;
    }
  }

  return false;
}

/**
 * Quick check whether the index cache exists and is non-empty.
 * Cheaper than hasPendingGraphIndexWork (no full workspace walk).
 */
export function hasIndexCache(rootDir: string): boolean {
  const cachePath = join(rootDir, CACHE_DIR, CACHE_FILE);
  if (!existsSync(cachePath)) return false;
  try {
    const cacheState = loadCacheState(cachePath, false);
    return Object.keys(cacheState).length > 0;
  } catch {
    return false;
  }
}