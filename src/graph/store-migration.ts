/**
 * Fold a sibling JSON graph store into the SQLite store.
 *
 * Hosts without better-sqlite3 (the shared VSIX runtime used by Cursor, Cline,
 * ZCode) wrote `graphflow-graph.json` while the npm package wrote
 * `graphflow-graph.sqlite` for the same project, so memories (dialogue turns,
 * workbench topics, skills, episodes) split across two stores. Whenever a
 * SQLite store opens next to a JSON store, the JSON side is merged in and
 * renamed to `*.merged-bak`, so both halves become one store again.
 */

import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { GraphEdge, GraphNode } from "../core/types";
import { logger } from "../utils/logger";
import { GRAPH_STORE_DELTA_SUFFIX, GraphifyFileClient, MERGED_BACKUP_SUFFIX } from "./graphify-file-client";

export { MERGED_BACKUP_SUFFIX };
export const MERGE_MARKER_SUFFIX = ".merge-log.json";

const DIALOGUE_TURN_ID = /^dialogue:([^:]+):(\d+)$/;
/**
 * Code nodes are re-derived from disk by the SQLite store's own index
 * manifest; copying JSON-only ones would resurrect symbols of deleted files
 * that no later index run knows to prune.
 */
const CODE_NODE_TYPES = new Set<GraphNode["type"]>(["File", "Symbol", "Module"]);
const DIALOGUE_SESSION_PREFIX = "dialogue-session:";

export interface StoreMergeStats {
  jsonNodes: number;
  jsonEdges: number;
  addedNodes: number;
  updatedNodes: number;
  keptNodes: number;
  skippedCodeNodes: number;
  renumberedTurns: number;
  addedEdges: number;
  droppedEdges: number;
}

type RecordLike = Record<string, unknown>;

function parseRecord(node: GraphNode): RecordLike | undefined {
  const raw = node.metadata?.record;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as RecordLike) : undefined;
    } catch {
      return undefined;
    }
  }
  return raw && typeof raw === "object" ? (raw as RecordLike) : undefined;
}

function withRecord(node: GraphNode, record: RecordLike): GraphNode {
  const raw = node.metadata?.record;
  return {
    ...node,
    metadata: { ...(node.metadata ?? {}), record: typeof raw === "string" ? JSON.stringify(record) : record },
  };
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/** Last-modified time of a memory node; undefined for code nodes (no timestamps). */
export function nodeUpdatedAt(node: GraphNode): number | undefined {
  const record = parseRecord(node);
  return (
    timestampOf(record?.updatedAt) ??
    timestampOf(record?.createdAt) ??
    timestampOf(node.metadata?.updatedAt) ??
    timestampOf(node.metadata?.createdAt)
  );
}

function sameEntity(a: GraphNode, b: GraphNode): boolean {
  const ra = parseRecord(a);
  const rb = parseRecord(b);
  const ca = timestampOf(ra?.createdAt);
  const cb = timestampOf(rb?.createdAt);
  if (ca !== undefined && cb !== undefined) return ca === cb;
  return a.content === b.content;
}

function turnIdFor(sessionHash: string, seq: number): string {
  return `dialogue:${sessionHash}:${String(seq).padStart(4, "0")}`;
}

/**
 * Pure merge plan: which JSON-side nodes / edges to write into SQLite.
 *
 * - File / Symbol / Module nodes are skipped (re-indexed from disk).
 * - Other nodes only in JSON are added.
 * - Same id on both sides: the newer `updatedAt` wins; without timestamps
 *   (code nodes) SQLite wins — code is re-indexed right after the merge anyway.
 * - Dialogue turns are keyed `dialogue:<session>:<seq>`, so two hosts that kept
 *   talking in the same session produced colliding ids for different turns.
 *   Colliding JSON turns are renumbered after the highest seq and the session
 *   node is updated, so no turn is lost.
 */
export function planJsonIntoSqliteMerge(
  sqlite: { nodes: GraphNode[]; edges: GraphEdge[] },
  json: { nodes: GraphNode[]; edges: GraphEdge[] }
): { nodes: GraphNode[]; edges: GraphEdge[]; stats: StoreMergeStats } {
  const existing = new Map(sqlite.nodes.map((n) => [n.id, n]));
  const stats: StoreMergeStats = {
    jsonNodes: json.nodes.length,
    jsonEdges: json.edges.length,
    addedNodes: 0,
    updatedNodes: 0,
    keptNodes: 0,
    skippedCodeNodes: 0,
    renumberedTurns: 0,
    addedEdges: 0,
    droppedEdges: 0,
  };

  const maxSeq = new Map<string, number>();
  for (const node of [...sqlite.nodes, ...json.nodes]) {
    const m = DIALOGUE_TURN_ID.exec(node.id);
    if (m) maxSeq.set(m[1]!, Math.max(maxSeq.get(m[1]!) ?? 0, Number(m[2])));
  }

  // First pass: renumber colliding dialogue turns (in seq order so parents map first).
  const renamed = new Map<string, string>();
  const jsonTurns = json.nodes
    .filter((n) => DIALOGUE_TURN_ID.test(n.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const turn of jsonTurns) {
    const other = existing.get(turn.id);
    if (!other || sameEntity(turn, other)) continue;
    const sessionHash = DIALOGUE_TURN_ID.exec(turn.id)![1]!;
    const seq = (maxSeq.get(sessionHash) ?? 0) + 1;
    maxSeq.set(sessionHash, seq);
    renamed.set(turn.id, turnIdFor(sessionHash, seq));
  }
  const remap = (id: string): string => renamed.get(id) ?? id;

  const out: GraphNode[] = [];
  const sessionTips = new Map<string, { tip: string; at: number }>();
  for (const original of json.nodes) {
    if (CODE_NODE_TYPES.has(original.type)) {
      stats.skippedCodeNodes += 1;
      continue;
    }
    let node = original;
    const newId = renamed.get(node.id);
    if (newId) {
      const record = parseRecord(node) ?? {};
      const seq = Number(DIALOGUE_TURN_ID.exec(newId)![2]);
      const parent = typeof record.parentTurnId === "string" ? remap(record.parentTurnId) : undefined;
      node = withRecord(
        { ...node, id: newId, metadata: { ...(node.metadata ?? {}), seq } },
        { ...record, id: newId, seq, ...(parent ? { parentTurnId: parent } : {}) }
      );
      stats.renumberedTurns += 1;
    } else if (DIALOGUE_TURN_ID.test(node.id)) {
      const record = parseRecord(node);
      if (record && typeof record.parentTurnId === "string" && renamed.has(record.parentTurnId)) {
        node = withRecord(node, { ...record, parentTurnId: remap(record.parentTurnId) });
      }
    }

    const current = existing.get(node.id);
    if (!current) {
      out.push(node);
      stats.addedNodes += 1;
    } else {
      const jsonAt = nodeUpdatedAt(node);
      const sqliteAt = nodeUpdatedAt(current);
      if (jsonAt !== undefined && (sqliteAt === undefined || jsonAt > sqliteAt)) {
        out.push(node);
        stats.updatedNodes += 1;
      } else {
        stats.keptNodes += 1;
      }
    }

    if (node.id.startsWith("dialogue:") && DIALOGUE_TURN_ID.test(node.id)) {
      const record = parseRecord(node);
      const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
      const at = nodeUpdatedAt(node) ?? 0;
      if (sessionId && (sessionTips.get(sessionId)?.at ?? -1) < at) {
        sessionTips.set(sessionId, { tip: node.id, at });
      }
    }
  }

  // Sessions touched by renumbering: turnCount must cover every seq, and the tip
  // must be the most recent turn across both stores.
  if (renamed.size > 0) {
    for (const node of sqlite.nodes) {
      if (!DIALOGUE_TURN_ID.test(node.id)) continue;
      const record = parseRecord(node);
      const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
      const at = nodeUpdatedAt(node) ?? 0;
      if (sessionId && (sessionTips.get(sessionId)?.at ?? -1) < at) {
        sessionTips.set(sessionId, { tip: node.id, at });
      }
    }
    const touchedHashes = new Set([...renamed.values()].map((id) => DIALOGUE_TURN_ID.exec(id)![1]!));
    for (const hash of touchedHashes) {
      const sessionId = `${DIALOGUE_SESSION_PREFIX}${hash}`;
      const base = out.find((n) => n.id === sessionId) ?? existing.get(sessionId);
      if (!base) continue;
      const record = parseRecord(base) ?? {};
      const tip = sessionTips.get(sessionId)?.tip;
      const updated = withRecord(base, {
        ...record,
        turnCount: maxSeq.get(hash) ?? record.turnCount,
        ...(tip ? { tipTurnId: tip } : {}),
      });
      const idx = out.findIndex((n) => n.id === sessionId);
      if (idx >= 0) out[idx] = updated;
      else out.push(updated);
    }
  }

  const finalIds = new Set<string>([...existing.keys(), ...out.map((n) => n.id)]);
  const existingEdges = new Set(sqlite.edges.map((e) => `${e.from}\u0000${e.to}\u0000${e.relation}`));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const edge of json.edges) {
    const mapped = { from: remap(edge.from), to: remap(edge.to), relation: edge.relation };
    if (!finalIds.has(mapped.from) || !finalIds.has(mapped.to)) {
      stats.droppedEdges += 1;
      continue;
    }
    const key = `${mapped.from}\u0000${mapped.to}\u0000${mapped.relation}`;
    if (existingEdges.has(key) || seen.has(key)) continue;
    seen.add(key);
    edges.push(mapped);
  }
  stats.addedEdges = edges.length;
  return { nodes: out, edges, stats };
}

/**
 * The first backup holds the pre-merge memory and is kept. A not-yet-upgraded
 * host keeps writing JSON, so later merges rotate a single `.latest` copy
 * instead of accumulating one full store per merge.
 */
function renameWithRetry(from: string, to: string): void {
  // Windows rename can fail transiently (EPERM) while a scanner or another
  // process still holds a handle — same retry shape as
  // GraphifyFileClient.writeStore.
  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" && i < maxRetries - 1) {
        sleepMs(50);
        continue;
      }
      throw error;
    }
  }
}

function moveToBackup(path: string): void {
  const first = `${path}${MERGED_BACKUP_SUFFIX}`;
  if (!existsSync(first)) {
    renameWithRetry(path, first);
    return;
  }
  const latest = `${first}.latest`;
  rmSync(latest, { force: true });
  renameWithRetry(path, latest);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const MERGE_LOCK_SUFFIX = ".merge-lock";
const MERGE_LOCK_WAIT_MS = 10_000;
const MERGE_LOCK_STALE_MS = 30_000;

/**
 * Best-effort mutex via an exclusively-created lock file, for merge targets
 * that cannot hand out the SQLite write lock (test doubles, mixed hosts).
 * Node has no cross-platform flock, so this is advisory only: it does not
 * exclude a process that holds the real BEGIN IMMEDIATE lock. A stale lock
 * (crashed holder) is stolen; past the wait deadline the merge degrades to
 * running unlocked — it is idempotent and retried on the next open anyway.
 */
function withMergeLockFile<T>(sqlitePath: string, fn: () => T): T {
  const lockPath = `${sqlitePath}${MERGE_LOCK_SUFFIX}`;
  const deadline = Date.now() + MERGE_LOCK_WAIT_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > MERGE_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // the lock vanished between stat and rm — the next attempt acquires it
      }
      if (Date.now() > deadline) return fn();
      sleepMs(50);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        // handle already closed
      }
      rmSync(lockPath, { force: true });
    }
  }
}

export interface SqliteMergeTarget {
  readSnapshot(): { nodes: GraphNode[]; edges: GraphEdge[] };
  upsertGraphSync(batch: { nodes: GraphNode[]; edges: GraphEdge[] }): void;
  /**
   * Run `fn` while holding the store's write lock, serializing concurrent
   * merges of the same JSON sibling across processes. Optional: production
   * targets implement it with BEGIN IMMEDIATE; without it the merge falls
   * back to a best-effort lock file.
   */
  withMergeLock?<T>(fn: () => T): T;
}

/**
 * Merge `<store>.json` (+ delta log) into the SQLite store at `sqlitePath`.
 * No-op when no JSON sibling exists. A failed merge leaves the JSON store in
 * place so the next open retries.
 *
 * The snapshot → plan → upsert → rename section runs under the target's write
 * lock: two processes merging the same sibling serialize, the second one
 * re-checks under the lock and skips once the first has renamed the JSON store
 * away. Without that, the loser would upsert a plan computed from a pre-merge
 * snapshot and clobber the winner's renumbered dialogue turns.
 */
export function mergeSiblingJsonStoreIntoSqlite(
  target: SqliteMergeTarget,
  sqlitePath: string
): StoreMergeStats | undefined {
  const jsonPath = sqlitePath.replace(/\.sqlite$/i, ".json");
  if (jsonPath === sqlitePath || !existsSync(jsonPath)) {
    return undefined;
  }
  try {
    // Read the JSON side before taking the lock: it is not covered by the
    // SQLite lock anyway, and this keeps the write-lock hold time down to the
    // snapshot → plan → upsert → rename section.
    const json = new GraphifyFileClient(jsonPath).readSnapshot();
    const runMerge = (): StoreMergeStats | undefined => {
      // Under the lock: a peer may have completed this merge (and renamed the
      // JSON store away) while we waited for the lock. Our plan inputs are
      // stale — skip instead of clobbering.
      if (!existsSync(jsonPath)) return undefined;
      const plan = planJsonIntoSqliteMerge(target.readSnapshot(), json);
      target.upsertGraphSync({ nodes: plan.nodes, edges: plan.edges });

      moveToBackup(jsonPath);
      const deltaPath = `${jsonPath}${GRAPH_STORE_DELTA_SUFFIX}`;
      if (existsSync(deltaPath)) {
        moveToBackup(deltaPath);
      }
      writeFileSync(
        `${sqlitePath}${MERGE_MARKER_SUFFIX}`,
        `${JSON.stringify({ mergedAt: new Date().toISOString(), from: jsonPath, stats: plan.stats }, null, 2)}\n`,
        "utf8"
      );
      logger.info({ jsonPath, sqlitePath, stats: plan.stats }, "[graphflow] merged JSON graph store into SQLite");
      return plan.stats;
    };
    return typeof target.withMergeLock === "function"
      ? target.withMergeLock(runMerge)
      : withMergeLockFile(sqlitePath, runMerge);
  } catch (error) {
    logger.warn({ error, jsonPath, sqlitePath }, "[graphflow] JSON → SQLite store merge failed; will retry on next open");
    return undefined;
  }
}
