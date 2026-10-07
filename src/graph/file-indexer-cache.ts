/**
 * file-indexer-cache.ts — Cache management
 *
 * Handles reading, writing, and querying the index-state cache
 * used for incremental indexing decisions.
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { GRAPH_STORE_DELTA_SUFFIX } from "./graphify-file-client.js";
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
 * The manifest must describe what is in *its* store: a host still on the JSON
 * store indexing a file must not make that file look "unchanged" to SQLite.
 */
export const SQLITE_INDEX_MANIFEST = "index-state.sqlite.json";

export function indexManifestPath(rootDir: string, manifestName: string = CACHE_FILE): string {
  return join(rootDir, CACHE_DIR, manifestName);
}

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

const CACHE_STATE_MEMO_LIMIT = 64;
const cacheStateMemo = new Map<string, { fingerprint: string; state: CacheState }>();

/**
 * loadCacheState memoized in-process, keyed by (path, mtimeMs, size): a
 * rewrite invalidates immediately, an unchanged file skips the JSON.parse.
 *
 * Motivation (P0-1b): the preview freshness chain parses the same manifest
 * (124KB index-state.json on this repo) twice per call — indexedStoreIsIncomplete
 * and hasPendingGraphIndexWork each did a full loadCacheState. The returned
 * object is SHARED between callers: treat it as read-only. The one caller that
 * mutates its cache state (file-indexer's incremental upsert) still uses the
 * uncached loadCacheState.
 */
export function loadCacheStateCached(cachePath: string): CacheState {
  let fingerprint: string;
  try {
    const stat = statSync(cachePath);
    fingerprint = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // Missing or unreadable: readFileSync fails fast, nothing worth memoizing.
    return loadCacheState(cachePath, false);
  }
  const memo = cacheStateMemo.get(cachePath);
  if (memo && memo.fingerprint === fingerprint) {
    return memo.state;
  }
  const state = loadCacheState(cachePath, false);
  if (cacheStateMemo.size >= CACHE_STATE_MEMO_LIMIT) {
    cacheStateMemo.clear();
  }
  cacheStateMemo.set(cachePath, { fingerprint, state });
  return state;
}

/**
 * Remove graph store and index cache for a full rebuild. Vectors live in node
 * metadata inside the store, so they go with it.
 * Close any client on `graphStorePath` first: on POSIX an open SQLite handle
 * keeps writing into the unlinked inode, and a leftover -wal would be replayed
 * into the fresh database.
 */
export function clearGraphIndexArtifacts(rootDir: string, graphStorePath: string): void {
  rmSync(graphStorePath, { force: true });
  rmSync(`${graphStorePath}${GRAPH_STORE_DELTA_SUFFIX}`, { force: true });
  rmSync(`${graphStorePath}-wal`, { force: true });
  rmSync(`${graphStorePath}-shm`, { force: true });
  rmSync(indexManifestPath(rootDir, /\.sqlite$/i.test(graphStorePath) ? SQLITE_INDEX_MANIFEST : CACHE_FILE), {
    force: true,
  });
}

/**
 * True when the manifest claims files the store no longer holds. Another host
 * on a different transport can fold or move the store away (JSON → SQLite
 * merge skips code nodes; a file-transport host recreates an empty JSON), and
 * an incremental index trusting the manifest then re-adds only changed files —
 * observed: 704 manifest entries against 16 files left in the store. Callers
 * must re-index with `forceReindex` when this fires.
 */
export function indexedStoreIsIncomplete(
  rootDir: string,
  manifestName: string | undefined,
  storeNodes: ReadonlyArray<{ id: string; type?: string }> | undefined
): boolean {
  if (!storeNodes) {
    return false;
  }
  // Shared memo: refreshIndexForPreview calls this and hasPendingGraphIndexWork
  // back to back — the same manifest must not be JSON.parsed twice per preview.
  const manifest = loadCacheStateCached(indexManifestPath(rootDir, manifestName));
  const claimed = Object.keys(manifest).length;
  if (claimed === 0) {
    return false;
  }
  let fileNodes = 0;
  for (const node of storeNodes) {
    if (node.type === "File") fileNodes += 1;
  }
  return fileNodes < claimed * 0.5;
}

/** Returns true when workspace files changed since last index (or cache is empty). */
export function hasPendingGraphIndexWork(
  rootDir: string,
  options?: Pick<
    FileIndexerOptions,
    "includeExtensions" | "maxFileSizeBytes" | "forceReindex" | "respectGitIgnore" | "excludeGlobs"
  > & { manifestName?: string | undefined }
): boolean {
  const includeExtensions = options?.includeExtensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const forceReindex = options?.forceReindex ?? false;
  if (forceReindex) {
    return true;
  }

  const cacheState = loadCacheStateCached(indexManifestPath(rootDir, options?.manifestName));
  const scanned = walkScannableFiles(rootDir, includeExtensions, maxFileSizeBytes, {
    ...(options?.respectGitIgnore === false ? { respectGitIgnore: false } : {}),
    ...(options?.excludeGlobs?.length ? { excludeGlobs: options.excludeGlobs } : {}),
  });
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
export function hasIndexCache(rootDir: string, manifestName?: string): boolean {
  const cachePath = indexManifestPath(rootDir, manifestName);
  if (!existsSync(cachePath)) return false;
  try {
    const cacheState = loadCacheState(cachePath, false);
    return Object.keys(cacheState).length > 0;
  } catch {
    return false;
  }
}