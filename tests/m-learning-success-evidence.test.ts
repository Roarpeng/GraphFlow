/**
 * 真实成功证据链（successCount）→ proven 准入测试。
 *
 * 覆盖（学习飞轮"学得会"修复）：
 *  - 出现 2 次但 0 成功 → 不 proven（uses 只是展示字段，不再参与判定）；
 *  - 绑定 2 个 pass episode → proven（successCount 去重累计）；
 *  - 闭集外技能（不在任何静态 golden 列表）凭成功证据可准入；
 *  - 报告形状：新增字段存在且旧字段未变；旧图数据向后兼容 + 迁移路径；
 *  - 阈值可被 GRAPHFLOW_SKILL_PROVEN_MIN_SUCCESS 覆盖；
 *  - workflow 蒸馏按 episode 去重累计 successCount；
 *  - legacy linkedSuccess 路径（旧版一次链接成功）保留兼容。
 */
import { describe, expect, it, afterEach } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  classifySkillOutcome,
  extractSkillAtoms,
  resolveSkillSuccessCount,
} from "../src/learning/skill-flywheel";
import {
  admitSkillToProven,
  DEFAULT_PROVEN_MIN_SUCCESS,
  resolveProvenMinSuccess,
} from "../src/learning/skill-admission";
import {
  parseSkillState,
  serializeAtomic,
  skillNodeId,
} from "../src/learning/skill-store";
import type { SkillState } from "../src/learning/skill-types";
import {
  distillWorkflowFromEpisode,
  workflowSkillId,
} from "../src/learning/workflow-skill";
import type { EpisodeRecord } from "../src/learning/episodic-memory";

const ENV_THRESHOLD = "GRAPHFLOW_SKILL_PROVEN_MIN_SUCCESS";

function listAtomicStates(client: GraphifyClient): SkillState[] {
  return client
    .snapshot()
    .nodes.filter((n) => n.type === "Skill" && !n.id.includes("composite"))
    .map((n) => parseSkillState(n.content)!)
    .filter(Boolean);
}

describe("learning success evidence chain (successCount → proven)", () => {
  afterEach(() => {
    delete process.env[ENV_THRESHOLD];
  });

  it("出现 2 次但 0 成功 → 不 proven（uses 不再参与 proven 判定）", () => {
    expect(
      classifySkillOutcome({ uses: 2, failStreak: 0, linkedSuccess: false, successCount: 0 })
    ).toBe("correctable");
    // 未提供 successCount 同样不 proven（提及次数不够）。
    expect(
      classifySkillOutcome({ uses: 2, failStreak: 0, linkedSuccess: false })
    ).toBe("correctable");
    // 99 次出现 + 1 个成功 episode 仍不 proven（未达阈值 2）。
    expect(
      classifySkillOutcome({ uses: 99, failStreak: 0, linkedSuccess: false, successCount: 1 })
    ).toBe("correctable");
    // 出现次数再高也不能越过成功证据门槛。
    expect(
      classifySkillOutcome({ uses: 999, failStreak: 0, linkedSuccess: false, successCount: 1 })
    ).toBe("correctable");
  });

  it("绑定 2 个 pass episode → proven", () => {
    expect(
      classifySkillOutcome({ uses: 0, failStreak: 0, linkedSuccess: false, successCount: 2 })
    ).toBe("proven");
  });

  it("legacy linkedSuccess（旧版一次链接成功）仍视为成功信号（兼容）", () => {
    expect(
      classifySkillOutcome({ uses: 1, failStreak: 0, linkedSuccess: true })
    ).toBe("proven");
  });

  it("applySkillLearning 端到端：无 episode 绑定的成功不 proven；绑定两个 pass episode 后 proven", async () => {
    const client = new GraphifyClient();
    const task = "refactor planner module in planner.ts and add tests";
    const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };

    // 两次成功但 0 个 pass episode 绑定 → 只累计 uses，不 proven。
    await applySkillLearning(client, task, run);
    await applySkillLearning(client, task, run);
    let atoms = listAtomicStates(client);
    expect(atoms.length).toBeGreaterThan(0);
    for (const state of atoms) {
      expect(state.outcomeKind).toBe("correctable");
      expect(state.successCount ?? 0).toBe(0);
      expect(state.uses).toBe(2);
    }

    // 绑定两个 pass episode（真实 reportOutcome 路径）→ 真实成功证据链。
    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-ev-a" });
    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-ev-b" });
    atoms = listAtomicStates(client);
    const proven = atoms.filter((s) => s.outcomeKind === "proven");
    expect(proven.length).toBeGreaterThan(0);
    for (const state of proven) {
      expect(state.successCount).toBe(2);
      expect(state.successEpisodeIds).toEqual(["ep-ev-a", "ep-ev-b"]);
      expect(state.score).toBeGreaterThan(0);
      expect(state.uses).toBe(4); // uses 仍累计，仅展示
    }
  });

  it("同一 episode 重复学习不重复计数（去重）", async () => {
    const client = new GraphifyClient();
    const task = "refactor planner module in planner.ts and add tests";
    const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };

    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-dedup" });
    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-dedup" });
    const atoms = listAtomicStates(client);
    const proven = atoms.filter((s) => s.outcomeKind === "proven");
    expect(proven).toHaveLength(0); // 同一个 episode 只算 1 个成功证据
    for (const state of atoms) {
      expect(state.successCount).toBe(1);
      expect(state.successEpisodeIds).toEqual(["ep-dedup"]);
    }
  });

  it("闭集外技能凭成功证据可准入（端到端）", async () => {
    const client = new GraphifyClient();
    // totalUnknownWidget 是 camelCase 符号，但不在任何静态 golden 列表 / 数据集中。
    const task = "totalUnknownWidget refactor";
    const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };

    const atoms = extractSkillAtoms(task);
    expect(atoms.length).toBeGreaterThan(0);
    // 无成功证据时，闭集外名字一律拒绝（golden-overlap / 符号证据辅助条件仍生效）。
    for (const atom of atoms) {
      expect(admitSkillToProven(atom).ok).toBe(false);
    }

    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-widget-a" });
    await applySkillLearning(client, task, run, undefined, { episodeId: "ep-widget-b" });
    const states = listAtomicStates(client);
    const unknown = states.find((s) => s.name === "totalunknownwidget");
    expect(unknown).toBeDefined();
    expect(unknown!.outcomeKind).toBe("proven");
    expect(unknown!.successCount).toBe(2);
    expect(admitSkillToProven(unknown!.name, { successCount: unknown!.successCount }).ok).toBe(
      true
    );
    // 未达阈值的成功证据不能免于闭集检查。
    expect(admitSkillToProven(unknown!.name, { successCount: 1 }).ok).toBe(false);
  });

  it("报告形状：新字段存在且旧字段未变（序列化往返 + 旧数据兼容）", () => {
    const legacy: SkillState = {
      id: skillNodeId("goal-anchor.ts"),
      name: "goal-anchor.ts",
      score: 1,
      uses: 5,
      lastOutcome: "pass",
      updatedAt: 123,
      hasSymbolEvidence: true,
      linkedSuccess: true,
      outcomeKind: "proven",
      provenance: { source: "local", episodeId: "ep-old" },
      guidance: "- keep it small",
    };
    const roundTripped = parseSkillState(serializeAtomic(legacy))!;
    // 旧字段语义未变：
    expect(roundTripped.score).toBe(1);
    expect(roundTripped.uses).toBe(5);
    expect(roundTripped.lastOutcome).toBe("pass");
    expect(roundTripped.linkedSuccess).toBe(true);
    expect(roundTripped.outcomeKind).toBe("proven");
    expect(roundTripped.provenance).toEqual({ source: "local", episodeId: "ep-old" });
    expect(roundTripped.guidance).toBe("- keep it small");
    // 旧节点无新字段 → 解析后保持缺省（向后兼容），迁移解析为 1 个成功 episode。
    expect(roundTripped.successCount).toBeUndefined();
    expect(roundTripped.successEpisodeIds).toBeUndefined();
    expect(resolveSkillSuccessCount(roundTripped)).toBe(1);

    // 新字段写读往返：
    const upgraded: SkillState = {
      ...legacy,
      successCount: 2,
      successEpisodeIds: ["ep-old", "ep-new"],
    };
    const parsed = parseSkillState(serializeAtomic(upgraded))!;
    expect(parsed.successCount).toBe(2);
    expect(parsed.successEpisodeIds).toEqual(["ep-old", "ep-new"]);
    // 旧字段仍不变：
    expect(parsed.uses).toBe(5);
    expect(parsed.score).toBe(1);
    expect(parsed.outcomeKind).toBe("proven");
    expect(parsed.provenance).toEqual({ source: "local", episodeId: "ep-old" });
  });

  it("阈值可被 GRAPHFLOW_SKILL_PROVEN_MIN_SUCCESS 覆盖", () => {
    expect(resolveProvenMinSuccess()).toBe(DEFAULT_PROVEN_MIN_SUCCESS);
    process.env[ENV_THRESHOLD] = "3";
    try {
      expect(resolveProvenMinSuccess()).toBe(3);
      expect(
        classifySkillOutcome({ uses: 9, failStreak: 0, linkedSuccess: false, successCount: 2 })
      ).toBe("correctable");
      expect(
        classifySkillOutcome({ uses: 9, failStreak: 0, linkedSuccess: false, successCount: 3 })
      ).toBe("proven");
      expect(admitSkillToProven("totally-unknown-widget.ts", { successCount: 2 }).ok).toBe(false);
      expect(admitSkillToProven("totally-unknown-widget.ts", { successCount: 3 }).ok).toBe(true);
    } finally {
      delete process.env[ENV_THRESHOLD];
    }
    expect(resolveProvenMinSuccess()).toBe(DEFAULT_PROVEN_MIN_SUCCESS);
  });

  it("workflow 技能按 pass episode 去重累计 successCount", async () => {
    const client = new GraphifyClient();
    const plan = [
      { id: "step-a", description: "refactor goal-anchor.ts" },
      { id: "step-b", description: "wire cache-layer.ts" },
    ];
    const makeEpisode = (id: string): EpisodeRecord => ({
      id,
      task: "refactor goal-anchor.ts and wire cache-layer.ts",
      plan,
      outcome: "pass",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
      createdAt: 1,
      updatedAt: 2,
    });

    const skillId = (await distillWorkflowFromEpisode(client, makeEpisode("ep-wf-a")))!;
    expect(skillId).toBe(workflowSkillId(plan));
    let state = parseSkillState(client.snapshot().nodes.find((n) => n.id === skillId)!.content)!;
    expect(state.successCount).toBe(1);
    expect(state.successEpisodeIds).toEqual(["ep-wf-a"]);

    // 同一 episode 重复蒸馏去重；新 episode 累计。
    await distillWorkflowFromEpisode(client, makeEpisode("ep-wf-a"));
    await distillWorkflowFromEpisode(client, makeEpisode("ep-wf-b"));
    state = parseSkillState(client.snapshot().nodes.find((n) => n.id === skillId)!.content)!;
    expect(state.successCount).toBe(2);
    expect(state.successEpisodeIds).toEqual(["ep-wf-a", "ep-wf-b"]);
    // 蒸馏本身不自动晋升 proven（分类仍 correctable，证据留给准入门判定）。
    expect(state.outcomeKind).toBe("correctable");
  });
});
