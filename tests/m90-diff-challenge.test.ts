/**
 * m90-diff-challenge.test.ts — 图 diff 质询清单测试
 *
 * stub 一个最小内存 GraphClient，复刻真实后端的边方向语义：
 *   defines:    File → Symbol            （file-indexer-nodes.ts）
 *   references: 引用方 File → 被引用 Symbol（file-indexer-edges.ts）
 *   calls:      调用方 Symbol → 被调用 Symbol（file-indexer-edges.ts）
 *   implements: 代码 Symbol/File → Requirement（document-semantic-ingest.ts）
 * 节点 id / metadata 键名同样按索引器真实格式构造。
 */
import { describe, expect, it } from "vitest";
import { buildChallengeList } from "../src/graph/diff-challenge";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphEdge, GraphNode } from "../src/core/types";

class StubGraph implements GraphClient {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];

  constructor(nodes: GraphNode[] = [], edges: GraphEdge[] = []) {
    for (const node of nodes) this.nodes.set(node.id, node);
    this.edges.push(...edges);
  }

  // 质询是只读质量门，写方法为满足接口的空实现
  async upsertNodes(): Promise<void> {}
  async upsertEdges(): Promise<void> {}

  /** 近似真实倒排语义：查询分词后任一 token 命中可搜索文本即返回 */
  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [...this.nodes.values()];
    const out: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      const text = [
        node.id,
        node.content,
        ...(node.metadata
          ? [node.metadata["file"], node.metadata["path"], node.metadata["name"], node.metadata["title"]]
              .filter((v): v is string => typeof v === "string")
          : []),
      ]
        .join(" ")
        .toLowerCase();
      if (tokens.some((t) => text.includes(t))) out.push(node);
    }
    return out;
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    const out: GraphNode[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction: "out" | "in" | "both" = "both"
  ): Promise<Array<{ node: GraphNode; via: GraphEdge["relation"] }>> {
    const relFilter = relations && relations.length > 0 ? new Set(relations) : null;
    const seen = new Set<string>();
    const out: Array<{ node: GraphNode; via: GraphEdge["relation"] }> = [];
    const add = (neighborId: string, via: GraphEdge["relation"]): void => {
      if (seen.has(neighborId)) return;
      const node = this.nodes.get(neighborId);
      if (!node) return;
      seen.add(neighborId);
      out.push({ node, via });
    };
    for (const id of nodeIds) {
      if (direction === "out" || direction === "both") {
        for (const edge of this.edges) {
          if (edge.from === id && (!relFilter || relFilter.has(edge.relation))) add(edge.to, edge.relation);
        }
      }
      if (direction === "in" || direction === "both") {
        for (const edge of this.edges) {
          if (edge.to === id && (!relFilter || relFilter.has(edge.relation))) add(edge.from, edge.relation);
        }
      }
    }
    return out;
  }
}

// —— 按索引器真实格式构造节点/边 ——

function fileNode(relPath: string, exports: string[] = []): GraphNode {
  return {
    id: `file:${relPath}`,
    type: "File",
    content: `${relPath}${exports.length > 0 ? ` # exports: ${exports.join(", ")}` : ""}`,
    metadata: { path: relPath, language: "typescript", exports, symbolCount: exports.length, sizeBytes: 100 },
  };
}

function symbolNode(relPath: string, hash: string, name: string, kind = "function"): GraphNode {
  return {
    id: `symbol:${relPath}:${hash}`,
    type: "Symbol",
    content: `${kind} ${name} (exported) @${relPath}:10`,
    metadata: { name, kind, exported: true, line: 10, file: relPath, signature: `${kind} ${name}()` },
  };
}

function requirementNode(id: string, title: string, claim: string): GraphNode {
  return {
    id,
    type: "Requirement",
    content: claim,
    metadata: { domain: "doc", kind: "requirement", sourcePath: "docs/spec.md", title, tags: [] },
  };
}

function edge(from: string, to: string, relation: GraphEdge["relation"]): GraphEdge {
  return { from, to, relation };
}

const A = "src/core/engine.ts";
const B = "src/core/runner.ts";
const C = "src/cli/main.ts";

function sym(path: string, name: string): string {
  return `symbol:${path}:${name}`;
}

describe("buildChallengeList（图 diff 质询清单）", () => {
  it("空 touched / 图无数据 → 空清单", async () => {
    expect(await buildChallengeList(new StubGraph(), { touchedFiles: [] })).toEqual({
      challenges: [],
      total: 0,
      truncated: false,
    });
    expect(await buildChallengeList(new StubGraph([], []), { touchedFiles: [A] })).toEqual({
      challenges: [],
      total: 0,
      truncated: false,
    });
  });

  it("external-caller：外部调用方产出质询，touched 集合内的调用方被排除", async () => {
    const graph = new StubGraph(
      [
        fileNode(A, ["buildPlan"]),
        fileNode(B, ["runAll"]),
        fileNode(C, ["cliMain"]),
        symbolNode(A, "buildPlan", "buildPlan"),
        symbolNode(B, "runAll", "runAll"),
        symbolNode(C, "cliMain", "cliMain"),
      ],
      [
        edge(`file:${A}`, sym(A, "buildPlan"), "defines"),
        edge(`file:${B}`, sym(B, "runAll"), "defines"),
        edge(`file:${C}`, sym(C, "cliMain"), "defines"),
        // touched 内部互相调用（A 与 B 都被触碰）→ 不应产出
        edge(sym(B, "runAll"), sym(A, "buildPlan"), "calls"),
        // 外部文件 C 调用 A 的符号 → 应产出
        edge(sym(C, "cliMain"), sym(A, "buildPlan"), "calls"),
      ]
    );

    const result = await buildChallengeList(graph, { touchedFiles: [A, B] });
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    const challenge = result.challenges[0]!;
    expect(challenge.kind).toBe("external-caller");
    expect(challenge.evidence.symbol).toBe("buildPlan");
    expect(challenge.evidence.touchedFile).toBe(A);
    expect(challenge.evidence.externalFile).toBe(C);
    expect(challenge.evidence.relation).toBe("calls");
    // touched 内部调用方绝不出现
    expect(result.challenges.some((c) => c.evidence.externalFile === B)).toBe(false);
  });

  it("external-caller 也覆盖 references 边（外部 File → touched 符号）", async () => {
    const graph = new StubGraph(
      [
        fileNode(A, ["buildPlan"]),
        fileNode(C),
        symbolNode(A, "buildPlan", "buildPlan"),
      ],
      [
        edge(`file:${A}`, sym(A, "buildPlan"), "defines"),
        edge(`file:${C}`, sym(A, "buildPlan"), "references"),
      ]
    );

    const result = await buildChallengeList(graph, { touchedFiles: [A] });
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]!.kind).toBe("external-caller");
    expect(result.challenges[0]!.evidence.relation).toBe("references");
    expect(result.challenges[0]!.evidence.externalFile).toBe(C);
    expect(result.challenges[0]!.question).toContain("引用");
  });

  it("requirement-link：implements 出边（代码 → Requirement）命中需求标题", async () => {
    const reqId = "requirement:must-support-incremental-index-1a2b3c";
    const graph = new StubGraph(
      [
        fileNode(A, ["buildPlan"]),
        symbolNode(A, "buildPlan", "buildPlan"),
        requirementNode(reqId, "支持增量索引", "系统必须支持增量索引。"),
      ],
      [
        edge(`file:${A}`, sym(A, "buildPlan"), "defines"),
        // implements 方向：代码符号 → Requirement
        edge(sym(A, "buildPlan"), reqId, "implements"),
      ]
    );

    const result = await buildChallengeList(graph, { touchedFiles: [A] });
    expect(result.challenges).toHaveLength(1);
    const challenge = result.challenges[0]!;
    expect(challenge.kind).toBe("requirement-link");
    expect(challenge.evidence.requirement).toBe("支持增量索引");
    expect(challenge.evidence.relation).toBe("implements");
    expect(challenge.evidence.symbol).toBe("buildPlan");
    expect(challenge.question).toContain("支持增量索引");
    expect(challenge.question).toContain("仍然满足");
  });

  it("deleted-symbol：文件不在图中但残留符号仍被外部引用", async () => {
    const gone = "src/core/legacy.ts";
    const graph = new StubGraph(
      [
        // 故意缺少 file:src/core/legacy.ts —— 模拟已删除/重命名
        fileNode(C),
        symbolNode(gone, "legacyFn", "legacyFn"),
        symbolNode(C, "cliMain", "cliMain"),
      ],
      [
        edge(`file:${C}`, sym(C, "cliMain"), "defines"),
        edge(`file:${C}`, sym(gone, "legacyFn"), "references"),
        edge(sym(C, "cliMain"), sym(gone, "legacyFn"), "calls"),
      ]
    );

    const result = await buildChallengeList(graph, { touchedFiles: [gone] });
    // references 与 calls 两条入边均指向同一外部文件，按 (relation) 去重后至少保留一条
    expect(result.challenges.length).toBeGreaterThanOrEqual(1);
    expect(result.challenges.every((c) => c.kind === "deleted-symbol")).toBe(true);
    const first = result.challenges[0]!;
    expect(first.evidence.touchedFile).toBe(gone);
    expect(first.evidence.symbol).toBe("legacyFn");
    expect(first.evidence.externalFile).toBe(C);
    expect(first.question).toContain(gone);
    expect(first.question).toContain("legacyFn");
    expect(first.question).toContain("删除");
  });

  it("图上无残留痕迹的已删文件不产出 deleted-symbol（绝不臆测）", async () => {
    const graph = new StubGraph([fileNode(C)], [edge(`file:${C}`, `file:${C}`, "depends_on")]);
    const result = await buildChallengeList(graph, { touchedFiles: ["src/core/vanished.ts"] });
    expect(result.challenges).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("排序 deleted-symbol > external-caller > requirement-link，截断置 truncated", async () => {
    const gone = "src/core/legacy.ts";
    const reqId = "requirement:req-x-abc123";
    const graph = new StubGraph(
      [
        fileNode(A, ["buildPlan", "validate"]),
        fileNode(C),
        symbolNode(A, "buildPlan", "buildPlan"),
        symbolNode(A, "validate", "validate"),
        symbolNode(C, "cliMain", "cliMain"),
        symbolNode(gone, "legacyFn", "legacyFn"),
        requirementNode(reqId, "计划必须可序列化", "计划必须可序列化。"),
      ],
      [
        edge(`file:${A}`, sym(A, "buildPlan"), "defines"),
        edge(`file:${A}`, sym(A, "validate"), "defines"),
        edge(`file:${C}`, sym(C, "cliMain"), "defines"),
        edge(sym(C, "cliMain"), sym(A, "buildPlan"), "calls"),
        edge(`file:${C}`, sym(A, "validate"), "references"),
        edge(`file:${C}`, sym(gone, "legacyFn"), "references"),
        edge(sym(A, "buildPlan"), reqId, "implements"),
      ]
    );

    // maxChallenges=2：共 4 条（1 deleted + 2 external + 1 requirement），截断
    const truncatedResult = await buildChallengeList(graph, {
      touchedFiles: [A, gone],
      maxChallenges: 2,
    });
    expect(truncatedResult.total).toBe(4);
    expect(truncatedResult.challenges).toHaveLength(2);
    expect(truncatedResult.truncated).toBe(true);
    expect(truncatedResult.challenges[0]!.kind).toBe("deleted-symbol");
    expect(truncatedResult.challenges[1]!.kind).toBe("external-caller");

    // 默认上限 20：不截断且顺序正确
    const full = await buildChallengeList(graph, { touchedFiles: [A, gone] });
    expect(full.truncated).toBe(false);
    expect(full.challenges).toHaveLength(4);
    const kinds = full.challenges.map((c) => c.kind);
    expect(kinds.indexOf("deleted-symbol")).toBeLessThan(kinds.indexOf("external-caller"));
    expect(kinds.indexOf("external-caller")).toBeLessThan(kinds.indexOf("requirement-link"));
  });

  it("fail-open：图查询异步失败返回空清单", async () => {
    const broken: GraphClient = {
      upsertNodes: async () => {},
      upsertEdges: async () => {},
      queryByKeyword: async () => {
        throw new Error("graph backend down");
      },
    };
    const result = await buildChallengeList(broken, { touchedFiles: [A] });
    expect(result).toEqual({ challenges: [], total: 0, truncated: false });
  });

  it("问题文案直接可读：包含符号名与两侧文件名", async () => {
    const graph = new StubGraph(
      [
        fileNode(A, ["buildPlan"]),
        fileNode(C),
        symbolNode(A, "buildPlan", "buildPlan"),
        symbolNode(C, "cliMain", "cliMain"),
      ],
      [
        edge(`file:${A}`, sym(A, "buildPlan"), "defines"),
        edge(sym(C, "cliMain"), sym(A, "buildPlan"), "calls"),
      ]
    );

    const result = await buildChallengeList(graph, { touchedFiles: [A] });
    expect(result.challenges).toHaveLength(1);
    const question = result.challenges[0]!.question;
    expect(question).toContain("buildPlan");
    expect(question).toContain(A);
    expect(question).toContain(C);
    expect(question).toContain("cliMain");
    expect(question).toContain("兼容");
    // touched 路径归一：反斜杠 / ./ 前缀同样命中
    const normalized = await buildChallengeList(graph, { touchedFiles: ["./src\\core/engine.ts"] });
    expect(normalized.challenges).toHaveLength(1);
    expect(normalized.challenges[0]!.evidence.touchedFile).toBe(A);
  });
});
