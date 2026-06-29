import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import type { SkillState, CompositeSkillState } from "./skill-types";
import {
  skillNodeId,
  serializeAtomic,
  serializeComposite,
  composeSkillId,
  readSkillState,
  loadCompositeSkill,
} from "./skill-store";

/**
 * 预置种子技能模块。
 *
 * 在图首次索引或 orchestrator 首次运行时调用 seedInitialSkills，
 * 为技能飞轮提供一组常见的工程动作类别基线，避免冷启动阶段没有任何可匹配技能。
 *
 * 设计原则：
 * - 原子技能 score=2, uses=0：给予基础权重但不过于强势，随真实使用逐步增强/衰减。
 * - 复合技能 score=2, uses=0：作为已知高频共现组合的登记，coOccurCount/successCount 保持 0，
 *   不触发 compositeGateMet，避免被误判为已验证的演化技能。
 * - 幂等：若技能节点已存在则跳过，重复调用安全。
 */

// 预置原子技能：覆盖常见工程动作类别
const SEED_ATOMIC_SKILLS: string[] = [
  "test",
  "refactor",
  "bugfix",
  "feature",
  "docs",
  "config",
  "api",
  "ui",
  "database",
  "performance",
  "security",
  "migration",
];

// 预置复合技能：高频共现的原子技能对（已排序，便于生成稳定的 composite id）
const SEED_COMPOSITE_SKILLS: Array<[string, string]> = [
  ["test", "refactor"],
  ["bugfix", "test"],
  ["feature", "test"],
  ["refactor", "performance"],
  ["api", "database"],
];

// 种子技能初始权重：有基础分但不过于强势
const SEED_INITIAL_SCORE = 2;
const SEED_INITIAL_USES = 0;

export interface SeedResult {
  /** 新创建的原子技能名称列表 */
  createdAtomic: string[];
  /** 新创建的复合技能名称列表（形如 "test+refactor"） */
  createdComposite: string[];
  /** 因已存在而跳过的技能数量 */
  skipped: number;
}

/**
 * 预置种子技能到图中。幂等：若技能节点已存在则跳过。
 *
 * @param client 图客户端
 * @returns 创建/跳过统计
 */
export async function seedInitialSkills(client: GraphClient): Promise<SeedResult> {
  const now = Date.now();
  const nodes: GraphNode[] = [];
  const createdAtomic: string[] = [];
  const createdComposite: string[] = [];
  let skipped = 0;

  // 1. 原子技能
  for (const name of SEED_ATOMIC_SKILLS) {
    const id = skillNodeId(name);
    // 幂等检查：已存在则跳过
    const existing = await readSkillState(client, id);
    if (existing) {
      skipped += 1;
      continue;
    }
    const state: SkillState = {
      id,
      name,
      score: SEED_INITIAL_SCORE,
      uses: SEED_INITIAL_USES,
      // 种子技能默认记为 pass，仅作为初始状态，不影响后续真实学习
      lastOutcome: "pass",
      updatedAt: now,
    };
    nodes.push({ id, type: "Skill", content: serializeAtomic(state) });
    createdAtomic.push(name);
  }

  // 2. 复合技能
  for (const pair of SEED_COMPOSITE_SKILLS) {
    const [n1, n2] = [pair[0], pair[1]].sort() as [string, string];
    const id = composeSkillId(n1, n2);
    // 幂等检查：已存在则跳过
    const existing = await loadCompositeSkill(client, id);
    if (existing) {
      skipped += 1;
      continue;
    }
    const state: CompositeSkillState = {
      id,
      name: `${n1}+${n2}`,
      parents: [skillNodeId(n1), skillNodeId(n2)],
      // 共现/成功/失败计数保持 0：种子复合技能仅作登记，
      // 不满足 compositeGateMet，不会被 suggestSkillHints 误判为已验证复合技能
      coOccurCount: 0,
      successCount: 0,
      failureCount: 0,
      score: SEED_INITIAL_SCORE,
      uses: SEED_INITIAL_USES,
      lastOutcome: "pass",
      updatedAt: now,
    };
    nodes.push({ id, type: "Skill", content: serializeComposite(state) });
    createdComposite.push(state.name);
  }

  if (nodes.length > 0) {
    await client.upsertNodes(nodes);
  }

  return { createdAtomic, createdComposite, skipped };
}

/** 供外部（如测试）使用的种子原子技能清单 */
export const SEED_ATOMIC_SKILL_NAMES = SEED_ATOMIC_SKILLS;

/** 供外部（如测试）使用的种子复合技能对清单 */
export const SEED_COMPOSITE_SKILL_PAIRS = SEED_COMPOSITE_SKILLS;
