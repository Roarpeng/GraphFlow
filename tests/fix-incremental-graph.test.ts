/**
 * Incremental knowledge-graph rebuild: correctness regressions.
 *
 * The graph is rebuilt from per-file contributions that are replayed from
 * `.graphflow/graph-shards.json`. The property these tests protect is the one that matters:
 * **an incremental rebuild must produce byte-identical nodes and edges to a full rebuild of
 * the same workspace** — otherwise "incremental" is just "fast and wrong".
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { getWorkspaceAstIndex } from "../src/slicer.js";
import { buildKnowledgeGraphData } from "../src/doc-graph.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Stable, comparable projection of a graph. */
function project(graph: ReturnType<typeof buildKnowledgeGraphData>): {
  nodes: string[];
  edges: string[];
} {
  return {
    nodes: graph.nodes.map((n) => `${n.id}|${n.label}|${n.kind}`).sort(),
    edges: graph.edges.map((e) => `${e.kind}|${e.source}|${e.target}`).sort(),
  };
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-incgraph-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/model.ts"),
    [
      "export class Order {",
      "  cancel() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "export class Invoice extends Order {",
      "  refund() {",
      "    return 2;",
      "  }",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "src/app.ts"),
    [
      'import { Order, Invoice } from "./model.ts";',
      "",
      "export function run() {",
      "  const o = new Order();",
      "  const i = new Invoice();",
      "  return o.cancel() + i.refund();",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "README.md"),
    ["# Payments", "", "## Orders", "", "Order.cancel stops a payment."].join("\n")
  );
  return root;
}

const root = makeRepo();
try {
  const index = getWorkspaceAstIndex(root);

  check("A1: cold incremental build equals a full build", () => {
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "0";
    const full = project(buildKnowledgeGraphData(index));
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "1";
    // Same process, same index: force the shard store to be rebuilt from scratch first.
    rmSync(join(root, ".graphflow", "graph-shards.json"), { force: true });
    rmSync(join(root, ".graphflow", "doc-links"), { recursive: true, force: true });
    const incremental = project(buildKnowledgeGraphData(index));
    assert.deepEqual(incremental.nodes, full.nodes, "node sets must match");
    assert.deepEqual(incremental.edges, full.edges, "edge sets must match");
    assert.ok(incremental.edges.length > 0, "fixture must produce edges");
  });

  check("A2: adding a method is picked up by the incremental rebuild", () => {
    writeFileSync(
      join(root, "src/model.ts"),
      [
        "export class Order {",
        "  cancel() {",
        "    return 1;",
        "  }",
        "  resume() {",
        "    return 3;",
        "  }",
        "}",
        "",
        "export class Invoice extends Order {",
        "  refund() {",
        "    return 2;",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    index.invalidateFile("src/model.ts");
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "1";
    const incremental = project(buildKnowledgeGraphData(index));
    assert.ok(
      incremental.nodes.some((n) => n.includes("resume")),
      `new method must appear in nodes: ${incremental.nodes.join("\n")}`
    );

    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "0";
    const full = project(buildKnowledgeGraphData(index));
    assert.deepEqual(incremental.nodes, full.nodes, "nodes must match a full rebuild");
    assert.deepEqual(incremental.edges, full.edges, "edges must match a full rebuild");
  });

  check("A3: a caller of the changed symbol is re-resolved", () => {
    // `app.ts` now calls the new method; its `calls` edge must be rebuilt too, which is only
    // possible if the reverse-dependency sweep invalidated it via `queriedNames`.
    writeFileSync(
      join(root, "src/app.ts"),
      [
        'import { Order, Invoice } from "./model.ts";',
        "",
        "export function run() {",
        "  const o = new Order();",
        "  const i = new Invoice();",
        "  return o.resume() + i.refund();",
        "}",
        "",
      ].join("\n")
    );
    index.invalidateFile("src/app.ts");
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "1";
    const incremental = project(buildKnowledgeGraphData(index));
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "0";
    const full = project(buildKnowledgeGraphData(index));
    assert.deepEqual(incremental.nodes, full.nodes, "nodes must match");
    assert.deepEqual(incremental.edges, full.edges, "edges must match");
    assert.ok(
      incremental.edges.some((e) => e.includes("resume")),
      "the new call edge must be present"
    );
  });

  check("A4: deleting a file drops its nodes from the incremental rebuild", () => {
    rmSync(join(root, "src/app.ts"));
    index.invalidateFile("src/app.ts");
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "1";
    const incremental = project(buildKnowledgeGraphData(index));
    assert.ok(
      !incremental.nodes.some((n) => n.includes("src/app.ts")),
      "deleted file must leave no nodes"
    );
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "0";
    const full = project(buildKnowledgeGraphData(index));
    assert.deepEqual(incremental.nodes, full.nodes, "nodes must match");
    assert.deepEqual(incremental.edges, full.edges, "edges must match");
  });

  check("A5: the shard manifest is written next to the graph", () => {
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "1";
    buildKnowledgeGraphData(index);
    const manifestPath = join(root, ".graphflow", "graph-shards.json");
    assert.ok(existsSync(manifestPath), "manifest must exist");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files?: Record<string, { syms?: unknown[] }>;
    };
    assert.ok(parsed.files && Object.keys(parsed.files).length > 0, "manifest must have files");
    // `syms` is what lets the next rebuild skip loading an unchanged AST.
    assert.ok(
      Object.values(parsed.files).every((f) => Array.isArray(f.syms)),
      "every record must carry its symbol table"
    );
  });

  check("A6: a corrupt manifest degrades to a full rebuild instead of failing", () => {
    writeFileSync(join(root, ".graphflow", "graph-shards.json"), "{ not json");
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "1";
    const incremental = project(buildKnowledgeGraphData(index));
    process.env.GRAPHFLOW_GRAPH_INCREMENTAL = "0";
    const full = project(buildKnowledgeGraphData(index));
    assert.deepEqual(incremental.nodes, full.nodes, "corrupt cache must fall back cleanly");
    assert.deepEqual(incremental.edges, full.edges, "corrupt cache must fall back cleanly");
  });
} finally {
  delete process.env.GRAPHFLOW_GRAPH_INCREMENTAL;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nincremental-graph: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
