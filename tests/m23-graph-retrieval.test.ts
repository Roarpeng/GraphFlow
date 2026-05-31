import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import {
  buildLayeredContextPackage,
  expandSubgraph,
} from "../src/graph/context-slicer";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphEdge, GraphNode } from "../src/core/types";

const cfg = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-5.3-codex" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 200,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly",
    canaryRatio: 10,
    exportPath: "tmp/learning-dataset.jsonl",
  },
});

function seed50(): GraphNode[] {
  const words = [
    "orchestrate task routing",
    "module alpha planner",
    "validator checks output",
    "router selects model",
    "fallback when provider unhealthy",
    "graph index symbol table",
    "context slicer compression",
    "skill flywheel synthesis",
    "decision log persistence",
    "telemetry metrics emit",
  ];
  const out: GraphNode[] = [];
  for (let i = 0; i < 50; i += 1) {
    const idx = i % words.length;
    out.push({
      id: `node:${i}`,
      type: i % 3 === 0 ? "File" : i % 3 === 1 ? "Symbol" : "Module",
      content: `${words[idx]} entry ${i}`,
    });
  }
  return out;
}

describe("M23 graph retrieval + tokenizer", () => {
  it("A: inverted index matches brute-force substring filter", async () => {
    const client = createGraphClient(cfg);
    const nodes = seed50();
    await client.upsertNodes(nodes);

    const indexed = await client.queryByKeyword("orchestrate");
    const brute = nodes.filter((n) => n.content.toLowerCase().includes("orchestrate"));

    const a = indexed.map((n) => n.id).sort();
    const b = brute.map((n) => n.id).sort();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("B: getNeighbors filters by requested relation", async () => {
    const client = createGraphClient(cfg);
    const nodes: GraphNode[] = [
      { id: "A", type: "Symbol", content: "alpha" },
      { id: "B", type: "Symbol", content: "beta" },
      { id: "C", type: "Symbol", content: "gamma" },
    ];
    const edges: GraphEdge[] = [
      { from: "A", to: "B", relation: "references" },
      { from: "A", to: "C", relation: "co_occurs" },
    ];
    await client.upsertNodes(nodes);
    await client.upsertEdges(edges);

    const neighbors = await client.getNeighbors!(["A"], ["references"], "out");
    const ids = neighbors.map((n) => n.node.id).sort();
    expect(ids).toEqual(["B"]);
  });

  it("C: expandSubgraph BFS respects hop limit", async () => {
    const client = createGraphClient(cfg);
    const nodes: GraphNode[] = ["A", "B", "C", "D"].map((id) => ({
      id,
      type: "Symbol",
      content: id,
    }));
    const edges: GraphEdge[] = [
      { from: "A", to: "B", relation: "references" },
      { from: "B", to: "C", relation: "references" },
      { from: "C", to: "D", relation: "references" },
    ];
    await client.upsertNodes(nodes);
    await client.upsertEdges(edges);

    const expanded = await expandSubgraph(client, ["A"], {
      hops: 2,
      relations: ["references"],
    });
    const ids = expanded.map((n) => n.id).sort();
    expect(ids).toContain("B");
    expect(ids).toContain("C");
    expect(ids).not.toContain("D");
    expect(ids).not.toContain("A");
  });

  it("D: buildLayeredContextPackage pulls edge-expanded neighbors into the package", async () => {
    const client = createGraphClient(cfg);
    await client.upsertNodes([
      { id: "file:X", type: "File", content: "router module entrypoint" },
      { id: "symbol:Y", type: "Symbol", content: "selectModel helper" },
    ]);
    await client.upsertEdges([
      { from: "file:X", to: "symbol:Y", relation: "references" },
    ]);

    const pkg = await buildLayeredContextPackage(client, "router", 200);
    const ids = pkg.anchorChannel.map((a) => a.id);
    expect(ids).toContain("file:X");
    expect(ids).toContain("symbol:Y");

    const pkgOff = await buildLayeredContextPackage(client, "router", 200, {
      enableEdgeExpansion: false,
    });
    const idsOff = pkgOff.anchorChannel.map((a) => a.id);
    expect(idsOff).toContain("file:X");
    expect(idsOff).not.toContain("symbol:Y");
  });

  it("E: real tokenizer differs from length/4 fallback", async () => {
    const client = new GraphifyClient();
    const content = "orchestrate handles task routing";
    await client.upsertNodes([{ id: "s:1", type: "Symbol", content }]);

    const pkg = await buildLayeredContextPackage(
      { upsertNodes: async () => {}, upsertEdges: async () => {}, queryByKeyword: async () => [{ id: "s:1", type: "Symbol", content }] },
      "orchestrate",
      200
    );
    const summary = `Symbol: ${content}`;
    const lengthOverFour = Math.ceil(summary.length / 4);
    // tokenEstimate should be the real tokenizer count (smaller than naive length/4 for this string)
    expect(pkg.tokenEstimate).not.toEqual(lengthOverFour);
    expect(pkg.tokenEstimate).toBeGreaterThan(0);
  });
});
