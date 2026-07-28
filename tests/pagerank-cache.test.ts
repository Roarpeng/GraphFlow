import { describe, expect, it } from "vitest";
import {
  computePageRank,
  pageRankCacheStats,
  resetPageRankCache,
} from "../src/graph/graph-compression";
import type { GraphEdge, GraphNode } from "../src/core/types";

function makeNodes(count: number): GraphNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `symbol:file${i}.ts:abc${i}`,
    type: "Symbol" as const,
    content: `function handler${i}()`,
  }));
}

function makeEdges(nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({ from: nodes[i]!.id, to: nodes[i + 1]!.id, relation: "calls" });
  }
  return edges;
}

describe("PageRank LRU cache", () => {
  it("returns identical results and records hits on repeated computation", () => {
    resetPageRankCache();
    const nodes = makeNodes(50);
    const edges = makeEdges(nodes);

    const first = computePageRank(nodes, edges);
    expect(pageRankCacheStats.misses).toBe(1);
    expect(pageRankCacheStats.hits).toBe(0);

    const second = computePageRank(nodes, edges);
    expect(pageRankCacheStats.hits).toBe(1);
    expect([...second.entries()]).toEqual([...first.entries()]);

    // Mutating the returned map must not poison the cache.
    second.set("garbage", 999);
    const third = computePageRank(nodes, edges);
    expect(third.has("garbage")).toBe(false);
  });

  it("recomputes when the edge set changes (no stale hits)", () => {
    resetPageRankCache();
    const nodes = makeNodes(10);
    const edgesV1 = makeEdges(nodes);
    const edgesV2 = [...edgesV1, { from: nodes[9]!.id, to: nodes[0]!.id, relation: "calls" as const }];

    const rankV1 = computePageRank(nodes, edgesV1);
    const rankV2 = computePageRank(nodes, edgesV2);
    expect(pageRankCacheStats.hits).toBe(0);
    expect(pageRankCacheStats.misses).toBe(2);
    // The extra back-edge changes centrality for node 0.
    expect(rankV2.get(nodes[0]!.id)).not.toBe(rankV1.get(nodes[0]!.id));
  });

  it("evicts oldest entries beyond the cache limit", () => {
    resetPageRankCache();
    for (let i = 0; i < 10; i += 1) {
      computePageRank(makeNodes(5 + i), []);
    }
    // Cache is capped at 8; earliest entries were evicted.
    expect(pageRankCacheStats.misses).toBe(10);
    const nodes = makeNodes(5);
    computePageRank(nodes, []);
    expect(pageRankCacheStats.misses).toBe(11); // evicted -> miss, not hit
  });
});
