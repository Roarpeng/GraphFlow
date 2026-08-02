import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { indexSingleFile, indexWorkspaceFiles } from "../src/graph/file-indexer";
import {
  assignSymbolNodeIds,
  resetSymbolIdStats,
  symbolIdStats,
  type IndexedSymbol,
  type ParsedFile,
} from "../src/graph/file-indexer-nodes";
import { buildBatchReferenceEdges } from "../src/graph/file-indexer-edges";
import {
  computePageRank,
  markGraphMutated,
  pageRankCacheStats,
  resetPageRankCache,
} from "../src/graph/graph-compression";
import { hashTextHex } from "../src/utils/hash";
import type { GraphEdge, GraphNode } from "../src/core/types";
import type { DeclaredSymbol } from "../src/graph/language-indexers";

function mkSymbol(name: string, kind: string, line: number): DeclaredSymbol {
  return { name, kind, exported: true, line, file: "src/ui.ts" };
}

function symbolId(relPath: string, name: string): string {
  return `symbol:${relPath}:${hashTextHex(name)}`;
}

/** 构造一个用于引用边测试的 ParsedFile（用消歧器生成 nodeId，顺带覆盖其使用）。 */
function parseFixture(relPath: string, content: string, names: string[]): ParsedFile {
  const declared: IndexedSymbol[] = assignSymbolNodeIds(
    relPath,
    names.map((name) => mkSymbol(name, "function", 1))
  );
  return {
    relPath,
    fileNodeId: `file:${relPath}`,
    moduleNodeId: `module:${relPath.replace(/\.ts$/, "")}`,
    declared,
    content,
    scannable: true,
    calls: [],
    inherits: [],
  };
}

function buildSymbolIndex(files: ParsedFile[]): Map<string, IndexedSymbol[]> {
  const symbolIndex = new Map<string, IndexedSymbol[]>();
  for (const file of files) {
    for (const sym of file.declared) {
      const list = symbolIndex.get(sym.name) ?? [];
      list.push(sym);
      symbolIndex.set(sym.name, list);
    }
  }
  return symbolIndex;
}

describe("符号哈希冲突消歧", () => {
  it("同文件两个同名函数获得不同 nodeId，首个保留旧 ID", () => {
    resetSymbolIdStats();
    const indexed = assignSymbolNodeIds("src/ui.ts", [
      mkSymbol("render", "function", 10),
      mkSymbol("render", "function", 40),
      mkSymbol("setup", "function", 5),
    ]);
    expect(indexed).toHaveLength(3);
    // 首个同名符号保留旧 ID（向后兼容），第三个无关符号不受影响
    expect(indexed[0]!.nodeId).toBe(symbolId("src/ui.ts", "render"));
    expect(indexed[2]!.nodeId).toBe(symbolId("src/ui.ts", "setup"));
    // 冲突符号获得不同 ID，且仍保持 symbol:{relPath}:{hash} 形式
    expect(indexed[1]!.nodeId).not.toBe(indexed[0]!.nodeId);
    expect(indexed[1]!.nodeId).toMatch(/^symbol:src\/ui\.ts:[0-9a-f]+$/);
    // 确定性：同样输入产出同样 ID（批量/增量索引可复用）
    const again = assignSymbolNodeIds("src/ui.ts", [
      mkSymbol("render", "function", 10),
      mkSymbol("render", "function", 40),
      mkSymbol("setup", "function", 5),
    ]);
    expect(again.map((s) => s.nodeId)).toEqual(indexed.map((s) => s.nodeId));
    // 统计钩子：两次调用各 1 处冲突（累计 2）、共 6 次赋值
    expect(symbolIdStats.collisionCount).toBe(2);
    expect(symbolIdStats.assignedIds).toBe(6);
  });

  it("三个同名符号两两不同；不同类型同名也消歧", () => {
    resetSymbolIdStats();
    const three = assignSymbolNodeIds("src/x.ts", [
      mkSymbol("config", "function", 1),
      mkSymbol("config", "function", 9),
      mkSymbol("config", "function", 17),
    ]);
    expect(new Set(three.map((s) => s.nodeId)).size).toBe(3);
    expect(symbolIdStats.collisionCount).toBe(2);

    const mixed = assignSymbolNodeIds("src/y.ts", [
      { ...mkSymbol("Item", "interface", 3), file: "src/y.ts" },
      { ...mkSymbol("Item", "class", 20), file: "src/y.ts" },
    ]);
    expect(mixed[0]!.nodeId).not.toBe(mixed[1]!.nodeId);
  });

  it("端到端：批量与增量索引中同文件同名符号不再碰撞", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-noise-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "guide.md"), "## Overview\nintro\n## Overview\nmore\n", "utf8");

      const config = validateConfig({
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-4.1" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          autoIndexOnPreview: true,
          workspaceRoot: root,
          includeExtensions: [".md"],
          transport: "memory",
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: false,
          trainingCadence: "nightly",
          exportPath: "graphflow-out/learning-dataset.jsonl",
        },
      });

      const client = createGraphClient(config);
      const indexed = await indexWorkspaceFiles(client, root, { includeExtensions: [".md"] });
      // 2 个同名标题符号 + 2 个段落 chunk 符号
      expect(indexed.indexedSymbols).toBe(4);

      const snapshot = client.readSnapshot!();
      const overviewIds = snapshot.nodes
        .filter((n) => n.type === "Symbol" && n.metadata?.name === "Overview")
        .map((n) => n.id);
      expect(overviewIds).toHaveLength(2);
      expect(new Set(overviewIds).size).toBe(2); // 不再碰撞
      expect(overviewIds[0]).toBe(symbolId("docs/guide.md", "Overview"));

      // 增量路径：改为三个同名标题后重索引，产出三个互异 ID
      writeFileSync(
        join(root, "docs", "guide.md"),
        "## Overview\nintro\n## Overview\nmore\n## Overview\nlast\n",
        "utf8"
      );
      await indexSingleFile(client, root, join(root, "docs", "guide.md"), {
        includeExtensions: [".md"],
      });
      const snapshot2 = client.readSnapshot!();
      const ids2 = snapshot2.nodes
        .filter((n) => n.type === "Symbol" && n.metadata?.name === "Overview")
        .map((n) => n.id);
      expect(ids2).toHaveLength(3);
      expect(new Set(ids2).size).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("引用边构建优化", () => {
  it("优化后保持正确性：跨文件引用、本文件自身跳过、黑名单词跳过", () => {
    const files = [
      parseFixture("src/a.ts", "alpha calls beta and delta", ["alpha"]),
      parseFixture("src/b.ts", "uses alpha", ["beta"]),
      parseFixture("src/c.ts", "default alpha", ["default"]),
    ];
    const symbolIndex = buildSymbolIndex(files);
    const { edges, referenceCount } = buildBatchReferenceEdges(files, symbolIndex);

    const edgeKeys = new Set(edges.map((e) => `${e.from}->${e.to}`));
    // a.ts: alpha 是本文件定义（跳过）；beta 跨文件 → a→b；delta/calls/and 无定义
    // b.ts: alpha 跨文件 → b→a
    // c.ts: default 在黑名单中（即使有定义也不产生引用边）；alpha 跨文件 → c→a
    expect(edgeKeys).toEqual(
      new Set([
        `file:src/a.ts->${symbolId("src/b.ts", "beta")}`,
        `file:src/b.ts->${symbolId("src/a.ts", "alpha")}`,
        `file:src/c.ts->${symbolId("src/a.ts", "alpha")}`,
      ])
    );
    expect(referenceCount).toBe(3);
  });

  it("空符号索引时直接返回（不扫描任何文件）", () => {
    const files = [parseFixture("src/a.ts", "alpha beta gamma", ["alpha"])];
    const { edges, referenceCount } = buildBatchReferenceEdges(files, new Map());
    expect(edges).toEqual([]);
    expect(referenceCount).toBe(0);
  });

  it("消歧后的同名符号作为独立引用目标（此前会合并成一条边）", () => {
    const files = [
      parseFixture("src/a.ts", "handle()", ["run"]),
      parseFixture("src/b.ts", "handle()", ["handle", "handle"]),
    ];
    const symbolIndex = buildSymbolIndex(files);
    const { edges } = buildBatchReferenceEdges(files, symbolIndex);
    const toB = edges.filter((e) => e.to.startsWith("symbol:src/b.ts:"));
    // b.ts 内两个同名 handle 是不同符号 → a.ts 的引用产生两条互异边
    expect(toB).toHaveLength(2);
    expect(new Set(toB.map((e) => e.to)).size).toBe(2);
  });
});

function makeNodes(count: number): GraphNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `symbol:f${i}.ts:x${i}`,
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

describe("PageRank 缓存影响面失效", () => {
  it("无标记变更时按指纹重算（默认行为不变）", () => {
    resetPageRankCache();
    const nodes = makeNodes(10);
    const v1 = makeEdges(nodes);
    const v2 = [...v1, { from: nodes[9]!.id, to: nodes[0]!.id, relation: "calls" as const }];

    const r1 = computePageRank(nodes, v1);
    const r2 = computePageRank(nodes, v2);
    expect(pageRankCacheStats.misses).toBe(2);
    expect(pageRankCacheStats.hits).toBe(0);
    // 回边改变了子图中心性 → 结果必须更新
    expect(r2.get(nodes[0]!.id)).not.toBe(r1.get(nodes[0]!.id));
  });

  it("触及子图外节点的变更不失效该子图（影响面快速命中，数值不变）", () => {
    resetPageRankCache();
    const nodes = makeNodes(10);
    const edges = makeEdges(nodes);
    const first = computePageRank(nodes, edges);
    expect(pageRankCacheStats.misses).toBe(1);

    markGraphMutated(["symbol:other/file.ts:zzz"]);
    const second = computePageRank(nodes, edges);
    expect(pageRankCacheStats.fastHits).toBe(1);
    expect(pageRankCacheStats.hits).toBe(1);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it("触及子图内节点后重算，结果更新", () => {
    resetPageRankCache();
    const nodes = makeNodes(10);
    const edges = makeEdges(nodes);
    const v1 = computePageRank(nodes, edges);

    markGraphMutated([nodes[9]!.id, nodes[0]!.id]);
    const changed = [...edges, { from: nodes[9]!.id, to: nodes[0]!.id, relation: "calls" as const }];
    const v2 = computePageRank(nodes, changed);
    expect(pageRankCacheStats.misses).toBe(2);
    expect(pageRankCacheStats.fastHits).toBe(0);
    expect(v2.get(nodes[0]!.id)).not.toBe(v1.get(nodes[0]!.id));
  });

  it("无范围（全局）变更使快速路径失效，指纹层仍保证数值正确", () => {
    resetPageRankCache();
    const nodes = makeNodes(5);
    const edges = makeEdges(nodes);
    computePageRank(nodes, edges);
    expect(pageRankCacheStats.misses).toBe(1);

    markGraphMutated(); // 影响面未知 → 全局失效
    const again = computePageRank(nodes, edges);
    expect(pageRankCacheStats.fastHits).toBe(0);
    expect(pageRankCacheStats.hits).toBe(1); // 指纹命中，数值仍正确
    expect(again.has(nodes[0]!.id)).toBe(true);

    // 全局变更后子图相关边真的变化 → 必须重算
    const changed = [...edges, { from: nodes[4]!.id, to: nodes[0]!.id, relation: "calls" as const }];
    computePageRank(nodes, changed);
    expect(pageRankCacheStats.misses).toBe(2);
  });

  it("client 写入自动触发影响面标记（装饰器接线）", async () => {
    resetPageRankCache();
    const config = validateConfig({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: { transport: "memory" },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    });
    const client = createGraphClient(config);

    const nodes = makeNodes(4);
    const edges = makeEdges(nodes);
    const first = computePageRank(nodes, edges);
    expect(pageRankCacheStats.misses).toBe(1);

    // 通过 client 写入一个子图内节点（模拟 reindex 触及该符号）
    await client.upsertNodes([{ id: nodes[0]!.id, type: "Symbol", content: "updated" }]);
    const second = computePageRank(nodes, edges);
    // 子图被触及 → 快速路径被跳过；相关边未变 → 指纹命中，数值仍正确
    expect(pageRankCacheStats.fastHits).toBe(0);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });
});
