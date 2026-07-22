import { hashTextHex as hashText } from "../utils/hash";
import type { GraphNode, TaskRunResult } from "../core/types";
import type { GraphClient } from "../graph/client-factory";

// 导入提取出去的类型与常量
import type {
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
  readSkillState,
  loadCompositeSkill,
  composeSkillId,
  compositeGateMet,
  boundedScore,
  dedup,
  dedupNodes,
  dedupEdges,
} from "./skill-store";

// 兼容性重新导出，确保外部消费者完全兼容
export type { SkillState, CompositeSkillState } from "./skill-types";
export { composeSkillId, loadCompositeSkill } from "./skill-store";

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

/** True when every non-empty token in the phrase is a stopword (e.g. "update readme"). */
export function isAllStopwordPhrase(phrase: string): boolean {
  const tokens = phrase
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_./-]/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return true;
  }
  return tokens.every((token) => STOPWORDS.has(token));
}

export function extractSkillAtoms(task: string): string[] {
  const normalized = task.trim().toLowerCase();

  const phrases = normalized
    .split(/\band\b|,|;/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .filter((part) => !isAllStopwordPhrase(part));

  const longPhrases = phrases.filter(
    (part) => part.length >= 6 && !isPathLikePhrase(part)
  );
  const shortPhrases = phrases.filter(
    (part) => part.length >= 3 && part.length < 6 && !isPathLikePhrase(part)
  );

  const tokenSkills: string[] = [];
  const partsForTokens = phrases.length > 0 ? phrases : [normalized];
  for (const part of partsForTokens) {
    if (isAllStopwordPhrase(part)) {
      continue;
    }
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
    .filter((skill) => !isAllStopwordPhrase(skill))
    .slice(0, 8);
}

export interface PruneFailedSkillsOptions {
  /** Soft-hide when score is at or below this (default -5). */
  scoreThreshold?: number;
  /** Require at least this many uses before pruning (default 5). */
  minUses?: number;
  /** Cap how many skills to hide in one pass (default 50). */
  maxPrune?: number;
}

export interface PruneFailedSkillsResult {
  pruned: number;
  ids: string[];
}

function isToxicAtomicSkill(
  state: SkillState,
  scoreThreshold: number,
  minUses: number
): boolean {
  if (state.hidden) {
    return false;
  }
  return (
    state.lastOutcome === "fail" &&
    state.score <= scoreThreshold &&
    state.uses >= minUses
  );
}

async function listSkillNodes(client: GraphClient): Promise<GraphNode[]> {
  if (client.readSnapshot) {
    return client.readSnapshot().nodes.filter((node) => node.type === "Skill");
  }
  const hits = await client.queryByKeyword("skill");
  return hits.filter((node) => node.type === "Skill");
}

/**
 * Soft-hide chronically failing low-score atomic skills so they stop polluting
 * insights and hint ranking. Prefer hide over delete (Decision history stays).
 */
export async function pruneFailedSkills(
  client: GraphClient,
  options?: PruneFailedSkillsOptions
): Promise<PruneFailedSkillsResult> {
  const scoreThreshold = options?.scoreThreshold ?? -5;
  const minUses = options?.minUses ?? 5;
  const maxPrune = options?.maxPrune ?? 50;

  const skillNodes = await listSkillNodes(client);
  const updates: GraphNode[] = [];
  const ids: string[] = [];

  for (const node of skillNodes) {
    if (ids.length >= maxPrune) {
      break;
    }
    const atomic = parseSkillState(node.content);
    if (!atomic || !isToxicAtomicSkill(atomic, scoreThreshold, minUses)) {
      continue;
    }
    const next: SkillState = {
      ...atomic,
      score: boundedScore(atomic.score - 1),
      hidden: true,
      updatedAt: Date.now(),
    };
    updates.push({ id: next.id, type: "Skill", content: serializeAtomic(next) });
    ids.push(next.id);
  }

  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return { pruned: ids.length, ids };
}

export async function applySkillLearning(
  client: GraphClient,
  task: string,
  run: TaskRunResult,
  lessons?: string[]
): Promise<number> {
  const lessonText = (lessons ?? [])
    .map((lesson) => lesson.trim())
    .filter((lesson) => lesson.length > 0);
  // Prefer task atoms; fold reported lessons so bridge report_outcome can seed skills
  // even when the original task string is too short/generic to extract atoms.
  const learningCorpus = [task, ...lessonText].filter(Boolean).join(" and ");
  const skills = extractSkillAtoms(learningCorpus);
  const passed = run.status === "COMPLETED";

  if (skills.length === 0) {
    if (!passed) {
      await pruneFailedSkills(client);
    }
    return 0;
  }

  const now = Date.now();
  const nodes: GraphNode[] = [];
  const edges: SkillEdge[] = [];
  const learnedSkills: string[] = [];

  // Create the Decision node so `improves` edges don't dangle.
  const decisionId = `decision:task:${hashText(task)}`;
  nodes.push({
    id: decisionId,
    type: "Decision",
    content: task.slice(0, 200),
    metadata: { outcome: passed ? "pass" : "fail", timestamp: now },
  });

  for (const skill of skills) {
    const id = skillNodeId(skill);
    const previous = await readSkillState(client, id);
    // Do not keep amplifying soft-hidden toxic atoms on further failures.
    if (previous?.hidden && !passed) {
      continue;
    }
    const next: SkillState = {
      id,
      name: skill,
      score: boundedScore((previous?.score ?? 0) + (passed ? 1 : -1)),
      uses: (previous?.uses ?? 0) + 1,
      lastOutcome: passed ? "pass" : "fail",
      updatedAt: now,
      // Pass clears soft-hide; fail preserves it if already set.
      ...(passed ? {} : previous?.hidden ? { hidden: true } : {}),
    };

    nodes.push({ id, type: "Skill", content: serializeAtomic(next) });
    edges.push({
      from: id,
      to: decisionId,
      relation: "improves",
    });
    learnedSkills.push(skill);
  }

  if (learnedSkills.length === 0) {
    if (!passed) {
      await pruneFailedSkills(client);
    }
    return 0;
  }

  for (let i = 0; i < learnedSkills.length; i += 1) {
    for (let j = i + 1; j < learnedSkills.length; j += 1) {
      const a = learnedSkills[i]!;
      const b = learnedSkills[j]!;
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
      }
    }
  }

  await client.upsertNodes(nodes);
  await client.upsertEdges(dedupEdges(edges));

  if (!passed) {
    await pruneFailedSkills(client);
  }

  return learnedSkills.length;
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
  for (const node of skillNodes) {
    const composite = parseCompositeState(node.content);
    if (composite) {
      compositeStates.push(composite);
      continue;
    }
    const atomic = parseSkillState(node.content);
    if (atomic && !atomic.hidden) {
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

  type Ranked = {
    name: string;
    score: number;
    uses: number;
    isComposite: boolean;
    state?: { kind: "composite" } & CompositeSkillState;
  };
  const ranked: Ranked[] = [
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
  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return chosen.map((item) => item.name);
}

const DECAY_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const DECAY_RATE = 1;

export interface SkillDecayResult {
  total: number;
  decayed: number;
  skipped: number;
}

export async function maybeDecaySkills(client: GraphClient): Promise<SkillDecayResult> {
  const nodes = await client.queryByKeyword("skill:");
  const skillNodes = dedupNodes(nodes.filter((n) => n.type === "Skill"));

  const now = Date.now();
  const updates: GraphNode[] = [];
  let decayed = 0;
  let skipped = 0;

  for (const node of skillNodes) {
    const skill = parseSkillState(node.content);
    if (!skill) {
      skipped += 1;
      continue;
    }

    const lastDecayedAt = skill.lastDecayedAt ?? skill.updatedAt;
    const daysSinceDecay = (now - lastDecayedAt) / DECAY_THRESHOLD_MS;
    if (daysSinceDecay < 1) {
      skipped += 1;
      continue;
    }

    const decayAmount = Math.floor(daysSinceDecay) * DECAY_RATE;
    if (decayAmount <= 0) {
      skipped += 1;
      continue;
    }

    let newScore = skill.score;
    if (skill.score > 0) {
      newScore = Math.max(0, skill.score - decayAmount);
    } else if (skill.score < 0) {
      newScore = Math.min(0, skill.score + decayAmount);
    }

    if (newScore === skill.score) {
      skipped += 1;
      continue;
    }

    const updated: SkillState = {
      ...skill,
      score: boundedScore(newScore),
      lastDecayedAt: now,
    };

    updates.push({ id: skill.id, type: "Skill", content: serializeAtomic(updated) });
    decayed += 1;
  }

  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return { total: skillNodes.length, decayed, skipped };
}

export async function resetSkillScore(
  client: GraphClient,
  skillName: string
): Promise<SkillState | undefined> {
  const id = skillNodeId(skillName);
  const previous = await readSkillState(client, id);
  if (!previous) {
    return undefined;
  }

  const reset: SkillState = {
    ...previous,
    score: 0,
    updatedAt: Date.now(),
    lastDecayedAt: Date.now(),
  };

  await client.upsertNodes([{ id, type: "Skill", content: serializeAtomic(reset) }]);
  return reset;
}

export async function pruneLowSkills(client: GraphClient): Promise<{ pruned: number }> {
  const nodes = await client.queryByKeyword("skill:");
  const skillNodes = dedupNodes(nodes.filter((n) => n.type === "Skill"));
  let pruned = 0;

  for (const node of skillNodes) {
    const skill = parseSkillState(node.content);
    if (!skill) continue;
    if (skill.score < -15) {
      if (client.deleteNode) {
        await client.deleteNode(node.id);
      }
      pruned += 1;
    }
  }

  return { pruned };
}
