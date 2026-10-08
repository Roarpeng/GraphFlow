import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPOSITE_WEIGHTS,
  UNCLASSIFIED_DOMAIN,
  aggregateSkillRecallEvents,
  buildCompetenceMap,
  computeCapabilityMetrics,
  computeSkillUseStats,
  describeCapabilityMetrics,
  type CapabilityEpisode,
  type CapabilityMetrics,
  type CapabilityOutcome,
  type SkillUseTelemetry,
} from "../src/learning/capability-metrics";

function ep(
  id: string,
  outcome: CapabilityOutcome,
  createdAt: number,
  attempts = 1,
  domain?: string
): CapabilityEpisode {
  return domain === undefined
    ? { id, outcome, attempts, createdAt }
    : { id, outcome, attempts, createdAt, domain };
}

/** 硬约束：任何指标都不能用 NaN / Infinity 表达"不知道"。 */
function expectAllFinite(metrics: CapabilityMetrics): void {
  for (const [key, value] of Object.entries(metrics)) {
    if (key === "insufficientData") continue;
    expect(Number.isFinite(value as number), `${key} must be finite`).toBe(true);
  }
}

/**
 * 时间序数据集（alpha 5 条 + beta 3 条 = 8 条已定论）：
 * alpha t1 pass, t2 pass, t3 fail, t4 pass, t5 fail
 * beta  t6 fail, t7 pass, t8 fail
 * 手算：passRate 4/8；遗忘 at-risk alpha a2..a5(4) + beta b3(1) = 5，遗忘事件 a3,a5,b3 = 3；
 * 前向迁移 alpha 首条 pass / beta 首条 fail = 1/2；全部 attempts=1 → 返工 0、效率 4/8。
 */
function temporalEpisodes(): CapabilityEpisode[] {
  return [
    ep("a1", "pass", 1, 1, "alpha"),
    ep("a2", "pass", 2, 1, "alpha"),
    ep("a3", "fail", 3, 1, "alpha"),
    ep("a4", "pass", 4, 1, "alpha"),
    ep("a5", "fail", 5, 1, "alpha"),
    ep("b1", "fail", 6, 1, "beta"),
    ep("b2", "pass", 7, 1, "beta"),
    ep("b3", "fail", 8, 1, "beta"),
  ];
}

describe("capability metrics (M1)", () => {
  it("空输入：insufficientData=true，不抛异常，不产生 NaN", () => {
    const metrics = computeCapabilityMetrics([]);
    expect(metrics.insufficientData).toBe(true);
    expect(metrics.sampleCount).toBe(0);
    expect(metrics.passRate).toBe(0);
    expect(metrics.reworkRate).toBe(0);
    expect(metrics.forgettingRate).toBe(0);
    expect(metrics.forwardTransferRate).toBe(0);
    expect(metrics.toolUseEfficiency).toBe(0);
    expect(metrics.compositeScore).toBe(0);
    expect(metrics.pendingRatio).toBe(0);
    expectAllFinite(metrics);
  });

  it("已定论样本少于 5：能力比率归零，但样本量与 pendingRatio 如实上报", () => {
    const metrics = computeCapabilityMetrics([
      ep("a", "pass", 1),
      ep("b", "pass", 2),
      ep("c", "pass", 3),
      ep("d", "fail", 4),
      ep("e", "pending", 5),
    ]);
    expect(metrics.sampleCount).toBe(5);
    expect(metrics.insufficientData).toBe(true);
    expect(metrics.passRate).toBe(0);
    expect(metrics.toolUseEfficiency).toBe(0);
    // 全 pending 时报 0 才是假数据；记账比率必须保持真实。
    expect(metrics.pendingRatio).toBeCloseTo(0.2, 12);
  });

  it("pass/fail/pending 混合样本：passRate / pendingRatio / reworkRate 手算", () => {
    const metrics = computeCapabilityMetrics([
      ep("p1", "pass", 1, 1),
      ep("p2", "pass", 2, 2),
      ep("p3", "pass", 3, 1),
      ep("p4", "pass", 4, 3),
      ep("f1", "fail", 5, 1),
      ep("f2", "fail", 6, 2),
      ep("h1", "human_review", 7, 9),
      ep("x1", "pending", 8, 9),
    ]);

    expect(metrics.sampleCount).toBe(8);
    expect(metrics.insufficientData).toBe(false);
    // 分母只含已定论：pass 4 / (4 pass + 2 fail)
    expect(metrics.passRate).toBeCloseTo(4 / 6, 12);
    // 未定论 = human_review + pending
    expect(metrics.pendingRatio).toBeCloseTo(2 / 8, 12);
    // 已定论里 attempts>1 的是 p2/p4/f2；两条 attempts=9 的未定论样本不进分母
    expect(metrics.reworkRate).toBeCloseTo(3 / 6, 12);
    expect(metrics.toolUseEfficiency).toBeCloseTo(4 / 10, 12);
    expectAllFinite(metrics);
  });

  it("跨时间序 domain 序列：手算 forgettingRate 与 forwardTransferRate", () => {
    const metrics = computeCapabilityMetrics(temporalEpisodes());
    expect(metrics.sampleCount).toBe(8);
    expect(metrics.insufficientData).toBe(false);
    expect(metrics.passRate).toBeCloseTo(4 / 8, 12);
    expect(metrics.reworkRate).toBe(0);
    // 处于风险中的 5 条里 3 条失败
    expect(metrics.forgettingRate).toBeCloseTo(3 / 5, 12);
    // 两个域首次定论：alpha pass，beta fail
    expect(metrics.forwardTransferRate).toBeCloseTo(1 / 2, 12);
    expect(metrics.toolUseEfficiency).toBeCloseTo(4 / 8, 12);
    // 0.4*0.5 + 0.2*(1-0.6) + 0.2*0.5 + 0.1*0.5 + 0.1*(1-0)
    expect(metrics.compositeScore).toBeCloseTo(0.53, 10);
  });

  it("输入顺序不影响时间序判据，且不就地修改输入数组", () => {
    const ordered = temporalEpisodes();
    const shuffled = [...ordered].reverse();
    const snapshot = shuffled.map((episode) => ({ ...episode }));

    expect(computeCapabilityMetrics(shuffled)).toEqual(computeCapabilityMetrics(ordered));
    computeCapabilityMetrics(shuffled);
    expect(shuffled).toEqual(snapshot);
  });

  it("复合分权重可传入并按权重和归一化；非法权重回落到默认值", () => {
    const episodes = temporalEpisodes();
    const baseline = computeCapabilityMetrics(episodes);
    const onlyPassRate = computeCapabilityMetrics(episodes, {
      weights: {
        passRate: 1,
        retention: 0,
        forwardTransferRate: 0,
        toolUseEfficiency: 0,
        rework: 0,
      },
    });
    expect(onlyPassRate.compositeScore).toBeCloseTo(onlyPassRate.passRate, 12);

    const totalWeight = Object.values(DEFAULT_COMPOSITE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(totalWeight).toBeCloseTo(1, 12);

    const negativeWeight = computeCapabilityMetrics(episodes, { weights: { passRate: -1 } });
    expect(negativeWeight.compositeScore).toBeCloseTo(baseline.compositeScore, 12);
  });

  it("minResolvedSamples 可覆盖（默认 5）", () => {
    const episodes = [ep("a", "pass", 1), ep("b", "pass", 2), ep("c", "fail", 3)];
    expect(computeCapabilityMetrics(episodes).insufficientData).toBe(true);
    const relaxed = computeCapabilityMetrics(episodes, { minResolvedSamples: 3 });
    expect(relaxed.insufficientData).toBe(false);
    expect(relaxed.passRate).toBeCloseTo(2 / 3, 12);
  });
});

describe("buildCompetenceMap 分级边界 (M5)", () => {
  const episodes: CapabilityEpisode[] = [
    // n=5 且 passRate 恰为 0.6 → verified
    ep("v1", "pass", 1, 1, "verified-boundary"),
    ep("v2", "pass", 2, 1, "verified-boundary"),
    ep("v3", "pass", 3, 1, "verified-boundary"),
    ep("v4", "fail", 4, 1, "verified-boundary"),
    ep("v5", "fail", 5, 1, "verified-boundary"),
    // n=4 且全 pass：passRate=1 仍然只能 provisional（样本不足）
    ep("q1", "pass", 6, 1, "four-only"),
    ep("q2", "pass", 7, 1, "four-only"),
    ep("q3", "pass", 8, 1, "four-only"),
    ep("q4", "pass", 9, 1, "four-only"),
    // n=5 但 passRate 0.4 < 0.6 → provisional
    ep("r1", "pass", 10, 1, "low-rate"),
    ep("r2", "pass", 11, 1, "low-rate"),
    ep("r3", "fail", 12, 1, "low-rate"),
    ep("r4", "fail", 13, 1, "low-rate"),
    ep("r5", "fail", 14, 1, "low-rate"),
    // 只有未定论 → unknown
    ep("u1", "pending", 15, 1, "pending-only"),
    ep("u2", "human_review", 16, 1, "pending-only"),
    // 全 fail → provisional，且从未 pass 过
    ep("z1", "fail", 17, 1, "all-fail"),
  ];

  it("n 与 passRate 的边界：n=5&0.6 verified，n=4 provisional，n=0 unknown", () => {
    const map = buildCompetenceMap(episodes);
    const byDomain = new Map(map.map((entry) => [entry.domain, entry]));

    const verified = byDomain.get("verified-boundary");
    expect(verified?.n).toBe(5);
    expect(verified?.pass).toBe(3);
    expect(verified?.fail).toBe(2);
    expect(verified?.passRate).toBeCloseTo(0.6, 12);
    expect(verified?.lastVerifiedAt).toBe(3);
    expect(verified?.status).toBe("verified");

    const fourOnly = byDomain.get("four-only");
    expect(fourOnly?.n).toBe(4);
    expect(fourOnly?.passRate).toBe(1);
    expect(fourOnly?.status).toBe("provisional");

    const lowRate = byDomain.get("low-rate");
    expect(lowRate?.n).toBe(5);
    expect(lowRate?.passRate).toBeCloseTo(0.4, 12);
    expect(lowRate?.status).toBe("provisional");

    const pendingOnly = byDomain.get("pending-only");
    expect(pendingOnly?.n).toBe(0);
    expect(pendingOnly?.pending).toBe(2);
    expect(pendingOnly?.passRate).toBe(0);
    expect(pendingOnly?.lastVerifiedAt).toBeNull();
    expect(pendingOnly?.status).toBe("unknown");

    const allFail = byDomain.get("all-fail");
    expect(allFail?.n).toBe(1);
    expect(allFail?.status).toBe("provisional");
    expect(allFail?.lastVerifiedAt).toBeNull();
  });

  it("域按名称确定序排序，未定论样本不参与分级", () => {
    const map = buildCompetenceMap(episodes);
    const domains = map.map((entry) => entry.domain);
    expect(domains).toEqual([...domains].sort());
    const totalResolved = map.reduce((sum, entry) => sum + entry.n, 0);
    const totalPending = map.reduce((sum, entry) => sum + entry.pending, 0);
    expect(totalResolved + totalPending).toBe(episodes.length);
    expect(totalPending).toBe(2);
  });

  it("domain 切分键与阈值可配置", () => {
    const byPrefix = buildCompetenceMap(episodes, {
      domainOf: (episode) => (episode.domain ?? UNCLASSIFIED_DOMAIN).split(":")[0] ?? UNCLASSIFIED_DOMAIN,
    });
    expect(byPrefix.length).toBeGreaterThan(0);

    // four-only (n=4, passRate=1) 放宽样本阈值后为 verified
    const relaxedSamples = buildCompetenceMap(episodes, { minSamples: 4 });
    expect(relaxedSamples.find((entry) => entry.domain === "four-only")?.status).toBe("verified");

    // low-rate (n=5, passRate=0.4) 放宽成功率阈值后为 verified
    const relaxedRate = buildCompetenceMap(episodes, { minPassRate: 0.4 });
    expect(relaxedRate.find((entry) => entry.domain === "low-rate")?.status).toBe("verified");

    // 自定义切分键：把低成功率域与 verified 域归到同一池
    const merged = buildCompetenceMap(
      [ep("m1", "pass", 1, 1, "a"), ep("m2", "fail", 2, 1, "b")],
      { domainOf: () => "merged" }
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.domain).toBe("merged");
    expect(merged[0]?.n).toBe(2);
  });

  it("domain 缺失归入未分类桶，且不会被误判为 verified", () => {
    const map = buildCompetenceMap([ep("n1", "pass", 1), ep("n2", "fail", 2)]);
    expect(map).toHaveLength(1);
    expect(map[0]?.domain).toBe(UNCLASSIFIED_DOMAIN);
    expect(map[0]?.n).toBe(2);
    expect(map[0]?.status).toBe("provisional");
  });
});

describe("computeSkillUseStats (M3)", () => {
  it("没有召回与使用遥测时 insufficientData=true，且不产生 NaN", () => {
    const inputs: Array<SkillUseTelemetry | undefined | null> = [
      undefined,
      null,
      {},
      { recalled: 10 },
      { recalled: 10, used: 3 },
      { recalled: 10, used: 3, shadowed: 4 },
    ];
    for (const input of inputs) {
      const stats = computeSkillUseStats(input);
      expect(stats.insufficientData).toBe(true);
      expect(stats.effectiveUsePrecision).toBe(0);
      expect(stats.shadowingRate).toBe(0);
      expect(Number.isFinite(stats.recalled)).toBe(true);
      expect(Number.isFinite(stats.used)).toBe(true);
    }
  });

  it("召回 / 使用 / 帮助判定齐全时才给出比率", () => {
    const stats = computeSkillUseStats({ recalled: 10, used: 4, helpful: 3, shadowed: 5 });
    expect(stats.insufficientData).toBe(false);
    expect(stats.effectiveUsePrecision).toBeCloseTo(0.75, 12);
    expect(stats.shadowingRate).toBeCloseTo(0.5, 12);
    expect(stats.shadowingBySkill).toEqual({});
  });

  it("被调用次数为 0（全被遮蔽）：精度没有分母 → 仍为 insufficientData", () => {
    const stats = computeSkillUseStats({ recalled: 10, used: 0, helpful: 0, shadowed: 10 });
    expect(stats.insufficientData).toBe(true);
    expect(stats.recalled).toBe(10);
    expect(stats.effectiveUsePrecision).toBe(0);
    // 不把"未测量"写成率
    expect(stats.shadowingRate).toBe(0);
  });

  it("上游计数不一致时夹到 [0,1]，不产出 >100% 的好数字", () => {
    const stats = computeSkillUseStats({ recalled: 4, used: 3, helpful: 9, shadowed: 20 });
    expect(stats.insufficientData).toBe(false);
    expect(stats.effectiveUsePrecision).toBe(1);
    expect(stats.shadowingRate).toBe(1);
  });

  it("aggregateSkillRecallEvents 能聚出召回 / 使用 / 遮蔽与按技能代理归因", () => {
    const telemetry = aggregateSkillRecallEvents([
      { recalledIds: ["skill-a", "skill-b"], usedId: "skill-a", helped: true },
      { recalledIds: ["skill-a"], helped: true },
      { recalledIds: ["skill-b", "skill-c"], usedId: "skill-c", helped: false },
      { recalledIds: [] },
      { recalledIds: ["skill-a"], usedId: "skill-z" },
    ]);

    expect(telemetry.recalled).toBe(4);
    expect(telemetry.used).toBe(2);
    expect(telemetry.helpful).toBe(1);
    expect(telemetry.shadowed).toBe(2);
    expect(telemetry.shadowingBySkill).toEqual({ "skill-a": 2 });

    const stats = computeSkillUseStats(telemetry);
    expect(stats.insufficientData).toBe(false);
    expect(stats.effectiveUsePrecision).toBeCloseTo(0.5, 12);
    expect(stats.shadowingRate).toBeCloseTo(0.5, 12);
  });

  it("一次外部帮助判定都没有时保持未测量状态（缺口可见，不假装是 0）", () => {
    const telemetry = aggregateSkillRecallEvents([
      { recalledIds: ["skill-a"], usedId: "skill-a" },
      { recalledIds: ["skill-b"], usedId: "skill-b" },
    ]);
    expect(telemetry.used).toBe(2);
    expect(telemetry.helpful).toBeUndefined();
    expect(computeSkillUseStats(telemetry).insufficientData).toBe(true);
  });
});

describe("边界输入 (attempts=0 / 重复 id / 缺失 id / 缺失 domain)", () => {
  it("attempts 为 0：不产生 NaN，返工率为 0，效率按 max(1, attempts) 归一", () => {
    const episodes = [1, 2, 3, 4, 5].map((index) =>
      ep(`p${index}`, "pass", index, 0, "zero-attempts")
    );
    const metrics = computeCapabilityMetrics(episodes);
    expect(metrics.insufficientData).toBe(false);
    expect(metrics.reworkRate).toBe(0);
    expect(metrics.toolUseEfficiency).toBe(1);
    expectAllFinite(metrics);
  });

  it("attempts 为非法值（负数/NaN）时按未记录处理", () => {
    const episodes: CapabilityEpisode[] = [
      { id: "n1", outcome: "pass", attempts: -3, createdAt: 1, domain: "bad-attempts" },
      { id: "n2", outcome: "pass", attempts: Number.NaN, createdAt: 2, domain: "bad-attempts" },
      ep("n3", "pass", 3, 1, "bad-attempts"),
      ep("n4", "pass", 4, 1, "bad-attempts"),
      ep("n5", "fail", 5, 1, "bad-attempts"),
    ];
    const metrics = computeCapabilityMetrics(episodes);
    expect(metrics.insufficientData).toBe(false);
    expect(metrics.reworkRate).toBe(0);
    expect(metrics.toolUseEfficiency).toBeCloseTo(4 / 5, 12);
    expectAllFinite(metrics);
  });

  it("episode id 重复：按 revision 取最新一条，且只计一次", () => {
    const episodes: CapabilityEpisode[] = [
      { id: "dup", outcome: "fail", attempts: 1, createdAt: 1, updatedAt: 1, domain: "old" },
      { id: "dup", outcome: "pass", attempts: 1, createdAt: 1, updatedAt: 9, domain: "new" },
      ep("k1", "pass", 2, 1, "other"),
      ep("k2", "pass", 3, 1, "other"),
      ep("k3", "pass", 4, 1, "other"),
      ep("k4", "pass", 5, 1, "other"),
      ep("k5", "pass", 6, 1, "other"),
    ];
    expect(computeCapabilityMetrics(episodes).sampleCount).toBe(6);
    const domains = buildCompetenceMap(episodes).map((entry) => entry.domain);
    expect(domains).toContain("new");
    expect(domains).not.toContain("old");
  });

  it("缺少 id 的记录被丢弃，不替它编造 id", () => {
    const withoutId = {
      outcome: "pass",
      attempts: 1,
      createdAt: 1,
    } as unknown as CapabilityEpisode;
    const metrics = computeCapabilityMetrics([withoutId, ep("ok", "pass", 1)]);
    expect(metrics.sampleCount).toBe(1);
  });

  it("无法识别的 outcome 归入未定论，绝不抬高 passRate", () => {
    const bogus = {
      id: "bogus",
      outcome: "succeeded-ish",
      attempts: 1,
      createdAt: 1,
    } as unknown as CapabilityEpisode;
    const metrics = computeCapabilityMetrics([bogus, ...temporalEpisodes()]);
    expect(metrics.sampleCount).toBe(9);
    expect(metrics.pendingRatio).toBeCloseTo(1 / 9, 12);
    expect(metrics.passRate).toBeCloseTo(4 / 8, 12);
  });
});

describe("describeCapabilityMetrics (M11 反基准最小实现)", () => {
  it("每个条目都有完整的 key/label/definition/evidence/caveat，且 key 唯一", () => {
    const descriptors = describeCapabilityMetrics();
    expect(descriptors.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const descriptor of descriptors) {
      expect(descriptor.key.trim().length).toBeGreaterThan(0);
      expect(descriptor.label.trim().length).toBeGreaterThan(0);
      expect(descriptor.definition.trim().length).toBeGreaterThan(0);
      expect(descriptor.evidence.trim().length).toBeGreaterThan(0);
      expect(descriptor.caveat.trim().length).toBeGreaterThan(0);
      keys.add(descriptor.key);
    }
    expect(keys.size).toBe(descriptors.length);
  });

  it("覆盖 CapabilityMetrics 全部字段，并把 arXiv 依据写进代码", () => {
    const descriptors = describeCapabilityMetrics();
    const keys = new Set(descriptors.map((descriptor) => descriptor.key));
    for (const field of [
      "sampleCount",
      "passRate",
      "reworkRate",
      "forgettingRate",
      "forwardTransferRate",
      "toolUseEfficiency",
      "compositeScore",
      "pendingRatio",
      "insufficientData",
    ]) {
      expect(keys.has(field), `missing descriptor for ${field}`).toBe(true);
    }

    const evidence = descriptors.map((descriptor) => descriptor.evidence).join(" ");
    expect(evidence).toContain("arXiv:2507.00014"); // SWE-Bench-CL 维度来源
    expect(evidence).toContain("arXiv:2607.12161"); // 节省率不该作核心指标
    expect(evidence).toContain("arXiv:2605.24050"); // shadowing / 选择精度
  });

  it("每次调用返回全新对象，调用方改写不会污染后续调用", () => {
    const first = describeCapabilityMetrics();
    const firstLength = first.length;
    first[0]!.definition = "tampered";
    first.push({ key: "x", label: "x", definition: "x", evidence: "x", caveat: "x" });

    const second = describeCapabilityMetrics();
    expect(second[0]?.definition).not.toBe("tampered");
    expect(second.length).toBe(firstLength);
  });
});
