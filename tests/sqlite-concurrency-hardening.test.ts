/**
 * Step-0 performance fixes, domain B: sqlite concurrency hardening.
 *
 * - migrate(): two processes first-opening the same v1 store serialize on
 *   BEGIN IMMEDIATE; the loser re-reads user_version under the lock and skips
 *   instead of dying on `ALTER TABLE ... duplicate column`.
 * - mergeSiblingJsonStoreIntoSqlite: snapshot → plan → upsert → rename runs
 *   under the target's write lock, and the JSON sibling is re-checked once the
 *   lock is held so a losing process cannot clobber the winner's renumbered
 *   dialogue turns from a stale snapshot.
 * - readSnapshot: a materialized node-object cache was measured on the real
 *   store (95% of rows carry metadata) and rejected — mutation isolation
 *   forces a deep copy per node, 7-10x slower than the current lazy build
 *   (details in rowToSnapshotNode's comment). These tests lock the contract
 *   the cache would have to keep: distinct node objects per call, fresh
 *   metadata parses, cache invalidated by own writes (writeGen) and other
 *   connections' commits (data_version).
 */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";
import { MERGE_MARKER_SUFFIX, mergeSiblingJsonStoreIntoSqlite } from "../src/graph/store-migration";
import { GraphifySqliteClient } from "../src/graph/sqlite-client";
import type { GraphNode } from "../src/core/types";

const require = createRequire(import.meta.url);

function hasBetterSqlite3(): boolean {
  try {
    const Database = require("better-sqlite3") as new (path: string) => { close(): void };
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch {
    return false;
  }
}

type RawDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
};

function openRaw(path: string): RawDatabase {
  const Database = require("better-sqlite3") as new (p: string) => RawDatabase;
  return new Database(path);
}

/** Minimal v1 store: nodes without the searchtext column, user_version = 1. */
function makeV1Store(path: string): void {
  const db = openRaw(path);
  db.exec(`
    CREATE TABLE nodes(
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT
    );
    CREATE TABLE edges(
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, relation)
    );
    INSERT INTO nodes(id, type, content) VALUES ('legacy1', 'File', 'legacy orchard row');
  `);
  db.pragma("user_version = 1");
  db.close();
}

const baseDir = mkdtempSync(join(tmpdir(), "graphflow-sqlite-hardening-"));
const clients: GraphifySqliteClient[] = [];

function uniquePath(name: string): string {
  return join(baseDir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

afterAll(() => {
  for (const c of clients) {
    try {
      c.close();
    } catch {
      // ignore on Windows file-lock
    }
  }
});

describe.skipIf(!hasBetterSqlite3())("constructor migrate concurrency", () => {
  it("two clients opening the same v1 store both construct and reach schema v3", async () => {
    const path = uniquePath("migrate-race");
    makeV1Store(path);

    const construct = async (): Promise<GraphifySqliteClient> => {
      // Jitter approximates two processes racing to first-open the same store.
      // The constructors themselves are synchronous, so within one process the
      // worst case is back-to-back: the second must also survive seeing the
      // store mid/post-migration. Across processes the BEGIN IMMEDIATE lock
      // plus the under-lock user_version re-check decide the race.
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 20)));
      return new GraphifySqliteClient(path);
    };
    const [a, b] = await Promise.all([construct(), construct()]);
    clients.push(a, b);

    expect(a.readSnapshot().nodes.map((n) => n.id)).toEqual(["legacy1"]);
    expect(b.readSnapshot().nodes.map((n) => n.id)).toEqual(["legacy1"]);
    for (const c of [a, b]) {
      // The v1 → v3 migration rebuilt FTS over the migrated rows.
      const hits = await c.queryByKeyword("orchard");
      expect(hits.map((h) => h.id)).toEqual(["legacy1"]);
    }
    const raw = openRaw(path);
    expect(raw.pragma("user_version", { simple: true })).toBe(3);
    raw.close();
  });

  it("an up-to-date store opens without waiting on another connection's write transaction", () => {
    const path = uniquePath("uptodate-open");
    const first = new GraphifySqliteClient(path);
    clients.push(first);

    const peer = openRaw(path);
    try {
      peer.pragma("busy_timeout = 500");
      peer.exec("BEGIN IMMEDIATE");
      peer
        .prepare("INSERT INTO nodes(id, type, content, metadata, searchtext) VALUES ('peer', 'File', 'uncommitted', NULL, '')")
        .run();

      // The migrate fast path must not take the write lock: if it did, this
      // constructor would block for the full busy_timeout (the peer never
      // commits inside this window) and then throw SQLITE_BUSY.
      const second = new GraphifySqliteClient(path);
      clients.push(second);
      // Reads see the last committed snapshot, not the peer's uncommitted row.
      expect(second.readSnapshot().nodes.map((n) => n.id)).toEqual([]);
    } finally {
      peer.exec("ROLLBACK");
      peer.close();
    }
    expect(first.readSnapshot().nodes.map((n) => n.id)).toEqual([]);
  });
});

describe.skipIf(!hasBetterSqlite3())("mergeSiblingJsonStoreIntoSqlite concurrency", () => {
  async function writeJsonSibling(sqlitePath: string, nodes: GraphNode[]): Promise<string> {
    const jsonPath = sqlitePath.replace(/\.sqlite$/i, ".json");
    const file = new GraphifyFileClient(jsonPath);
    await file.upsertNodes(nodes);
    await file.close?.();
    return jsonPath;
  }

  it("runs snapshot → plan → upsert → rename inside the target's write lock", async () => {
    const sqlitePath = uniquePath("merge-lock");
    const jsonPath = await writeJsonSibling(sqlitePath, [
      { id: "episode:x", type: "Decision", content: "memory", metadata: { createdAt: "2026-10-01T00:00:00Z" } },
    ]);

    const events: string[] = [];
    const stats = mergeSiblingJsonStoreIntoSqlite(
      {
        readSnapshot: () => {
          events.push("read");
          return { nodes: [], edges: [] };
        },
        upsertGraphSync: () => {
          events.push("upsert");
        },
        withMergeLock: <T>(fn: () => T): T => {
          events.push("lock");
          const out = fn();
          events.push("unlock");
          return out;
        },
      },
      sqlitePath
    );
    expect(stats?.addedNodes).toBe(1);
    expect(events).toEqual(["lock", "read", "upsert", "unlock"]);
    expect(existsSync(jsonPath)).toBe(false); // renamed to backup inside the lock
    expect(existsSync(`${sqlitePath}${MERGE_MARKER_SUFFIX}`)).toBe(true);
  });

  it("skips the merge when the JSON sibling is gone by the time the lock is held", async () => {
    const sqlitePath = uniquePath("merge-peer-won");
    const jsonPath = await writeJsonSibling(sqlitePath, [
      { id: "episode:y", type: "Decision", content: "memory" },
    ]);

    let targetCalls = 0;
    expect(
      mergeSiblingJsonStoreIntoSqlite(
        {
          readSnapshot: () => {
            targetCalls += 1;
            return { nodes: [], edges: [] };
          },
          upsertGraphSync: () => {
            targetCalls += 1;
          },
          // Simulates the winning process having renamed the JSON store away
          // while this merge waited for the lock: our snapshot inputs are
          // stale, so the merge must become a no-op instead of upserting a
          // plan computed against the pre-merge store.
          withMergeLock: <T>(fn: () => T): T => {
            rmSync(jsonPath, { force: true });
            return fn();
          },
        },
        sqlitePath
      )
    ).toBeUndefined();
    expect(targetCalls).toBe(0);
    expect(existsSync(`${sqlitePath}${MERGE_MARKER_SUFFIX}`)).toBe(false);
  });

  it("falls back to a lock file for targets without withMergeLock", async () => {
    const sqlitePath = uniquePath("merge-lockfile");
    await writeJsonSibling(sqlitePath, [{ id: "episode:z", type: "Decision", content: "memory" }]);

    const seen: string[] = [];
    const stats = mergeSiblingJsonStoreIntoSqlite(
      {
        readSnapshot: () => {
          seen.push("read");
          return { nodes: [], edges: [] };
        },
        upsertGraphSync: () => {
          seen.push("upsert");
        },
      },
      sqlitePath
    );
    expect(stats?.addedNodes).toBe(1);
    expect(seen).toEqual(["read", "upsert"]);
    expect(existsSync(`${sqlitePath}.merge-lock`)).toBe(false); // lock released after the merge
  });

  it("a real client merges its JSON sibling under its own write lock", async () => {
    const sqlitePath = uniquePath("merge-real");
    await writeJsonSibling(sqlitePath, [
      {
        id: "episode:real",
        type: "Decision",
        content: "real orchard memory",
        metadata: { createdAt: "2026-10-02T00:00:00Z" },
      },
    ]);
    const client = new GraphifySqliteClient(sqlitePath);
    clients.push(client);
    expect(typeof client.withMergeLock).toBe("function");

    const stats = mergeSiblingJsonStoreIntoSqlite(client, sqlitePath);
    expect(stats?.addedNodes).toBe(1);
    expect(client.readSnapshot().nodes.map((n) => n.id)).toEqual(["episode:real"]);
    const hits = await client.queryByKeyword("orchard");
    expect(hits.map((h) => h.id)).toEqual(["episode:real"]);
    expect(existsSync(`${sqlitePath}${MERGE_MARKER_SUFFIX}`)).toBe(true);
  });
});

describe.skipIf(!hasBetterSqlite3())("readSnapshot node cache semantics", () => {
  it("repeated reads return distinct but equal objects; caller mutations never leak", async () => {
    const client = new GraphifySqliteClient(uniquePath("snapshot-cache"));
    clients.push(client);
    await client.upsertNodes([
      { id: "meta1", type: "Decision", content: "with meta", metadata: { kind: "dialogue-turn", tags: ["a"] } },
      { id: "plain1", type: "File", content: "no meta" },
    ]);

    const first = client.readSnapshot();
    const second = client.readSnapshot();
    // Same rows cache, fresh node objects per call.
    expect(first.nodes).not.toBe(second.nodes);
    expect(first.nodes).toEqual(second.nodes);
    for (let i = 0; i < first.nodes.length; i += 1) {
      expect(first.nodes[i]).not.toBe(second.nodes[i]);
    }
    // Lazy metadata stays enumerable before first access.
    expect(Object.keys(first.nodes.find((n) => n.id === "meta1")!)).toEqual(["id", "type", "content", "metadata"]);

    const m1 = first.nodes.find((n) => n.id === "meta1")!;
    (m1.metadata!.tags as string[]).push("mutated");
    m1.metadata = { replaced: true };
    m1.content = "changed";
    first.nodes.find((n) => n.id === "plain1")!.content = "changed";

    const third = client.readSnapshot();
    expect(third.nodes.find((n) => n.id === "meta1")!.content).toBe("with meta");
    expect(third.nodes.find((n) => n.id === "meta1")!.metadata).toEqual({ kind: "dialogue-turn", tags: ["a"] });
    expect(third.nodes.find((n) => n.id === "plain1")!.content).toBe("no meta");
    expect("metadata" in third.nodes.find((n) => n.id === "plain1")!).toBe(false);
  });

  it("cache invalidates on this client's writes and on other connections' commits", async () => {
    const path = uniquePath("snapshot-invalidate");
    const a = new GraphifySqliteClient(path);
    clients.push(a);
    await a.upsertNodes([{ id: "n1", type: "File", content: "v1 orchard" }]);
    expect(a.readSnapshot().nodes[0]!.content).toBe("v1 orchard");

    await a.upsertNodes([{ id: "n1", type: "File", content: "v2 orchard" }]);
    expect(a.readSnapshot().nodes[0]!.content).toBe("v2 orchard"); // writeGen invalidation

    const b = new GraphifySqliteClient(path);
    clients.push(b);
    await b.upsertNodes([{ id: "n2", type: "File", content: "external orchard" }]);
    expect(a.readSnapshot().nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]); // data_version invalidation
  });

  it("materializes warm snapshots of a 3k-node store fast (smoke bound)", async () => {
    const client = new GraphifySqliteClient(uniquePath("snapshot-warm"));
    clients.push(client);
    const nodes: GraphNode[] = Array.from({ length: 3000 }, (_, i) => ({
      id: `sym:${i}`,
      type: "Symbol",
      content: `symbol number ${i}`,
      ...(i % 20 === 0 ? { metadata: { jsdoc: `node ${i} docs`, exports: [`e${i}`] } } : {}),
    }));
    await client.upsertNodes(nodes);
    client.readSnapshot(); // warm the row cache

    const started = performance.now();
    for (let i = 0; i < 10; i += 1) {
      client.readSnapshot();
    }
    const perSnapshot = (performance.now() - started) / 10;
    // Measured ~3 ms per warm snapshot locally (3000 nodes); the bound only
    // guards against a pathological regression of the node materialization.
    expect(perSnapshot).toBeLessThan(500);
  });
});
