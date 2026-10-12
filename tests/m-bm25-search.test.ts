import { describe, expect, it } from "vitest";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphNode } from "../src/core/types";
import { bm25Idf, createBm25Index, rrfFuse, search, tokenizeBm25 } from "../src/graph/bm25";
import type { Bm25Doc } from "../src/graph/bm25";
import { computeAnchorRelevance, querySymbolGraph, searchGraphNodes } from "../src/graph/graph-search";

/**
 * M-BM25-SEARCH — recall-quality upgrade of the lexical channel:
 * token-overlap scoring replaced by real BM25 (IDF + tf saturation + field
 * boosts) with RRF fusion for the lexical/vector channels.
 *
 * Behavior goals under test:
 * ① exact symbol-name match ranks first;
 * ② IDF strongly downweights generic tokens (utils / index / test) so the
 *    manual generic-segment blocklist is belt-and-suspenders only;
 * ③ deterministic ordering for identical inputs.
 */

function keywordClient(keywordHits: GraphNode[], extra: Partial<GraphClient> = {}): GraphClient {
  return {
    async upsertNodes() {
      /* test stub */
    },
    async upsertEdges() {
      /* test stub */
    },
    async queryByKeyword() {
      return keywordHits;
    },
    ...extra,
  };
}

function symbolNode(id: string, name: string, file: string, content: string): GraphNode {
  return {
    id,
    type: "Symbol",
    content,
    metadata: { name, file },
  };
}

describe("M-BM25 tokenizeBm25", () => {
  it("splits camelCase / snake_case / kebab-case identifiers and lowercases", () => {
    expect(tokenizeBm25("createBm25Index")).toEqual(
      expect.arrayContaining(["createbm25index", "create", "bm25", "index"])
    );
    expect(tokenizeBm25("cost-ledger_parser")).toEqual(
      expect.arrayContaining(["cost", "ledger", "parser"])
    );
  });

  it("drops generic dev-path segments as a safety net (IDF does the real work)", () => {
    const tokens = tokenizeBm25("C:/Users/dev/Desktop/tmp/code/proj");
    expect(tokens).toEqual(["proj"]);
  });

  it("passes CJK phrases and overlapping bigrams through", () => {
    expect(tokenizeBm25("成本台账")).toEqual(
      expect.arrayContaining(["成本台账", "成本", "本台", "台账"])
    );
  });
});

describe("M-BM25 index + search", () => {
  it("ranks the exact symbol-name match first (goal ①)", () => {
    const docs: Bm25Doc[] = [
      { id: "doc-guide", path: "docs/bm25-guide.md", summary: "how to create a bm25 index for search and ranking" },
      { id: "sym-sibling", symbol: "createBm25Report", path: "src/graph/report.ts" },
      { id: "sym-exact", symbol: "createBm25Index", path: "src/graph/bm25.ts" },
    ];
    const results = search(createBm25Index(docs), tokenizeBm25("createBm25Index"));
    expect(results[0]?.id).toBe("sym-exact");
    // Only docs sharing at least one query token are returned, all positive.
    expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(["sym-exact", "sym-sibling", "doc-guide"]));
    expect(results.every((r) => r.score > 0)).toBe(true);
  });

  it("IDF strongly downweights corpus-generic tokens (goal ②)", () => {
    const generic: Bm25Doc[] = Array.from({ length: 6 }, (_, i) => ({
      id: `g${i}`,
      path: `src/utils/index-${i}.ts`,
    }));
    const distinctive: Bm25Doc = { id: "ledger", symbol: "ledgerReconcile", path: "src/finance/ledger.ts" };
    const index = createBm25Index([...generic, distinctive]);

    expect(bm25Idf(index, "ledger")).toBeGreaterThan(bm25Idf(index, "utils"));
    // utils/index appear in EVERY generic doc, so they must not outrank the
    // one doc matching the distinctive term — no blocklist involved.
    const results = search(index, tokenizeBm25("utils index ledger"));
    expect(results[0]?.id).toBe("ledger");
    expect(results).toHaveLength(7);
  });

  it("is deterministic for identical inputs (goal ③)", () => {
    const docs: Bm25Doc[] = [
      { id: "a", symbol: "alphaWidget", path: "src/a.ts" },
      { id: "b", symbol: "betaWidget", path: "src/b.ts" },
    ];
    const query = tokenizeBm25("widget alpha");
    expect(search(createBm25Index(docs), query)).toEqual(search(createBm25Index(docs), query));
  });

  it("honors configurable k1 / b (tf saturation flattens as k1 → 0)", () => {
    const docs: Bm25Doc[] = [
      { id: "repeat", summary: "ledger ledger ledger ledger ledger" },
      { id: "single", summary: "ledger" },
    ];
    // Default k1=1.2: five occurrences saturate above one.
    expect(search(createBm25Index(docs), ["ledger"])[0]?.id).toBe("repeat");
    // k1=0 collapses saturation to a constant, so tf stops discriminating
    // and the deterministic insertion-order tie-break decides.
    const flat = search(createBm25Index(docs, { k1: 0, b: 0 }), ["ledger"]);
    expect(flat[0]?.score).toBe(flat[1]?.score);
    expect(flat.map((r) => r.id)).toEqual(["repeat", "single"]);
  });
});

describe("M-BM25 rrfFuse", () => {
  it("fuses rankings; ids present in both lists win", () => {
    // c and b appear in both lists and outrank the single-channel a and d;
    // c edges out b because its list-2 rank is 0 (1/61 + 1/63 > 2/62).
    expect(rrfFuse([["a", "b", "c"], ["c", "b", "d"]])).toEqual(["c", "b", "a", "d"]);
  });

  it("breaks score ties by first-seen order (deterministic)", () => {
    expect(rrfFuse([["x"], ["y"]])).toEqual(["x", "y"]);
    expect(rrfFuse([["y"], ["x"]])).toEqual(["y", "x"]);
  });
});

describe("M-BM25 searchGraphNodes", () => {
  it("ranks the exact symbol-name match first with positive BM25 relevance", async () => {
    const exact = symbolNode(
      "symbol:src/graph/bm25.ts:aaa",
      "createBm25Index",
      "src/graph/bm25.ts",
      "function createBm25Index (exported) @src/graph/bm25.ts:20"
    );
    const guide: GraphNode = {
      id: "file:docs/bm25-guide.md",
      type: "File",
      content: "docs/bm25-guide.md # exports: chapters about bm25 usage",
    };
    const result = await searchGraphNodes(keywordClient([guide, exact]), "createBm25Index");
    expect(result.results[0]?.id).toBe(exact.id);
    expect(result.results[0]?.relevance).toBeGreaterThan(0);
    expect(result.totalCount).toBe(2);
  });

  it("IDF keeps a distinctive match above generic-only matches", async () => {
    const generic: GraphNode[] = Array.from({ length: 6 }, (_, i) => ({
      id: `file:src/utils/index-${i}.ts`,
      type: "File" as const,
      content: `src/utils/index-${i}.ts # exports: helper${i}`,
    }));
    const ledger = symbolNode(
      "symbol:src/finance/ledger.ts:abc",
      "ledgerReconcile",
      "src/finance/ledger.ts",
      "function ledgerReconcile (exported) @src/finance/ledger.ts:9"
    );
    const result = await searchGraphNodes(keywordClient([...generic, ledger]), "utils index ledger");
    expect(result.results[0]?.id).toBe(ledger.id);
  });

  it("expands CJK queries through the glossary before scoring", async () => {
    const truth: GraphNode = {
      id: "file:src/learning/cost-ledger.ts",
      type: "File",
      content: "src/learning/cost-ledger.ts # exports: appendCostEvent, summarizeCost",
    };
    const noise: GraphNode = {
      id: "file:src/ui/theme.css",
      type: "File",
      content: "src/ui/theme.css # exports: colors",
    };
    const result = await searchGraphNodes(keywordClient([noise, truth]), "成本台账");
    expect(result.results[0]?.id).toContain("cost-ledger");
  });

  it("fuses lexical and vector rankings via RRF (vector-only ids included)", async () => {
    // alpha matches only "foo" lexically; beta matches "foo" + "bar" and is
    // ALSO the vector channel's top hit — dual-channel evidence must win.
    const alpha = symbolNode("symbol:src/x.ts:aaa", "fooAlpha", "src/x.ts", "function fooAlpha @src/x.ts:1");
    const beta = symbolNode("symbol:src/x.ts:bbb", "fooBarBeta", "src/x.ts", "function fooBarBeta @src/x.ts:2");
    const vectorOnly: GraphNode = {
      id: "file:src/semantic-cache.ts",
      type: "File",
      content: "src/semantic-cache.ts # exports: semanticRescue",
    };
    const client = keywordClient([alpha, beta], {
      async getNodesByIds(ids) {
        return ids.includes(vectorOnly.id) ? [vectorOnly] : [];
      },
    });

    const fused = await searchGraphNodes(client, "fooBar", 20, {
      vectorNodeIds: [beta.id, vectorOnly.id],
    });
    const ids = fused.results.map((r) => r.id);
    // Dual-channel evidence (beta) outranks single-channel nodes; the
    // vector-only node is materialized through getNodesByIds.
    expect(fused.totalCount).toBe(3);
    expect(ids).toContain(vectorOnly.id);
    expect(ids[0]).toBe(beta.id);

    // Without the vector channel the lexical order is unchanged.
    const lexical = await searchGraphNodes(keywordClient([alpha, beta]), "fooBar");
    expect(lexical.results.map((r) => r.id)).toEqual([beta.id, alpha.id]);
  });

  it("is deterministic across runs", async () => {
    const nodes: GraphNode[] = [
      symbolNode("symbol:src/a.ts:1", "widgetOne", "src/a.ts", "function widgetOne @src/a.ts:1"),
      symbolNode("symbol:src/b.ts:2", "widgetTwo", "src/b.ts", "function widgetTwo @src/b.ts:2"),
      { id: "file:src/c.ts", type: "File", content: "src/c.ts # exports: widget helpers" },
    ];
    const first = await searchGraphNodes(keywordClient(nodes), "widget");
    const second = await searchGraphNodes(keywordClient(nodes), "widget");
    expect(first).toEqual(second);
  });
});

describe("M-BM25 querySymbolGraph ranking", () => {
  it("puts the exact symbol-name match first regardless of store order", async () => {
    const nodes: GraphNode[] = [
      symbolNode(
        "symbol:src/graph/graph-search.ts:111",
        "searchGraphNodesExtra",
        "src/graph/graph-search.ts",
        "async function searchGraphNodesExtra @src/graph/graph-search.ts:111"
      ),
      symbolNode(
        "symbol:src/graph/graph-search.ts:189",
        "searchGraphNodes",
        "src/graph/graph-search.ts",
        "async function searchGraphNodes (exported) @src/graph/graph-search.ts:189"
      ),
      symbolNode(
        "symbol:src/other.ts:333",
        "SearchGraphNodesCache",
        "src/other.ts",
        "class SearchGraphNodesCache @src/other.ts:333"
      ),
    ];
    const client = keywordClient(nodes, {
      readSnapshot: () => ({ nodes, edges: [] }),
    });
    const result = await querySymbolGraph(client, "searchGraphNodes");
    expect(result.totalCount).toBe(3);
    expect(result.matches[0]?.symbol.name).toBe("searchGraphNodes");
  });
});

describe("M-BM25 computeAnchorRelevance", () => {
  const englishNode: GraphNode = {
    id: "file:src/utils/errors.ts",
    type: "File",
    content: "src/utils/errors.ts # exports: formatError, isRetryable",
  };

  it("keeps the legacy 0/1 baselines without a corpus index", () => {
    expect(computeAnchorRelevance(englishNode, "errors")).toBe(1);
    expect(computeAnchorRelevance(englishNode, "router")).toBe(0);
  });

  it("weights tokens by corpus IDF when an index is supplied (goal ②)", () => {
    const corpus = createBm25Index([
      ...Array.from({ length: 6 }, (_, i) => ({ id: `g${i}`, path: `src/utils/index-${i}.ts` })),
      { id: "ledger", symbol: "ledgerReconcile", path: "src/finance/ledger.ts" },
    ]);
    const genericAnchor: GraphNode = {
      id: "file:src/utils/index-0.ts",
      type: "File",
      content: "src/utils/index-0.ts # exports: helper",
    };
    const distinctiveAnchor = symbolNode(
      "symbol:src/finance/ledger.ts:abc",
      "ledgerReconcile",
      "src/finance/ledger.ts",
      "function ledgerReconcile (exported) @src/finance/ledger.ts:9"
    );
    const query = "utils index ledger";

    // Without the index the raw overlap scorer prefers the generic anchor
    // (2 of 3 tokens) — the pre-upgrade behavior this test pins as changed.
    expect(computeAnchorRelevance(genericAnchor, query)).toBeGreaterThan(
      computeAnchorRelevance(distinctiveAnchor, query)
    );

    // With corpus IDF the distinctive term dominates: ledger (df=1) carries
    // far more weight than utils/index (df=6), flipping the ordering.
    expect(
      computeAnchorRelevance(distinctiveAnchor, query, undefined, { index: corpus })
    ).toBeGreaterThan(computeAnchorRelevance(genericAnchor, query, undefined, { index: corpus }));
  });
});
