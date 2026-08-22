import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  GraphifyFileClient,
  getGraphifyFileStoreParseCount,
  graphifyFileStoreCache,
  resetGraphifyFileStoreCacheForTests,
} from "../src/graph/graphify-file-client";
import type { GraphEdge, GraphNode } from "../src/core/types";

const root = mkdtempSync(join(tmpdir(), "graphflow-file-cache-"));

afterEach(() => {
  resetGraphifyFileStoreCacheForTests();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a store file the way the file client would (pretty-printed JSON). */
function writeStoreJson(storePath: string, nodes: GraphNode[], edges: GraphEdge[] = []): void {
  writeFileSync(storePath, `${JSON.stringify({ nodes, edges }, null, 2)}\n`, "utf8");
}

const sampleNodes: GraphNode[] = [
  { id: "n1", type: "File", content: "orchestrate task pipeline alpha", metadata: { team: "core" } },
  { id: "n2", type: "Symbol", content: "orchestrate routing decision" },
  { id: "n3", type: "Symbol", content: "validator output gamma" },
];

describe("GraphifyFileClient process-wide store cache", () => {
  it("reuses the parsed store on repeated queries while mtime+size are unchanged", async () => {
    const storePath = join(root, `hit-${Date.now()}.json`);
    writeStoreJson(storePath, sampleNodes);

    const client = new GraphifyFileClient(storePath);
    const before = getGraphifyFileStoreParseCount();

    const first = await client.queryByKeyword("orchestrate");
    expect(first.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);

    // Same file on disk => cache hit, no re-parse.
    const second = await client.queryByKeyword("orchestrate");
    expect(second.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);

    // Snapshots on the same store are also served from the cache.
    client.readSnapshot();
    client.readSnapshot();
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);
  });

  it("shares one cache entry across instances pointing at the same absolute path", async () => {
    const storePath = join(root, `shared-${Date.now()}.json`);
    writeStoreJson(storePath, sampleNodes);

    const clientA = new GraphifyFileClient(storePath);
    const clientB = new GraphifyFileClient(storePath);
    const before = getGraphifyFileStoreParseCount();

    await clientA.queryByKeyword("validator");
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);

    // Second instance must not re-read the file: the cache is keyed by path.
    const hits = await clientB.queryByKeyword("validator");
    expect(hits.map((n) => n.id)).toEqual(["n3"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);

    expect(graphifyFileStoreCache.size).toBe(1);
    expect([...graphifyFileStoreCache.keys()]).toEqual([resolve(storePath)]);
  });

  it("invalidates on external content change (mtime + size differ) and re-reads", async () => {
    const storePath = join(root, `invalidate-${Date.now()}.json`);
    writeStoreJson(storePath, sampleNodes);
    const client = new GraphifyFileClient(storePath);
    await client.queryByKeyword("orchestrate");
    const before = getGraphifyFileStoreParseCount();

    // External process rewrites the store (different content and size).
    writeStoreJson(storePath, [{ id: "n9", type: "File", content: "brand new topic" }]);
    const hits = await client.queryByKeyword("brand");
    expect(hits.map((n) => n.id)).toEqual(["n9"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);

    // And the stale cache was fully replaced: old nodes are gone.
    expect(await client.queryByKeyword("orchestrate")).toEqual([]);
  });

  it("invalidates on an mtime-only change (same size) and re-reads", async () => {
    const storePath = join(root, `mtime-${Date.now()}.json`);
    const payload = `${JSON.stringify({ nodes: sampleNodes, edges: [] }, null, 2)}\n`;
    writeFileSync(storePath, payload, "utf8");

    const client = new GraphifyFileClient(storePath);
    await client.queryByKeyword("orchestrate");
    const before = getGraphifyFileStoreParseCount();

    // Rewrite the exact same bytes, then force a future mtime: size identical,
    // only mtime differs — the cache must still invalidate.
    writeFileSync(storePath, payload, "utf8");
    utimesSync(storePath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const hits = await client.queryByKeyword("orchestrate");
    expect(hits.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);
  });

  it("write-through: own writes update the cache without re-reading the file", async () => {
    const storePath = join(root, `write-through-${Date.now()}.json`);
    const clientA = new GraphifyFileClient(storePath);
    const before = getGraphifyFileStoreParseCount();

    await clientA.upsertNodes(sampleNodes);
    // The write itself never parses the file, and subsequent reads are cache hits.
    expect(getGraphifyFileStoreParseCount()).toBe(before);

    const snapshot = clientA.readSnapshot();
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before);

    // A brand-new client on the same path sees the same data from the cache.
    const clientB = new GraphifyFileClient(storePath);
    const hits = await clientB.queryByKeyword("gamma");
    expect(hits.map((n) => n.id)).toEqual(["n3"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before);

    // And the on-disk content matches the cached state.
    const onDisk = JSON.parse(readFileSync(storePath, "utf8")) as {
      nodes: GraphNode[];
      edges: GraphEdge[];
    };
    expect(onDisk.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("write-through: edge upserts and deletes are visible without re-parse", async () => {
    const storePath = join(root, `write-edges-${Date.now()}.json`);
    const client = new GraphifyFileClient(storePath);
    await client.upsertNodes(sampleNodes);
    await client.upsertEdges([
      { from: "n1", to: "n2", relation: "references" },
      { from: "n1", to: "n3", relation: "co_occurs" },
    ]);
    const before = getGraphifyFileStoreParseCount();

    const neighbors = await client.getNeighbors(["n1"], undefined, "out");
    expect(neighbors.map((n) => n.node.id).sort()).toEqual(["n2", "n3"]);
    expect(getGraphifyFileStoreParseCount()).toBe(before);

    await client.deleteNodes(["n3"]);
    const snapshot = client.readSnapshot();
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(snapshot.edges).toEqual([{ from: "n1", to: "n2", relation: "references" }]);
    expect(getGraphifyFileStoreParseCount()).toBe(before);

    await client.deleteEdge("n1", "n2", "references");
    expect(client.readSnapshot().edges).toEqual([]);
    expect(getGraphifyFileStoreParseCount()).toBe(before);
  });

  it("a corrupt store file is parsed once and cached as empty", async () => {
    const storePath = join(root, `corrupt-${Date.now()}.json`);
    writeFileSync(storePath, "{ this is not json !!!", "utf8");

    const client = new GraphifyFileClient(storePath);
    const before = getGraphifyFileStoreParseCount();
    expect(await client.queryByKeyword("anything")).toEqual([]);
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);

    // Corrupt state is cached: no repeated parse (and no repeated warning).
    expect(await client.queryByKeyword("anything")).toEqual([]);
    expect(client.readSnapshot()).toEqual({ nodes: [], edges: [] });
    expect(getGraphifyFileStoreParseCount()).toBe(before + 1);
  });

  it("stays consistent under interleaved writes and reads across instances", async () => {
    const storePath = join(root, `interleave-${Date.now()}.json`);
    const clientA = new GraphifyFileClient(storePath);
    const clientB = new GraphifyFileClient(storePath);

    // Every public method runs its body synchronously, so interleaved calls
    // serialize; the shared cache must never expose a half-written store.
    await Promise.all([
      clientA.upsertNodes([sampleNodes[0]]),
      clientB.upsertNodes([sampleNodes[1]]),
      clientA.queryByKeyword("orchestrate"),
      clientB.upsertNodes([sampleNodes[2]]),
      clientA.queryByKeyword("gamma"),
    ]);

    const snapshot = clientB.readSnapshot();
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);

    const onDisk = JSON.parse(readFileSync(storePath, "utf8")) as { nodes: GraphNode[] };
    expect(onDisk.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("a store created by another instance after a missing-file cache entry is picked up", async () => {
    const storePath = join(root, `late-create-${Date.now()}.json`);
    const reader = new GraphifyFileClient(storePath);
    expect(await reader.queryByKeyword("anything")).toEqual([]);

    // External writer creates the store file; the cached "missing" entry must
    // not mask it.
    writeStoreJson(storePath, [sampleNodes[0]]);
    const hits = await reader.queryByKeyword("alpha");
    expect(hits.map((n) => n.id)).toEqual(["n1"]);
  });
});
