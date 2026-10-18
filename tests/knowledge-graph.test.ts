/**
 * GraphFlow — Standalone regression test for real knowledge-graph edges (`src/doc-graph.ts`).
 *
 * Verifies that the "interactive knowledge graph" exports actual code-dependency edges:
 *  1. `defines`: file -> symbol, kind/label correctly "defines" (not imports).
 *  2. `imports`: file -> file, resolved from real import statements (TS/JS relative + Python)
 *     and from tsconfig/jsconfig `paths` aliases (`@/model` -> ts/model.ts).
 *  3. `calls`: symbol -> symbol, receiver-type-aware (A.cancel vs B.cancel in one file),
 *     foreign receivers dropped, unknown receivers via same-file -> import -> package scope;
 *     deduped, no self edges, never matched across language families (Rust same-named fn).
 *  4. Every edge references a real node; duplicate (kind, source, target) triples never appear.
 *  5. The generated single-file HTML/JSON carry the new edge kinds, legend text and colors.
 *
 * Temp dirs only. Exits non-zero on failure.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKnowledgeGraphData,
  generateKnowledgeGraphHtml,
  getWorkspaceAstIndex,
} from "../src/index.js";

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, ...relPath.split("/"));
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function run(): void {
  const root = mkdtempSync(join(tmpdir(), "gf-knowledge-graph-"));
  try {
    // ── TypeScript fixture: class method reached through an imported class + member call ──
    writeFile(
      root,
      "ts/model.ts",
      [
        "export class OrderService {",
        "  cancelOrder(orderId: string): boolean {",
        "    return orderId.length > 0;",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "ts/app.ts",
      [
        'import { OrderService } from "./model.js";',
        "",
        "export function main(): boolean {",
        "  const service = new OrderService();",
        '  const first = service.cancelOrder("order-1");',
        '  const second = service.cancelOrder("order-2");',
        "  return first && second;",
        "}",
        "",
      ].join("\n")
    );

    // ── Python fixture: same shape, to prove file->file + symbol->symbol edges are language-agnostic ──
    writeFile(
      root,
      "py/model.py",
      [
        "class OrderService:",
        "    def cancel_order(self, order_id: str) -> bool:",
        '        return order_id != ""',
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "py/app.py",
      [
        "from model import OrderService",
        "",
        "def main() -> bool:",
        "    service = OrderService()",
        '    return service.cancel_order("order-1")',
        "",
      ].join("\n")
    );

    // ── Same-named foreign-language symbol: must NEVER receive a TS call edge ──
    writeFile(
      root,
      "rs/order.rs",
      [
        "pub fn cancelOrder(id: &str) -> bool {",
        "    !id.is_empty()",
        "}",
        "",
      ].join("\n")
    );

    // ── Receiver-type-aware calls: A.cancel vs B.cancel live in the same file ──
    writeFile(
      root,
      "ts/ab.ts",
      [
        "class A {",
        "  cancel(): string {",
        '    return "a";',
        "  }",
        "}",
        "",
        "class B {",
        "  cancel(): string {",
        '    return "b";',
        "  }",
        "}",
        "",
        "class C {",
        "  describe(): string {",
        '    return "c";',
        "  }",
        "}",
        "",
        "export function runBoth(): string {",
        "  const a = new A();",
        "  const b = new B();",
        "  return a.cancel() + b.cancel();",
        "}",
        "",
        "export function foreignCall(): string {",
        "  const c = new C();",
        "  return c.cancel();",
        "}",
        "",
      ].join("\n")
    );

    // ── tsconfig path alias (`@/*` -> ts/*) with JSONC comments/trailing commas ──
    writeFile(
      root,
      "tsconfig.json",
      [
        "{",
        "  // JSONC tsconfig for knowledge-graph alias resolution",
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "@/*": ["ts/*"], /* wildcard alias */',
        "    },",
        "  },",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "ts/alias-app.ts",
      [
        'import { OrderService } from "@/model";',
        "",
        "export function aliasMain(): boolean {",
        "  const service = new OrderService();",
        '  return service.cancelOrder("order-alias");',
        "}",
        "",
      ].join("\n")
    );

    const index = getWorkspaceAstIndex(root);
    const graph = buildKnowledgeGraphData(index);
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

    // ── 1. Structural integrity: valid refs, no duplicate (kind, source, target) triples ──
    for (const edge of graph.edges) {
      assert.ok(nodesById.has(edge.source), `edge source must exist as a node: ${edge.source}`);
      assert.ok(nodesById.has(edge.target), `edge target must exist as a node: ${edge.target}`);
    }
    assert.equal(
      new Set(graph.edges.map((edge) => `${edge.kind}|${edge.source}|${edge.target}`)).size,
      graph.edges.length,
      "knowledge graph edges must be deduplicated by (kind, source, target)"
    );

    // ── 2. file -> symbol edges are kind/label "defines" ──
    const defineEdges = graph.edges.filter((edge) => edge.kind === "defines");
    assert.ok(defineEdges.length >= 5, `expected at least 5 defines edges, got ${defineEdges.length}`);
    for (const edge of defineEdges) {
      assert.equal(edge.label, "defines");
      assert.ok(edge.source.startsWith("file:"), "defines edge must start at a file node");
      assert.ok(edge.target.startsWith("sym:"), "defines edge must end at a symbol node");
    }
    assert.ok(
      !graph.edges.some(
        (edge) =>
          edge.kind === "imports" &&
          edge.source.startsWith("file:") &&
          edge.target.startsWith("sym:")
      ),
      "file -> symbol edges must not be mislabeled as imports"
    );

    // ── 3. file -> file imports edges ──
    const importEdges = graph.edges.filter((edge) => edge.kind === "imports");
    const tsImportEdge = importEdges.find(
      (edge) => edge.source === "file:ts/app.ts" && edge.target === "file:ts/model.ts"
    );
    assert.ok(tsImportEdge, "ts/app.ts must import ts/model.ts");
    assert.ok(
      tsImportEdge.label?.includes("./model.js"),
      "import edge label must carry the raw import statement"
    );
    assert.ok(
      importEdges.some(
        (edge) => edge.source === "file:py/app.py" && edge.target === "file:py/model.py"
      ),
      "py/app.py must import py/model.py"
    );
    assert.ok(
      importEdges.every((edge) => edge.source !== edge.target),
      "self import edges must be skipped"
    );

    // ── 3b. tsconfig/jsconfig path-alias imports (`@/model` -> ts/model.ts) ──
    assert.ok(
      importEdges.some(
        (edge) => edge.source === "file:ts/alias-app.ts" && edge.target === "file:ts/model.ts"
      ),
      "tsconfig `@/*` alias import must produce a file->file imports edge"
    );

    // ── 4. symbol -> symbol calls edges (imported class method + constructor) ──
    const callEdges = graph.edges.filter((edge) => edge.kind === "calls");
    const cancelCall = callEdges.find(
      (edge) =>
        edge.source === "sym:ts/app.ts#main" && edge.target === "sym:ts/model.ts#OrderService.cancelOrder"
    );
    assert.ok(cancelCall, "main() must have a calls edge to OrderService.cancelOrder");
    assert.ok(
      callEdges.some(
        (edge) =>
          edge.source === "sym:ts/app.ts#main" && edge.target === "sym:ts/model.ts#OrderService"
      ),
      "main() must have a calls edge to the imported OrderService class (new OrderService())"
    );
    assert.equal(
      callEdges.filter(
        (edge) =>
          edge.source === "sym:ts/app.ts#main" &&
          edge.target === "sym:ts/model.ts#OrderService.cancelOrder"
      ).length,
      1,
      "duplicate identical call sites must collapse into one edge"
    );
    assert.ok(
      callEdges.some(
        (edge) =>
          edge.source === "sym:py/app.py#main" && edge.target === "sym:py/model.py#OrderService.cancel_order"
      ),
      "python main() must have a calls edge to OrderService.cancel_order"
    );
    assert.ok(
      callEdges.every((edge) => edge.source !== edge.target),
      "call self-edges must be skipped"
    );

    // ── 4b. Receiver-type-aware attribution: same-file A.cancel vs B.cancel ──
    const runBothId = "sym:ts/ab.ts#runBoth";
    assert.ok(
      callEdges.some(
        (edge) => edge.source === runBothId && edge.target === "sym:ts/ab.ts#A.cancel"
      ),
      "runBoth() must call A.cancel (receiver `a` inferred as A)"
    );
    assert.ok(
      callEdges.some(
        (edge) => edge.source === runBothId && edge.target === "sym:ts/ab.ts#B.cancel"
      ),
      "runBoth() must call B.cancel (receiver `b` inferred as B), not be misattributed to A.cancel"
    );
    assert.equal(
      callEdges.filter((edge) => edge.target === "sym:ts/ab.ts#A.cancel").length,
      1,
      "A.cancel must receive exactly one calls edge"
    );
    assert.equal(
      callEdges.filter((edge) => edge.target === "sym:ts/ab.ts#B.cancel").length,
      1,
      "B.cancel must receive exactly one calls edge"
    );
    // `const c = new C(); c.cancel()` — receiver resolves to the foreign class C, which has no
    // `cancel` method: the edge must be dropped, never guessed onto A or B.
    assert.ok(
      !callEdges.some(
        (edge) =>
          edge.source === "sym:ts/ab.ts#foreignCall" &&
          (edge.target === "sym:ts/ab.ts#A.cancel" ||
            edge.target === "sym:ts/ab.ts#B.cancel")
      ),
      "a receiver resolving to a foreign class must not be misattributed"
    );

    // ── 4c. Alias-imported class method call still resolves through receiver inference ──
    assert.ok(
      callEdges.some(
        (edge) =>
          edge.source === "sym:ts/alias-app.ts#aliasMain" &&
          edge.target === "sym:ts/model.ts#OrderService.cancelOrder"
      ),
      "alias-imported OrderService.cancelOrder call must resolve"
    );

    // ── 5. Language-family guarding: the Rust `cancelOrder` never receives a TS call edge ──
    assert.ok(
      !callEdges.some((edge) => edge.target.startsWith("sym:rs/")),
      "no call edge may cross language families (Rust cancelOrder vs TS cancelOrder)"
    );
    assert.ok(
      !callEdges.some((edge) => edge.target === "sym:ts/model.ts#OrderService.cancelOrder" && edge.source.startsWith("sym:rs/")),
      "rust symbols must not call TS methods of the same name"
    );

    // ── 6. Rebuild is deterministic and stays fast ──
    const startedAt = Date.now();
    const graphAgain = buildKnowledgeGraphData(index);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(
      graphAgain.edges.length,
      graph.edges.length,
      "building the graph twice must produce the same edge count (no duplicate accumulation)"
    );
    assert.ok(elapsedMs < 5000, `knowledge-graph build must stay fast (took ${elapsedMs}ms)`);

    const edgeCounts: Record<string, number> = {};
    for (const edge of graph.edges) edgeCounts[edge.kind] = (edgeCounts[edge.kind] ?? 0) + 1;
    console.log(
      `[knowledge-graph] nodes=${graph.nodes.length} edges=${graph.edges.length} ` +
        `defines=${edgeCounts.defines ?? 0} imports=${edgeCounts.imports ?? 0} ` +
        `calls=${edgeCounts.calls ?? 0} doc-links-code=${edgeCounts["doc-links-code"] ?? 0} ` +
        `co-edit=${edgeCounts["co-edit"] ?? 0} (${elapsedMs}ms rebuild)`
    );

    // ── 7. HTML/JSON visualizer carries the new kinds, legend text and colors ──
    const viz = generateKnowledgeGraphHtml(index);
    assert.ok(existsSync(viz.htmlPath), "knowledge-graph.html must be written");
    assert.ok(existsSync(viz.jsonPath), "knowledge-graph.json must be written");
    assert.equal(viz.nodeCount, graph.nodes.length);
    assert.equal(viz.edgeCount, graph.edges.length);

    const html = readFileSync(viz.htmlPath, "utf8");
    const exported = JSON.parse(readFileSync(viz.jsonPath, "utf8")) as {
      nodes: unknown[];
      edges: Array<{ kind: string }>;
    };
    assert.ok(
      exported.edges.some((edge) => edge.kind === "imports"),
      "exported JSON must contain real imports edges"
    );
    assert.ok(
      exported.edges.some((edge) => edge.kind === "calls"),
      "exported JSON must contain real calls edges"
    );
    assert.ok(
      exported.edges.some((edge) => edge.kind === "defines"),
      "exported JSON must contain defines edges"
    );
    for (const kind of ["defines", "imports", "calls", "doc-links-code", "co-edit"]) {
      assert.ok(html.includes(kind), `knowledge-graph.html must render edge kind "${kind}"`);
    }
    for (const legendText of [
      "defines (file → symbol)",
      "imports (file → file)",
      "calls (symbol → symbol)",
      "doc-links-code",
      "co-edit",
    ]) {
      assert.ok(html.includes(legendText), `legend must contain "${legendText}"`);
    }
    assert.ok(html.includes("EDGE_STYLES"), "canvas renderer must style edges per kind");
    assert.ok(html.includes("GraphFlow 3.6.1 Knowledge Graph"), "single-file HTML title preserved");

    console.log(
      "PASS [knowledge-graph] defines/imports/calls edges real, cross-language guarded, deduped, HTML legend updated"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  console.error("FAIL [knowledge-graph]", error);
  process.exit(1);
}
