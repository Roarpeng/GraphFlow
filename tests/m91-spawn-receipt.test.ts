import { describe, expect, it } from "vitest";
import { issueSpawnReceipt } from "../src/graph/spawn-receipt";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphNode } from "../src/core/types";

/** 构造图节点（metadata 可选，模拟 Symbol 节点携带 name 的情形）。 */
function node(id: string, type: GraphNode["type"], content: string, name?: string): GraphNode {
  if (name === undefined) return { id, type, content };
  return { id, type, content, metadata: { name } };
}

/** stub GraphClient：按关键词返回预置节点，并记录每次查询词；可切换为 reject。 */
function makeStub(
  results: Record<string, GraphNode[]>,
  opts?: { reject?: boolean }
): { client: GraphClient; calls: string[] } {
  const calls: string[] = [];
  const client: GraphClient = {
    upsertNodes: async () => {},
    upsertEdges: async () => {},
    queryByKeyword: async (query: string) => {
      calls.push(query);
      if (opts?.reject === true) throw new Error("graph backend down");
      return results[query] ?? [];
    },
  };
  return { client, calls };
}

describe("issueSpawnReceipt（subagent 出生证）", () => {
  it("优先用 query 分词召回，跨词重叠结果按节点 id 去重", async () => {
    // "compress" 与 "anchor" 两个词都召回 n1，且各自多召回一个独有节点
    const shared = node("symbol:src/a.ts:aaa1", "Symbol", "function compress");
    const { client, calls } = makeStub({
      compress: [shared, node("file:src/a.ts", "File", "File: src/a.ts")],
      anchor: [node("concept:anchor", "Concept", "锚点机制"), shared],
    });
    const receipt = await issueSpawnReceipt(client, {
      task: "重构 refactor 模块",
      query: "compress anchor",
    });
    // 只查询了 query 的分词（task 里的 "refactor"、"模块" 不查）
    expect(calls.sort()).toEqual(["anchor", "compress"]);
    const ids = receipt.anchors.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length); // 无重复
    expect(ids).toContain("symbol:src/a.ts:aaa1");
    expect(ids).toContain("file:src/a.ts");
    expect(ids).toContain("concept:anchor");
  });

  it("query 缺省时回退用 task 文本分词召回", async () => {
    const { client, calls } = makeStub({
      重构: [node("file:src/refactor.ts", "File", "File: src/refactor.ts")],
    });
    const receipt = await issueSpawnReceipt(client, { task: "重构 压缩逻辑" });
    expect(calls).toContain("重构");
    expect(calls).toContain("压缩逻辑");
    expect(receipt.anchors).toHaveLength(1);
    expect(receipt.anchors[0]?.kind).toBe("file");
  });

  it("kind 分类正确：Symbol/File/Concept/Requirement，其余类型（如 Module）被过滤", async () => {
    const { client } = makeStub({
      all: [
        node("symbol:s.ts:1", "Symbol", "fn"),
        node("file:f.ts", "File", "File: f.ts"),
        node("concept:c1", "Concept", "概念"),
        node("requirement:r1", "Requirement", "需求"),
        node("module:m1", "Module", "Module: m1"),
        node("decision:d1", "Decision", "决策"),
      ],
    });
    const receipt = await issueSpawnReceipt(client, { task: "all", maxAnchors: 10 });
    const byId = new Map(receipt.anchors.map((a) => [a.id, a.kind]));
    expect(byId.get("symbol:s.ts:1")).toBe("symbol");
    expect(byId.get("file:f.ts")).toBe("file");
    expect(byId.get("concept:c1")).toBe("knowledge");
    expect(byId.get("requirement:r1")).toBe("knowledge");
    expect(byId.has("module:m1")).toBe(false);
    expect(byId.has("decision:d1")).toBe(false);
  });

  it("maxAnchors 截断：显式传 3 生效，缺省为 6", async () => {
    const ten: GraphNode[] = Array.from({ length: 10 }, (_, i) =>
      node(`symbol:s.ts:h${i}`, "Symbol", `symbol ${i}`)
    );
    const { client } = makeStub({ everything: ten });
    const cut = await issueSpawnReceipt(client, { task: "everything", maxAnchors: 3 });
    expect(cut.anchors).toHaveLength(3);
    const dflt = await issueSpawnReceipt(client, { task: "everything" });
    expect(dflt.anchors).toHaveLength(6); // 默认 6
    expect(dflt.anchors.map((a) => a.id)).toEqual(ten.slice(0, 6).map((n) => n.id));
  });

  it("estimatedReceiptTokens 是诚实的 length/4 估算：>0 且小于收据序列化长度", async () => {
    const { client } = makeStub({
      compress: [node("symbol:a.ts:11", "Symbol", "function compressAnchor", "compressAnchor")],
    });
    const receipt = await issueSpawnReceipt(client, { task: "做压缩", query: "compress" });
    const serialized = JSON.stringify(receipt);
    expect(receipt.estimatedReceiptTokens).toBeGreaterThan(0);
    expect(receipt.estimatedReceiptTokens).toBeLessThan(serialized.length);
    // 恰好等于载荷（不含估算字段自身）长度的 ceil(len/4)
    const payload = JSON.stringify({
      task: receipt.task,
      anchors: receipt.anchors,
      instructions: receipt.instructions,
    });
    expect(receipt.estimatedReceiptTokens).toBe(Math.ceil(payload.length / 4));
  });

  it("空召回与异步失败均 fail-open：anchors 为空、instructions 仍生成、不抛错", async () => {
    // 全停用词 → 无关键词可查，不触碰 client
    const empty = makeStub({});
    const r1 = await issueSpawnReceipt(empty.client, { task: "的 了 the" });
    expect(empty.calls).toEqual([]);
    expect(r1.anchors).toEqual([]);
    expect(r1.instructions).toContain("graphflow_context");

    // 关键词召回为空
    const miss = makeStub({ compress: [] });
    const r2 = await issueSpawnReceipt(miss.client, { task: "compress" });
    expect(r2.anchors).toEqual([]);
    expect(r2.instructions.length).toBeGreaterThan(0);

    // 后端 reject → 不抛错，空锚点收据
    const broken = makeStub({}, { reject: true });
    const r3 = await issueSpawnReceipt(broken.client, { task: "compress" });
    expect(r3.anchors).toEqual([]);
    expect(r3.instructions).toContain("自行探索");
    expect(r3.estimatedReceiptTokens).toBeGreaterThan(0);
  });

  it("instructions 包含 graphflow_context 取回方式与锚点按需展开/回写引用说明", async () => {
    const withAnchors = makeStub({
      compress: [node("symbol:a.ts:22", "Symbol", "fn compress")],
    });
    const r1 = await issueSpawnReceipt(withAnchors.client, { task: "t", query: "compress" });
    expect(r1.instructions).toContain("graphflow_context");
    expect(r1.instructions).toContain("anchorId");
    expect(r1.instructions).toContain("只展开当前任务真正需要的锚点");
    expect(r1.instructions).toContain("引用你实际依据的锚点 id");

    const none = makeStub({});
    const r2 = await issueSpawnReceipt(none.client, { task: "的" });
    expect(r2.instructions).toContain("graphflow_context");
    expect(r2.instructions).toContain("anchors 为空");
  });

  it("label 优先取 metadata.name，否则取 content 前 60 字符", async () => {
    const long = "x".repeat(120);
    const { client } = makeStub({
      look: [
        node("symbol:n.ts:1", "Symbol", "whatever content", "prettyName"),
        node("file:long.ts", "File", long),
      ],
    });
    const receipt = await issueSpawnReceipt(client, { task: "look" });
    const labels = new Map(receipt.anchors.map((a) => [a.id, a.label]));
    expect(labels.get("symbol:n.ts:1")).toBe("prettyName");
    expect(labels.get("file:long.ts")).toBe("x".repeat(60)); // 截断到 60
    expect(labels.get("file:long.ts")?.length).toBe(60);
  });
});
