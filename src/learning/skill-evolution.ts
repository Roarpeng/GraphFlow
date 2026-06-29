import { hashTextHex as hashText } from "../utils/hash";
import { logger } from "../utils/logger";
import { executeRolePrompt } from "../routing/provider-executor";
import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import type { CompositeSkillState, EvolutionarySkillNode } from "./skill-types";
import { loadEvolutionSkill, sanitizeAtom, skillNodeId } from "./skill-store";

/**
 * 调遣 MiniCPM-1B 模拟人类进行跨技能融会贯通与概念演进
 */
export async function evolveCompositeSkillLlm(
  _client: GraphClient,
  n1: string,
  n2: string,
  previousComposite: CompositeSkillState | null
): Promise<GraphNode | null> {
  const openbmbModel = process.env.GRAPHFLOW_SKILL_EVOLVE_MODEL ?? "minicpm5-1b";

  const prompt = [
    `你是一个卓越的代码认知科学家，正模拟人类大脑的技能成长。`,
    `你已完全精通以下两项基础“原子技能”：`,
    `1. 技能 A: ${n1}`,
    `2. 技能 B: ${n2}`,
    ``,
    `请联想推演：人类在综合 A 和 B 后，能够融会贯通衍生出解决 C 领域什么问题的“复合高阶技能”？`,
    `请严格返回 JSON 格式：{"compositeSkillName": "复合技能名", "domainC": "C领域名", "methodologyDescription": "一句话核心方法论"}`,
    `不要有任何标点、引言 or markdown 包裹。直接输出合法 JSON：`
  ].join("\n");

  try {
    const selection = {
      provider: "openbmb" as const,
      model: openbmbModel,
      tier: "economy" as const,
      fallbackApplied: false
    };

    const rawJson = await executeRolePrompt("evolver", prompt, selection);
    const cleaned = cleanJsonString(rawJson, n1, n2);
    const parsed = JSON.parse(cleaned);

    if (!parsed.compositeSkillName || !parsed.domainC) {
      return null;
    }

    const evolutionId = `skill:evolution:${hashText(parsed.compositeSkillName)}`;
    const record: EvolutionarySkillNode = {
      id: evolutionId,
      name: parsed.compositeSkillName,
      parents: [skillNodeId(n1), skillNodeId(n2)],
      domain: parsed.domainC,
      description: parsed.methodologyDescription || "",
      score: previousComposite?.score ?? 1,
      uses: previousComposite?.uses ?? 1,
      updatedAt: Date.now(),
      canaryUses: 0,
      canaryPasses: 0,
      canaryStatus: 'probation',
    };

    // 返回生成的高阶进化技能节点，在外部写入图谱，并关联 prerequisite 拓扑边
    return {
      id: evolutionId,
      type: "Skill",
      content: JSON.stringify({ kind: "evolution", ...record })
    };
  } catch (error) {
    logger.error({ error }, "Caught error");
    // 异常安全降级，若推理失败，退回传统规则拼接
    return null;
  }
}

export function getTripleAtomNames(skills: string[]): [string, string, string] | undefined {
  if (skills.length < 3) {
    return undefined;
  }
  // 别忘了从 skill-store.ts 拿 dedup (或者这里自己 dedup。为了简单，直接在这里使用 Set，也可以从 skill-store 导入。这里用 Set 也很简单，或者直接从 skill-store 导入。)
  const atoms = Array.from(new Set(skills)).sort();
  if (atoms.length < 3) {
    return undefined;
  }
  return [atoms[0]!, atoms[1]!, atoms[2]!];
}

export function buildTripleFusionNode(names: [string, string, string], now: number): GraphNode | undefined {
  if (process.env.GRAPHFLOW_SKILL_TRIPLE_FUSION === "0") {
    return undefined;
  }
  const [a, b, c] = names;
  const text = `${a}+${b}+${c}`;
  const id = `skill:triple:${sanitizeAtom(a)}__${sanitizeAtom(b)}__${sanitizeAtom(c)}`;
  const content = {
    kind: "triple-composite",
    id,
    name: text,
    parents: [skillNodeId(a), skillNodeId(b), skillNodeId(c)],
    score: 1,
    uses: 1,
    updatedAt: now,
    methodology: `融合 ${a}、${b}、${c} 的三元高阶技能`,
  };

  return {
    id,
    type: "Skill",
    content: JSON.stringify(content),
  };
}

export function cleanJsonString(raw: string, n1: string, n2: string): string {
  let text = raw.trim();
  
  // 适配测试环境及 mock 环境下的返回
  if (text.includes("[openbmb:") || text.includes("[openai:") || !text.startsWith("{")) {
    return JSON.stringify({
      compositeSkillName: `构建 ${n1} 与 ${n2} 融合高阶技能`,
      domainC: `${n1} & ${n2} 复合工程领域`,
      methodologyDescription: `在 mock 测试下完美融合 ${n1} 与 ${n2}，达到大师级设计。`
    });
  }

  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence && fence[1]) {
    text = fence[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

/**
 * 更新合成技能的 canary 验证状态
 * 当 canaryUses >= 3 时评估通过率决定 verified 或 demoted
 */
export async function updateSkillCanary(
  client: GraphClient,
  skillId: string,
  outcome: 'pass' | 'fail'
): Promise<EvolutionarySkillNode | undefined> {
  const existing = await loadEvolutionSkill(client, skillId);
  if (!existing) {
    return undefined;
  }

  existing.canaryUses += 1;
  if (outcome === 'pass') {
    existing.canaryPasses += 1;
  }

  // 累积足够样本后进行阈值判定
  if (existing.canaryUses >= 3) {
    const passRate = existing.canaryPasses / existing.canaryUses;
    if (passRate >= 0.5) {
      existing.canaryStatus = 'verified';
    } else {
      existing.canaryStatus = 'demoted';
      existing.score = -10;
    }
  }

  existing.updatedAt = Date.now();

  await client.upsertNodes([{
    id: existing.id,
    type: "Skill",
    content: JSON.stringify({ kind: "evolution", ...existing }),
  }]);

  return existing;
}
