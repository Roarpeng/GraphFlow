import { afterEach, describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { recordEpisode } from "../src/learning/episodic-memory";
import {
  buildProvenance,
  evaluateWriteSalience,
  isRetracted,
  readRetraction,
  readWriteGate,
  resolveWriteGateMode,
  retractMemory,
  summarizeGateStats,
  WRITE_GATE_ENV,
  type GateDecision,
  type MemoryProvenance,
  type WriteCandidate,
  type WriteSource,
} from "../src/learning/memory-gate";
import { parseSkillState } from "../src/learning/skill-store";
import { distillWorkflowFromEpisode } from "../src/learning/workflow-skill";

const BASE_CONTENT = "refactor planner module to split the oversized planning function";
const BASE_TASK = "refactor planner module";

const originalGateEnv = process.env[WRITE_GATE_ENV];

afterEach(() => {
  // 环境变量是全局状态：逐个用例后恢复，避免污染同文件其它用例。
  if (originalGateEnv === undefined) {
    delete process.env[WRITE_GATE_ENV];
  } else {
    process.env[WRITE_GATE_ENV] = originalGateEnv;
  }
});

function makeCandidate(overrides: Partial<WriteCandidate> = {}): WriteCandidate {
  return {
    kind: "episode",
    content: BASE_CONTENT,
    task: BASE_TASK,
    source: { kind: "agent-reported", ref: "test:1" },
    ...overrides,
  };
}

const DUPLICATE_EPISODE = {
  task: "cache invalidation strategy for the graph store",
  plan: [{ id: "t1", description: "adopt version stamped cache entries" }],
  outcome: "pass" as const,
  keyDecisions: ["adopt version stamped cache entries"],
  lessons: ["keep the file store fallback"],
  attempts: 1,
};

function episodeNodes(client: GraphifyClient) {
  return client.snapshot().nodes.filter((node) => node.id.startsWith("episode:"));
}

describe("M2 写入门控 — 单个信号", () => {
  it("高重复内容被去重 reject", () => {
    const decision = evaluateWriteSalience(makeCandidate(), {
      existing: [
        {
          id: "episode:dup",
          kind: "episode",
          content: BASE_CONTENT,
          task: BASE_TASK,
        },
      ],
    });

    expect(decision.decision).toBe("reject");
    expect(decision.reasons.some((reason) => reason.startsWith("duplicate-of"))).toBe(true);
    expect(decision.reasons).toContain("duplicate-of:episode:dup");
  });

  it("同一 task 的互斥结论进入 review，绝不静默覆盖", () => {
    const decision = evaluateWriteSalience(
      makeCandidate({
        content: "refactor planner module: revert the split approach",
        task: BASE_TASK,
      }),
      {
        existing: [
          {
            id: "episode:old",
            kind: "episode",
            content: "refactor planner module: adopt the split approach",
            task: BASE_TASK,
          },
        ],
      }
    );

    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("conflict-with");
    expect(decision.conflictWith).toEqual(["episode:old"]);
  });

  it("durable 为 false 的临时决策降级为 review 而不是 admit", () => {
    const decision = evaluateWriteSalience(
      makeCandidate({
        content: "use an in-memory cache for this one-off migration script",
        durable: false,
        source: { kind: "human-confirmed", ref: "review:42" },
      }),
      { existing: [] }
    );

    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("temporary-not-durable");
  });

  it("人工确认来源倾向 admit，且分数高于 agent 自报", () => {
    const human = evaluateWriteSalience(
      makeCandidate({ source: { kind: "human-confirmed", ref: "review:42" } }),
      { existing: [] }
    );
    const agent = evaluateWriteSalience(makeCandidate(), { existing: [] });

    expect(human.decision).toBe("admit");
    expect(human.score).toBeGreaterThanOrEqual(0.9);
    expect(agent.decision).toBe("admit");
    expect(agent.score).toBeLessThan(human.score);
  });

  it("空内容与过短内容被当作噪声 reject", () => {
    expect(evaluateWriteSalience(makeCandidate({ content: "" }), { existing: [] }).decision).toBe(
      "reject"
    );
    const short = evaluateWriteSalience(makeCandidate({ content: "fix bug" }), { existing: [] });
    expect(short.decision).toBe("reject");
    expect(short.reasons).toContain("content-too-short");
  });

  it("缺 source 不抛异常，且降级为 review（不编造可信度）", () => {
    const candidate = makeCandidate({ source: undefined as unknown as WriteSource });
    expect(() => evaluateWriteSalience(candidate, { existing: [] })).not.toThrow();
    const decision = evaluateWriteSalience(candidate, { existing: [] });
    expect(decision.decision).toBe("review");
    expect(decision.reasons).toContain("unattributed-source");
  });

  it("阈值可传入：放宽去重阈值后相似内容不再被 reject", () => {
    const context = {
      existing: [
        {
          id: "episode:near",
          kind: "episode",
          content: "refactor planner module to split the oversized planning helper",
          task: BASE_TASK,
        },
      ],
    };
    const strict = evaluateWriteSalience(makeCandidate(), context, { duplicateOverlap: 0.5 });
    const loose = evaluateWriteSalience(makeCandidate(), context, { duplicateOverlap: 0.99 });

    expect(strict.decision).toBe("reject");
    expect(loose.decision).not.toBe("reject");
  });

  it("不抛异常：空 content、缺 source、existing 为空 / 缺失", () => {
    const noSource = makeCandidate({ content: "", source: undefined as unknown as WriteSource });
    expect(() => evaluateWriteSalience(noSource, { existing: [] })).not.toThrow();
    expect(() =>
      evaluateWriteSalience(makeCandidate(), { existing: [] as never[] })
    ).not.toThrow();
    expect(() =>
      evaluateWriteSalience(makeCandidate(), { existing: undefined as never })
    ).not.toThrow();
  });
});

describe("M2 来源链（provenance）", () => {
  it("buildProvenance 确定性地产出来源 + 门控裁决", () => {
    const candidate = makeCandidate({ id: "episode:abc" });
    const decision = evaluateWriteSalience(candidate, { existing: [] });

    const first = buildProvenance(candidate, decision, 1000).provenance;
    const second = buildProvenance(candidate, decision, 1000).provenance;

    expect(first).toEqual(second);
    expect(first.memoryId).toBe("episode:abc");
    expect(first.episodeId).toBe("episode:abc");
    expect(first.source).toEqual({ kind: "agent-reported", ref: "test:1" });
    expect(first.gate.decision).toBe(decision.decision);
    expect(first.contentHash.length).toBeGreaterThan(0);
    expect(first.recordedAt).toBe(1000);
  });

  it("内容不同则内容指纹不同", () => {
    const decision = evaluateWriteSalience(makeCandidate(), { existing: [] });
    const a = buildProvenance(makeCandidate({ content: BASE_CONTENT }), decision).provenance;
    const b = buildProvenance(
      makeCandidate({ content: `${BASE_CONTENT} plus an extra step` }),
      decision
    ).provenance;
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe("M2 撤回链（软撤回，绝不删除证据）", () => {
  it("retractMemory 后 isRetracted 为真，且节点未被删除", async () => {
    const client = new GraphifyClient();
    const episode = await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [{ id: "t1", description: "split planner module" }],
      outcome: "pass",
      keyDecisions: ["split into 3 subtasks"],
      lessons: [],
      attempts: 1,
    });

    const result = await retractMemory(client, episode.id, "polluted: temporary decision");

    expect(result.found).toBe(true);
    expect(result.retracted).toBe(true);
    expect(result.alreadyRetracted).toBe(false);

    const node = client.snapshot().nodes.find((item) => item.id === episode.id);
    expect(node).toBeDefined();
    expect(isRetracted(node)).toBe(true);
    expect(readRetraction(node)?.reason).toContain("polluted");
    expect(readRetraction(node)?.retractedAt).toBeGreaterThan(0);
    // 与 forgetEpisode 一致：软隐藏标记让召回路径立即不再返回该 episode。
    expect(node?.metadata?.pruned).toBe(true);
  });

  it("撤回 episode 会级联软隐藏派生技能，技能节点仍然存在", async () => {
    const client = new GraphifyClient();
    const episode = await recordEpisode(client, {
      task: "refactor planner.ts and add tests",
      plan: [
        { id: "task-1", description: "split planner.ts" },
        { id: "task-2", description: "cover planner.ts with tests" },
      ],
      outcome: "pass",
      keyDecisions: [],
      lessons: ["keep public api"],
      attempts: 1,
    });
    const skillId = await distillWorkflowFromEpisode(client, episode);

    const result = await retractMemory(client, episode.id, "bad source episode");

    expect(result.skillsHidden).toBe(1);
    const skillNode = client.snapshot().nodes.find((item) => item.id === skillId);
    expect(skillNode).toBeDefined();
    expect(parseSkillState(skillNode!.content)?.hidden).toBe(true);
  });

  it("重复撤回是幂等的：保留第一次的 reason 与时间", async () => {
    const client = new GraphifyClient();
    const episode = await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });

    const first = await retractMemory(client, episode.id, "first reason", 111);
    const second = await retractMemory(client, episode.id, "second reason", 222);
    const node = client.snapshot().nodes.find((item) => item.id === episode.id);

    expect(first.alreadyRetracted).toBe(false);
    expect(second.alreadyRetracted).toBe(true);
    expect(readRetraction(node)?.reason).toBe("first reason");
    expect(readRetraction(node)?.retractedAt).toBe(111);
  });

  it("撤回不存在的 id 是 no-op，不抛异常", async () => {
    const client = new GraphifyClient();
    const result = await retractMemory(client, "episode:missing", "nothing here");
    expect(result.found).toBe(false);
    expect(result.retracted).toBe(false);
  });

  it("isRetracted 对未撤回 / undefined 节点为 false", async () => {
    const client = new GraphifyClient();
    const episode = await recordEpisode(client, {
      task: "refactor planner module and add tests",
      plan: [],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });
    const node = client.snapshot().nodes.find((item) => item.id === episode.id);
    expect(isRetracted(node)).toBe(false);
    expect(isRetracted(undefined)).toBe(false);
  });
});

describe("M2 门控可观测（summarizeGateStats）", () => {
  it("按裁决与拒绝原因正确计数", () => {
    const decisions: GateDecision[] = [
      { decision: "admit", score: 0.9, reasons: ["admit", "source:human-confirmed"] },
      { decision: "review", score: 0.4, reasons: ["conflict-with"] },
      {
        decision: "reject",
        score: 0.7,
        reasons: ["source:agent-reported", "duplicate-of:episode:1"],
      },
      { decision: "reject", score: 0, reasons: ["empty-content"] },
    ];

    expect(summarizeGateStats(decisions)).toEqual({
      total: 4,
      admitted: 1,
      reviewed: 1,
      rejected: 2,
      // 描述性信号码（source:）不计入拒绝原因分布。
      rejectReasons: { "duplicate-of": 1, "empty-content": 1 },
    });
  });

  it("无数据时返回全零，而不是编造统计", () => {
    expect(summarizeGateStats([])).toEqual({
      total: 0,
      admitted: 0,
      reviewed: 0,
      rejected: 0,
      rejectReasons: {},
    });
  });
});

describe("M2 写入门控 — 环境变量开关", () => {
  it("resolveWriteGateMode 映射稳定", () => {
    expect(resolveWriteGateMode(undefined)).toBe("advisory");
    expect(resolveWriteGateMode("")).toBe("advisory");
    expect(resolveWriteGateMode("0")).toBe("off");
    expect(resolveWriteGateMode("off")).toBe("off");
    expect(resolveWriteGateMode("false")).toBe("off");
    expect(resolveWriteGateMode("enforce")).toBe("enforce");
    expect(resolveWriteGateMode("strict")).toBe("enforce");
    expect(resolveWriteGateMode("1")).toBe("advisory");
    expect(resolveWriteGateMode("nonsense")).toBe("advisory");
  });

  it("GRAPHFLOW_WRITE_GATE=0 时写入不被拒绝，且不写门控元数据", async () => {
    process.env[WRITE_GATE_ENV] = "0";
    const client = new GraphifyClient();
    const first = await recordEpisode(client, DUPLICATE_EPISODE);
    // 完全相同的第二次写入：门控开启时会被去重 reject。
    await recordEpisode(client, DUPLICATE_EPISODE);

    const nodes = episodeNodes(client);
    expect(nodes.length).toBe(2);
    const firstNode = nodes.find((node) => node.id === first.id);
    expect(readWriteGate(firstNode)).toBeUndefined();
    expect(firstNode?.metadata?.provenance).toBeUndefined();
  });

  it("默认（advisory）开启门控：重复写入被判定为 reject 但仍保留证据", async () => {
    delete process.env[WRITE_GATE_ENV];
    const client = new GraphifyClient();
    const first = await recordEpisode(client, DUPLICATE_EPISODE);
    const second = await recordEpisode(client, DUPLICATE_EPISODE);

    const nodes = episodeNodes(client);
    expect(nodes.length).toBe(2);
    const firstNode = nodes.find((node) => node.id === first.id);
    const secondNode = nodes.find((node) => node.id === second.id);

    expect(readWriteGate(firstNode)?.decision).toBe("admit");
    expect(readWriteGate(secondNode)?.decision).toBe("reject");

    const provenance = firstNode?.metadata?.provenance as MemoryProvenance | undefined;
    expect(provenance?.episodeId).toBe(first.id);
    expect(provenance?.gate.decision).toBe("admit");
  });

  it("GRAPHFLOW_WRITE_GATE=enforce 时被拒绝的写入不落库", async () => {
    process.env[WRITE_GATE_ENV] = "enforce";
    const client = new GraphifyClient();
    const first = await recordEpisode(client, DUPLICATE_EPISODE);
    const second = await recordEpisode(client, DUPLICATE_EPISODE);

    // 返回契约不变：仍然返回带 id 的 record。
    expect(second.id.startsWith("episode:")).toBe(true);
    const nodes = episodeNodes(client);
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.id).toBe(first.id);
  });

  it("门控不会因异常内容阻断写入（空 task 也不抛异常）", async () => {
    const client = new GraphifyClient();
    await expect(
      recordEpisode(client, {
        task: "",
        plan: [],
        outcome: "pending",
        keyDecisions: [],
        lessons: [],
        attempts: 0,
      })
    ).resolves.toBeDefined();
  });
});
