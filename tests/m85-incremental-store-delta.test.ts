import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../src/core/types";
import { clearGraphIndexArtifacts } from "../src/graph/file-indexer-cache";
import {
  GRAPH_STORE_DELTA_SUFFIX,
  GraphifyFileClient,
  applyGraphStoreDelta,
  resetGraphifyFileStoreCacheForTests,
} from "../src/graph/graphify-file-client";

/**
 * M85 — incremental (delta) store writes.
 *
 * The file transport stores the whole graph in one JSON document, so before this
 * every save rewrote hundreds of MB (read + write) even when a single file
 * changed. Small batches now append to a delta log; the base file is rewritten
 * only for big batches, deletes, explicit vacuum or when the log outgrows its
 * threshold. Readers merge base + delta transparently.
 */

const tempRoots: string[] = [];

function makeStoreDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  resetGraphifyFileStoreCacheForTests();
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

const node = (id: string, content = id): GraphNode => ({ id, type: "File", content });
const edge = (from: string, to: string): GraphEdge => ({ from, to, relation: "references" });

describe("M85 incremental store delta", () => {
  it("appends small batches instead of rewriting the base store", async () => {
    const dir = makeStoreDir("gf-m85-append-");
    const storePath = join(dir, "graphflow-graph.json");
    const deltaPath = `${storePath}${GRAPH_STORE_DELTA_SUFFIX}`;
    const client = new GraphifyFileClient(storePath, { deltaMinBaseBytes: 0 });

    const baseNodes = Array.from({ length: 400 }, (_, i) => node(`file:base${i}.ts`));
    await client.upsertGraph({ nodes: baseNodes });
    const baseBefore = statSync(storePath);
    expect(existsSync(deltaPath)).toBe(false);

    // One incremental save: a handful of nodes/edges.
    await client.upsertGraph({ nodes: [node("file:changed.ts")], edges: [edge("file:changed.ts", "file:base1.ts")] });

    const baseAfter = statSync(storePath);
    expect(baseAfter.mtimeMs).toBe(baseBefore.mtimeMs);
    expect(baseAfter.size).toBe(baseBefore.size);
    expect(existsSync(deltaPath)).toBe(true);

    // A fresh reader sees base + delta merged.
    resetGraphifyFileStoreCacheForTests();
    const reader = new GraphifyFileClient(storePath);
    const snapshot = reader.readSnapshot();
    expect(snapshot.nodes.map((n) => n.id)).toContain("file:changed.ts");
    expect(snapshot.edges).toEqual([edge("file:changed.ts", "file:base1.ts")]);
  });

  it("compacts the delta once it outgrows the threshold", async () => {
    const dir = makeStoreDir("gf-m85-compact-");
    const storePath = join(dir, "graphflow-graph.json");
    const deltaPath = `${storePath}${GRAPH_STORE_DELTA_SUFFIX}`;
    const client = new GraphifyFileClient(storePath, { deltaCompactBytes: 1024, deltaMinBaseBytes: 0 });

    await client.upsertGraph({ nodes: Array.from({ length: 300 }, (_, i) => node(`file:base${i}.ts`)) });
    for (let i = 0; i < 40; i += 1) {
      await client.upsertGraph({ nodes: [node(`file:add${i}.ts`)] });
    }

    resetGraphifyFileStoreCacheForTests();
    const snapshot = new GraphifyFileClient(storePath).readSnapshot();
    expect(snapshot.nodes).toHaveLength(340);
    // Compaction happened at least once: an early append is baked into the base
    // file itself (the log is reset after each compaction, so a small log may
    // legitimately exist again for the appends that followed it).
    const baseContents = readFileSync(storePath, "utf8");
    expect(baseContents).toContain("file:add0.ts");
    if (existsSync(deltaPath)) {
      expect(statSync(deltaPath).size).toBeLessThan(1024);
    }
  });

  it("appends small deletes to the delta and compacts large ones", async () => {
    const dir = makeStoreDir("gf-m85-delete-");
    const storePath = join(dir, "graphflow-graph.json");
    const deltaPath = `${storePath}${GRAPH_STORE_DELTA_SUFFIX}`;
    const client = new GraphifyFileClient(storePath, { deltaMinBaseBytes: 0 });

    await client.upsertGraph({ nodes: [node("file:a.ts"), node("file:b.ts")], edges: [edge("file:a.ts", "file:b.ts")] });
    await client.upsertGraph({ nodes: [node("file:c.ts")] });
    const baseBefore = statSync(storePath);

    // Small delete (one file) stays in the delta: the base file is untouched.
    await client.deleteNodes(["file:b.ts"]);
    expect(statSync(storePath).mtimeMs).toBe(baseBefore.mtimeMs);
    expect(existsSync(deltaPath)).toBe(true);

    resetGraphifyFileStoreCacheForTests();
    const merged = new GraphifyFileClient(storePath).readSnapshot();
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["file:a.ts", "file:c.ts"]);
    expect(merged.edges).toEqual([]);

    // A large delete compacts instead of appending.
    const big = new GraphifyFileClient(join(makeStoreDir("gf-m85-bigdel-"), "graph.json"), { deltaMinBaseBytes: 0 });
    const ids = Array.from({ length: 400 }, (_, i) => `file:big${i}.ts`);
    await big.upsertGraph({ nodes: ids.map((id) => node(id)) });
    await big.upsertGraph({ nodes: [node("file:extra.ts")] });
    await big.deleteNodes(ids);
    expect(big.readSnapshot().nodes.map((n) => n.id)).toEqual(["file:extra.ts"]);
  });

  it("vacuum merges the delta into the base on demand", async () => {
    const dir = makeStoreDir("gf-m85-vacuum-");
    const storePath = join(dir, "graphflow-graph.json");
    const deltaPath = `${storePath}${GRAPH_STORE_DELTA_SUFFIX}`;
    const client = new GraphifyFileClient(storePath, { deltaMinBaseBytes: 0 });

    await client.upsertGraph({ nodes: [node("file:a.ts")] });
    await client.upsertGraph({ nodes: [node("file:b.ts")] });
    expect(existsSync(deltaPath)).toBe(true);

    client.vacuum();

    expect(existsSync(deltaPath)).toBe(false);
    resetGraphifyFileStoreCacheForTests();
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { nodes: GraphNode[] };
    expect(parsed.nodes.map((n) => n.id).sort()).toEqual(["file:a.ts", "file:b.ts"]);
  });

  it("ignores a torn trailing delta line instead of losing the store", () => {
    const base = { nodes: [node("file:a.ts")], edges: [] as GraphEdge[] };
    const contents = [
      JSON.stringify({ op: "upsert", nodes: [node("file:b.ts")], edges: [edge("file:b.ts", "file:a.ts")] }),
      '{"op":"upsert","nodes":[{"id":"file:c.ts"', // crash mid-append
    ].join("\n");

    const merged = applyGraphStoreDelta(base, contents);

    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["file:a.ts", "file:b.ts"]);
    expect(merged.edges).toEqual([edge("file:b.ts", "file:a.ts")]);
  });

  it("clears the delta on rebuild", () => {
    const dir = makeStoreDir("gf-m85-clear-");
    const storePath = join(dir, "graphflow-graph.json");
    const deltaPath = `${storePath}${GRAPH_STORE_DELTA_SUFFIX}`;
    writeFileSync(storePath, '{"nodes":[],"edges":[]}\n', "utf8");
    writeFileSync(deltaPath, `${JSON.stringify({ op: "upsert", nodes: [node("file:a.ts")] })}\n`, "utf8");

    clearGraphIndexArtifacts(dir, storePath);

    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(deltaPath)).toBe(false);
  });
});
