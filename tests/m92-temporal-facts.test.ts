import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import type { DialogueTurnRecord } from "../src/learning/dialogue-thread";
import { queryFactsAt } from "../src/graph/temporal-facts";

/**
 * 时点事实查询（temporal-facts）测试。
 *
 * 策略：不 vi.mock 检索模块，而是构造一个内存版 GraphClient——把
 * DialogueTurnRecord 序列化进 Decision 节点的 metadata.record（与生产
 * 存储格式一致），让真实的 searchDialogueTurns + listDialogueTurns 跑
 * 完整链路，再断言 queryFactsAt 的时点分流结果。这样同时覆盖了召回、
 * join 和过滤，比 mock 模块更接近真实行为。
 */

const T_JAN = Date.parse("2026-01-01T00:00:00.000Z");
const T_FEB = Date.parse("2026-02-01T00:00:00.000Z");
const T_MAR = Date.parse("2026-03-01T00:00:00.000Z");
const T_APR = Date.parse("2026-04-01T00:00:00.000Z");
const ISO_MAR = "2026-03-01T00:00:00.000Z";
const ISO_JUN = "2026-06-01T00:00:00.000Z";

/** 生成一条合法的对话轮记录；未显式给出的字段走默认值。 */
function makeTurn(
  overrides: {
    id: string;
    seq: number;
    userQuery?: string;
    assistantReply?: string;
    summary?: string;
    title?: string;
    validAt?: number;
    invalidAt?: number;
    supersedesTurnIds?: string[];
    updatedAt?: number;
  }
): DialogueTurnRecord {
  const base: DialogueTurnRecord = {
    id: overrides.id,
    sessionId: "dialogue-session:fixed",
    seq: overrides.seq,
    userQuery: "现在的报价政策是什么",
    assistantReply: "报价按 3 月新政执行。",
    jumped: false,
    relatedNodeIds: [],
    createdAt: T_JAN,
    updatedAt: T_JAN,
  };
  return {
    ...base,
    ...(overrides.userQuery !== undefined ? { userQuery: overrides.userQuery } : {}),
    ...(overrides.assistantReply !== undefined ? { assistantReply: overrides.assistantReply } : {}),
    ...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.validAt !== undefined ? { validAt: overrides.validAt } : {}),
    ...(overrides.invalidAt !== undefined ? { invalidAt: overrides.invalidAt } : {}),
    ...(overrides.supersedesTurnIds !== undefined ? { supersedesTurnIds: overrides.supersedesTurnIds } : {}),
    ...(overrides.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
  };
}

/** 报价政策的完整版本链：旧版（3 月失效）→ 新版（3 月生效）→ 未来版（4 月生效）。 */
function pricingChain(): DialogueTurnRecord[] {
  return [
    makeTurn({
      id: "dialogue:s1:0001",
      seq: 1,
      summary: "旧版：报价按 2025 标准执行。",
      validAt: T_JAN,
      invalidAt: T_MAR,
      updatedAt: T_JAN,
    }),
    makeTurn({
      id: "dialogue:s1:0002",
      seq: 2,
      summary: "新版：报价按 3 月新政执行。",
      validAt: T_MAR,
      supersedesTurnIds: ["dialogue:s1:0001"],
      updatedAt: T_MAR,
    }),
    makeTurn({
      id: "dialogue:s1:0003",
      seq: 3,
      summary: "未来版：4 月起报价再调整。",
      validAt: T_APR,
      updatedAt: T_APR,
    }),
  ];
}

/** 内存 client：readSnapshot 直接喂序列化好的对话轮节点（生产存储格式）。 */
function makeClient(turns: DialogueTurnRecord[]): GraphClient {
  const nodes: GraphNode[] = turns.map((turn) => ({
    id: turn.id,
    type: "Decision",
    content: `dialogue-turn #${turn.seq} Q: ${turn.userQuery}`,
    metadata: { kind: "dialogue-turn", record: JSON.stringify(turn) },
  }));
  const edges: GraphEdge[] = [];
  return {
    upsertNodes: async () => {},
    upsertEdges: async () => {},
    queryByKeyword: async () => nodes,
    readSnapshot: () => ({ nodes, edges }),
  };
}

/** 存储坏掉的 client：任何读取都抛错，用于验证 fail-open。 */
function makeBrokenClient(): GraphClient {
  return {
    upsertNodes: async () => {},
    upsertEdges: async () => {},
    queryByKeyword: async () => {
      throw new Error("store offline");
    },
    readSnapshot: () => {
      throw new Error("store offline");
    },
  };
}

describe("temporal-facts queryFactsAt", () => {
  it("asOf 边界：validAt==asOf 算有效，invalidAt==asOf 算失效，validAt>asOf 的未来版不进任何桶", async () => {
    const report = await queryFactsAt(makeClient(pricingChain()), {
      query: "报价政策",
      asOf: ISO_MAR,
    });

    expect(report.asOf).toBe(ISO_MAR);
    // 新版恰好在 asOf 生效 → 有效
    expect(report.effective.map((fact) => fact.turnId)).toEqual(["dialogue:s1:0002"]);
    expect(report.effective[0]?.validAt).toBe(ISO_MAR);
    // 旧版恰好在 asOf 失效 → 归入历史结论
    expect(report.supersededAtPoint.map((fact) => fact.turnId)).toEqual(["dialogue:s1:0001"]);
    expect(report.supersededAtPoint[0]?.invalidAt).toBe(ISO_MAR);
    // 未来版在 asOf 时点尚未成真 → 两个桶都不进
    expect(report.effective.some((fact) => fact.turnId === "dialogue:s1:0003")).toBe(false);
    expect(report.supersededAtPoint.some((fact) => fact.turnId === "dialogue:s1:0003")).toBe(false);
    expect(report.unresolved).toBe(false);
  });

  it("superseded 历史结论归入 supersededAtPoint 并携带时间戳与取代链", async () => {
    const report = await queryFactsAt(makeClient(pricingChain()), {
      query: "报价政策",
      asOf: "2027-01-01T00:00:00.000Z",
    });

    expect(report.supersededAtPoint.map((fact) => fact.turnId)).toEqual(["dialogue:s1:0001"]);
    expect(report.supersededAtPoint[0]?.invalidAt).toBe(ISO_MAR);
    expect(report.effective.map((fact) => fact.turnId).sort()).toEqual([
      "dialogue:s1:0002",
      "dialogue:s1:0003",
    ]);
    // 新版记录了它取代了谁，供追溯"当时的旧说法"
    expect(report.effective.find((fact) => fact.turnId === "dialogue:s1:0002")?.supersedesTurnIds).toEqual([
      "dialogue:s1:0001",
    ]);
  });

  it("默认 now：不传 asOf 时用注入的 now 作为时点", async () => {
    const report = await queryFactsAt(makeClient(pricingChain()), {
      query: "报价政策",
      now: ISO_JUN,
    });

    expect(report.asOf).toBe(ISO_JUN);
    // 6 月时点：旧版已被取代，新版与未来版均生效
    expect(report.supersededAtPoint.map((fact) => fact.turnId)).toEqual(["dialogue:s1:0001"]);
    expect(report.effective.map((fact) => fact.turnId).sort()).toEqual([
      "dialogue:s1:0002",
      "dialogue:s1:0003",
    ]);
  });

  it("完全不注入 now/asOf 时回退到当前时间（wall clock）", async () => {
    // validAt = 0（1970）保证无论何时运行都已成为过去
    const ancient = makeTurn({ id: "dialogue:s9:0001", seq: 1, summary: "远古结论。", validAt: 0 });
    const report = await queryFactsAt(makeClient([ancient]), { query: "报价政策" });

    expect(report.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(report.effective.map((fact) => fact.turnId)).toEqual(["dialogue:s9:0001"]);
    expect(report.effective[0]?.validAt).toBe("1970-01-01T00:00:00.000Z");
    expect(report.unresolved).toBe(false);
  });

  it("unresolved：无匹配时 effective 为空且 advisory 建议换 query 或确认时点", async () => {
    const report = await queryFactsAt(makeClient(pricingChain()), {
      query: "zzzqqq毫不相干的关键词",
      asOf: ISO_MAR,
    });

    expect(report.effective).toEqual([]);
    expect(report.supersededAtPoint).toEqual([]);
    expect(report.unresolved).toBe(true);
    expect(report.advisory).toContain("query");
    expect(report.advisory).toContain("时点");
  });

  it("limit 透传到 searchDialogueTurns 的召回上限", async () => {
    const turns = [
      makeTurn({ id: "dialogue:s2:0001", seq: 1, summary: "结论一。", validAt: T_JAN, updatedAt: T_JAN }),
      makeTurn({ id: "dialogue:s2:0002", seq: 2, summary: "结论二。", validAt: T_JAN, updatedAt: T_FEB }),
      makeTurn({ id: "dialogue:s2:0003", seq: 3, summary: "结论三。", validAt: T_JAN, updatedAt: T_MAR }),
    ];
    const report = await queryFactsAt(makeClient(turns), {
      query: "报价政策",
      asOf: ISO_JUN,
      limit: 2,
    });

    // 3 条全部时点有效，但召回被 limit 截到 2
    expect(report.effective).toHaveLength(2);
    expect(report.supersededAtPoint).toHaveLength(0);
    expect(report.unresolved).toBe(false);
  });

  it("fail-open：检索失败时返回空结果 + 失败说明，不抛异常", async () => {
    const report = await queryFactsAt(makeBrokenClient(), {
      query: "报价政策",
      asOf: ISO_MAR,
    });

    expect(report.effective).toEqual([]);
    expect(report.supersededAtPoint).toEqual([]);
    expect(report.unresolved).toBe(true);
    expect(report.advisory).toContain("失败");
    expect(report.asOf).toBe(ISO_MAR);
  });

  it("summary 非空：优先 record.summary，缺失时回退到 assistantReply 截断", async () => {
    const turns = [
      // 没有摘要/标题，只有回复正文 → 回退截断
      makeTurn({
        id: "dialogue:s3:0001",
        seq: 1,
        validAt: T_JAN,
        assistantReply: "报价政策：3 月起按新折扣表执行，旧折扣表作废。",
        summary: "",
        updatedAt: T_JAN,
      }),
      // 有精炼摘要 → 直接用
      makeTurn({ id: "dialogue:s3:0002", seq: 2, summary: "精炼摘要。", validAt: T_JAN, updatedAt: T_FEB }),
    ];
    const report = await queryFactsAt(makeClient(turns), { query: "报价政策", asOf: ISO_JUN });

    for (const fact of [...report.effective, ...report.supersededAtPoint]) {
      expect(typeof fact.summary).toBe("string");
      expect(fact.summary.length).toBeGreaterThan(0);
    }
    expect(report.effective.find((fact) => fact.turnId === "dialogue:s3:0001")?.summary).toContain(
      "新折扣表"
    );
    expect(report.effective.find((fact) => fact.turnId === "dialogue:s3:0002")?.summary).toBe("精炼摘要。");
  });
});
