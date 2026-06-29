import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  createHashEmbeddingProvider,
  warmupEmbeddingProvider,
  cosineSimilarity,
} from "../src/learning/embeddings";
import {
  recordEpisode,
  findSimilarEpisodes,
} from "../src/learning/episodic-memory";
import { seedInitialSkills } from "../src/learning/seed-skills";
import { skillNodeId } from "../src/learning/skill-store";
import {
  recordTriageDecision,
  backfillTriageOutcome,
  parseTriageEvent,
} from "../src/learning/triage-telemetry";
import { triageTaskExplain } from "../src/core/triage";

describe("学习层增强：Embedding 预热", () => {
  it("warmupEmbeddingProvider 不抛异常且 provider 仍可正常 embed", async () => {
    const provider = createHashEmbeddingProvider();
    await warmupEmbeddingProvider(provider); // 不应抛出
    const vec = await provider.embed("warmup text");
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThan(0);
  });

  it("重复调用 warmupEmbeddingProvider 安全（幂等）", async () => {
    const provider = createHashEmbeddingProvider();
    await Promise.all([
      warmupEmbeddingProvider(provider),
      warmupEmbeddingProvider(provider),
    ]);
    const vec = await provider.embed("hello");
    expect(vec.length).toBeGreaterThan(0);
  });
});

describe("学习层增强：Episode 语义检索", () => {
  it("recordEpisode 携带 provider 时将 embedding 附加到节点 metadata", async () => {
    const client = new GraphifyClient();
    const provider = createHashEmbeddingProvider();
    const ep = await recordEpisode(
      client,
      {
        task: "refactor planner module and add tests",
        plan: [],
        outcome: "pass",
        keyDecisions: [],
        lessons: [],
        attempts: 1,
      },
      provider
    );
    const nodes = await client.getNodesByIds([ep.id]);
    const emb = nodes[0]?.metadata?.embedding;
    expect(Array.isArray(emb)).toBe(true);
    expect((emb as number[]).length).toBeGreaterThan(0);
  });

  it("findSimilarEpisodes 携带 provider 时按语义检索命中同任务 episode", async () => {
    const client = new GraphifyClient();
    const provider = createHashEmbeddingProvider();
    await recordEpisode(
      client,
      {
        task: "refactor planner module and add tests",
        plan: [],
        outcome: "pass",
        keyDecisions: ["split into subtasks"],
        lessons: [],
        attempts: 1,
      },
      provider
    );

    const matches = await findSimilarEpisodes(
      client,
      "refactor planner module and add tests",
      5,
      provider
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.task).toContain("refactor planner");
  });

  it("无 provider 时优雅降级为 Jaccard（不报错）", async () => {
    const client = new GraphifyClient();
    await recordEpisode(client, {
      task: "refactor planner module",
      plan: [],
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });
    const matches = await findSimilarEpisodes(client, "refactor planner module", 5);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("RRF 融合：pass episode 排名高于 fail（语义路径）", async () => {
    const client = new GraphifyClient();
    const provider = createHashEmbeddingProvider();
    const fail = await recordEpisode(
      client,
      { task: "refactor planner module", plan: [], outcome: "fail", keyDecisions: [], lessons: [], attempts: 2 },
      provider
    );
    const pass = await recordEpisode(
      client,
      { task: "refactor planner module", plan: [], outcome: "pass", keyDecisions: [], lessons: [], attempts: 1 },
      provider
    );
    const ranked = await findSimilarEpisodes(client, "refactor planner module", 5, provider);
    const passIdx = ranked.findIndex((r) => r.id === pass.id);
    const failIdx = ranked.findIndex((r) => r.id === fail.id);
    expect(passIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(passIdx).toBeLessThan(failIdx);
  });
});

describe("学习层增强：预置种子技能", () => {
  it("seedInitialSkills 写入原子与复合技能，score=2 uses=0", async () => {
    const client = new GraphifyClient();
    const result = await seedInitialSkills(client);
    expect(result.createdAtomic.length).toBeGreaterThanOrEqual(10);
    expect(result.createdComposite.length).toBe(5);

    const snap = client.snapshot();
    const testSkill = snap.nodes.find((n) => n.id === skillNodeId("test"));
    expect(testSkill).toBeDefined();
    const parsed = JSON.parse(testSkill!.content);
    expect(parsed.score).toBe(2);
    expect(parsed.uses).toBe(0);
  });

  it("seedInitialSkills 幂等：重复调用跳过已存在技能", async () => {
    const client = new GraphifyClient();
    const first = await seedInitialSkills(client);
    const second = await seedInitialSkills(client);
    expect(first.createdAtomic.length).toBeGreaterThan(0);
    expect(second.createdAtomic.length).toBe(0);
    expect(second.skipped).toBe(first.createdAtomic.length + first.createdComposite.length);
  });
});

describe("学习层增强：Triage 准确率数据收集", () => {
  it("triageTaskExplain 返回决策与原因", () => {
    const ex = triageTaskExplain("refactor module and add tests across files");
    expect(ex.decision).toBe("complex");
    expect(ex.reason.matchedKeywords.length).toBeGreaterThanOrEqual(2);
    expect(ex.reason.taskLength).toBeGreaterThan(0);
  });

  it("recordTriageDecision 写入节点，backfillTriageOutcome 回填实际结果", async () => {
    const client = new GraphifyClient();
    const ex = triageTaskExplain("fix a typo");
    const triageId = await recordTriageDecision(client, "fix a typo", ex.decision, ex.reason);
    expect(triageId).toBeDefined();
    expect(triageId!.startsWith("triage:")).toBe(true);

    // 回填实际结果
    await backfillTriageOutcome(client, triageId!, {
      actualMode: "simple",
      actualSteps: 1,
      driftReplan: false,
      replanRounds: 0,
      finalStatus: "COMPLETED",
      resolvedAt: Date.now(),
    });

    const nodes = await client.getNodesByIds([triageId!]);
    const event = parseTriageEvent(nodes[0]!);
    expect(event).toBeDefined();
    expect(event!.status).toBe("resolved");
    expect(event!.outcome).toBeDefined();
    expect(event!.outcome!.finalStatus).toBe("COMPLETED");
    expect(event!.outcome!.actualSteps).toBe(1);
  });

  it("cosineSimilarity 基线保持正确", () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, [0, 1, 0])).toBeCloseTo(0, 6);
  });
});
