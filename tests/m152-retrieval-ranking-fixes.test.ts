import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import { diversifyHitsBySourceFile } from "../src/graph/hit-diversify";
import { extractBodyTerms, nodeRecallText, rankNodesForContextQuery } from "../src/graph/graph-utils";
import { buildFileNodesAndEdges } from "../src/graph/file-indexer-nodes";
import { indexedStoreIsIncomplete, saveCacheState, indexManifestPath } from "../src/graph/file-indexer-cache";
import { reciprocalRankFusion } from "../src/learning/embeddings";
import { estimateRawContextTokens } from "../src/surfaces/cli/runtime/helpers";

const sym = (path: string, hash: string, content: string, jsdoc?: string): GraphNode => ({
  id: `symbol:${path}:${hash}`,
  type: "Symbol",
  content: `${content} @${path}:1`,
  ...(jsdoc ? { metadata: { jsdoc } } : {}),
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("diversifyHitsBySourceFile keeps retrieval order", () => {
  it("does not hoist File nodes above better-ranked symbols", () => {
    const hits: GraphNode[] = [
      sym("src/a.ts", "1", "function alpha"),
      { id: "file:src/z.ts", type: "File", content: "file src/z.ts" },
      sym("src/b.ts", "2", "function beta"),
    ];
    expect(diversifyHitsBySourceFile(hits).map((n) => n.id)).toEqual([
      "symbol:src/a.ts:1",
      "file:src/z.ts",
      "symbol:src/b.ts:2",
    ]);
  });

  it("collapses identical copies of one doc shipped under several roots", () => {
    const hits: GraphNode[] = [
      sym("src/surfaces/trae-skill/graphflow/SKILL.md", "300f3c99", "section Workflow"),
      sym("skills/graphflow/SKILL.md", "300f3c99", "section Workflow"),
      sym(".trae/skills/graphflow/SKILL.md", "300f3c99", "section Workflow"),
      sym("src/graph/query-expand.ts", "eab344c6", "function collectExpandedKeywordHits"),
    ];
    expect(diversifyHitsBySourceFile(hits).map((n) => n.id)).toEqual([
      "symbol:src/surfaces/trae-skill/graphflow/SKILL.md:300f3c99",
      "symbol:src/graph/query-expand.ts:eab344c6",
    ]);
  });

  it("keeps same-named symbols of different files (name hash alone is not a copy)", () => {
    const hits: GraphNode[] = [
      sym("src/a/index.ts", "abc", "function createClient(url)"),
      sym("src/b/index.ts", "abc", "function createClient(options, retries)"),
    ];
    expect(diversifyHitsBySourceFile(hits)).toHaveLength(2);
  });
});

describe("rankNodesForContextQuery field weighting", () => {
  it("prefers the file named by a query term over body matches of rarer words", () => {
    const nodes: GraphNode[] = [
      sym("src/agents/planner.ts", "p1", "function planSteps", "executes executes executes the plan"),
      sym("src/agents/worker.ts", "w1", "function runWorker", "runs a task"),
      sym("src/core/other.ts", "o1", "function other", "worker pool"),
    ];
    const ranked = rankNodesForContextQuery(nodes, "worker executes tasks");
    expect(ranked[0]?.id).toBe("symbol:src/agents/worker.ts:w1");
  });

  it("demotes tests and prose for implementation questions, not for test/doc questions", () => {
    const nodes: GraphNode[] = [
      sym("tests/typesafe-worker.test.ts", "t1", "it typesafe system one judgment api"),
      sym("src/routing/typesafe-systemone.ts", "s1", "function createSystemOneClient", "typesafe judgment api"),
      sym("README.md", "r1", "section TypeSafe System One judgment API"),
    ];
    expect(rankNodesForContextQuery(nodes, "call the typesafe system one judgment api")[0]?.id).toBe(
      "symbol:src/routing/typesafe-systemone.ts:s1"
    );
    expect(rankNodesForContextQuery(nodes, "typesafe judgment api tests")[0]?.id).toBe(
      "symbol:tests/typesafe-worker.test.ts:t1"
    );
  });

  it("saturates repeated terms so one long jsdoc cannot outvote distinct-term coverage", () => {
    const nodes: GraphNode[] = [
      sym("src/x/noisy.ts", "n1", "function noisy", "graph ".repeat(40)),
      sym("src/x/store-migration.ts", "m1", "function mergeJsonIntoSqlite", "fold the json graph into sqlite"),
    ];
    expect(rankNodesForContextQuery(nodes, "fold json graph into sqlite")[0]?.id).toBe(
      "symbol:src/x/store-migration.ts:m1"
    );
  });
});

describe("File body terms", () => {
  it("harvests identifiers and CJK comment terms, skipping short and numeric tokens", () => {
    const terms = extractBodyTerms("const tamperEvident = 42; // 哈希链防篡改\nif (x) chainHash(prev);").split(" ");
    expect(terms).toEqual(expect.arrayContaining(["tamperevident", "tamper", "evident", "chainhash", "chain", "hash"]));
    expect(terms.some((t) => /[\u4e00-\u9fff]/.test(t))).toBe(true);
    expect(terms).not.toContain("42");
    expect(terms).not.toContain("if");
  });

  it("only code File nodes get body terms, and recall text includes them", () => {
    const { nodes } = buildFileNodesAndEdges("src/audit/log.ts", 100, "typescript", [], [], "function appendEntry() { verifyChain(); }");
    const file = nodes.find((n) => n.type === "File")!;
    expect(nodeRecallText(file)).toContain("verifychain");
    const md = buildFileNodesAndEdges("docs/a.md", 100, "markdown", [], [], "verifyChain everywhere").nodes[0]!;
    expect(md.metadata?.bodyTerms).toBeUndefined();
  });

  it("scores body-term coverage without the length penalty of the main field", () => {
    const withBody: GraphNode = {
      id: "file:src/learning/evidence.ts",
      type: "File",
      content: "src/learning/evidence.ts",
      metadata: { path: "src/learning/evidence.ts", bodyTerms: "prevhash chain tamper audit append verify" },
    };
    const nodes: GraphNode[] = [
      sym("src/utils/misc.ts", "m1", "function formatDate"),
      withBody,
      { id: "file:src/utils/misc.ts", type: "File", content: "src/utils/misc.ts", metadata: { path: "src/utils/misc.ts" } },
    ];
    expect(rankNodesForContextQuery(nodes, "hash chain tamper audit")[0]?.id).toBe("file:src/learning/evidence.ts");
  });
});

describe("reciprocalRankFusion weights", () => {
  it("lets a half-weight list break ties but not outvote the primary list head", () => {
    const a = sym("src/a.ts", "1", "a");
    const b = sym("src/b.ts", "2", "b");
    const doc = sym("docs/x.md", "3", "doc");
    const fused = reciprocalRankFusion([[a, b], [doc]], 60, [1, 0.5]);
    expect(fused.map((n) => n.id)).toEqual([a.id, b.id, doc.id]);
  });
});

describe("indexedStoreIsIncomplete", () => {
  it("fires when the manifest claims far more files than the store holds", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-store-incomplete-"));
    dirs.push(root);
    mkdirSync(join(root, ".graphflow-cache"), { recursive: true });
    const state = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`src/f${i}.ts`, { mtimeMs: 1, hash: "h", numNodes: 1 }])
    );
    saveCacheState(indexManifestPath(root), state);
    const few = Array.from({ length: 5 }, (_, i) => ({ id: `file:src/f${i}.ts`, type: "File" }));
    const all = Array.from({ length: 40 }, (_, i) => ({ id: `file:src/f${i}.ts`, type: "File" }));
    expect(indexedStoreIsIncomplete(root, undefined, few)).toBe(true);
    expect(indexedStoreIsIncomplete(root, undefined, all)).toBe(false);
    expect(indexedStoreIsIncomplete(root, undefined, undefined)).toBe(false);
  });

  it("stays quiet without a manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-store-incomplete-"));
    dirs.push(root);
    expect(indexedStoreIsIncomplete(root, undefined, [])).toBe(false);
  });
});

describe("estimateRawContextTokens with file sizes", () => {
  it("counts each anchored source file once at its full size", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-raw-baseline-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x".repeat(4000));
    const nodes: GraphNode[] = [
      { id: "file:src/a.ts", type: "File", content: "file src/a.ts" },
      sym("src/a.ts", "1", "function one"),
      sym("src/a.ts", "2", "function two"),
    ];
    const estimate = estimateRawContextTokens({
      anchors: nodes.map((n) => ({ id: n.id, type: n.type })),
      store: { nodes, edges: [] },
      query: "one two",
      compressedTokens: 50,
      fileTokens: (rel) => (rel === "src/a.ts" ? 1000 : undefined),
    });
    expect(estimate).toBe(1000);
  });
});
