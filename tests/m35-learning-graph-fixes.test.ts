import { describe, it, expect } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphNode } from "../src/core/types";
import { parseEpisodes, pruneExpiredEpisodes } from "../src/learning/episodic-memory";

// ── Index cleanup on upsert ─────────────────────────────────────────

describe("graphify-client: index cleanup on upsert", () => {
  it("should remove stale tokens when node content is updated", async () => {
    const client = new GraphifyClient();

    const nodeV1: GraphNode = {
      id: "sym:foo",
      type: "Symbol",
      content: "export function oldFunctionName(): void",
    };
    await client.upsertNodes([nodeV1]);

    // 旧 token 可以命中
    const beforeUpdate = await client.queryByKeyword("oldfunctionname");
    expect(beforeUpdate).toHaveLength(1);

    // 更新节点 content
    const nodeV2: GraphNode = {
      id: "sym:foo",
      type: "Symbol",
      content: "export function newFunctionName(): void",
    };
    await client.upsertNodes([nodeV2]);

    // 旧 token 不再命中
    const afterUpdateOld = await client.queryByKeyword("oldfunctionname");
    expect(afterUpdateOld).toHaveLength(0);

    // 新 token 可以命中
    const afterUpdateNew = await client.queryByKeyword("newfunctionname");
    expect(afterUpdateNew).toHaveLength(1);
    expect(afterUpdateNew[0]!.content).toContain("newFunctionName");
  });

  it("should not leave orphan entries in inverted index", async () => {
    const client = new GraphifyClient();

    const node: GraphNode = { id: "n1", type: "Symbol", content: "uniqueTokenXyz" };
    await client.upsertNodes([node]);

    // 用完全不同的 content 替换
    await client.upsertNodes([{ ...node, content: "completelyDifferent" }]);

    // 原始 token 应返回 0 结果
    const results = await client.queryByKeyword("uniquetokenxyz");
    expect(results).toHaveLength(0);
  });
});

// ── Episode pruning ──────────────────────────────────────────────────

describe("episodic-memory: pruneExpiredEpisodes", () => {
  it("should prune episodes older than maxAge", async () => {
    const client = new GraphifyClient();

    // 写入一个 "旧" episode（通过手动构造节点）
    const oldEpisode: GraphNode = {
      id: "episode:old1",
      type: "Decision",
      content: "episode fix old bug",
      metadata: {
        record: JSON.stringify({
          id: "episode:old1",
          task: "fix old bug",
          plan: [],
          outcome: "pass",
          keyDecisions: [],
          lessons: [],
          attempts: 1,
          createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000, // 40 天前
          updatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
        }),
        kind: "episode",
      },
    };

    // 写入一个 "新" episode
    const newEpisode: GraphNode = {
      id: "episode:new1",
      type: "Decision",
      content: "episode fix new bug",
      metadata: {
        record: JSON.stringify({
          id: "episode:new1",
          task: "fix new bug",
          plan: [],
          outcome: "pass",
          keyDecisions: [],
          lessons: [],
          attempts: 1,
          createdAt: Date.now() - 1000,
          updatedAt: Date.now() - 1000,
        }),
        kind: "episode",
      },
    };

    await client.upsertNodes([oldEpisode, newEpisode]);

    const result = await pruneExpiredEpisodes(client, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    expect(result.pruned).toBe(1);

    // 验证旧 episode 被标记为 pruned
    const allNodes = await client.queryByKeyword("episode");
    const oldNode = allNodes.find((n) => n.id === "episode:old1");
    expect(oldNode).toBeUndefined();

    // 新 episode 未被影响
    const newNode = allNodes.find((n) => n.id === "episode:new1");
    expect(newNode?.metadata?.pruned).toBeUndefined();
  });

  it("should prune excess episodes beyond maxCount", async () => {
    const client = new GraphifyClient();

    // 插入 5 个 episode，maxCount = 3
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push({
        id: `episode:batch${i}`,
        type: "Decision",
        content: `episode task batch ${i}`,
        metadata: {
          record: JSON.stringify({
            id: `episode:batch${i}`,
            task: `task batch ${i}`,
            plan: [],
            outcome: "pass",
            keyDecisions: [],
            lessons: [],
            attempts: 1,
            createdAt: Date.now() - i * 1000, // 0,1,2,3,4 秒前
            updatedAt: Date.now() - i * 1000,
          }),
          kind: "episode",
        },
      });
    }
    await client.upsertNodes(nodes);

    const result = await pruneExpiredEpisodes(client, { maxCount: 3 });
    expect(result.pruned).toBe(2); // 最旧的 2 个被 pruned
  });

  it("should filter pruned episodes from parseEpisodes", async () => {
    const prunedNode: GraphNode = {
      id: "episode:pruned1",
      type: "Decision",
      content: "episode pruned task",
      metadata: {
        record: JSON.stringify({
          id: "episode:pruned1",
          task: "pruned task",
          plan: [],
          outcome: "pass",
          keyDecisions: [],
          lessons: [],
          attempts: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        kind: "episode",
        pruned: true,
      },
    };

    const activeNode: GraphNode = {
      id: "episode:active1",
      type: "Decision",
      content: "episode active task",
      metadata: {
        record: JSON.stringify({
          id: "episode:active1",
          task: "active task",
          plan: [],
          outcome: "pass",
          keyDecisions: [],
          lessons: [],
          attempts: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        kind: "episode",
      },
    };

    const records = parseEpisodes([prunedNode, activeNode]);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("episode:active1");
  });
});

// ── Post-index enrichment ────────────────────────────────────────────

describe("post-run-sync: auto enrichment", () => {
  it("should return enrichment count after sync", async () => {
    // 测试 syncGraphAfterRun 的签名和返回结构
    const { syncGraphAfterRun } = await import("../src/hooks/post-run-sync");
    
    // 空 changes → 返回 {indexed: 0, enriched: 0}
    const client = new GraphifyClient();
    const result = await syncGraphAfterRun(client, []);
    expect(result).toEqual({ indexed: 0, enriched: 0 });
  });
});
