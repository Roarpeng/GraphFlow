import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/routing/provider-executor", async () => {
  const actual = await vi.importActual<typeof import("../src/routing/provider-executor")>(
    "../src/routing/provider-executor"
  );
  return {
    ...actual,
    executeRolePrompt: vi.fn(),
  };
});

import { executeRolePrompt } from "../src/routing/provider-executor";
import { enrichGraphSemanticsSilent } from "../src/graph/semantic-enricher";
import { enrichSemanticsSilent } from "../src/surfaces/cli/runtime";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphNode } from "../src/core/types";

const mockedExec = vi.mocked(executeRolePrompt);

describe("MiniCPM Backend Silent Enrichment", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("enrichGraphSemanticsSilent processes only pending Symbol nodes in batches", async () => {
    mockedExec.mockImplementation(async (role, prompt) => {
      if (prompt.includes("executeDag")) {
        return "功能总结: 执行有向无环图的任务编排";
      }
      if (prompt.includes("indexWorkspaceFiles")) {
        return "功能总结: 索引工作区中的代码文件";
      }
      return "无描述";
    });

    const mockNodes: GraphNode[] = [
      {
        id: "node1",
        type: "Symbol",
        content: "export function executeDag(...)",
        metadata: { file: "src/core/orchestrator.ts" }
      },
      {
        id: "node2",
        type: "Symbol",
        content: "export class GraphifySqliteClient",
        metadata: { file: "src/graph/sqlite-client.ts", summary: "已富化的摘要" }
      },
      {
        id: "node3",
        type: "File",
        content: "console.log('file node')",
        metadata: { file: "src/index.ts" }
      },
      {
        id: "node4",
        type: "Symbol",
        content: "export function indexWorkspaceFiles(...)",
        metadata: { file: "src/graph/file-indexer.ts" }
      }
    ];

    const upserted: GraphNode[] = [];
    const client: GraphClient = {
      readSnapshot: () => ({
        nodes: mockNodes,
        edges: []
      }),
      upsertNodes: async (nodes) => {
        upserted.push(...nodes);
      },
      upsertEdges: async () => {},
      queryByKeyword: async () => []
    };

    // 使用 batchSize: 1, 应该只富化第一个待处理的 node1
    const res1 = await enrichGraphSemanticsSilent(client, { batchSize: 1, sleepMs: 0 });
    expect(res1.enrichedCount).toBe(1);
    expect(upserted.length).toBe(1);
    expect(upserted[0].id).toBe("node1");
    expect(upserted[0].metadata?.summary).toBe("执行有向无环图的任务编排");
    expect(upserted[0].metadata?.enrichedAt).toBeGreaterThan(0);

    // 再次调用，如果更新了 mockNodes，或者我们传 batchSize: 5，它应该把剩余的 node4 也富化
    upserted.length = 0; // 重置
    const mockNodesAfterFirst = [
      { ...upserted[0] }, // node1 已经有 summary 了
      mockNodes[1],
      mockNodes[2],
      mockNodes[3]
    ];
    const client2: GraphClient = {
      readSnapshot: () => ({
        nodes: mockNodesAfterFirst,
        edges: []
      }),
      upsertNodes: async (nodes) => {
        upserted.push(...nodes);
      },
      upsertEdges: async () => {},
      queryByKeyword: async () => []
    };

    const res2 = await enrichGraphSemanticsSilent(client2, { batchSize: 5, sleepMs: 0 });
    expect(res2.enrichedCount).toBe(1);
    expect(upserted.length).toBe(1);
    expect(upserted[0].id).toBe("node4");
    expect(upserted[0].metadata?.summary).toBe("索引工作区中的代码文件");
  });

  it("returns 0 if no readSnapshot method is defined", async () => {
    const client: GraphClient = {
      upsertNodes: async () => {},
      upsertEdges: async () => {},
      queryByKeyword: async () => []
    };

    const res = await enrichGraphSemanticsSilent(client, { sleepMs: 0 });
    expect(res.enrichedCount).toBe(0);
  });

  it("gracefully continues when an exception occurs inside the processing loop", async () => {
    mockedExec.mockImplementation(async (role, prompt) => {
      if (prompt.includes("throw_error_signature")) {
        throw new Error("Mocked model generation failure");
      }
      return "功能总结: 正常总结";
    });

    const mockNodes: GraphNode[] = [
      {
        id: "node1",
        type: "Symbol",
        content: "throw_error_signature",
        metadata: { file: "error.ts" }
      },
      {
        id: "node2",
        type: "Symbol",
        content: "normal_signature",
        metadata: { file: "normal.ts" }
      }
    ];

    const upserted: GraphNode[] = [];
    const client: GraphClient = {
      readSnapshot: () => ({
        nodes: mockNodes,
        edges: []
      }),
      upsertNodes: async (nodes) => {
        upserted.push(...nodes);
      },
      upsertEdges: async () => {},
      queryByKeyword: async () => []
    };

    const res = await enrichGraphSemanticsSilent(client, { batchSize: 5, sleepMs: 0 });
    expect(res.enrichedCount).toBe(1);
    expect(upserted.length).toBe(1);
    expect(upserted[0].id).toBe("node2");
    expect(upserted[0].metadata?.summary).toBe("正常总结");
  });

  it("expose enrichSemanticsSilent through runtime", async () => {
    expect(typeof enrichSemanticsSilent).toBe("function");
  });
});
