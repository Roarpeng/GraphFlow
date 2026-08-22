import { hashTextHex as hashText } from "../utils/hash";
import type { GraphNode, TaskRunResult } from "../core/types";
import type { GraphClient } from "../graph/client-factory";

// 导入提取出去的类型与常量
import type {
  SkillState,
  CompositeSkillState,
  SkillEdge,
  SkillOutcomeKind,
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
import { applyPlaybookDelta, seedPlaybookFromGuidance } from "./skill-opt-lite";
import { gateSkillPromotion } from "./canary-gate";
import {
  admitSkillToProven,
  isSymbolicSkillName,
  resolveProvenMinSuccess,
} from "./skill-admission";
import { serializePlaybookGuidance } from "./skill-types";

// 兼容性重新导出，确保外部消费者完全兼容
export type { SkillState, CompositeSkillState } from "./skill-types";
export { composeSkillId, loadCompositeSkill } from "./skill-store";
export {
  canaryPassed,
  gateSkillPromotion,
  DEFAULT_CANARY_LOCAL_SUCCESSES,
  shouldHardDeleteAntiPattern,
} from "./canary-gate";
export {
  admitSkillToProven,
  isSymbolicSkillName,
  wouldDegradeLibrary,
  goldenTokenOverlap,
  registerGoldenEvidenceTokens,
  resolveProvenMinSuccess,
  DEFAULT_PROVEN_MIN_SUCCESS,
} from "./skill-admission";
export {
  planSkillConsolidation,
  applySkillConsolidation,
  planFromRequest,
  toConsolidateResult,
  normalizeSkillNameKey,
  type ConsolidateAction,
  type ConsolidateActionKind,
  type ConsolidateRequest,
  type ConsolidateResult,
  type ConsolidateSkillInput,
  type ConsolidateCandidate,
  type PlanSkillConsolidationOptions,
  type ApplySkillConsolidationResult,
} from "./skill-consolidate";

const STOPWORDS = new Set([
  "update", "readme", "add", "fix", "file", "files",
  "module", "the", "and", "with", "in", "a", "an", "to", "for", "of",
  "on", "at", "by", "from", "is", "are", "was", "were", "be", "been",
  "or", "not", "but", "this", "that", "it", "as", "if", "do", "done",
]);

const PATH_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|py|go|rs|css|html)\b/i;

/**
 * P0-2 extraction quality gate: a skill candidate must reference project-specific
 * symbols (file/function/class paths from the episode record, e.g. "goal-anchor.ts").
 * These shapes are unambiguous project-symbol evidence:
 *  - file references:  goal-anchor.ts, src/a/b.js, readme.md, compose_skill.go
 *  - slash paths:      src/learning/skill-flywheel.ts
 *  - camelCase:        skillNodeId, GraphifyClient
 *  - snake_case:       compose_skill_id
 * Generic bare tokens without symbol evidence (update, readme, create, fix) never
 * qualify, so shallow n-gram noise can no longer become a skill node.
 */
const PROJECT_SYMBOL_PATTERNS: Array<{ test: RegExp; match: RegExp }> = [
  { test: /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/i, match: /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/gi },
  { test: /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/i, match: /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/gi },
  { test: /[a-z]+[A-Z][a-zA-Z0-9]*/, match: /[a-z]+[A-Z][a-zA-Z0-9]*/g },
  { test: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i, match: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi },
];

/** True when the text references at least one project-specific symbol. */
export function hasProjectSymbolEvidence(text: string): boolean {
  if (!text) return false;
  return PROJECT_SYMBOL_PATTERNS.some(({ test }) => test.test(text));
}

/** Extract project-symbol-shaped tokens from the text (for diagnostics/tests). */
export function extractProjectSymbols(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  for (const { match } of PROJECT_SYMBOL_PATTERNS) {
    for (const m of text.matchAll(match)) {
      const token = m[0].trim();
      if (token.length > 0) out.add(token);
    }
  }
  return Array.from(out);
}

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

export function extractSkillAtoms(task: string, evidence?: string[]): string[] {
  const corpus = [task, ...(evidence ?? [])].filter(Boolean).join(" ");
  // P0-2 quality gate: reject corpora that reference no project-specific symbols
  // (file/function/class paths). Generic bare-token text ("update readme",
  // "create fix") is extraction noise and must not become skill candidates.
  if (!hasProjectSymbolEvidence(corpus)) {
    return [];
  }
  const normalized = corpus.trim().toLowerCase();

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
  const zhWords = Array.from(segmenter.segment(corpus))
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

export interface SkillLearningOptions {
  /** Extra episode-record material (plan descriptions, key decisions) that
   *  carries project-symbol evidence for the extraction gate. */
  evidence?: string[];
  /** True when the outcome was reported back through the episode outcome loop
   *  (bridge reportOutcome) — counts as a "linked successful outcome". */
  linked?: boolean;
  /** Episode id from bridge report_outcome; stamped on newly created local skills. */
  episodeId?: string;
}

/**
 * P0-2 outcome taxonomy classification:
 * - noise:        no symbol evidence — never persisted; pruned on load.
 * - anti-pattern: >= 2 consecutive failures with symbol evidence — the ONLY
 *                 class that accrues negative score.
 * - proven:       real success evidence chain — successCount (绑定且 pass 的
 *                 去重 episode 数) >= 阈值（默认 2，见 DEFAULT_PROVEN_MIN_SUCCESS
 *                 / GRAPHFLOW_SKILL_PROVEN_MIN_SUCCESS），或 legacy 的
 *                 linkedSuccess（旧版"一次链接成功"信号，保留兼容）。uses
 *                 （出现/提及次数）不再参与 proven 判定，仅用于展示。
 *                 Curated seed skills count as proven by design (baseline,
 *                 never sinkable to negative). External (sync/import) skills
 *                 additionally require canary (N local successes or
 *                 canaryValidated) before proven.
 * - correctable:  symbol evidence present, not yet proven. Score stays put.
 */
export function classifySkillOutcome(options: {
  uses: number;
  failStreak: number;
  linkedSuccess: boolean;
  /** 绑定且 outcome=pass 的去重 episode 数（真实成功证据链，主要判定依据）。 */
  successCount?: number;
  seeded?: boolean;
  provenance?: SkillState["provenance"];
  canaryValidated?: boolean;
  /** Successful local applications for canary (defaults to uses). */
  localSuccesses?: number;
  /** When set, proven is held at correctable unless the admission gate passes. */
  skillName?: string;
}): SkillOutcomeKind {
  if (options.seeded === true) {
    return "proven";
  }
  if (options.failStreak >= 2) {
    return "anti-pattern";
  }
  // 未显式提供 successCount 时按 legacy 语义回退：linkedSuccess 视为 1 个成功 episode。
  const successCount =
    options.successCount ?? (options.linkedSuccess ? 1 : 0);
  const candidate: SkillOutcomeKind =
    successCount >= resolveProvenMinSuccess() || options.linkedSuccess
      ? "proven"
      : "correctable";
  return gateSkillPromotion({
    outcomeKind: candidate,
    localSuccesses: options.localSuccesses ?? options.uses,
    successCount,
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.canaryValidated !== undefined
      ? { validated: options.canaryValidated }
      : {}),
    ...(options.skillName ? { skillName: options.skillName } : {}),
  });
}

/**
 * 技能的真实成功证据计数：优先读持久化 successCount；旧数据按
 * linkedSuccess + provenance.episodeId 迁移为 1（向后兼容）。
 */
export function resolveSkillSuccessCount(state: SkillState): number {
  if (typeof state.successCount === "number" && Number.isFinite(state.successCount)) {
    return Math.max(0, Math.floor(state.successCount));
  }
  return state.linkedSuccess === true && state.provenance?.episodeId ? 1 : 0;
}

/**
 * Explicit canary validate hook: mark an atomic skill as canary-validated and
 * re-run promotion classification (external skills may become proven immediately).
 */
export async function markSkillCanaryValidated(
  client: GraphClient,
  skillId: string
): Promise<SkillState | undefined> {
  const previous = await readSkillState(client, skillId);
  if (!previous) {
    return undefined;
  }
  const outcomeKind = classifySkillOutcome({
    uses: previous.uses,
    failStreak: previous.failStreak ?? 0,
    linkedSuccess: previous.linkedSuccess === true,
    successCount: resolveSkillSuccessCount(previous),
    localSuccesses: previous.uses,
    canaryValidated: true,
    skillName: previous.name,
    ...(previous.seeded === true ? { seeded: true } : {}),
    ...(previous.provenance ? { provenance: previous.provenance } : {}),
  });
  const next: SkillState = {
    ...previous,
    canaryValidated: true,
    outcomeKind,
    updatedAt: Date.now(),
  };
  await client.upsertNodes([{ id: next.id, type: "Skill", content: serializeAtomic(next) }]);
  return next;
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
 * Anti-patterns stay isolated for audit — never hard-deleted (canary policy).
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

export interface CleanupNoiseSkillsResult {
  /** Nodes deleted (or soft-hidden when deleteNode is unavailable). */
  pruned: number;
  ids: string[];
  /** Legacy nodes whose names carry symbol evidence, re-tagged as correctable. */
  reclassified: number;
}

/**
 * P0-2 load-time cleanup: reclassify / prune existing pure-noise skill nodes.
 * Nodes learned by older versions have no symbol evidence (shallow n-grams
 * like "update" at score=-2). Curated seed nodes (seeded: true) are kept.
 * Non-symbolic names (including readme+update fusions) are pruned even when
 * `hasSymbolEvidence` was wrongly set true (legacy lie).
 * Runs at graph load (orchestration start / outcome report) — idempotent.
 */
export async function cleanupNoiseSkills(
  client: GraphClient
): Promise<CleanupNoiseSkillsResult> {
  const skillNodes = await listSkillNodes(client);
  const ids: string[] = [];
  const updates: GraphNode[] = [];
  let reclassified = 0;

  for (const node of skillNodes) {
    const atomic = parseSkillState(node.content);
    if (atomic) {
      if (atomic.seeded === true) {
        continue;
      }
      if (isSymbolicSkillName(atomic.name)) {
        if (atomic.hasSymbolEvidence !== true) {
          updates.push({
            id: atomic.id,
            type: "Skill",
            content: serializeAtomic({
              ...atomic,
              hasSymbolEvidence: true,
              outcomeKind: atomic.outcomeKind ?? "correctable",
              updatedAt: Date.now(),
            }),
          });
          reclassified += 1;
        }
        continue;
      }
      ids.push(atomic.id);
      if (client.deleteNode) {
        await client.deleteNode(atomic.id);
      } else {
        updates.push({
          id: atomic.id,
          type: "Skill",
          content: serializeAtomic({
            ...atomic,
            hidden: true,
            outcomeKind: "noise",
            updatedAt: Date.now(),
          }),
        });
      }
      continue;
    }

    const composite = parseCompositeState(node.content);
    if (composite) {
      if (composite.seeded === true) {
        continue;
      }
      if (isSymbolicSkillName(composite.name)) {
        if (composite.hasSymbolEvidence !== true) {
          updates.push({
            id: composite.id,
            type: "Skill",
            content: serializeComposite({
              ...composite,
              hasSymbolEvidence: true,
              outcomeKind: composite.outcomeKind ?? "correctable",
              updatedAt: Date.now(),
            }),
          });
          reclassified += 1;
        }
        continue;
      }
      ids.push(composite.id);
      if (client.deleteNode) {
        await client.deleteNode(composite.id);
      } else {
        // CompositeSkillState has no `hidden` flag; tag as noise so the next
        // load (or a deleteNode-capable client) finishes the job.
        updates.push({
          id: composite.id,
          type: "Skill",
          content: serializeComposite({
            ...composite,
            outcomeKind: "noise",
            updatedAt: Date.now(),
          }),
        });
      }
    }
  }

  if (updates.length > 0) {
    await client.upsertNodes(updates);
  }

  return { pruned: ids.length, ids, reclassified };
}

export async function applySkillLearning(
  client: GraphClient,
  task: string,
  run: TaskRunResult,
  lessons?: string[],
  options?: SkillLearningOptions
): Promise<number> {
  const lessonText = (lessons ?? [])
    .map((lesson) => lesson.trim())
    .filter((lesson) => lesson.length > 0);
  // Prefer task atoms; fold reported lessons so bridge report_outcome can seed skills
  // even when the original task string is too short/generic to extract atoms.
  // P0-2: evidence (plan descriptions / key decisions from the episode record)
  // provides project-symbol references for the extraction quality gate.
  const learningCorpus = [task, ...lessonText].filter(Boolean).join(" and ");
  const skills = extractSkillAtoms(learningCorpus, options?.evidence);
  const passed = run.status === "COMPLETED";
  const linked = options?.linked === true;

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
    const uses = (previous?.uses ?? 0) + 1;
    const failStreak = passed ? 0 : (previous?.failStreak ?? 0) + 1;
    const linkedSuccess =
      (passed && linked) || previous?.linkedSuccess === true;
    // 真实成功证据链：绑定且 outcome=pass 的去重 episode 数。
    // 去重簿记存 successEpisodeIds；旧数据按 linkedSuccess + provenance.episodeId
    // 迁移为 1 个 pass episode（仅当 successCount 尚未持久化时执行一次）。
    const boundEpisodeIds = new Set<string>(previous?.successEpisodeIds ?? []);
    if (
      previous?.successCount === undefined &&
      previous?.linkedSuccess === true &&
      previous?.provenance?.episodeId
    ) {
      boundEpisodeIds.add(previous.provenance.episodeId);
    }
    if (passed && options?.episodeId) {
      boundEpisodeIds.add(options.episodeId);
    }
    const successEpisodeIds = Array.from(boundEpisodeIds);
    const successCount = successEpisodeIds.length;
    let outcomeKind = classifySkillOutcome({
      uses,
      failStreak,
      linkedSuccess,
      successCount,
      localSuccesses: uses,
      skillName: skill,
      ...(previous?.seeded === true ? { seeded: true } : {}),
      ...(previous?.provenance ? { provenance: previous.provenance } : {}),
      ...(previous?.canaryValidated === true ? { canaryValidated: true } : {}),
    });
    // Held-out admission: proven candidates without real success evidence or
    // golden overlap stay correctable. Real success evidence (successCount >=
    // 阈值) bypasses the golden gate — see admitSkillToProven.
    if (
      outcomeKind === "proven" &&
      previous?.seeded !== true &&
      !admitSkillToProven(skill, { successCount }).ok
    ) {
      outcomeKind = "correctable";
    }
    // Evidence gate: positive score accrues only for proven skills (>= 2 uses
    // or a linked successful outcome); negative scoring applies ONLY to
    // anti-pattern outcomes (>= 2 consecutive failures).
    let score = previous?.score ?? 0;
    if (passed && outcomeKind === "proven") {
      score += 1;
    } else if (!passed && outcomeKind === "anti-pattern") {
      score -= 1;
    }
    const newLocalProvenance =
      !previous?.provenance && options?.episodeId
        ? { source: "local" as const, episodeId: options.episodeId }
        : undefined;
    const next: SkillState = {
      id,
      name: skill,
      score: boundedScore(score),
      uses,
      lastOutcome: passed ? "pass" : "fail",
      updatedAt: now,
      hasSymbolEvidence: isSymbolicSkillName(skill),
      linkedSuccess,
      // 真实成功证据链：仅在有绑定 pass episode 时持久化（去重）。
      ...(successCount > 0 ? { successCount, successEpisodeIds } : {}),
      failStreak,
      outcomeKind,
      // 来源元数据随本地学习延续（外部 sync 技能晋升 proven 后仍保留来源标记）。
      ...(previous?.provenance
        ? { provenance: previous.provenance }
        : newLocalProvenance
          ? { provenance: newLocalProvenance }
          : {}),
      ...(previous?.canaryValidated === true ? { canaryValidated: true } : {}),
      ...(previous?.seeded === true ? { seeded: true } : {}),
      // Pass clears soft-hide; fail preserves it if already set.
      ...(passed ? {} : previous?.hidden ? { hidden: true } : {}),
    };

    // SkillOpt-lite playbook: incremental helpful/harmful counts + append lessons.
    if (lessonText.length > 0) {
      const seedPlaybook =
        previous?.playbook && previous.playbook.length > 0
          ? previous.playbook
          : seedPlaybookFromGuidance(previous?.guidance);
      const playbook = applyPlaybookDelta(seedPlaybook, lessonText, passed);
      if (playbook.length > 0) {
        next.playbook = playbook;
        next.guidance = serializePlaybookGuidance(playbook);
      } else if (previous?.guidance) {
        next.guidance = previous.guidance;
      }
    } else if (previous?.playbook && previous.playbook.length > 0) {
      next.playbook = previous.playbook;
      next.guidance = previous.guidance ?? serializePlaybookGuidance(previous.playbook);
    } else if (previous?.guidance) {
      next.guidance = previous.guidance;
    }

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
      if (!isSymbolicSkillName(n1!) || !isSymbolicSkillName(n2!)) {
        continue;
      }
      const compositeId = composeSkillId(n1!, n2!);
      const previous = await loadCompositeSkill(client, compositeId);
      const compositeName = `${n1}+${n2}`;
      const newCompositeProvenance =
        !previous?.provenance && options?.episodeId
          ? { source: "local" as const, episodeId: options.episodeId }
          : undefined;
      const composite: CompositeSkillState = {
        id: compositeId,
        name: compositeName,
        parents: [skillNodeId(n1!), skillNodeId(n2!)],
        coOccurCount: (previous?.coOccurCount ?? 0) + 1,
        successCount: (previous?.successCount ?? 0) + (passed ? 1 : 0),
        failureCount: (previous?.failureCount ?? 0) + (passed ? 0 : 1),
        score: 0,
        uses: previous?.uses ?? 0,
        lastOutcome: passed ? "pass" : "fail",
        updatedAt: now,
        hasSymbolEvidence: isSymbolicSkillName(compositeName),
        ...(previous?.seeded === true ? { seeded: true } : {}),
        // 来源元数据随共现更新延续（外部 sync 组合技能保留来源标记）。
        ...(previous?.provenance
          ? { provenance: previous.provenance }
          : newCompositeProvenance
            ? { provenance: newCompositeProvenance }
            : {}),
      };
      // P0-2 taxonomy: negative composite scores apply only to anti-pattern
      // pairs (>= 2 failures and more failures than successes); correctable /
      // proven pairs are clamped to non-negative.
      const compositeAntiPattern =
        composite.failureCount >= 2 && composite.failureCount > composite.successCount;
      composite.score = boundedScore(
        compositeAntiPattern
          ? composite.successCount - composite.failureCount
          : Math.max(0, composite.successCount - composite.failureCount)
      );
      composite.outcomeKind = gateSkillPromotion({
        outcomeKind: compositeAntiPattern
          ? "anti-pattern"
          : compositeGateMet(composite)
            ? "proven"
            : "correctable",
        localSuccesses: composite.successCount,
        skillName: compositeName,
        ...(previous?.provenance ? { provenance: previous.provenance } : {}),
        ...(previous?.canaryValidated === true ? { validated: true } : {}),
      });

      nodes.push({
        id: compositeId,
        type: "Skill",
        content: serializeComposite({
          ...composite,
          ...(previous?.canaryValidated === true ? { canaryValidated: true } : {}),
        }),
      });

      if (composite.outcomeKind === "proven" && compositeGateMet(composite)) {
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

/** Structured skill conditioning for plan DAG nodes / agent-bridge prompts. */
export interface SkillConditionHints {
  /** Proven / correctable skill names to apply while executing steps. */
  skillRefs: string[];
  /** Anti-pattern skill names the agent should avoid. */
  avoidPatterns: string[];
}

type RankedSkillHint = {
  name: string;
  score: number;
  uses: number;
  isComposite: boolean;
  outcomeKind?: SkillOutcomeKind;
  state?: { kind: "composite" } & CompositeSkillState;
};

function rankSkillHint(a: RankedSkillHint, b: RankedSkillHint): number {
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
}

function resolveAtomicOutcomeKind(state: SkillState): SkillOutcomeKind {
  if (state.outcomeKind) {
    return state.outcomeKind;
  }
  return classifySkillOutcome({
    uses: state.uses,
    failStreak: state.failStreak ?? 0,
    linkedSuccess: state.linkedSuccess === true,
    successCount: resolveSkillSuccessCount(state),
    ...(state.seeded === true ? { seeded: true } : {}),
    ...(state.provenance ? { provenance: state.provenance } : {}),
    ...(state.canaryValidated === true ? { canaryValidated: true } : {}),
  });
}

function resolveCompositeOutcomeKind(state: CompositeSkillState): SkillOutcomeKind {
  if (state.outcomeKind) {
    return state.outcomeKind;
  }
  const anti =
    state.failureCount >= 2 && state.failureCount > state.successCount;
  if (anti) {
    return "anti-pattern";
  }
  return compositeGateMet(state) ? "proven" : "correctable";
}

async function collectTaskSkillCandidates(
  client: GraphClient,
  task: string
): Promise<{ atoms: string[]; ranked: RankedSkillHint[]; avoid: RankedSkillHint[] }> {
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
  const matchingComposites = compositeStates.filter((composite) => {
    const [n1, n2] = composite.name.split("+");
    return Boolean(n1 && n2 && atomSet.has(n1) && atomSet.has(n2));
  });

  const eligibleComposites = matchingComposites.filter(
    (composite) => compositeGateMet(composite) && composite.score > 0
  );

  const ranked: RankedSkillHint[] = [
    ...eligibleComposites.map((c) => ({
      name: c.name,
      score: c.score,
      uses: c.uses,
      isComposite: true as const,
      outcomeKind: resolveCompositeOutcomeKind(c),
      state: { kind: "composite" as const, ...c },
    })),
    ...atomicStates
      .filter((a) => {
        const kind = resolveAtomicOutcomeKind(a);
        return kind === "proven" || kind === "correctable" || a.score > 0;
      })
      .map((a) => ({
        name: a.name,
        score: a.score,
        uses: a.uses,
        isComposite: false as const,
        outcomeKind: resolveAtomicOutcomeKind(a),
      })),
  ];

  ranked.sort(rankSkillHint);

  const avoid: RankedSkillHint[] = [
    ...matchingComposites
      .filter((c) => resolveCompositeOutcomeKind(c) === "anti-pattern" || c.score < 0)
      .map((c) => ({
        name: c.name,
        score: c.score,
        uses: c.uses,
        isComposite: true as const,
        outcomeKind: resolveCompositeOutcomeKind(c),
      })),
    ...atomicStates
      .filter((a) => resolveAtomicOutcomeKind(a) === "anti-pattern" || a.score < 0)
      .map((a) => ({
        name: a.name,
        score: a.score,
        uses: a.uses,
        isComposite: false as const,
        outcomeKind: resolveAtomicOutcomeKind(a),
      })),
  ];
  avoid.sort(rankSkillHint);

  return { atoms, ranked, avoid };
}

/**
 * Skill-conditioned DAG helper: returns proven/correctable refs plus anti-patterns
 * to avoid, without bumping composite use counters (read-only for plan packaging).
 */
export async function suggestSkillConditionHints(
  client: GraphClient,
  task: string,
  maxHints: number
): Promise<SkillConditionHints> {
  const { ranked, avoid } = await collectTaskSkillCandidates(client, task);
  const skillRefs = ranked
    .filter((item) => item.outcomeKind !== "anti-pattern")
    .slice(0, Math.max(0, maxHints))
    .map((item) => item.name);
  const avoidPatterns = avoid
    .slice(0, Math.max(0, maxHints))
    .map((item) => item.name)
    .filter((name) => !skillRefs.includes(name));
  return { skillRefs, avoidPatterns };
}

export async function suggestSkillHints(
  client: GraphClient,
  task: string,
  maxHints: number
): Promise<string[]> {
  const { ranked } = await collectTaskSkillCandidates(client, task);
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
        ...(item.state.hasSymbolEvidence === true ? { hasSymbolEvidence: true } : {}),
        ...(item.state.seeded === true ? { seeded: true } : {}),
        ...(item.state.outcomeKind ? { outcomeKind: item.state.outcomeKind } : {}),
        ...(item.state.provenance ? { provenance: item.state.provenance } : {}),
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
const DECAY_MAX_PERIODS = 4;

export interface SkillDecayResult {
  total: number;
  decayed: number;
  skipped: number;
}

/**
 * Deterministic dual-evidence forgetting. Staleness expands the decay budget,
 * failures accelerate it, and bound successful episodes retain score. The
 * returned amount is always a non-negative magnitude; the caller applies it
 * toward zero.
 */
export function computeAdaptiveDecayAmount(
  skill: Pick<
    SkillState,
    | "score"
    | "uses"
    | "lastOutcome"
    | "updatedAt"
    | "lastDecayedAt"
    | "successCount"
    | "successEpisodeIds"
    | "failStreak"
    | "outcomeKind"
    | "linkedSuccess"
    | "provenance"
  >,
  now: number
): number {
  const referenceTime = skill.lastDecayedAt ?? skill.updatedAt;
  const elapsedPeriods = Math.floor((now - referenceTime) / DECAY_THRESHOLD_MS);
  if (!Number.isFinite(elapsedPeriods) || elapsedPeriods < 1) {
    return 0;
  }

  const stalePeriods = Math.min(elapsedPeriods, DECAY_MAX_PERIODS);
  const stalenessFactor = 1 + 0.25 * (stalePeriods - 1);

  const persistedSuccesses =
    typeof skill.successCount === "number" && Number.isFinite(skill.successCount)
      ? Math.max(0, Math.floor(skill.successCount))
      : 0;
  const episodeSuccesses = Array.isArray(skill.successEpisodeIds)
    ? new Set(skill.successEpisodeIds.filter(Boolean)).size
    : 0;
  const legacySuccess =
    skill.linkedSuccess === true && skill.provenance?.episodeId ? 1 : 0;
  const successEvidence = Math.min(
    Math.max(persistedSuccesses, episodeSuccesses, legacySuccess),
    5
  );
  const successRetention = 1 / (1 + 0.5 * successEvidence);

  const failureEvidence = Math.min(
    Math.max(
      typeof skill.failStreak === "number" && Number.isFinite(skill.failStreak)
        ? Math.max(0, Math.floor(skill.failStreak))
        : 0,
      skill.lastOutcome === "fail" ? 1 : 0
    ),
    4
  );
  const failureFactor = 1 + 0.25 * failureEvidence;

  const isProvenWithRealEvidence =
    skill.outcomeKind === "proven" &&
    Math.max(persistedSuccesses, episodeSuccesses, legacySuccess) >= 2;
  const provenFactor = isProvenWithRealEvidence ? 0.5 : 1;
  const amount = stalenessFactor * failureFactor * successRetention * provenFactor;

  // Keep the curve portable across JSON round-trips while avoiding float dust.
  return Math.round(amount * 1000) / 1000;
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
    if ((now - lastDecayedAt) / DECAY_THRESHOLD_MS < 1) {
      skipped += 1;
      continue;
    }

    const decayAmount = computeAdaptiveDecayAmount(skill, now);
    if (decayAmount <= 0) {
      skipped += 1;
      continue;
    }

    const currentScore = boundedScore(skill.score);
    let newScore = currentScore;
    if (currentScore > 0) {
      newScore = Math.max(0, currentScore - decayAmount);
    } else if (currentScore < 0) {
      newScore = Math.min(0, currentScore + decayAmount);
    }

    if (newScore === currentScore) {
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
