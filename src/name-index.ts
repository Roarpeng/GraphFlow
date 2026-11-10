/**
 * Workspace name index (`src/name-index.ts`)
 *
 * Blast radius asks one question about every file in the workspace: "does this file
 * mention the identifier I care about?" It answered that by reading each file's full
 * source and running a word regex over it — on a 9 900-file workspace that is ~39 MB of
 * reads and, measured, ~4 s of the ~4.5 s a single-symbol read took.
 *
 * This index precomputes the identifier set per file from the AST shards that already
 * exist (declared symbols, call callees/receivers, imported names) and persists it as one
 * compact file, keyed by the same `mtimeMs:size` fingerprint the other stores use.
 *
 * A miss is never treated as "no". An unknown or stale record returns `undefined`, and the
 * caller falls back to the source scan; only a *certain* no short-circuits.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { branchScopeKey, graphCachePath } from "./branch-scope.js";
import type { getWorkspaceAstIndex } from "./slicer.js";

/** Lives in the branch-scoped cache dir (see `branch-scope.ts`). */
const NAME_INDEX_REL = "name-index.json";
const NAME_INDEX_VERSION = 2;

type Index = ReturnType<typeof getWorkspaceAstIndex>;

/** relPath -> [`mtimeMs:size`, space-joined identifier set]. */
interface NameIndexFile {
  version: number;
  files: Record<string, [string, string]>;
}

export interface WorkspaceNameIndex {
  /** `true`/`false` when certain, `undefined` when the record is missing or stale. */
  mentions(relPath: string, name: string): boolean | undefined;
  /** Same contract, for "does it mention any of these". */
  mentionsAny(relPath: string, names: readonly string[]): boolean | undefined;
}

const cacheByRoot = new Map<string, WorkspaceNameIndex>();

function indexPath(rootDir: string): string {
  return graphCachePath(rootDir, NAME_INDEX_REL);
}

function readStore(path: string): NameIndexFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as NameIndexFile;
    if (parsed?.version !== NAME_INDEX_VERSION) return undefined;
    if (typeof parsed.files !== "object" || parsed.files === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeStore(path: string, store: NameIndexFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), "utf8");
    renameSync(tmp, path);
  } catch {
    // A read-only workspace just means the index is rebuilt next run.
  }
}

const IDENTIFIER_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

/**
 * Every identifier-shaped token in the file's text — deliberately *not* derived from the
 * AST. A pre-filter must never answer "no" for a file that does mention the name, and the
 * AST does not retain every textual reference (a callback passed by value,
 * `items.map(handleItem)`, is an argument, not a call site). Tokenizing the text gives
 * exactly the same answer as the word-boundary regex it replaces, at a fraction of the size.
 * Tokens shorter than 3 characters are dropped: they carry little signal and would bloat
 * the store.
 */
function namesOfFile(content: string): string {
  const names = new Set<string>();
  for (const match of content.matchAll(IDENTIFIER_TOKEN_RE)) {
    names.add(match[0]);
  }
  return [...names].sort().join(" ");
}

/**
 * Loads (and incrementally refreshes) the name index for a workspace root.
 * First build costs one AST-shard read per file; afterwards it is one JSON load plus a
 * stat per file.
 */
export function getWorkspaceNameIndex(rootDir: string, index: Index): WorkspaceNameIndex {
  if (process.env.GRAPHFLOW_NAME_INDEX === "0") {
    return { mentions: () => undefined, mentionsAny: () => undefined };
  }
  // Per root *and* branch: each branch keeps its own identifier sets (and store file).
  const cacheKey = `${rootDir}\u0000${branchScopeKey(rootDir)}`;
  const cached = cacheByRoot.get(cacheKey);
  if (cached) return cached;

  const storePath = indexPath(rootDir);
  const store: NameIndexFile = readStore(storePath) ?? { version: NAME_INDEX_VERSION, files: {} };
  const files = index.getFiles();
  const known = new Map<string, Set<string> | null>();
  let changed = false;

  for (const relFile of files) {
    const stat = index.getFileState(relFile);
    if (!stat) {
      known.set(relFile, null);
      continue;
    }
    const state = `${stat.mtimeMs}:${stat.size}`;
    const record = store.files[relFile];
    if (record && record[0] === state) {
      known.set(relFile, new Set(record[1] ? record[1].split(" ") : []));
      continue;
    }
    const data = index.getFileAnalysis(relFile);
    if (!data) {
      known.set(relFile, null);
      continue;
    }
    const joined = namesOfFile(data.content);
    store.files[relFile] = [state, joined];
    known.set(relFile, new Set(joined ? joined.split(" ") : []));
    changed = true;
  }

  const live = new Set(files);
  for (const relFile of Object.keys(store.files)) {
    if (!live.has(relFile)) {
      delete store.files[relFile];
      changed = true;
    }
  }
  if (changed) writeStore(storePath, store);

  /**
   * Re-reads one file's identifier set when its fingerprint moved. Editing a file makes the
   * in-memory set stale immediately — a rename in this very process would otherwise answer
   * "this file never mentions the new name", which is a false negative the caller cannot
   * detect. Refreshing on read keeps the index self-correcting without invalidation hooks.
   */
  const refreshIfStale = (relFile: string): Set<string> | null => {
    const cached = known.get(relFile);
    if (!cached) return null;
    const stat = index.getFileState(relFile);
    if (!stat) return null;
    const state = `${stat.mtimeMs}:${stat.size}`;
    const record = store.files[relFile];
    if (record && record[0] === state) return cached;
    const data = index.getFileAnalysis(relFile);
    if (!data) {
      known.set(relFile, null);
      return null;
    }
    const joined = namesOfFile(data.content);
    store.files[relFile] = [state, joined];
    const fresh = new Set(joined ? joined.split(" ") : []);
    known.set(relFile, fresh);
    changed = true;
    return fresh;
  };

  const result: WorkspaceNameIndex = {
    mentions(relFile: string, name: string): boolean | undefined {
      // Tokens shorter than 3 characters are not stored, so those names stay unknown and
      // the caller falls back to the byte scan rather than trusting a missing entry.
      if (name.length < 3) return undefined;
      const set = refreshIfStale(relFile);
      if (!set) return undefined;
      return set.has(name);
    },
    mentionsAny(relFile: string, names: readonly string[]): boolean | undefined {
      if (names.some((name) => name.length < 3)) return undefined;
      const set = refreshIfStale(relFile);
      if (!set) return undefined;
      return names.some((name) => set.has(name));
    },
  };
  cacheByRoot.set(cacheKey, result);
  return result;
}

/** Drops the cached index (tests, or after a bulk workspace change). */
export function clearWorkspaceNameIndex(rootDir?: string): void {
  if (rootDir === undefined) {
    cacheByRoot.clear();
    return;
  }
  const prefix = `${rootDir}\u0000`;
  for (const key of [...cacheByRoot.keys()]) {
    if (key.startsWith(prefix)) cacheByRoot.delete(key);
  }
}
