import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import { computeAnchorRelevance } from "../src/graph/graph-search";
import {
  anchorRelevanceQuality,
  QUERY_TRANSLATE_LOW_RELEVANCE_THRESHOLD,
  QUERY_TRANSLATE_RELEVANCE_TOP_K,
} from "../src/graph/query-translate";
import { estimateRawContextTokens, estimateTokenCount } from "../src/surfaces/cli/runtime/helpers";
import type { ContextAnchorItem } from "../src/graph/context-slicer-types";

/**
 * 低相关触发 + 锚点集基线（纯函数层）/ Low-relevance trigger + anchor-set
 * raw baseline (pure functions).
 *
 * ① computeAnchorRelevance: normalized 0..1 share of query tokens present in
 *    the node's searchable text (CJK bigrams included).
 * ② anchorRelevanceQuality: mean of the top-K anchor head; feeds the
 *    query-translate-en delegation trigger.
 * ③ estimateRawContextTokens: raw baseline over the DELIVERED anchor set —
 *    never a whole-graph scan.
 */

function anchorsWith(relevance: number | undefined, count: number): ContextAnchorItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `file:src/a${i}.ts`,
    type: "File",
    layer: "L1",
    ...(relevance !== undefined ? { relevance } : {}),
  }));
}

describe("M110 computeAnchorRelevance", () => {
  const battleNode: GraphNode = {
    id: "symbol:src/combat/Battle.ts:abc",
    type: "Symbol",
    content: "class BattleSystem (exported) @src/combat/Battle.ts:10 # 游戏战斗系统核心逻辑",
    metadata: { jsdoc: "处理战斗伤害与回合制逻辑", file: "src/combat/Battle.ts" },
  };
  const englishNode: GraphNode = {
    id: "file:src/utils/errors.ts",
    type: "File",
    content: "src/utils/errors.ts # exports: formatError, isRetryable",
  };

  it("scores a node whose text literally contains the CJK query high", () => {
    const relevance = computeAnchorRelevance(battleNode, "游戏战斗系统");
    expect(relevance).toBeGreaterThanOrEqual(0.5);
  });

  it("scores an unrelated English node 0 against a pure-CJK query", () => {
    // The defect scenario: anchors reached only via path/expansion terms
    // share no wording with a pure-Chinese query.
    expect(computeAnchorRelevance(englishNode, "启动引导时序图里的初始化守卫在哪里处理？")).toBe(0);
  });

  it("scores exact English matches 1 and misses 0", () => {
    expect(computeAnchorRelevance(englishNode, "errors")).toBe(1);
    expect(computeAnchorRelevance(englishNode, "router")).toBe(0);
  });

  it("merges englishQuery into the token set and returns 0 for empty queries", () => {
    expect(computeAnchorRelevance(battleNode, "战斗", "battle combat")).toBeGreaterThan(0);
    expect(computeAnchorRelevance(battleNode, "")).toBe(0);
    expect(computeAnchorRelevance(battleNode, "??")).toBe(0);
  });
});

describe("M110 anchorRelevanceQuality (top-K mean)", () => {
  it("averages only the first QUERY_TRANSLATE_RELEVANCE_TOP_K scored anchors", () => {
    // 5 strong + 2 unscored-injected anchors at the tail: head mean decides.
    const anchors = [
      ...anchorsWith(0.8, 5),
      ...anchorsWith(0, 2),
    ];
    expect(anchorRelevanceQuality(anchors)).toBe(0.8);
  });

  it("ignores anchors without a relevance score and returns undefined when none carry one", () => {
    expect(anchorRelevanceQuality([...anchorsWith(0.6, 2), ...anchorsWith(undefined, 3)])).toBe(0.6);
    expect(anchorRelevanceQuality(anchorsWith(undefined, 5))).toBeUndefined();
    expect(anchorRelevanceQuality([])).toBeUndefined();
  });

  it("uses fewer than K anchors when the channel is shorter than K", () => {
    expect(anchorRelevanceQuality(anchorsWith(0.2, QUERY_TRANSLATE_RELEVANCE_TOP_K - 2))).toBeCloseTo(0.2);
    expect(QUERY_TRANSLATE_LOW_RELEVANCE_THRESHOLD).toBe(0.25);
  });
});

describe("M110 estimateRawContextTokens over the delivered anchor set", () => {
  const anchorNodeA: GraphNode = {
    id: "file:src/alpha.ts",
    type: "File",
    content: "src/alpha.ts # exports: alphaRunner",
  };
  const anchorNodeB: GraphNode = {
    id: "symbol:src/alpha.ts:dead",
    type: "Symbol",
    content: "function alphaRunner (exported) @src/alpha.ts:12",
  };
  // Noise: huge, and under the OLD whole-graph formula this node (and every
  // other fuzzy match) inflated the baseline ~25x for CJK queries.
  const junk: GraphNode[] = Array.from({ length: 50 }, (_, i) => ({
    id: `node:junk${i}`,
    type: "Symbol",
    content: `totally unrelated filler node ${i} `.repeat(40),
  }));
  const store = { nodes: [anchorNodeA, anchorNodeB, ...junk], edges: [] };

  const perNode = (node: GraphNode): number =>
    estimateTokenCount(`${node.id}\n${node.type}\n${node.content}`);

  it("sums only delivered File/Symbol/Module anchors, never the whole store", () => {
    const estimate = estimateRawContextTokens({
      anchors: [
        { id: anchorNodeA.id, type: "File" },
        { id: anchorNodeB.id, type: "Symbol" },
      ],
      store,
      query: "alphaRunner",
      compressedTokens: 10,
    });
    expect(estimate).toBe(
      Math.max(10, perNode(anchorNodeA) + perNode(anchorNodeB), estimateTokenCount("alphaRunner"))
    );
    // The 50 junk nodes (old-formula inflation source) contribute nothing.
    const junkSum = junk.reduce((sum, node) => sum + perNode(node), 0);
    expect(estimate).toBeLessThan(junkSum / 10);
  });

  it("skips non-code anchor types and unknown ids, keeps the compressed floor", () => {
    const estimate = estimateRawContextTokens({
      anchors: [
        { id: "skill:some-skill", type: "Skill" },
        { id: "file:missing.ts", type: "File" },
      ],
      store,
      query: "q",
      compressedTokens: 4242,
    });
    expect(estimate).toBe(4242);
  });

  it("returns the conservative floor for an empty anchor set instead of scanning the store", () => {
    const estimate = estimateRawContextTokens({
      anchors: [],
      store,
      query: "启动引导时序图里的初始化守卫在哪里处理？",
      compressedTokens: 77,
    });
    expect(estimate).toBe(
      Math.max(77, estimateTokenCount("启动引导时序图里的初始化守卫在哪里处理？"))
    );
    expect(estimate).toBeLessThan(2000);
  });

  it("never reports below the delivered payload (floor semantics)", () => {
    const estimate = estimateRawContextTokens({
      anchors: [{ id: anchorNodeA.id, type: "File" }],
      store,
      query: "x",
      compressedTokens: 999_999,
    });
    expect(estimate).toBe(999_999);
  });
});
