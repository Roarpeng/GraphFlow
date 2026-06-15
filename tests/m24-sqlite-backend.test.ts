import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { GraphifySqliteClient } from "../src/graph/sqlite-client";
import type { GraphEdge, GraphNode } from "../src/core/types";

const baseDir = mkdtempSync(join(tmpdir(), "graphflow-sqlite-"));
const clients: GraphifySqliteClient[] = [];

function freshClient(name: string): GraphifySqliteClient {
  const path = join(baseDir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const client = new GraphifySqliteClient(path);
  clients.push(client);
  return client;
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

describe.skipIf(!hasBetterSqlite3())("M24 SQLite + FTS5 backend", () => {
  it("A: FTS5 multi-token query returns nodes containing all tokens", async () => {
    const client = freshClient("a");
    const nodes: GraphNode[] = [
      { id: "n1", type: "File", content: "orchestrate task pipeline alpha" },
      { id: "n2", type: "File", content: "orchestrate routing decision" },
      { id: "n3", type: "Symbol", content: "task runner module" },
      { id: "n4", type: "Symbol", content: "validator output gamma" },
    ];
    await client.upsertNodes(nodes);

    const hits = await client.queryByKeyword("orchestrate task");
    const ids = hits.map((n) => n.id).sort();
    expect(ids).toEqual(["n1"]);
  });

  it("B: upsert is idempotent and updates content", async () => {
    const client = freshClient("b");
    await client.upsertNodes([{ id: "x", type: "File", content: "original orchestrate" }]);
    await client.upsertNodes([{ id: "x", type: "File", content: "updated orchestrate version" }]);

    const hits = await client.queryByKeyword("updated");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toBe("updated orchestrate version");

    const stale = await client.queryByKeyword("original");
    expect(stale).toHaveLength(0);
  });

  it("C: duplicate edges are dedup'd by PK", async () => {
    const client = freshClient("c");
    const nodes: GraphNode[] = [
      { id: "A", type: "Symbol", content: "alpha" },
      { id: "B", type: "Symbol", content: "beta" },
    ];
    const edge: GraphEdge = { from: "A", to: "B", relation: "references" };
    await client.upsertNodes(nodes);
    await client.upsertEdges([edge, edge, edge]);
    await client.upsertEdges([edge]);

    const neighbors = await client.getNeighbors(["A"], undefined, "out");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].node.id).toBe("B");
    expect(neighbors[0].via).toBe("references");
  });

  it("D: getNodesByIds drops missing ids silently", async () => {
    const client = freshClient("d");
    await client.upsertNodes([
      { id: "k1", type: "File", content: "one", metadata: { tag: "x" } },
      { id: "k2", type: "File", content: "two" },
    ]);
    const got = await client.getNodesByIds(["k1", "missing", "k2"]);
    const ids = got.map((n) => n.id).sort();
    expect(ids).toEqual(["k1", "k2"]);
    const k1 = got.find((n) => n.id === "k1")!;
    expect(k1.metadata).toEqual({ tag: "x" });
  });

  it("E: getNeighbors respects relation filter and direction", async () => {
    const client = freshClient("e");
    const nodes: GraphNode[] = [
      { id: "A", type: "Symbol", content: "a" },
      { id: "B", type: "Symbol", content: "b" },
      { id: "C", type: "Symbol", content: "c" },
    ];
    const edges: GraphEdge[] = [
      { from: "A", to: "B", relation: "references" },
      { from: "A", to: "C", relation: "co_occurs" },
      { from: "C", to: "A", relation: "depends_on" },
    ];
    await client.upsertNodes(nodes);
    await client.upsertEdges(edges);

    const outRef = await client.getNeighbors(["A"], ["references"], "out");
    expect(outRef.map((n) => n.node.id)).toEqual(["B"]);

    const inA = await client.getNeighbors(["A"], undefined, "in");
    expect(inA.map((n) => n.node.id)).toEqual(["C"]);

    const both = await client.getNeighbors(["A"], undefined, "both");
    const bothIds = both.map((n) => n.node.id).sort();
    expect(bothIds).toEqual(["B", "C"]);
  });

  it("F: createGraphClient with transport=sqlite returns a working client", async () => {
    const dbPath = join(baseDir, `factory-${Date.now()}.sqlite`);
    const cfg = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-5.3-codex" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 4000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "sqlite",
        graphStorePath: dbPath,
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        canaryRatio: 10,
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });
    expect(cfg.graphPolicy.transport).toBe("sqlite");

    const client = createGraphClient(cfg);
    await client.upsertNodes([
      { id: "f1", type: "File", content: "factory routed via sqlite backend" },
    ]);
    const hits = await client.queryByKeyword("sqlite backend");
    expect(hits.map((n) => n.id)).toEqual(["f1"]);
  });
});
