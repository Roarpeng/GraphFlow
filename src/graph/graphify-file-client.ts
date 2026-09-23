import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GraphEdge, GraphNode } from "../core/types";
import { logger } from "../utils/logger";
import { tokenizeForIndex, nodeSearchableText } from "./graph-utils";
import { readGraphStoreFileChunked } from "./graph-store-json-chunks";

interface GraphStore {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Incremental writes append to a delta log next to the store instead of
 * rewriting the whole JSON document. On a large workspace (hundreds of MB) every
 * save used to cost one full read + rewrite; now a small batch is an append.
 * The log is compacted back into the base file once it grows past the threshold
 * (or immediately for large batches and deletes), so the base file always stays
 * a plain, self-contained graph store.
 */
export const GRAPH_STORE_DELTA_SUFFIX = ".delta.jsonl";
/** Compact the delta into the base store once it exceeds this size. */
export const GRAPH_STORE_DELTA_COMPACT_BYTES = 8 * 1024 * 1024;
/**
 * Only large base stores use a delta log. Below this size a full rewrite is
 * cheap, so small/medium projects keep the historical layout: exactly one
 * self-contained JSON file, byte-identical to before.
 */
export const GRAPH_STORE_DELTA_MIN_BASE_BYTES = 4 * 1024 * 1024;

interface DeltaUpsertOp {
  op: "upsert";
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

interface DeltaDeleteOp {
  op: "delete";
  nodeIds?: string[];
  edges?: Array<{ from: string; to: string; relation: GraphEdge["relation"] }>;
}

type DeltaOp = DeltaUpsertOp | DeltaDeleteOp;

export function graphStoreDeltaPath(storePath: string): string {
  return `${storePath}${GRAPH_STORE_DELTA_SUFFIX}`;
}

const deltaPathFor = graphStoreDeltaPath;

/** Merge a delta log into a base store (applied in file order). */
export function applyGraphStoreDelta(
  base: GraphStore,
  deltaContents: string
): GraphStore {
  const nodeMap = new Map(base.nodes.map((node) => [node.id, node]));
  const edges = [...base.edges];
  const edgeKey = (edge: GraphEdge) => `${edge.from}::${edge.relation}::${edge.to}`;
  const edgeKeys = new Set(edges.map(edgeKey));
  // Endpoint index for O(degree) deletes. The previous implementation ran a
  // full edges.filter + edgeKeys rebuild per delete op — with a real-world
  // 1k-op delta log over a 35k-edge store that was ~77M string ops (~31s on
  // this machine), enough to blow the 60s MCP resources timeout on every
  // diagnose/stats read.
  const edgeIdxByEndpoint = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    for (const endpoint of [edge.from, edge.to]) {
      const list = edgeIdxByEndpoint.get(endpoint);
      if (list) list.push(index);
      else edgeIdxByEndpoint.set(endpoint, [index]);
    }
  });
  const keyToIdx = new Map(edges.map((edge, index) => [edgeKey(edge), index]));
  /** Lazily-marked removed edge indices; compacted once at the end. */
  const removedEdgeIdx = new Set<number>();

  const markEdgeRemoved = (index: number): void => {
    if (index < 0 || index >= edges.length) return;
    if (removedEdgeIdx.has(index)) return;
    removedEdgeIdx.add(index);
    edgeKeys.delete(edgeKey(edges[index]!));
  };

  for (const line of deltaContents.split("\n")) {
    if (!line.trim()) continue;
    let op: DeltaOp;
    try {
      op = JSON.parse(line) as DeltaOp;
    } catch {
      // A torn trailing line (crash mid-append) must not poison the store.
      logger.warn({ deltaLine: line.slice(0, 120) }, "skipping malformed graph store delta line");
      continue;
    }
    if (op.op === "upsert") {
      for (const node of op.nodes ?? []) nodeMap.set(node.id, node);
      for (const edge of op.edges ?? []) {
        const key = edgeKey(edge);
        const existingIdx = keyToIdx.get(key);
        if (existingIdx !== undefined) {
          if (!removedEdgeIdx.has(existingIdx)) continue; // already present
          markEdgeRemoved(existingIdx); // re-add below
        }
        edgeKeys.add(key);
        keyToIdx.set(key, edges.length);
        for (const endpoint of [edge.from, edge.to]) {
          const list = edgeIdxByEndpoint.get(endpoint);
          if (list) list.push(edges.length);
          else edgeIdxByEndpoint.set(endpoint, [edges.length]);
        }
        edges.push(edge);
      }
    } else if (op.op === "delete") {
      const ids = new Set(op.nodeIds ?? []);
      const removedEdges = (op.edges ?? []).map(edgeKey);
      if (ids.size === 0 && removedEdges.length === 0) continue;
      for (const id of ids) nodeMap.delete(id);
      for (const id of ids) {
        for (const index of edgeIdxByEndpoint.get(id) ?? []) {
          markEdgeRemoved(index);
        }
      }
      for (const key of removedEdges) {
        const index = keyToIdx.get(key);
        if (index !== undefined) markEdgeRemoved(index);
      }
    }
  }

  if (removedEdgeIdx.size === 0) {
    return { nodes: Array.from(nodeMap.values()), edges };
  }
  return {
    nodes: Array.from(nodeMap.values()),
    edges: edges.filter((_, index) => !removedEdgeIdx.has(index)),
  };
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
  /**
   * Lazily built `edgeKey` set for `store.edges`. Rebuilt at most once per store
   * load and kept in sync by writes, so an incremental save no longer re-keys
   * every existing edge (millions of template strings) on each write.
   */
  edgeKeys: Set<string> | null;
  /** Stat of the delta log when this entry was validated (null when absent). */
  deltaStat: FileStat | null;
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

/**
 * Stores with at most this many elements (nodes + edges) are pretty-printed so
 * nodes stay human-readable in editors. Bigger stores are written compact and in
 * chunks: `JSON.stringify(store, null, 2)` on a multi-million-edge workspace
 * graph exceeds V8's maximum string length (~512 MB on 64-bit) and throws
 * `RangeError: Invalid string length` — surfaced to users as
 * "GraphFlow MCP 自动安装失败: Invalid string length" in the VS Code extension.
 */
export const GRAPH_STORE_PRETTY_PRINT_MAX_ELEMENTS = 20_000;

/** Flush the accumulating chunk at this size; peak string memory while writing. */
const GRAPH_STORE_WRITE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Refuse to read a store above this size: `readFileSync(path, "utf8")` on a
 * bigger file throws `ERR_STRING_TOO_LONG` (a V8 string-length failure with a
 * confusing message). Failing loudly with the path + size keeps the cause
 * actionable; silently returning an empty store would trigger a re-index loop.
 */
export const GRAPH_STORE_MAX_READ_BYTES = 512 * 1024 * 1024;

/** Actionable error for a store too large to read as one string (shared). */
export function graphStoreTooLargeError(storePath: string, sizeBytes: number): Error {
  const sizeMb = Math.round(sizeBytes / (1024 * 1024));
  const limitMb = Math.round(GRAPH_STORE_MAX_READ_BYTES / (1024 * 1024));
  return new Error(
    `Graph store is too large to read (${sizeMb} MB at ${storePath}, limit ${limitMb} MB). ` +
      "Remove the file and run a rebuild, or narrow graphPolicy.includeExtensions."
  );
}

function serializeStoreElement(value: unknown, kind: "node" | "edge"): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to serialize graph store ${kind}: ${message}`);
  }
}

/**
 * Write the whole store as one JSON document without ever materializing it as a
 * single string (compact form, chunked writes).
 */
function streamGraphStore(
  filePath: string,
  store: GraphStore,
  chunkBytes: number = GRAPH_STORE_WRITE_CHUNK_BYTES
): void {
  const fd = openSync(filePath, "w");
  let buffer = "";
  const flush = (): void => {
    if (buffer.length > 0) {
      writeSync(fd, buffer);
      buffer = "";
    }
  };
  const push = (text: string): void => {
    buffer += text;
    if (buffer.length >= chunkBytes) flush();
  };
  try {
    push('{"nodes":[');
    for (let i = 0; i < store.nodes.length; i += 1) {
      push(`${i === 0 ? "" : ","}${serializeStoreElement(store.nodes[i], "node")}`);
    }
    push('],"edges":[');
    for (let i = 0; i < store.edges.length; i += 1) {
      push(`${i === 0 ? "" : ","}${serializeStoreElement(store.edges[i], "edge")}`);
    }
    push("]}\n");
    flush();
  } finally {
    closeSync(fd);
  }
}

/**
 * Persist a store to `filePath` (exported for tests).
 *
 * Pretty output is attempted first for small stores; anything that cannot be
 * stringified in one piece (or that exceeds the element budget) falls back to
 * the chunked compact writer instead of failing with "Invalid string length".
 */
export function writeGraphStoreFile(
  filePath: string,
  store: GraphStore,
  options: { prettyPrintMaxElements?: number; chunkBytes?: number } = {}
): void {
  const budget = options.prettyPrintMaxElements ?? GRAPH_STORE_PRETTY_PRINT_MAX_ELEMENTS;
  if (store.nodes.length + store.edges.length <= budget) {
    try {
      writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      return;
    } catch (error) {
      // Fall through to the streaming writer (e.g. a few very large nodes).
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), filePath },
        "Graph store pretty-print failed; falling back to the chunked writer"
      );
    }
  }
  streamGraphStore(filePath, store, options.chunkBytes);
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
  constructor(
    private readonly storePath: string,
    private readonly options: {
      deltaCompactBytes?: number;
      /** Base-store size above which incremental writes use a delta log. */
      deltaMinBaseBytes?: number;
    } = {}
  ) {}

  /**
   * Merge nodes and edges into the store with a SINGLE read + write.
   *
   * The store is one JSON document, so every mutation rewrites the whole file:
   * on a large workspace (millions of edges / hundreds of MB) two separate
   * upserts per indexed file cost two full rewrites — the dominant cost of
   * incremental indexing. Callers that have both halves (the file indexer, the
   * file watcher) must use this instead of calling the two methods in sequence.
   *
   * An empty batch is a no-op and never touches the file: the watcher fires on
   * saves that changed nothing indexable, and a needless rewrite there is pure
   * latency.
   *
   * Contract: the incoming `edges` must already be unique (the file builders
   * dedupe per source; the legacy `upsertEdges` dedupes its batch before
   * delegating). This method dedupes against the STORE, which is what makes
   * re-indexing idempotent.
   */
  async upsertGraph(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }): Promise<void> {
    const incomingNodes = batch.nodes ?? [];
    const incomingEdges = batch.edges ?? [];
    if (incomingNodes.length === 0 && incomingEdges.length === 0) {
      return;
    }

    const entry = this.readStoreEntry();
    const store = entry.store;
    const nodeMap = new Map(store.nodes.map((node) => [node.id, node]));
    for (const node of incomingNodes) {
      nodeMap.set(node.id, node);
    }

    const next: GraphStore = { nodes: Array.from(nodeMap.values()), edges: [...store.edges] };
    let edgeKeys: Set<string> | null = entry.edgeKeys;
    if (incomingEdges.length > 0) {
      if (next.edges.length === 0) {
        // Nothing to dedupe against: append directly and let the key set be
        // rebuilt lazily if a later write needs it.
        for (const edge of incomingEdges) next.edges.push(edge);
        edgeKeys = null;
      } else {
        if (!edgeKeys) {
          edgeKeys = new Set(next.edges.map((edge) => this.edgeKey(edge)));
        }
        for (const edge of incomingEdges) {
          const key = this.edgeKey(edge);
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          next.edges.push(edge);
        }
      }
    }

    const addedEdges = next.edges.length - store.edges.length;
    const upsertOp: DeltaUpsertOp = {
      op: "upsert",
      ...(incomingNodes.length > 0 ? { nodes: incomingNodes } : {}),
      ...(incomingEdges.length > 0 && addedEdges > 0
        ? { edges: next.edges.slice(store.edges.length, store.edges.length + addedEdges) }
        : {}),
    };
    if (this.tryAppendDelta(entry, upsertOp, next, edgeKeys)) {
      return;
    }
    this.writeStore(next, edgeKeys);
  }

  /**
   * Append an operation to the delta log when it is small relative to the store.
   * Returns false when the caller must compact (large batch, no base file yet, or
   * the log would outgrow its threshold).
   */
  private tryAppendDelta(
    entry: StoreCacheEntry,
    op: DeltaOp,
    nextStore: GraphStore,
    edgeKeys: Set<string> | null
  ): boolean {
    if (entry.stat === null) {
      return false;
    }
    const minBaseBytes = this.options.deltaMinBaseBytes ?? GRAPH_STORE_DELTA_MIN_BASE_BYTES;
    if (entry.stat.size < minBaseBytes) {
      // Small store: a plain rewrite is cheaper (and keeps one file on disk).
      return false;
    }
    const storeElements = entry.store.nodes.length + entry.store.edges.length;
    const addedElements =
      op.op === "upsert"
        ? (op.nodes?.length ?? 0) + (op.edges?.length ?? 0)
        : (op.nodeIds?.length ?? 0) + (op.edges?.length ?? 0);
    if (addedElements === 0) {
      return false;
    }
    const compactBytes = this.options.deltaCompactBytes ?? GRAPH_STORE_DELTA_COMPACT_BYTES;
    const deltaBytes = entry.deltaStat?.size ?? 0;
    if (addedElements > Math.max(200, Math.ceil(storeElements * 0.05))) {
      return false;
    }
    if (deltaBytes + addedElements * 160 > compactBytes) {
      return false;
    }
    const deltaPath = resolve(deltaPathFor(resolve(this.storePath)));
    try {
      mkdirSync(dirname(deltaPath), { recursive: true });
      appendFileSync(deltaPath, `${JSON.stringify(op)}\n`, "utf8");
      this.updateCacheAfterWrite(nextStore, edgeKeys, statIfExists(deltaPath));
      return true;
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), deltaPath },
        "graph store delta append failed; falling back to a full rewrite"
      );
      return false;
    }
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    await this.upsertGraph({ nodes });
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    // Legacy entry point: callers may hand over duplicates, so dedupe the batch
    // here (upsertGraph requires unique input and skips the in-batch check).
    const seen = new Set<string>();
    const unique: GraphEdge[] = [];
    for (const edge of edges) {
      const key = this.edgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(edge);
    }
    await this.upsertGraph({ edges: unique });
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
    const deltaPath = resolve(deltaPathFor(absPath));
    const deltaStat = statIfExists(deltaPath);
    const cached = graphifyFileStoreCache.get(absPath);
    if (cached && sameStat(cached.stat, current) && sameStat(cached.deltaStat, deltaStat)) {
      return cached;
    }

    let base: GraphStore | undefined;
    if (current !== null && current.size > GRAPH_STORE_MAX_READ_BYTES) {
      // Above the single-string limit: parse in bounded chunks instead of
      // throwing ERR_STRING_TOO_LONG from readFileSync.
      try {
        const chunked = readGraphStoreFileChunked(absPath);
        base = { nodes: chunked.nodes as GraphNode[], edges: chunked.edges as GraphEdge[] };
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error), absPath },
          "Chunked graph store read failed"
        );
        throw graphStoreTooLargeError(absPath, current.size);
      }
    }

    const store = base ?? (current === null ? { nodes: [], edges: [] } : this.parseStoreFile(absPath));
    const merged = this.applyDelta(store, deltaPath, deltaStat);
    const entry: StoreCacheEntry = {
      store: merged,
      index: null,
      stat: current,
      edgeKeys: null,
      deltaStat,
    };
    graphifyFileStoreCache.set(absPath, entry);
    return entry;
  }

  /** Merge the delta log (when present) into a freshly loaded base store. */
  private applyDelta(base: GraphStore, deltaPath: string, deltaStat: FileStat | null): GraphStore {
    if (deltaStat === null || deltaStat.size === 0) {
      return base;
    }
    let contents: string;
    try {
      contents = readFileSync(deltaPath, "utf8");
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), deltaPath },
        "graph store delta unreadable; using the base store"
      );
      return base;
    }
    return applyGraphStoreDelta(base, contents);
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

  private writeStore(store: GraphStore, edgeKeys: Set<string> | null = null): void {
    const dir = dirname(this.storePath);
    mkdirSync(dir, { recursive: true });
    const tempPath = join(
      dir,
      `.graphflow-graph-${process.pid}-${randomBytes(4).toString("hex")}.tmp`
    );
    try {
      // Small graphs stay pretty-printed (human-readable); large ones are
      // written compact + chunked so the payload never becomes one giant string.
      writeGraphStoreFile(tempPath, store);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
    // A successful base write supersedes any delta log.
    const deltaPath = deltaPathFor(this.storePath);
    if (existsSync(deltaPath)) {
      rmSync(deltaPath, { force: true });
    }
    // Windows 上 rename 可能因文件锁定而失败，添加重试机制
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      try {
        renameSync(tempPath, this.storePath);
        // Write-through: only after the rename succeeded does the cache move to
        // the new store. On failure the previous entry (matching the untouched
        // file on disk) stays valid.
        this.updateCacheAfterWrite(store, edgeKeys);
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
  private updateCacheAfterWrite(
    store: GraphStore,
    edgeKeys: Set<string> | null,
    deltaStat: FileStat | null = null
  ): void {
    const absPath = resolve(this.storePath);
    let stat: FileStat | null = null;
    try {
      const st = statSync(absPath);
      stat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // Extremely unlikely immediately after rename; leave stat null so the
      // next read re-validates from disk.
    }
    graphifyFileStoreCache.set(absPath, { store, index: null, stat, edgeKeys, deltaStat });
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
    const entry = this.readStoreEntry();
    const store = entry.store;
    const next: GraphStore = {
      nodes: store.nodes.filter((n) => !idSet.has(n.id)),
      edges: store.edges.filter((e) => !(idSet.has(e.from) || idSet.has(e.to))),
    };
    // A per-file prune during a re-index must not rewrite the whole store.
    if (this.tryAppendDelta(entry, { op: "delete", nodeIds: ids }, next, null)) {
      return;
    }
    this.writeStore(next, null);
  }

  /** Compact the delta log into the base store (no-op when there is none). */
  vacuum(): void {
    const deltaPath = deltaPathFor(this.storePath);
    if (!existsSync(deltaPath)) {
      return;
    }
    const entry = this.readStoreEntry();
    this.writeStore(entry.store, entry.edgeKeys);
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    const entry = this.readStoreEntry();
    const store = entry.store;
    const next: GraphStore = {
      nodes: [...store.nodes],
      edges: store.edges.filter(
        (e) => !(e.from === from && e.to === to && e.relation === relation)
      ),
    };
    if (this.tryAppendDelta(entry, { op: "delete", edges: [{ from, to, relation }] }, next, null)) {
      return;
    }
    this.writeStore(next, null);
  }
}
