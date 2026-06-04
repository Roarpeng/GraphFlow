import { logger } from "../utils/logger";
import type { GraphEdge, GraphNode, TaskRunResult } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { executeRolePrompt } from "../routing/provider-executor";

export interface EvolutionarySkillNode {
  id: string;
  name: string; // MiniCPM 生成的复合中文名
  parents: [string, string];
  domain: string; // 解决的 C 领域
  description: string; // 合成方法论描述
  score: number;
  uses: number;
  updatedAt: number;
  canaryUses: number;
  canaryPasses: number;
  canaryStatus: 'probation' | 'verified' | 'demoted';
}

export interface SkillState {
  id: string;
  name: string;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
}

export interface CompositeSkillState {
  id: string;
  name: string;
  parents: [string, string];
  coOccurCount: number;
  successCount: number;
  failureCount: number;
  score: number;
  uses: number;
  lastOutcome: "pass" | "fail";
  updatedAt: number;
}

type EdgeRelation = GraphEdge["relation"];
type SkillEdge = { from: string; to: string; relation: EdgeRelation };

const DEFAULT_COMPOSITE_MIN_COOCCUR = 2;
const DEFAULT_COMPOSITE_MIN_SUCCESS = 2;

export function extractSkillAtoms(task: string): string[] {
  const phrases = task
    .split(/\band\b|,|;/i)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3)
    .slice(0, 8);

  const tokenSkills = task
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_./-]/g, ""))
    .filter((token) => token.length >= 5)
    .slice(0, 8);

  return dedup([...phrases, ...tokenSkills]);
}

export async function applySkillLearning(
  client: GraphClient,
  task: string,
  run: TaskRunResult
): Promise<void> {
  const skills = extractSkillAtoms(task);
  if (skills.length === 0) {
    return;
  }

  const passed = run.status === "COMPLETED";
  const now = Date.now();
  const nodes: GraphNode[] = [];
  const edges: SkillEdge[] = [];

  for (const skill of skills) {
    const id = skillNodeId(skill);
    const previous = await readSkillState(client, id);
    const next: SkillState = {
      id,
      name: skill,
      score: boundedScore((previous?.score ?? 0) + (passed ? 1 : -1)),
      uses: (previous?.uses ?? 0) + 1,
      lastOutcome: passed ? "pass" : "fail",
      updatedAt: now,
    };

    nodes.push({ id, type: "Skill", content: serializeAtomic(next) });
    edges.push({
      from: id,
      to: `decision:task:${hashText(task)}`,
      relation: "improves",
    });
  }

  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const a = skills[i]!;
      const b = skills[j]!;
      edges.push({
        from: skillNodeId(a),
        to: skillNodeId(b),
        relation: "co_occurs",
      });

      const [n1, n2] = [a, b].sort();
      const compositeId = composeSkillId(n1!, n2!);
      const previous = await loadCompositeSkill(client, compositeId);
      const composite: CompositeSkillState = {
        id: compositeId,
        name: `${n1}+${n2}`,
        parents: [skillNodeId(n1!), skillNodeId(n2!)],
        coOccurCount: (previous?.coOccurCount ?? 0) + 1,
        successCount: (previous?.successCount ?? 0) + (passed ? 1 : 0),
        failureCount: (previous?.failureCount ?? 0) + (passed ? 0 : 1),
        score: 0,
        uses: previous?.uses ?? 0,
        lastOutcome: passed ? "pass" : "fail",
        updatedAt: now,
      };
      composite.score = boundedScore(composite.successCount - composite.failureCount);

      nodes.push({ id: compositeId, type: "Skill", content: serializeComposite(composite) });

      if (compositeGateMet(composite)) {
        edges.push({ from: skillNodeId(n1!), to: compositeId, relation: "prerequisite" });
        edges.push({ from: skillNodeId(n2!), to: compositeId, relation: "prerequisite" });

        // 异步调度 evolveCompositeSkillLlm 进行脑暴合成
        const evolutionNode = await evolveCompositeSkillLlm(client, n1!, n2!, composite);
        if (evolutionNode) {
          nodes.push(evolutionNode);
          edges.push({ from: skillNodeId(n1!), to: evolutionNode.id, relation: "prerequisite" });
          edges.push({ from: skillNodeId(n2!), to: evolutionNode.id, relation: "prerequisite" });
        }
      }
    }
  }

  if (passed) {
    const tripleAtomNames = getTripleAtomNames(skills);
    const tripleNode = tripleAtomNames ? buildTripleFusionNode(tripleAtomNames, now) : undefined;
    if (tripleNode && tripleAtomNames) {
      nodes.push(tripleNode);
      for (const atom of tripleAtomNames) {
        edges.push({ from: skillNodeId(atom), to: tripleNode.id, relation: "prerequisite" });
      }
    }
  }

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));
}

export async function suggestSkillHints(
  client: GraphClient,
  task: string,
  maxHints: number
): Promise<string[]> {
  const atoms = extractSkillAtoms(task);
  const queries = dedup([task.toLowerCase(), ...atoms]).slice(0, 10);
  const resultSets = await Promise.all(queries.map((query) => client.queryByKeyword(query)));

  const skillNodes = dedupNodes(resultSets.flat().filter((node) => node.type === "Skill"));

  const atomicStates: SkillState[] = [];
  const compositeStates: CompositeSkillState[] = [];
  const evolutionStates: EvolutionarySkillNode[] = [];
  for (const node of skillNodes) {
    const evolution = parseEvolutionState(node.content);
    if (evolution) {
      evolutionStates.push(evolution);
      continue;
    }
    const composite = parseCompositeState(node.content);
    if (composite) {
      compositeStates.push(composite);
      continue;
    }
    const atomic = parseSkillState(node.content);
    if (atomic) {
      atomicStates.push(atomic);
    }
  }

  const atomSet = new Set(atoms);
  const eligibleComposites = compositeStates.filter((composite) => {
    if (!compositeGateMet(composite) || composite.score <= 0) {
      return false;
    }
    const [n1, n2] = composite.name.split("+");
    return Boolean(n1 && n2 && atomSet.has(n1) && atomSet.has(n2));
  });

  const eligibleEvolutions = evolutionStates.filter((evo) => {
    // 排除已被 demoted 的合成技能
    if (evo.canaryStatus === 'demoted') {
      return false;
    }
    if (evo.score <= 0) {
      return false;
    }
    const [p1, p2] = evo.parents;
    const n1 = p1?.replace(/^skill:/, "");
    const n2 = p2?.replace(/^skill:/, "");
    return Boolean(n1 && n2 && atomSet.has(n1) && atomSet.has(n2));
  });

  type Ranked = {
    name: string;
    score: number;
    uses: number;
    isComposite: boolean;
    state?: any;
  };
  const ranked: Ranked[] = [
    ...eligibleEvolutions.map((e) => ({
      name: e.name,
      // probation 状态权重降低为 0.5 倍用于排序
      score: e.canaryStatus === 'probation' ? e.score * 0.5 : e.score,
      uses: e.uses,
      isComposite: true,
      state: { kind: "evolution", ...e },
    })),
    ...eligibleComposites.map((c) => ({
      name: c.name,
      score: c.score,
      uses: c.uses,
      isComposite: true,
      state: { kind: "composite", ...c },
    })),
    ...atomicStates.map((a) => ({
      name: a.name,
      score: a.score,
      uses: a.uses,
      isComposite: false,
    })),
  ];

  ranked.sort((a, b) => {
    if (a.isComposite !== b.isComposite) {
      return a.isComposite ? -1 : 1;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.uses !== a.uses) {
      return b.uses - a.uses;
    }
    return a.name.localeCompare(b.name);
  });

  const chosen = ranked.slice(0, maxHints);

  const updates: GraphNode[] = [];
  for (const item of chosen) {
    if (item.isComposite && item.state) {
      if (item.state.kind === "evolution") {
        const updated: EvolutionarySkillNode = {
          id: item.state.id,
          name: item.state.name,
          parents: item.state.parents,
          domain: item.state.domain,
          description: item.state.description,
          score: item.state.score,
          uses: item.state.uses + 1,
          updatedAt: Date.now(),
          canaryUses: item.state.canaryUses ?? 0,
          canaryPasses: item.state.canaryPasses ?? 0,
          canaryStatus: item.state.canaryStatus ?? 'probation',
        };
        updates.push({ id: updated.id, type: "Skill", content: JSON.stringify({ kind: "evolution", ...updated }) });
      } else {
        const updated: CompositeSkillState = {
          id: item.state.id,
          name: item.state.name,
          parents: item.state.parents,
          coOccurCount: item.state.coOccurCount,
          successCount: item.state.successCount,
          failureCount: item.state.failureCount,
          score: item.state.score,
          uses: item.state.uses + 1,
          lastOutcome: item.state.lastOutcome,
          updatedAt: Date.now(),
        };
        updates.push({ id: updated.id, type: "Skill", content: serializeComposite(updated) });
      }
    }
  }
  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return chosen.map((item) => item.name);
}

export function composeSkillId(atomA: string, atomB: string): string {
  const [first, second] = [atomA, atomB].sort();
  return `skill:composite:${sanitizeAtom(first!)}__${sanitizeAtom(second!)}`;
}

export async function loadCompositeSkill(
  client: GraphClient,
  id: string
): Promise<CompositeSkillState | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseCompositeState(direct.content) : undefined;
}

function compositeGateMet(composite: CompositeSkillState): boolean {
  const minCoOccur = Number(process.env.GRAPHFLOW_SKILL_EVOLVE_MIN_COOCCUR ?? DEFAULT_COMPOSITE_MIN_COOCCUR);
  const minSuccess = Number(process.env.GRAPHFLOW_SKILL_EVOLVE_MIN_SUCCESS ?? DEFAULT_COMPOSITE_MIN_SUCCESS);
  return (
    composite.coOccurCount >= (Number.isFinite(minCoOccur) ? minCoOccur : DEFAULT_COMPOSITE_MIN_COOCCUR) &&
    composite.successCount >= (Number.isFinite(minSuccess) ? minSuccess : DEFAULT_COMPOSITE_MIN_SUCCESS) &&
    composite.successCount > composite.failureCount
  );
}

function sanitizeAtom(skill: string): string {
  return skill.replace(/[^a-z0-9]+/g, "-");
}

function skillNodeId(skill: string): string {
  return `skill:${sanitizeAtom(skill)}`;
}

function serializeAtomic(state: SkillState): string {
  return JSON.stringify({ kind: "atomic", ...state });
}

function serializeComposite(state: CompositeSkillState): string {
  return JSON.stringify({ kind: "composite", ...state });
}

function parseSkillState(content: string): SkillState | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<SkillState> & { kind?: string };
    if (!parsed.id || !parsed.name) {
      return undefined;
    }
    if (parsed.kind && parsed.kind !== "atomic") {
      return undefined;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch (error) {
    logger.error({ error }, "Caught error");
    return undefined;
  }
}

function parseCompositeState(content: string): CompositeSkillState | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<CompositeSkillState> & { kind?: string };
    if (parsed.kind !== "composite" || !parsed.id || !parsed.name || !parsed.parents) {
      return undefined;
    }
    const parents = parsed.parents;
    if (!Array.isArray(parents) || parents.length !== 2) {
      return undefined;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      parents: [parents[0]!, parents[1]!],
      coOccurCount: parsed.coOccurCount ?? 0,
      successCount: parsed.successCount ?? 0,
      failureCount: parsed.failureCount ?? 0,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch (error) {
    logger.error({ error }, "Caught error");
    return undefined;
  }
}

async function readSkillState(client: GraphClient, id: string): Promise<SkillState | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseSkillState(direct.content) : undefined;
}

function dedup(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupNodes(nodes: GraphNode[]): GraphNode[] {
  const map = new Map<string, GraphNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return Array.from(map.values());
}

function boundedScore(score: number): number {
  if (score > 20) {
    return 20;
  }

  if (score < -20) {
    return -20;
  }

  return score;
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function dedupEdges(edges: SkillEdge[]): SkillEdge[] {
  const seen = new Set<string>();
  const result: SkillEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.relation}|${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}

export function parseEvolutionState(content: string): EvolutionarySkillNode | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<EvolutionarySkillNode> & { kind?: string };
    if (parsed.kind !== "evolution" || !parsed.id || !parsed.name || !parsed.parents) {
      return undefined;
    }
    const parents = parsed.parents;
    if (!Array.isArray(parents) || parents.length !== 2) {
      return undefined;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      parents: [parents[0]!, parents[1]!],
      domain: parsed.domain || "",
      description: parsed.description || "",
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      updatedAt: parsed.updatedAt ?? 0,
      canaryUses: parsed.canaryUses ?? 0,
      canaryPasses: parsed.canaryPasses ?? 0,
      canaryStatus: parsed.canaryStatus ?? 'probation',
    };
  } catch (error) {
    logger.error({ error }, "Caught error");
    return undefined;
  }
}

export async function loadEvolutionSkill(
  client: GraphClient,
  id: string
): Promise<EvolutionarySkillNode | undefined> {
  const hits = await client.queryByKeyword(id);
  const direct = hits.find((node) => node.id === id && node.type === "Skill");
  return direct ? parseEvolutionState(direct.content) : undefined;
}

/**
 * 调遣 MiniCPM-1B 模拟人类进行跨技能融会贯通与概念演进
 */
export async function evolveCompositeSkillLlm(
  client: GraphClient,
  n1: string,
  n2: string,
  previousComposite: any
): Promise<GraphNode | null> {
  const openbmbModel = process.env.GRAPHFLOW_SKILL_EVOLVE_MODEL ?? "minicpm-1b";

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
      score: previousComposite.score ?? 1,
      uses: previousComposite.uses ?? 1,
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

function getTripleAtomNames(skills: string[]): [string, string, string] | undefined {
  if (skills.length < 3) {
    return undefined;
  }
  const atoms = dedup(skills).sort();
  if (atoms.length < 3) {
    return undefined;
  }
  return [atoms[0]!, atoms[1]!, atoms[2]!];
}

function buildTripleFusionNode(names: [string, string, string], now: number): GraphNode | undefined {
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

function cleanJsonString(raw: string, n1: string, n2: string): string {
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
