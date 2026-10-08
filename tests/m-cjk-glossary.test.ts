import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandSearchQueries, tokenizeForIndex } from "../src/graph/graph-utils";
import { expandCjkGlossaryTerms } from "../src/graph/cjk-glossary";
import { collectExpandedKeywordHits } from "../src/graph/query-expand";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";
import type { GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import { attachEmbedding } from "../src/learning/embeddings";

/**
 * M-CJK-GLOSSARY — regression tests for the对照测试 findings:
 * - T3: pure-Chinese "成本台账…" query returned zero cost-ledger anchors.
 * - T4: "providerPriority自定义provider…" got buried under workspace-path
 *   junk (users/desktop/tmp/code/…) RRF-fused at equal weight.
 * - T2: English multi-hop "client ownership handoff" ranked the wrong
 *   "handoff" sense (context-pressure compaction) above the true owner.
 */
describe("M-CJK-glossary deterministic Chinese→English expansion", () => {
  it("expands known domain terms without an agent round-trip", () => {
    expect(expandCjkGlossaryTerms("成本台账栏A栏B分别统计什么")).toEqual(
      expect.arrayContaining(["cost", "ledger"])
    );
    // Glossary translates Chinese substrings only; Latin already in the query
    // ("provider") is the tokenizer's job (mixed-span harvest, below).
    expect(expandCjkGlossaryTerms("自定义provider为什么fail-fast")).toEqual(["custom"]);
    expect(expandCjkGlossaryTerms("deferred embedding handoff")).toEqual([]);
    expect(expandCjkGlossaryTerms("")).toEqual([]);
  });

  it("tokenizer harvests Latin identifiers glued to Chinese (no whitespace)", () => {
    expect(tokenizeForIndex("providerPriority自定义provider为什么fail-fast")).toEqual(
      expect.arrayContaining(["providerpriority", "provider", "priority", "fail", "fast"])
    );
    // Single Latin chars stay dropped; CJK bigrams still emitted.
    expect(tokenizeForIndex("成本台账栏A")).toContain("台账");
    expect(tokenizeForIndex("成本台账栏A")).not.toContain("a");
  });

  it("relevance credits glossary-driven retrieval (T3 delivery stage)", async () => {
    const { computeAnchorRelevance } = await import("../src/graph/graph-search");
    const q = "成本台账栏A栏B分别统计什么，落到哪个文件";
    const truth: GraphNode = {
      id: "file:src/learning/cost-ledger.ts",
      type: "File",
      content: "src/learning/cost-ledger.ts # exports: appendCostEvent, summarizeCost",
    };
    // Retrieved via glossary "cost ledger": scores > 0, so the delivery trim
    // keeps it instead of dropping it as unresponsive.
    const truthScore = computeAnchorRelevance(truth, q);
    expect(truthScore).toBeGreaterThan(0);
    const partial: GraphNode = {
      id: "file:src/graph/file-indexer.ts",
      type: "File",
      content: "src/graph/file-indexer.ts # exports: processFile, indexWorkspace",
    };
    // Matches only the generic "file" substring: stays below the truth that
    // matches the distinctive glossary terms too.
    expect(computeAnchorRelevance(partial, q)).toBeLessThan(truthScore);
  });

  it("expandSearchQueries gains glossary English for CJK queries", () => {
    const expanded = expandSearchQueries("成本台账栏A栏B分别统计什么", join("tmp", "proj"));
    expect(expanded[0]).toBe("成本台账栏A栏B分别统计什么");
    expect(expanded).toContain("cost ledger");
    expect(expanded).toContain("cost");
    expect(expanded).toContain("ledger");
  });

  it("expandSearchQueries drops generic dev-path segments from RRF", () => {
    const expanded = expandSearchQueries(
      "成本台账",
      join("C:", "Users", "roarp", "Desktop", "TMP", "Code", "AICode", "GraphFlow")
    );
    expect(expanded.some((q) => q === "users" || q === "desktop" || q === "tmp" || q === "code")).toBe(
      false
    );
    // Project-distinctive game-workspace hints (m61 contract) still expand.
    const game = expandSearchQueries("游戏战斗系统", join("home", "user", "fat-battle", "web"));
    expect(game.some((q) => q.includes("battle"))).toBe(true);
  });

  it("T3 repro: pure-Chinese cost-ledger query recalls English-only nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-cjk-gloss-"));
    const client = new GraphifyFileClient(join(dir, "graph.json"));
    await client.upsertNodes([
      {
        id: "file:src/learning/cost-ledger.ts",
        type: "File",
        content: "src/learning/cost-ledger.ts # exports: appendCostEvent, summarizeCost",
      },
      {
        id: "symbol:src/learning/cost-ledger.ts:aaa",
        type: "Symbol",
        content: "function appendCostEvent (exported) @src/learning/cost-ledger.ts:40",
        metadata: {
          jsdoc: "cost is measured from real traffic: llm and deliver events",
          file: "src/learning/cost-ledger.ts",
          name: "appendCostEvent",
        },
      },
      {
        id: "file:src/graph/file-indexer.ts",
        type: "File",
        content: "src/graph/file-indexer.ts # exports: processFile, indexWorkspace",
      },
    ]);

    const hits = await collectExpandedKeywordHits(
      client,
      "成本台账栏A栏B分别统计什么，落到哪个文件",
      join("C:", "Users", "dev", "Desktop", "tmp", "code", "proj")
    );
    const topIds = hits.slice(0, 5).map((n) => n.id);
    expect(topIds.some((id) => id.includes("cost-ledger"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("T4 repro: path junk no longer buries providerPriority nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-cjk-pp-"));
    const client = new GraphifyFileClient(join(dir, "graph.json"));
    await client.upsertNodes([
      {
        id: "symbol:src/config/schema.ts:abc",
        type: "Symbol",
        content: "providerPriority?: string[] @src/config/schema.ts:261",
        metadata: { file: "src/config/schema.ts", name: "providerPriority" },
      },
      {
        id: "symbol:src/config/loader.ts:def",
        type: "Symbol",
        content: "function validateProviderPriority (exported) @src/config/loader.ts:103",
        metadata: { file: "src/config/loader.ts", name: "validateProviderPriority" },
      },
      {
        id: "file:src/graph/framework-routes.ts",
        type: "File",
        content: "src/graph/framework-routes.ts # exports: detectFastAPI // sample code in tmp dir",
      },
    ]);

    const hits = await collectExpandedKeywordHits(
      client,
      "providerPriority自定义provider为什么fail-fast",
      join("C:", "Users", "dev", "Desktop", "TMP", "Code", "proj")
    );
    const topIds = hits.slice(0, 3).map((n) => n.id);
    expect(topIds.some((id) => id.includes("schema") || id.includes("loader"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("T2 repro: broad-coverage owner outranks single rare-token sense collision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-handoff-"));
    const client = new GraphifyFileClient(join(dir, "graph.json"));
    await client.upsertNodes([
      {
        id: "symbol:src/surfaces/cli/runtime/graph.ts:aaa",
        type: "Symbol",
        content:
          "async function refreshIndexForPreview @src/surfaces/cli/runtime/graph.ts:477",
        metadata: {
          jsdoc:
            "Returns true when the deferred vector pass took ownership of graphClient: the caller must then NOT close the client",
          file: "src/surfaces/cli/runtime/graph.ts",
          name: "refreshIndexForPreview",
        },
      },
      {
        id: "symbol:src/graph/context-pressure.ts:bbb",
        type: "Symbol",
        content: "function buildCompactionSignal @src/graph/context-pressure.ts:273",
        metadata: {
          jsdoc: "Pair a boundary compaction economics with its handoff payload",
          file: "src/graph/context-pressure.ts",
          name: "buildCompactionSignal",
        },
      },
    ]);

    const hits = await collectExpandedKeywordHits(
      client,
      "previewContext graph client ownership who creates and who closes it, deferred embedding handoff semantics"
    );
    const topIds = hits.slice(0, 3).map((n) => n.id);
    expect(topIds.some((id) => id.includes("runtime/graph.ts"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

function stubClient(nodes: GraphNode[], keywordHits: GraphNode[]): GraphClient {
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
    readSnapshot() {
      return { nodes, edges: [] };
    },
  };
}

describe("M-CJK semantic rescue (out-of-glossary Chinese, empty keyword recall)", () => {
  // Query with no glossary coverage and no Latin: keyword recall is empty by
  // construction, so only the vector channel can answer.
  const OUT_OF_GLOSSARY = "大象的鼻子有多长";

  it("glossary honestly reports no coverage for this query", () => {
    expect(expandCjkGlossaryTerms(OUT_OF_GLOSSARY)).toEqual([]);
  });

  it("rescues via full-graph vectors on a semantic backend", async () => {
    const truth = attachEmbedding(
      { id: "symbol:trunk", type: "Symbol", content: "elephant trunk length nose" },
      [0, 1]
    );
    const decoy = attachEmbedding(
      { id: "symbol:tail", type: "Symbol", content: "elephant tail length rear" },
      [1, 0]
    );
    const client = stubClient([truth, decoy], []);
    const { buildLayeredContextPackage } = await import("../src/graph/context-slicer");

    const pkg = await buildLayeredContextPackage(client, OUT_OF_GLOSSARY, 500, {
      embeddingProvider: {
        embed: async () => [0, 1],
        fingerprint: () => "test-semantic-v1",
      },
      enableEdgeExpansion: false,
      enableVectorRecall: true,
      vectorMinSimilarity: 0.9,
      vectorTopK: 8,
    });

    expect(pkg.anchorChannel.map((anchor) => anchor.id)).toContain("symbol:trunk");
  });

  it("does NOT rescue on a hash backend (FNV vectors carry no meaning)", async () => {
    const truth = attachEmbedding(
      { id: "symbol:trunk", type: "Symbol", content: "elephant trunk length nose" },
      [0, 1]
    );
    const client = stubClient([truth], []);
    const { buildLayeredContextPackage } = await import("../src/graph/context-slicer");

    const pkg = await buildLayeredContextPackage(client, OUT_OF_GLOSSARY, 500, {
      embeddingProvider: {
        embed: async () => [0, 1],
        fingerprint: () => "fnv1a-384",
      },
      enableEdgeExpansion: false,
      enableVectorRecall: true,
      vectorMinSimilarity: 0.0,
      vectorTopK: 8,
    });

    // No noise injection: empty keyword stays empty instead of surfacing
    // random hash-neighbors.
    expect(pkg.anchorChannel.map((anchor) => anchor.id)).not.toContain("symbol:trunk");
  });
});
