import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GraphEdge, GraphNode } from "../core/types";
import { logger } from "../utils/logger";
import { tokenizeForIndex, nodeSearchableText } from "./graph-utils";

interface GraphStore {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Recorded file identity used to validate a cache entry (mtime + size). */
interface FileStat {
  mtimeMs: number;
  size: number;
}

/**
 * One cache entry per absolute store path.
 *
 * - `store` is the parsed graph object. Internal write paths never mutate it
 *   (they build a fresh object and pass it to writeStore), and readSnapshot
 *   returns a shallow copy, so the shared entry cannot be corrupted by callers.
 * - `index` is the inverted index over `store.nodes`' searchable text; it is
 *   built lazily on the first keyword query and reset to null on every write.
 * - `stat` is the {mtimeMs, size} of the file when the entry was recorded
 *   (null when the file did not exist at that moment).
 */
interface StoreCacheEntry {
  store: GraphStore;
  index: Map<string, Set<string>> | null;
  stat: FileStat | null;
}

/**
 * Process-wide store cache keyed by the absolute store path, so every
 * GraphifyFileClient instance pointing at the same file (the context-slicer
 * reads snapshots several times per request) shares one parsed store + index
 * instead of re-reading + re-parsing the whole graph JSON each time.
 *
 * Entries are validated with a cheap statSync (mtime + size) on every read, so
 * external writes are picked up; our own writes update the entry write-through.
 *
 * Exported for tests (introspection / reset); production code should treat it
 * as an internal detail.
 */
export const graphifyFileStoreCache = new Map<string, StoreCacheEntry>();

let graphifyFileStoreParseCount = 0;

/** Test-only: number of times a store file was actually read from disk. */
export function getGraphifyFileStoreParseCount(): number {
  return graphifyFileStoreParseCount;
}

/** Test-only: drop every cached entry and reset the parse counter. */
export function resetGraphifyFileStoreCacheForTests(): void {
  graphifyFileStoreCache.clear();
  graphifyFileStoreParseCount = 0;
}

function statIfExists(absPath: string): FileStat | null {
  try {
    const st = statSync(absPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Missing file (or a path component that is not a directory) => "no store yet".
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    // Permission errors etc. must surface exactly like readFileSync would.
    throw error;
  }
}

function sameStat(a: FileStat | null, b: FileStat | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export class GraphifyFileClient {
  constructor(private readonly storePath: string) {}

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    const store = this.readStore();
    const map = new Map(store.nodes.map((node) => [node.id, node]));

    for (const node of nodes) {
      map.set(node.id, node);
    }

    this.writeStore({
      nodes: Array.from(map.values()),
      edges: [...store.edges],
    });
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    const store = this.readStore();
    const next: GraphStore = { nodes: [...store.nodes], edges: [...store.edges] };
    const edgeKeys = new Set(next.edges.map((edge) => this.edgeKey(edge)));

    for (const edge of edges) {
      const key = this.edgeKey(edge);
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        next.edges.push(edge);
      }
    }

    this.writeStore(next);
  }

  readSnapshot(): GraphStore {
    const { store } = this.readStoreEntry();
    // Shallow copy so callers can never corrupt the shared cache entry.
    return { nodes: [...store.nodes], edges: [...store.edges] };
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const entry = this.readStoreEntry();
    const store = entry.store;
    const tokens = tokenizeForIndex(query);
    if (tokens.length === 0) {
      const normalized = query.toLowerCase();
      return store.nodes.filter((node) =>
        nodeSearchableText(node).toLowerCase().includes(normalized)
      );
    }

    // The inverted index is stored on the cache entry, so repeated keyword
    // queries over an unchanged store do not re-tokenize every node.
    if (!entry.index) {
      entry.index = this.buildIndex(store.nodes);
    }
    const index = entry.index;
    const matched = new Set<string>();
    for (const tok of tokens) {
      const ids = index.get(tok);
      if (!ids) continue;
      for (const id of ids) matched.add(id);
    }
    return store.nodes.filter((n) => matched.has(n.id));
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    const store = this.readStore();
    const want = new Set(ids);
    return store.nodes.filter((n) => want.has(n.id));
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction: "out" | "in" | "both" = "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    const store = this.readStore();
    const nodeMap = new Map(store.nodes.map((n) => [n.id, n]));
    const relFilter = relations && relations.length > 0 ? new Set(relations) : null;
    const seedSet = new Set(nodeIds);
    const seen = new Set<string>();
    const out: { node: GraphNode; via: GraphEdge["relation"] }[] = [];

    for (const edge of store.edges) {
      if (relFilter && !relFilter.has(edge.relation)) continue;

      if ((direction === "out" || direction === "both") && seedSet.has(edge.from)) {
        if (!seen.has(edge.to)) {
          const node = nodeMap.get(edge.to);
          if (node) {
            seen.add(edge.to);
            out.push({ node, via: edge.relation });
          }
        }
      }
      if ((direction === "in" || direction === "both") && seedSet.has(edge.to)) {
        if (!seen.has(edge.from)) {
          const node = nodeMap.get(edge.from);
          if (node) {
            seen.add(edge.from);
            out.push({ node, via: edge.relation });
          }
        }
      }
    }
    return out;
  }

  private buildIndex(nodes: GraphNode[]): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    for (const node of nodes) {
      for (const tok of tokenizeForIndex(nodeSearchableText(node))) {
        let set = index.get(tok);
        if (!set) {
          set = new Set();
          index.set(tok, set);
        }
        set.add(node.id);
      }
    }
    return index;
  }

  private readStore(): GraphStore {
    return this.readStoreEntry().store;
  }

  /**
   * Return the validated cache entry for this store path: a cheap statSync
   * against the recorded mtime+size decides between a cache hit and a full
   * read + JSON.parse. All cache operations are synchronous, and every public
   * method runs its whole body without yielding, so no async gap can observe
   * a half-updated entry (single-threaded safety).
   */
  private readStoreEntry(): StoreCacheEntry {
    const absPath = resolve(this.storePath);
    const current = statIfExists(absPath);
    const cached = graphifyFileStoreCache.get(absPath);
    if (cached && sameStat(cached.stat, current)) {
      return cached;
    }

    const store = current === null ? { nodes: [], edges: [] } : this.parseStoreFile(absPath);
    const entry: StoreCacheEntry = { store, index: null, stat: current };
    graphifyFileStoreCache.set(absPath, entry);
    return entry;
  }

  private parseStoreFile(absPath: string): GraphStore {
    if (!existsSync(absPath)) {
      return { nodes: [], edges: [] };
    }

    const raw = readFileSync(absPath, "utf8");
    graphifyFileStoreParseCount += 1;
    if (!raw.trim()) {
      return { nodes: [], edges: [] };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<GraphStore>;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Graph store JSON root must be an object");
      }
      return {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      };
    } catch (error) {
      logger.warn(
        { error, storePath: this.storePath },
        "Corrupt graph store JSON; returning empty store (run graphflow_rebuild to repair)"
      );
      return { nodes: [], edges: [] };
    }
  }

  private writeStore(store: GraphStore): void {
    const dir = dirname(this.storePath);
    mkdirSync(dir, { recursive: true });
    // Pretty-print so nodes/edges are human-readable in editors (not one giant line).
    const payload = `${JSON.stringify(store, null, 2)}\n`;
    const tempPath = join(
      dir,
      `.graphflow-graph-${process.pid}-${randomBytes(4).toString("hex")}.tmp`
    );
    writeFileSync(tempPath, payload, "utf8");
    // Windows 上 rename 可能因文件锁定而失败，添加重试机制
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      try {
        renameSync(tempPath, this.storePath);
        // Write-through: only after the rename succeeded does the cache move to
        // the new store. On failure the previous entry (matching the untouched
        // file on disk) stays valid.
        this.updateCacheAfterWrite(store);
        return;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === "EPERM" && i < maxRetries - 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          continue;
        }
        rmSync(tempPath, { force: true });
        throw error;
      }
    }
  }

  /** Record the freshly written store (and its on-disk stat) in the cache. */
  private updateCacheAfterWrite(store: GraphStore): void {
    const absPath = resolve(this.storePath);
    let stat: FileStat | null = null;
    try {
      const st = statSync(absPath);
      stat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // Extremely unlikely immediately after rename; leave stat null so the
      // next read re-validates from disk.
    }
    graphifyFileStoreCache.set(absPath, { store, index: null, stat });
  }

  private edgeKey(edge: GraphEdge): string {
    return `${edge.from}::${edge.relation}::${edge.to}`;
  }

  async deleteNode(id: string): Promise<void> {
    await this.deleteNodes([id]);
  }

  async deleteNodes(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const store = this.readStore();
    this.writeStore({
      nodes: store.nodes.filter((n) => !idSet.has(n.id)),
      edges: store.edges.filter((e) => !(idSet.has(e.from) || idSet.has(e.to))),
    });
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    const store = this.readStore();
    this.writeStore({
      nodes: [...store.nodes],
      edges: store.edges.filter(
        (e) => !(e.from === from && e.to === to && e.relation === relation)
      ),
    });
  }
}
