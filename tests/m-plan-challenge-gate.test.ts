/**
 * m-plan-challenge-gate.test.ts — U3 计划质询门（merge 主通道桥接）
 *
 * 验证链路：mergeAgentInsightsFromGraph 产出最终 plan 后，从 planNodes 的
 * description 提取文件/符号 → buildChallengeList 对照图事实生成质询 →
 * 以 challenges: string[]（每条一行中文问句）附加到 merge 结果。
 * fail-open 语义：质询失败/为空 → 不附加字段，merge 照常返回。
 *
 * 图结构按索引器真实格式构造（同 m90-diff-challenge.test.ts）：
 *   File id = `file:{relPath}`（metadata.path）；Symbol id = `symbol:{relPath}:{hash}`
 *   （metadata.name / metadata.file）；defines: File → Symbol；calls: Symbol → Symbol。
 */
import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { buildChallengeList, extractTouchedFromPlan } from "../src/graph/diff-challenge";
import { mergeAgentInsightsFromGraph } from "../src/core/merge-agent-insight";
import { submitAgentInsight } from "../src/core/submit-agent-insight";
import type { GraphClient } from "../src/graph/client-factory";
import type { GraphEdge, GraphNode } from "../src/core/types";

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

function edge(from: string, to: string, relation: GraphEdge["relation"]): GraphEdge {
  return { from, to, relation };
}

/** simple-plan 桥两件套：intent + decomposition（无 confidence → 默认 1，complete=true） */
async function submitSimplePlan(
  client: GraphClient,
  task: string,
  planDescription: string
): Promise<void> {
  await submitAgentInsight(client, {
    task,
    workItemId: "simple-plan-intent",
    response: JSON.stringify({
      explicitIntent: task,
      coreProblem: task,
      nonGoals: [],
      successDefinition: "plan executed safely",
    }),
  });
  await submitAgentInsight(client, {
    task,
    workItemId: "simple-plan-decomposition",
    response: JSON.stringify([
      { id: "task-1", description: planDescription, dependencies: [] },
    ]),
  });
}

describe("U3 计划质询门（merge 集成）", () => {
  it("计划描述提及文件+符号 → challenges 命中外部调用方（含 b.ts）", async () => {
    const task = "refactor Foo safely";
    const client = new GraphifyClient();
    await client.upsertNodes([
      fileNode("a.ts", ["Foo"]),
      fileNode("b.ts", ["barFn"]),
      symbolNode("a.ts", "foo-hash", "Foo", "class"),
      symbolNode("b.ts", "bar-hash", "barFn"),
    ]);
    await client.upsertEdges([
      edge("file:a.ts", "symbol:a.ts:foo-hash", "defines"),
      edge("file:b.ts", "symbol:b.ts:bar-hash", "defines"),
      edge("symbol:b.ts:bar-hash", "symbol:a.ts:foo-hash", "calls"),
    ]);
    await submitSimplePlan(client, task, "refactor Foo in a.ts");

    const merged = await mergeAgentInsightsFromGraph(client, task);
    expect(merged.complete).toBe(true);
    expect(merged.plan).toHaveLength(1);
    expect(merged.challenges).toBeDefined();
    const questions = merged.challenges!;
    expect(questions.length).toBeGreaterThanOrEqual(1);
    const text = questions.join("\n");
    expect(text).toContain("a.ts"); // 被触及文件
    expect(text).toContain("Foo"); // 被触及符号
    expect(text).toContain("b.ts"); // 外部调用方文件
    // 文本形态：每条挑战一行问句
    for (const question of questions) {
      expect(question.trim().length).toBeGreaterThan(0);
      expect(question).not.toContain("\n");
    }
  });

  it("符号-only 计划：图精确解析符号所属文件后仍产出质询", async () => {
    const task = "rename Foo class";
    const client = new GraphifyClient();
    await client.upsertNodes([
      fileNode("a.ts", ["Foo"]),
      fileNode("b.ts", ["barFn"]),
      symbolNode("a.ts", "foo-hash", "Foo", "class"),
      symbolNode("b.ts", "bar-hash", "barFn"),
    ]);
    await client.upsertEdges([
      edge("file:a.ts", "symbol:a.ts:foo-hash", "defines"),
      edge("file:b.ts", "symbol:b.ts:bar-hash", "defines"),
      edge("symbol:b.ts:bar-hash", "symbol:a.ts:foo-hash", "calls"),
    ]);
    // 描述只有符号、没有文件路径
    await submitSimplePlan(client, task, "重命名 Foo 类，保持行为不变");

    const merged = await mergeAgentInsightsFromGraph(client, task);
    expect(merged.complete).toBe(true);
    expect(merged.challenges).toBeDefined();
    const text = merged.challenges!.join("\n");
    expect(text).toContain("Foo");
    expect(text).toContain("b.ts");
  });

  it("计划不含任何符号/文件 → challenges 为空（字段不附加）", async () => {
    const task = "write a summary";
    const client = new GraphifyClient();
    await submitSimplePlan(client, task, "梳理现有思路，写一段中文总结，不改任何代码");

    const merged = await mergeAgentInsightsFromGraph(client, task);
    expect(merged.complete).toBe(true);
    expect(merged.plan).toHaveLength(1);
    expect(merged.challenges).toBeUndefined();
  });

  it("fail-open：readSnapshot 抛错 → merge 正常返回、无 challenges", async () => {
    const task = "refactor Foo in a.ts";
    const records: GraphNode[] = [
      {
        id: "decision:intent",
        type: "Decision",
        content: "",
        metadata: {
          kind: "agent-insight",
          task,
          workItemId: "simple-plan-intent",
          response: JSON.stringify({ coreProblem: task }),
        },
      },
      {
        id: "decision:plan",
        type: "Decision",
        content: "",
        metadata: {
          kind: "agent-insight",
          task,
          workItemId: "simple-plan-decomposition",
          response: JSON.stringify([
            { id: "task-1", description: "refactor Foo in a.ts", dependencies: [] },
          ]),
        },
      },
    ];
    const client: GraphClient = {
      upsertNodes: async () => {},
      upsertEdges: async () => {},
      readSnapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
        throw new Error("snapshot backend down");
      },
      queryByKeyword: async () => records,
    };

    const merged = await mergeAgentInsightsFromGraph(client, task);
    expect(merged.complete).toBe(true);
    expect(merged.plan).toHaveLength(1);
    expect(merged.challenges).toBeUndefined();
  });

  it("maxChallenges=10 截断生效（merge 通道）", async () => {
    const task = "refactor all helpers";
    const client = new GraphifyClient();
    const nodes: GraphNode[] = [fileNode("a.ts")];
    const edges: GraphEdge[] = [];
    for (let i = 1; i <= 12; i++) {
      const tag = String(i).padStart(2, "0");
      const ext = `ext${tag}.ts`;
      const helper = `helper${tag}`;
      const caller = `caller${tag}`;
      nodes.push(fileNode(ext, [caller]), symbolNode("a.ts", helper, helper), symbolNode(ext, caller, caller));
      edges.push(
        edge("file:a.ts", `symbol:a.ts:${helper}`, "defines"),
        edge(`file:${ext}`, `symbol:${ext}:${caller}`, "defines"),
        edge(`symbol:${ext}:${caller}`, `symbol:a.ts:${helper}`, "calls")
      );
    }
    await client.upsertNodes(nodes);
    await client.upsertEdges(edges);
    await submitSimplePlan(client, task, "refactor all helpers in a.ts");

    const merged = await mergeAgentInsightsFromGraph(client, task);
    // 12 条 external-caller 质询被 merge 门截为 10 条
    expect(merged.challenges).toHaveLength(10);
    for (const question of merged.challenges!) {
      expect(question).toContain("ext");
      expect(question).not.toContain("\n");
    }
  });
});

describe("extractTouchedFromPlan（纯函数单元）", () => {
  it("camelCase / snake_case / 路径 / PascalCase / 中文混合描述", () => {
    const result = extractTouchedFromPlan([
      { id: "t1", description: "refactor Foo in a.ts" },
      { id: "t2", description: "update parse_user_data inside src/core/legacy.ts" },
      {
        id: "t3",
        description: "在 src/graph/diff-challenge.ts 中调整 buildDiffChallenges，并补充 foo_bar 用例",
      },
      { id: "t4", description: "重命名 GraphFlowClient 后回测，不改其它文件" },
      { id: "t5", description: "按 step_by_step 推进，先跑 npm run build" },
    ]);
    expect(result.files).toEqual(["a.ts", "src/core/legacy.ts", "src/graph/diff-challenge.ts"]);
    for (const symbol of [
      "Foo",
      "parse_user_data",
      "buildDiffChallenges",
      "GraphFlowClient",
      "foo_bar",
      "step_by_step",
    ]) {
      expect(result.symbols).toContain(symbol);
    }
  });

  it("反斜杠路径归一 + 文件/符号去重 + 符号片段不与文件双计", () => {
    const win = extractTouchedFromPlan([
      { id: "w1", description: "修改 src\\core\\engine.ts 的导出" },
    ]);
    expect(win.files).toEqual(["src/core/engine.ts"]);

    const dupe = extractTouchedFromPlan([
      { id: "d1", description: "edit a.ts and update a.ts again" },
      { id: "d2", description: "move my_file.ts and my_file" },
    ]);
    expect(dupe.files).toEqual(["a.ts", "my_file.ts"]);
    // "my_file" 是 "my_file.ts" 的路径片段 → 不作为独立符号双计
    expect(dupe.symbols).not.toContain("my_file");
  });

  it("空计划 / 空描述 → 空结果", () => {
    expect(extractTouchedFromPlan([])).toEqual({ files: [], symbols: [] });
    expect(extractTouchedFromPlan([{ id: "x", description: "" }])).toEqual({
      files: [],
      symbols: [],
    });
  });
});

describe("buildChallengeList planNodes 直连路径", () => {
  it("planNodes 与 touchedFiles 合并去重（同文件不重复产出）", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      fileNode("a.ts", ["Foo"]),
      fileNode("b.ts", ["barFn"]),
      symbolNode("a.ts", "foo-hash", "Foo", "class"),
      symbolNode("b.ts", "bar-hash", "barFn"),
    ]);
    await client.upsertEdges([
      edge("file:a.ts", "symbol:a.ts:foo-hash", "defines"),
      edge("file:b.ts", "symbol:b.ts:bar-hash", "defines"),
      edge("symbol:b.ts:bar-hash", "symbol:a.ts:foo-hash", "calls"),
    ]);

    const viaPlan = await buildChallengeList(client, {
      touchedFiles: [],
      planNodes: [{ id: "task-1", description: "refactor Foo in a.ts" }],
    });
    expect(viaPlan.total).toBe(1);
    expect(viaPlan.challenges[0]!.evidence.externalFile).toBe("b.ts");

    const mergedSources = await buildChallengeList(client, {
      touchedFiles: ["a.ts"],
      planNodes: [{ id: "task-1", description: "refactor Foo in a.ts" }],
    });
    // touchedFiles 与 planNodes 指向同一文件 → 去重后仍是 1 条
    expect(mergedSources.total).toBe(1);
  });
});
