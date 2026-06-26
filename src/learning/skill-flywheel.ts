import { hashTextHex as hashText } from "../utils/hash";
import type { GraphNode, TaskRunResult } from "../core/types";
import type { GraphClient } from "../graph/client-factory";

// 导入提取出去的类型与常量
import type {
  EvolutionarySkillNode,
  SkillState,
  CompositeSkillState,
  SkillEdge,
} from "./skill-types";

// 导入提取出去的辅助函数与存储方法
import {
  skillNodeId,
  serializeAtomic,
  serializeComposite,
  parseSkillState,
  parseCompositeState,
  parseEvolutionState,
  readSkillState,
  loadCompositeSkill,
  composeSkillId,
  compositeGateMet,
  boundedScore,
  dedup,
  dedupNodes,
  dedupEdges,
} from "./skill-store";

// 导入提取出去的演进方法
import {
  evolveCompositeSkillLlm,
  getTripleAtomNames,
  buildTripleFusionNode,
} from "./skill-evolution";

// 兼容性重新导出，确保外部消费者完全兼容
export type { SkillState, CompositeSkillState, EvolutionarySkillNode } from "./skill-types";
export { composeSkillId, loadCompositeSkill, loadEvolutionSkill, parseEvolutionState } from "./skill-store";
export { evolveCompositeSkillLlm, updateSkillCanary } from "./skill-evolution";

const STOPWORDS = new Set([
  "update", "readme", "add", "fix", "file", "files",
  "module", "the", "and", "with", "in", "a", "an", "to", "for", "of",
  "on", "at", "by", "from", "is", "are", "was", "were", "be", "been",
  "or", "not", "but", "this", "that", "it", "as", "if", "do", "done",
]);

const PATH_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|py|go|rs|css|html)\b/i;

function isPathLikeToken(token: string): boolean {
  if (token.includes("/")) {
    return true;
  }
  return PATH_EXT_RE.test(token);
}

function isPathLikePhrase(phrase: string): boolean {
  return phrase.includes("/") || PATH_EXT_RE.test(phrase);
}

function extractTokens(part: string): string[] {
  return part
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_./-]/g, ""))
    .filter((token) => token.length >= 5)
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !isPathLikeToken(token));
}

/** Pull verb/noun tokens from multi-word phrases for composite skill co-occurrence. */
function extractSignificantTokensFromPhrase(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_./-]/g, ""))
    .filter((token) => token.length >= 5)
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !isPathLikeToken(token));
}

function isBareStopword(skill: string): boolean {
  return STOPWORDS.has(skill);
}

export function extractSkillAtoms(task: string): string[] {
  const normalized = task.trim().toLowerCase();

  const phrases = normalized
    .split(/\band\b|,|;/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

  const longPhrases = phrases.filter(
    (part) => part.length >= 6 && !isPathLikePhrase(part)
  );
  const shortPhrases = phrases.filter(
    (part) => part.length >= 3 && part.length < 6 && !isPathLikePhrase(part)
  );

  const tokenSkills: string[] = [];
  const partsForTokens = phrases.length > 0 ? phrases : [normalized];
  for (const part of partsForTokens) {
    if (part.length >= 6 && !isPathLikePhrase(part)) {
      continue;
    }
    tokenSkills.push(...extractTokens(part));
  }

  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const zhWords = Array.from(segmenter.segment(task))
    .filter(
      (seg) =>
        seg.isWordLike &&
        seg.segment.length >= 2 &&
        /[\u4e00-\u9fa5]/.test(seg.segment)
    )
    .map((seg) => seg.segment.toLowerCase());

  const phraseHeadTokens = longPhrases.flatMap(extractSignificantTokensFromPhrase);

  return dedup([...longPhrases, ...shortPhrases, ...phraseHeadTokens, ...tokenSkills, ...zhWords])
    .filter((skill) => !isBareStopword(skill))
    .slice(0, 8);
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
    state?: ({ kind: "evolution" } & EvolutionarySkillNode) | ({ kind: "composite" } & CompositeSkillState);
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
