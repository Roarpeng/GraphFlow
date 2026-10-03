import { closeSync, mkdtempSync, openSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  GRAPH_STORE_MAX_READ_BYTES,
  GraphifyFileClient,
  getGraphifyFileStoreParseCount,
  graphStoreDeltaPath,
  resetGraphifyFileStoreCacheForTests,
  writeGraphStoreFile,
} from "../src/graph/graphify-file-client";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphEdge, GraphNode } from "../src/core/types";
import { getDefaultConfig } from "../src/config/defaults";
import type { GraphFlowConfig } from "../src/config/schema";
import { readFileGraphStore, resolveGraphStoreAfterIndex } from "../src/surfaces/cli/runtime/helpers";
import { graphStoreNeedsIndexing, resolveDeferredEmbeddingPassLimit } from "../src/surfaces/cli/runtime/graph";

/**
 * Step-0 performance fix, domain A — the file-transport READ path used to
 * bypass the process-wide `graphifyFileStoreCache` outside GraphifyFileClient:
 *
 * - `graphStoreNeedsIndexing` did its own readFileSync + JSON.parse per
 *   preview just to count node types;
 * - `readFileGraphStore` (loadGraphStore → resolveGraphStoreAfterIndex) did a
 *   SECOND full read + parse right after.
 *
 * On a 9.5MB store that is two full reads + parses per preview. Both now go
 * through `GraphifyFileClient.peekStore`, which shares the statSync-validated
 * cache entry with the file client. These tests pin:
 * 1. peekStore hits the shared cache (byte probe: parse counter stays put);
 * 2. the file-transport decisions are behaviorally equivalent (code-node
 *    detection, full-store read result, delta application);
 * 3. the chunked large-file fallback still works when peek declines;
 * 4. the deferred embedding pass limit is env-overridable (default 128).
 */

const root = mkdtempSync(join(tmpdir(), "graphflow-fileread-cache-"));

afterEach(() => {
  resetGraphifyFileStoreCacheForTests();
  delete process.env.GRAPHFLOW_EMBEDDING_PASS_LIMIT;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeStoreJson(storePath: string, nodes: GraphNode[], edges: GraphEdge[] = []): void {
  writeGraphStoreFile(storePath, { nodes, edges });
}

const codeNodes: GraphNode[] = [
  { id: "file:src/a.ts", type: "File", content: "src/a.ts#module alpha" },
  { id: "symbol:src/a.ts#fnOne", type: "Symbol", content: "fnOne does alpha things" },
];

const dialogueOnlyNodes: GraphNode[] = [
  { id: "taskrun:1", type: "TaskRun", content: "how does the cache work" },
  { id: "taskrun:2", type: "TaskRun", content: "it shares one parsed store" },
];

const sampleEdges: GraphEdge[] = [
  { from: "file:src/a.ts", to: "symbol:src/a.ts#fnOne", relation: "defines" },
];

/** Minimal file-transport config whose store path points into the temp root. */
function fileTransportConfig(storePath: string): GraphFlowConfig {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    graphPolicy: {
      ...defaults.graphPolicy,
      transport: "file",
      workspaceRoot: root,
      graphStorePath: storePath,
    },
  };
}

describe("GraphifyFileClient.peekStore (shared read entry)", () => {
  it("serves repeated peeks of the same path from the shared cache (zero re-reads)", () => {
    const storePath = join(root, "peek-hit.json");
    writeStoreJson(storePath, codeNodes, sampleEdges);

    const first = GraphifyFileClient.peekStore(storePath);
    expect(first?.nodes.map((n) => n.id)).toEqual(["file:src/a.ts", "symbol:src/a.ts#fnOne"]);
    expect(getGraphifyFileStoreParseCount()).toBe(1);

    // Second peek: statSync-validated cache hit, no re-read.
    const second = GraphifyFileClient.peekStore(storePath);
    expect(second?.nodes).toHaveLength(2);
    expect(getGraphifyFileStoreParseCount()).toBe(1);

    // A real client instance on the same path shares the SAME entry.
    const client = new GraphifyFileClient(storePath);
    expect(client.readSnapshot().nodes).toHaveLength(2);
    expect(getGraphifyFileStoreParseCount()).toBe(1);
  });

  it("re-reads when the file changes on disk (mtime+size validation)", () => {
    const storePath = join(root, "peek-invalidate.json");
    writeStoreJson(storePath, codeNodes);
    expect(GraphifyFileClient.peekStore(storePath)?.nodes).toHaveLength(2);

    // Different byte length => stat mismatch => one fresh read + parse.
    writeStoreJson(storePath, [...codeNodes, { id: "file:src/b.ts", type: "File", content: "src/b.ts" }]);
    const after = GraphifyFileClient.peekStore(storePath);
    expect(after?.nodes.map((n) => n.id)).toContain("file:src/b.ts");
    expect(getGraphifyFileStoreParseCount()).toBe(2);
  });

  it("returns undefined for a missing store file", () => {
    expect(GraphifyFileClient.peekStore(join(root, "no-such-store.json"))).toBeUndefined();
    expect(getGraphifyFileStoreParseCount()).toBe(0);
  });

  it("declines oversized stores without reading them (large-file fallback trigger)", () => {
    const storePath = join(root, "peek-oversized.json");
    writeStoreJson(storePath, codeNodes);
    // Sparse extension: NTFS grows the file instantly; stat reports the size
    // without anyone reading the (NUL) contents.
    truncateSync(storePath, GRAPH_STORE_MAX_READ_BYTES + 1);

    expect(GraphifyFileClient.peekStore(storePath)).toBeUndefined();
    // Declining must be cheap: the oversized file was never read or parsed.
    expect(getGraphifyFileStoreParseCount()).toBe(0);
  });
});

describe("graphStoreNeedsIndexing via the shared cache (file transport)", () => {
  it("reports false for a store with code nodes, true for a non-code store", () => {
    const codeStore = join(root, "needs-index-code.json");
    writeStoreJson(codeStore, codeNodes);
    const dialogueStore = join(root, "needs-index-dialogue.json");
    writeStoreJson(dialogueStore, dialogueOnlyNodes);

    expect(graphStoreNeedsIndexing(fileTransportConfig(codeStore))).toBe(false);
    expect(graphStoreNeedsIndexing(fileTransportConfig(dialogueStore))).toBe(true);
    // Decision equivalence was reached through ONE parse per store, shared
    // with any later peek — repeated checks never re-read.
    expect(getGraphifyFileStoreParseCount()).toBe(2);
    expect(graphStoreNeedsIndexing(fileTransportConfig(codeStore))).toBe(false);
    expect(graphStoreNeedsIndexing(fileTransportConfig(dialogueStore))).toBe(true);
    expect(getGraphifyFileStoreParseCount()).toBe(2);
  });

  it("treats corrupt JSON like the old catch path (needs indexing)", () => {
    const storePath = join(root, "needs-index-corrupt.json");
    writeFileSync(storePath, "{ not valid json !!", "utf8");
    expect(graphStoreNeedsIndexing(fileTransportConfig(storePath))).toBe(true);
  });

  it("reports true when neither store nor delta log exists", () => {
    expect(graphStoreNeedsIndexing(fileTransportConfig(join(root, "absent.json")))).toBe(true);
  });
});

describe("readFileGraphStore / resolveGraphStoreAfterIndex via the shared cache", () => {
  it("returns the identical store (delta applied) and adds zero parses after a peek", async () => {
    const storePath = join(root, "full-read.json");
    const deltaNode: GraphNode = { id: "file:src/c.ts", type: "File", content: "src/c.ts" };
    writeStoreJson(storePath, codeNodes, sampleEdges);
    writeFileSync(
      graphStoreDeltaPath(storePath),
      `${JSON.stringify({ op: "upsert", nodes: [deltaNode] })}\n`,
      "utf8"
    );

    // Warm the shared cache the way the preview path does (indexing check).
    GraphifyFileClient.peekStore(storePath);
    expect(getGraphifyFileStoreParseCount()).toBe(1);

    // Full read through the SAME cache: same result as a cold parse, no
    // additional read.
    const read = readFileGraphStore(storePath);
    expect(read.nodes.map((n) => n.id).sort()).toEqual(
      ["file:src/a.ts", "file:src/c.ts", "symbol:src/a.ts#fnOne"].sort()
    );
    expect(read.edges).toHaveLength(1);
    expect(getGraphifyFileStoreParseCount()).toBe(1);

    // resolveGraphStoreAfterIndex (file transport) goes through the same
    // entry: still zero additional parses.
    const config = fileTransportConfig(storePath);
    const resolved = await resolveGraphStoreAfterIndex(config, {} as GraphClient);
    expect(resolved.nodes.map((n) => n.id).sort()).toEqual(read.nodes.map((n) => n.id).sort());
    expect(getGraphifyFileStoreParseCount()).toBe(1);
  });

  it("shallow-copies the shared arrays so callers cannot corrupt the cache", () => {
    const storePath = join(root, "mutation-safety.json");
    writeStoreJson(storePath, codeNodes, sampleEdges);

    const read = readFileGraphStore(storePath);
    read.nodes.reverse();
    read.nodes.push({ id: "file:evil.ts", type: "File", content: "injected" });

    const again = readFileGraphStore(storePath);
    expect(again.nodes.map((n) => n.id)).toEqual(["file:src/a.ts", "symbol:src/a.ts#fnOne"]);
    expect(GraphifyFileClient.peekStore(storePath)?.nodes).toHaveLength(2);
  });

  it("keeps the chunked large-file fallback when peek declines", () => {
    const storePath = join(root, "chunked-fallback.json");
    writeStoreJson(storePath, codeNodes, sampleEdges);
    const size = getFileSizeOrThrow(storePath);

    // Force the size branch with the documented option (the same branch a
    // >GRAPH_STORE_MAX_READ_BYTES store takes when peekStore returns
    // undefined): the chunked reader must return the identical store.
    const read = readFileGraphStore(storePath, { singleStringLimitBytes: size - 1 });
    expect(read.nodes.map((n) => n.id)).toEqual(["file:src/a.ts", "symbol:src/a.ts#fnOne"]);
    expect(read.edges).toHaveLength(1);
  });
});

describe("deferred embedding pass limit", () => {
  it("defaults to 128 and reads GRAPHFLOW_EMBEDDING_PASS_LIMIT", () => {
    delete process.env.GRAPHFLOW_EMBEDDING_PASS_LIMIT;
    expect(resolveDeferredEmbeddingPassLimit()).toBe(128);

    process.env.GRAPHFLOW_EMBEDDING_PASS_LIMIT = "256";
    expect(resolveDeferredEmbeddingPassLimit()).toBe(256);

    process.env.GRAPHFLOW_EMBEDDING_PASS_LIMIT = "64";
    expect(resolveDeferredEmbeddingPassLimit()).toBe(64);
  });

  it("falls back to 128 for non-positive or non-numeric values", () => {
    for (const value of ["0", "-5", "abc", ""]) {
      process.env.GRAPHFLOW_EMBEDDING_PASS_LIMIT = value;
      expect(resolveDeferredEmbeddingPassLimit()).toBe(128);
    }
  });
});

function getFileSizeOrThrow(path: string): number {
  return statSync(path).size;
}


describe("graphStoreNeedsIndexing semantic locks (review round 2)", () => {
  it("code nodes living only in the delta log count as indexed (post-peek semantics)", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-peek-delta-"));
    try {
      const storePath = join(root, "graph.json");
      // Tiny base without code nodes; threshold lowered so upserts take delta.
      const file = new GraphifyFileClient(storePath, { deltaMinBaseBytes: 1, deltaCompactBytes: 64 * 1024 });
      await file.upsertNodes([{ id: "dialogue:a", type: "Decision", content: "conversation only" }]);
      await file.upsertNodes([{ id: "file:src/x.ts", type: "File", content: "code node via delta" }]);
      await file.close?.();
      // Pre-peek code path read only the base and would have returned true
      // (re-index trigger); the peek path applies the delta, sees the code
      // node, and correctly reports an indexed store.
      const cfg = { ...getDefaultConfig(), graphPolicy: { ...getDefaultConfig().graphPolicy, transport: "file" as const, graphStorePath: storePath, workspaceRoot: root } };
      expect(graphStoreNeedsIndexing(cfg)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an oversized base store reports not-needs-indexing instead of a doomed re-index loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-peek-oversize-"));
    try {
      const storePath = join(root, "graph.json");
      const fh = openSync(storePath, "w");
      truncateSync(fh, 512 * 1024 * 1024 + 1); // NTFS sparse: instant
      closeSync(fh);
      const cfg = { ...getDefaultConfig(), graphPolicy: { ...getDefaultConfig().graphPolicy, transport: "file" as const, graphStorePath: storePath, workspaceRoot: root } };
      expect(graphStoreNeedsIndexing(cfg)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
