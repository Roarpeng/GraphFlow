import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import {
  computePersonalizedPageRank,
  pprCacheStats,
  resetPprCache,
} from "../src/graph/pagerank";
import { expandSubgraph } from "../src/graph/context-package-core";
import { buildLayeredContextPackage } from "../src/graph/context-slicer";
import type { GraphClient } from "../src/graph/client-factory";
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
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

function node(id: string): GraphNode {
  return { id, type: "Symbol", content: id };
}

function edge(from: string, to: string, relation: GraphEdge["relation"]): GraphEdge {
  return { from, to, relation };
}

/** Leaf L → hub H, satellites S1..S5 → H: H is the structural hub. */
function hubGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: ["L", "H", "S1", "S2", "S3", "S4", "S5"].map(node),
    edges: [edge("L", "H", "references"), ...[1, 2, 3, 4, 5].map((i) => edge(`S${i}`, "H", "references"))],
  };
}

/**
 * Contrast fixture: seed A; strong reference chain A→B→H with H also
 * referenced by C and D; weak decorative peer A→Z (co_occurs).
 */
function contrastGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: ["A", "B", "Z", "H", "C", "D"].map(node),
    edges: [
      edge("A", "B", "references"),
      edge("A", "Z", "co_occurs"),
      edge("B", "H", "references"),
      edge("C", "H", "references"),
      edge("D", "H", "references"),
    ],
  };
}

async function seedClient(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): Promise<GraphClient> {
  const client = createGraphClient(cfg);
  await client.upsertNodes(graph.nodes);
  await client.upsertEdges(graph.edges);
  return client;
}

describe("Personalized PageRank (computePersonalizedPageRank)", () => {
  it("gives the hub referenced by many the highest mass from a leaf seed", () => {
    const ranks = computePersonalizedPageRank(hubGraph(), ["L"]);

    expect(ranks.size).toBe(7);
    const hub = ranks.get("H")!;
    expect(hub).toBeGreaterThan(ranks.get("L")!);
    for (let i = 1; i <= 5; i += 1) {
      expect(hub).toBeGreaterThan(ranks.get(`S${i}`)!);
    }
    // Mass is conserved.
    let sum = 0;
    for (const mass of ranks.values()) sum += mass;
    expect(sum).toBeCloseTo(1, 5);
  });

  it("restart keeps a seed node ranked top when it is also the hub", () => {
    const ranks = computePersonalizedPageRank(hubGraph(), ["H"]);
    const hub = ranks.get("H")!;
    expect(hub).toBeGreaterThan(ranks.get("L")!);
    for (let i = 1; i <= 5; i += 1) {
      expect(hub).toBeGreaterThan(ranks.get(`S${i}`)!);
    }
  });

  it("is deterministic: identical output across runs and input permutations", () => {
    const graph = hubGraph();
    const first = computePersonalizedPageRank(graph, ["L"]);
    const second = computePersonalizedPageRank(hubGraph(), ["L"]);
    expect([...second.entries()]).toEqual([...first.entries()]);

    // Same graph, shuffled node/edge array order → canonicalized → identical.
    const shuffled = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    const third = computePersonalizedPageRank(shuffled, ["L"]);
    expect([...third.entries()]).toEqual([...first.entries()]);
  });

  it("gives isolated seeds uniform mass (no edges, no NaN, no zero division)", () => {
    const isolated = computePersonalizedPageRank({ nodes: [node("X")], edges: [] }, ["X"]);
    expect(isolated.get("X")).toBeCloseTo(1, 6);
    expect(Number.isFinite(isolated.get("X")!)).toBe(true);

    // Seed mixed into an edgeless crowd: restart mass spreads over nothing else.
    const crowd = computePersonalizedPageRank(
      { nodes: [node("X"), node("Y"), node("W")], edges: [] },
      ["X", "Y"]
    );
    expect(crowd.get("X")).toBeCloseTo(0.5, 6);
    expect(crowd.get("Y")).toBeCloseTo(0.5, 6);
    expect(crowd.get("W")).toBeCloseTo(0, 6);
  });

  it("ranks relation kinds by the weight table: references edge beats co_occurs edge", () => {
    const ranks = computePersonalizedPageRank(
      {
        nodes: [node("A"), node("strong"), node("weak")],
        edges: [edge("A", "strong", "references"), edge("A", "weak", "co_occurs")],
      },
      ["A"]
    );
    expect(ranks.get("strong")!).toBeGreaterThan(ranks.get("weak")!);
  });
});

describe("expandSubgraph PPR strategy", () => {
  it('strategy "ppr" admits the high-mass 2-hop hub before the weak direct peer', async () => {
    const client = await seedClient(contrastGraph());
    const relations: GraphEdge["relation"][] = ["references", "co_occurs"];

    // BFS encounter order: [B, Z, H] — with limit 2 it keeps the weak peer Z.
    const bfs = await expandSubgraph(client, ["A"], { hops: 2, maxNodes: 2, relations });
    expect(bfs.map((n) => n.id)).toEqual(["B", "Z"]);

    // PPR ranks B (0.39) > H (0.16) > Z (0.07): the multi-hop hub H beats Z.
    const ppr2 = await expandSubgraph(client, ["A"], {
      maxNodes: 2,
      relations,
      expansionStrategy: "ppr",
    });
    expect(ppr2.map((n) => n.id)).toEqual(["B", "H"]);

    const ppr3 = await expandSubgraph(client, ["A"], {
      maxNodes: 3,
      relations,
      expansionStrategy: "ppr",
    });
    expect(ppr3.map((n) => n.id)).toEqual(["B", "H", "Z"]);
  });

  it("default strategy output is unchanged (explicit expected BFS node sets)", async () => {
    const client = await seedClient(contrastGraph());
    const relations: GraphEdge["relation"][] = ["references", "co_occurs"];

    const defaults = await expandSubgraph(client, ["A"], { hops: 2, relations });
    expect(defaults.map((n) => n.id)).toEqual(["B", "Z", "H"]);

    const explicitBfs = await expandSubgraph(client, ["A"], {
      hops: 2,
      relations,
      expansionStrategy: "bfs",
    });
    expect(explicitBfs.map((n) => n.id)).toEqual(defaults.map((n) => n.id));

    // The default relation filter (no co_occurs) drops Z in both strategies.
    const defaultRelations = await expandSubgraph(client, ["A"], { hops: 2 });
    expect(defaultRelations.map((n) => n.id)).toEqual(["B", "H"]);
  });

  it("breaks equal-mass ties by node id (deterministic admission)", async () => {
    const client = await seedClient({
      nodes: ["A", "S1", "S2"].map(node),
      edges: [edge("A", "S1", "references"), edge("A", "S2", "references")],
    });

    const ranks = computePersonalizedPageRank(
      {
        nodes: ["A", "S1", "S2"].map(node),
        edges: [edge("A", "S1", "references"), edge("A", "S2", "references")],
      },
      ["A"]
    );
    expect(ranks.get("S1")).toBe(ranks.get("S2"));

    const expanded = await expandSubgraph(client, ["A"], {
      maxNodes: 1,
      expansionStrategy: "ppr",
    });
    expect(expanded.map((n) => n.id)).toEqual(["S1"]);
  });

  it("memoizes PPR per cheap version signature and invalidates on graph change", async () => {
    resetPprCache();
    const client = await seedClient(contrastGraph());
    const relations: GraphEdge["relation"][] = ["references", "co_occurs"];

    const first = await expandSubgraph(client, ["A"], {
      maxNodes: 2,
      relations,
      expansionStrategy: "ppr",
    });
    expect(pprCacheStats.misses).toBe(1);
    expect(pprCacheStats.hits).toBe(0);

    // Same graph, same seeds → cache hit; the cached artifact is the rank map,
    // so a different maxNodes limit also hits (limit applied post-cache).
    const second = await expandSubgraph(client, ["A"], {
      maxNodes: 2,
      relations,
      expansionStrategy: "ppr",
    });
    expect(second.map((n) => n.id)).toEqual(first.map((n) => n.id));
    expect(pprCacheStats.hits).toBe(1);

    await expandSubgraph(client, ["A"], {
      maxNodes: 3,
      relations,
      expansionStrategy: "ppr",
    });
    expect(pprCacheStats.hits).toBe(2);
    expect(pprCacheStats.misses).toBe(1);

    // Graph mutation changes the version signature (counts) → recompute.
    await client.upsertNodes([node("E")]);
    await client.upsertEdges([edge("B", "E", "references")]);
    const afterMutation = await expandSubgraph(client, ["A"], {
      maxNodes: 3,
      relations,
      expansionStrategy: "ppr",
    });
    expect(afterMutation.map((n) => n.id)).toContain("E");
    expect(pprCacheStats.misses).toBe(2);
  });
});

describe("LayeredPackageOptions.expansionStrategy threading", () => {
  it("buildLayeredContextPackage pulls 2-hop PPR neighbors only under strategy ppr", async () => {
    const client = createGraphClient(cfg);
    await client.upsertNodes([
      { id: "file:A", type: "File", content: "alpha entrypoint" },
      { id: "symbol:B", type: "Symbol", content: "beta helper" },
      { id: "symbol:H", type: "Symbol", content: "hub core" },
      { id: "symbol:Z", type: "Symbol", content: "zeta misc" },
    ]);
    await client.upsertEdges([
      { from: "file:A", to: "symbol:B", relation: "references" },
      { from: "symbol:B", to: "symbol:H", relation: "references" },
      { from: "file:A", to: "symbol:Z", relation: "co_occurs" },
    ]);

    const ppr = await buildLayeredContextPackage(client, "alpha", 300, {
      expansionStrategy: "ppr",
    });
    const pprIds = ppr.anchorChannel.map((a) => a.id);
    expect(pprIds).toContain("symbol:B");
    expect(pprIds).toContain("symbol:H");

    // Default (bfs, hops 1): only the direct reference neighbor B joins.
    const bfs = await buildLayeredContextPackage(client, "alpha", 300);
    const bfsIds = bfs.anchorChannel.map((a) => a.id);
    expect(bfsIds).toContain("symbol:B");
    expect(bfsIds).not.toContain("symbol:H");
  });
});
