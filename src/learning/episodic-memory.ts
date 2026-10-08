import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";
import {
  attachEmbedding,
  cosineSimilarity,
  extractEmbedding,
  type EmbeddingProvider,
} from "./embeddings";
import {
  distillWorkflowFromEpisode,
  quarantineSkillsFromEpisode,
} from "./workflow-skill";
import {
  extractGoldenEvidenceTokens,
  registerGoldenEvidenceTokens,
} from "./skill-admission";
import {
  resolveAntiPatternLessonsForTask,
  upsertAntiPatternLessonsFromEpisode,
} from "./skill-flywheel";
import {
  normalizeOutcomeEvidence,
  type OutcomeEvidence,
  type OutcomeEvidenceInput,
} from "./evidence";
import {
  buildProvenance,
  evaluateWriteSalienceSafe,
  resolveWriteGateMode,
  type ExistingMemory,
  type GateDecision,
  type MemoryProvenance,
  type WriteCandidate,
  type WriteGateMode,
  type WriteGateOptions,
  type WriteSource,
} from "./memory-gate";

export { quarantineSkillsFromEpisode };

export interface EpisodeRecord {
  id: string;
  task: string;
  plan: Array<{ id: string; description: string }>;
  outcome: "pass" | "fail" | "human_review" | "pending";
  keyDecisions: string[];
  lessons: string[];
  attempts: number;
  executionRounds?: string[][];
  createdAt: number;
  updatedAt: number;
  runFeedback?: string;
  /** Worker's final textual answer (persisted so a COMPLETED episode stays auditable). */
  result?: string;
  /**
   * P1 — Drift classification: WHY the work deviated from the original goal
   * anchor (or "none" when it stayed aligned). Makes deviation measurable and
   * learnable instead of collapsing every outcome into pass/fail.
   */
  deviation?: DeviationKind;
  /** P0 evidence package: commit + diff + tests + confirmation. */
  evidence?: OutcomeEvidence;
  /**
   * U1 cost ledger — token totals for the calls this episode burned, attached
   * at outcome-report time so a pass/fail verdict always carries its bill.
   */
  costSummary?: EpisodeCostSummary;
}

/** U1 — per-episode token totals (see EpisodeRecord.costSummary). */
export interface EpisodeCostSummary {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  calls: number;
}

/** Drift taxonomy shared by alignment-check submit and outcome report. */
export const DEVIATION_KINDS = [
  "none",
  "misread-requirement",
  "scope-creep",
  "tech-drift",
] as const;

export type DeviationKind = (typeof DEVIATION_KINDS)[number];

export function isDeviationKind(value: unknown): value is DeviationKind {
  return typeof value === "string" && (DEVIATION_KINDS as readonly string[]).includes(value);
}

const EPISODE_PREFIX = "episode:";
const EPISODE_SENTINEL = "episode";

let idCounter = 0;

/**
 * Episode nodes recorded by this process (bounded, oldest evicted first). A
 * long-lived server keeps them so an outcome report still resolves its own
 * episode after the backing store file was swapped underneath it.
 */
const RECENT_EPISODE_LIMIT = 128;
const recentEpisodeNodes = new Map<string, GraphNode>();

function rememberEpisodeNode(node: GraphNode): void {
  recentEpisodeNodes.delete(node.id);
  recentEpisodeNodes.set(node.id, node);
  while (recentEpisodeNodes.size > RECENT_EPISODE_LIMIT) {
    const oldest = recentEpisodeNodes.keys().next().value;
    if (oldest === undefined) break;
    recentEpisodeNodes.delete(oldest);
  }
}

/**
 * Re-insert an episode this process recorded when the client no longer has
 * it. Returns false when the id is unknown here or the store already has it.
 */
export async function restoreRecentEpisode(client: GraphClient, episodeId: string): Promise<boolean> {
  const remembered = recentEpisodeNodes.get(episodeId);
  if (!remembered) return false;
  if (client.getNodesByIds) {
    const existing = await client.getNodesByIds([episodeId]);
    if (existing.some((n) => n.id === episodeId)) return false;
  }
  await client.upsertNodes([remembered]);
  return true;
}

export function extractTaskTokens(task: string): string[] {
  const out = new Set<string>();
  for (const raw of task.toLowerCase().split(/\s+/)) {
    const t = raw.replace(/[^a-z0-9_]/g, "");
    if (t.length >= 3) out.add(t);
  }
  return Array.from(out);
}

/**
 * Pure Jaccard similarity between two task texts over extractTaskTokens —
 * the same baseline the episode ranking uses. Exported so consumers of
 * `similarEpisodes` (the efficiency advisory) can gate on SIMILARITY rather
 * than the outcome-derived `score` (pass=1/pending=0/fail=-1); conflating
 * the two made ADAPT fire whenever any pass episode ranked top-3.
 */
export function taskSimilarity(a: string, b: string): number {
  const aTokens = new Set(extractTaskTokens(a));
  const bTokens = new Set(extractTaskTokens(b));
  let inter = 0;
  for (const t of bTokens) {
    if (aTokens.has(t)) inter += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * M2 write-gate knobs for recordEpisode. Every field is optional and purely
 * additive: omitting the whole options object keeps the previous call shape.
 */
export interface EpisodeWriteGateOptions {
  /** Force a gate mode, overriding GRAPHFLOW_WRITE_GATE (used by tests/embedders). */
  mode?: WriteGateMode;
  /** Threshold overrides forwarded to evaluateWriteSalience. */
  thresholds?: WriteGateOptions;
  /**
   * Caller-declared provenance for this episode. Defaults to agent-reported:
   * growth-plan §1.5 — a self-reported boolean outcome is weak evidence, so the
   * gate must not pretend it was verified.
   */
  source?: WriteSource;
  /**
   * Extra memories to weigh against (skills/dialogue/lessons). Episode history is
   * read from the graph automatically; this only adds to it.
   */
  existing?: ExistingMemory[];
}

export async function recordEpisode(
  client: GraphClient,
  episode: Omit<EpisodeRecord, "id" | "createdAt" | "updatedAt">,
  embeddingProvider?: EmbeddingProvider,
  gateOptions?: EpisodeWriteGateOptions
): Promise<EpisodeRecord> {
  const now = Date.now();
  idCounter += 1;
  const id = `${EPISODE_PREFIX}${hashText(`${episode.task}|${now}|${idCounter}`)}`;
  const record: EpisodeRecord = {
    id,
    task: episode.task,
    plan: episode.plan,
    outcome: episode.outcome,
    keyDecisions: (episode.keyDecisions ?? []).slice(0, 6),
    lessons: (episode.lessons ?? []).slice(0, 4),
    attempts: episode.attempts,
    ...(episode.executionRounds ? { executionRounds: episode.executionRounds } : {}),
    createdAt: now,
    updatedAt: now,
      ...(episode.runFeedback !== undefined ? { runFeedback: episode.runFeedback } : {}),
      ...(episode.result !== undefined ? { result: episode.result } : {}),
      ...(episode.deviation !== undefined ? { deviation: episode.deviation } : {}),
      ...(episode.evidence !== undefined ? { evidence: episode.evidence } : {}),
      ...(episode.costSummary !== undefined ? { costSummary: episode.costSummary } : {}),
  };

  // M2 写入门控：episode 写入在落库前过一遍复合显著性判定（来源 / 新颖度 /
  // 冲突 / 持久性 / 噪声），裁决与来源链写入节点 metadata。
  // 门控自身永不抛异常、永不阻断既有调用方；默认 advisory 模式只判定与标注，
  // 不丢弃证据（原始 episode 是一等证据，见 growth-plan §M7）。
  const gateMode = gateOptions?.mode ?? resolveWriteGateMode();
  let gateDecision: GateDecision | undefined;
  let provenance: MemoryProvenance | undefined;
  if (gateMode !== "off") {
    const candidate: WriteCandidate = {
      id,
      kind: "episode",
      content: episodeGateContent(record),
      task: record.task,
      // 原始 episode 是持久证据，不是临时决策：durable 恒为 true。
      durable: true,
      source: gateOptions?.source ?? { kind: "agent-reported", ref: id },
      createdAt: now,
    };
    const existing = [
      ...(gateOptions?.existing ?? []),
      ...(await loadExistingEpisodeMemories(client)),
    ];
    gateDecision = evaluateWriteSalienceSafe(
      candidate,
      { existing, now },
      gateOptions?.thresholds
    );
    provenance = buildProvenance(candidate, gateDecision, now).provenance;
    // enforce 是显式开启的严格模式：reject 的写入不落库，但仍返回 record，
    // 以保持 recordEpisode 的返回契约不变。
    if (gateMode === "enforce" && gateDecision.decision === "reject") {
      return record;
    }
  }

  const node: GraphNode = {
    id,
    type: "Decision",
    content: `${EPISODE_SENTINEL} ${truncate(episode.task, 160)}`,
    metadata: {
      record: serialize(record),
      kind: EPISODE_SENTINEL,
      ...(gateDecision !== undefined
        ? {
            writeGate: {
              decision: gateDecision.decision,
              score: gateDecision.score,
              reasons: gateDecision.reasons,
              mode: gateMode,
              evaluatedAt: now,
              ...(gateDecision.conflictWith
                ? { conflictWith: gateDecision.conflictWith }
                : {}),
            },
          }
        : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    },
  };

  // 若 embedding provider 可用，计算任务描述的 embedding 并附加到节点 metadata，
  // 供后续 findSimilarEpisodes 做语义余弦检索；计算失败则优雅降级为无语义向量。
  let episodeNode = node;
  if (embeddingProvider) {
    try {
      const emb = await embeddingProvider.embed(episode.task);
      if (Array.isArray(emb) && emb.length > 0) {
        // Same writer as code nodes: int8 storage plus the model stamp. A raw
        // float32 `metadata.embedding` carries no model, so it reads as
        // compatible forever and never migrates when the model changes.
        episodeNode = attachEmbedding(node, emb, embeddingProvider.fingerprint?.());
      }
    } catch {
      // embedding 计算失败不应阻断 episode 记录，降级为无语义向量
    }
  }

  await client.upsertNodes([episodeNode]);
  rememberEpisodeNode(episodeNode);
  return record;
}

/**
 * Update an existing episode's outcome after an external agent reports back.
 * This closes the learning loop in bridge mode: the episode is initially
 * recorded as "pending", and the external coding agent calls this to report
 * whether execution succeeded, optionally providing lessons learned.
 */
export async function updateEpisodeOutcome(
  client: GraphClient,
  episodeId: string,
  outcome: "pass" | "fail",
  lessons?: string[],
  deviation?: DeviationKind,
  evidenceInput?: OutcomeEvidenceInput,
  costSummary?: EpisodeCostSummary
): Promise<EpisodeRecord | undefined> {
  if (!client.getNodesByIds) {
    return undefined;
  }
  const nodes = await client.getNodesByIds([episodeId]);
  const node = nodes.find((n) => n.id === episodeId);
  if (!node || !isEpisodeNode(node)) {
    return undefined;
  }
  const rec = deserialize(node);
  if (!rec) {
    return undefined;
  }
  const updated: EpisodeRecord = {
    ...rec,
    outcome,
    lessons: lessons ? lessons.slice(0, 4) : rec.lessons,
    ...(deviation !== undefined ? { deviation } : {}),
    ...(normalizeOutcomeEvidence(evidenceInput)
      ? { evidence: normalizeOutcomeEvidence(evidenceInput)! }
      : {}),
    ...(costSummary !== undefined ? { costSummary } : {}),
    updatedAt: Date.now(),
  };
  const updatedNode: GraphNode = {
    ...node,
    metadata: { ...node.metadata, record: serialize(updated) },
  };
  await client.upsertNodes([updatedNode]);
  if (recentEpisodeNodes.has(episodeId)) rememberEpisodeNode(updatedNode);
  if (outcome === "pass") {
    // U5 negative knowledge base: a pass on this task retires its unresolved
    // anti-pattern lessons so they stop injecting into plan prompts.
    // Best-effort — must never block outcome reporting.
    try {
      await resolveAntiPatternLessonsForTask(client, updated.task);
    } catch {
      // 教训退出失败不影响 outcome 回填
    }
    // 叠加真实 episode/symbol 证据到动态 golden 词集：pass episode 的
    // plan 描述 / keyDecisions 是执行成功的真实符号证据（best-effort，
    // 失败不阻断 outcome 回填）。
    try {
      registerGoldenEvidenceTokens(
        extractGoldenEvidenceTokens([
          updated.task,
          ...updated.plan.map((p) => p.description),
          ...updated.keyDecisions,
        ])
      );
    } catch {
      // 证据词叠加失败不影响 outcome 回填
    }
    if (updated.plan.length >= 2) {
      try {
        await distillWorkflowFromEpisode(client, updated);
      } catch {
        // Distillation must never block outcome reporting.
      }
    }
  } else if (updated.lessons.length > 0) {
    // U5 negative knowledge base: a failing episode's reported lessons become
    // anti-pattern-lesson Decision nodes (injected only after the failCount
    // precision gate). Task echoes are filtered inside the upsert.
    // Best-effort — must never block outcome reporting.
    try {
      await upsertAntiPatternLessonsFromEpisode(client, {
        id: updated.id,
        task: updated.task,
        lessons: updated.lessons,
      });
    } catch {
      // 负知识沉淀失败不影响 outcome 回填
    }
  }
  return updated;
}

/**
 * Load a single episode record (including its plan) by node id.
 */
export async function loadEpisode(
  client: GraphClient,
  episodeId: string
): Promise<EpisodeRecord | undefined> {
  const node = await loadEpisodeNode(client, episodeId);
  if (!node) return undefined;
  return deserialize(node);
}

/**
 * Forget one episode: quarantine descendant skills (SkillJack hide, not
 * delete), then mark the episode pruned so it stays auditable.
 */
export async function forgetEpisode(
  client: GraphClient,
  episodeId: string
): Promise<{ found: boolean; hidden: number; ids: string[]; pruned: boolean }> {
  const { hidden, ids } = await quarantineSkillsFromEpisode(client, episodeId);
  const node = await loadEpisodeNode(client, episodeId);
  if (!node) {
    return { found: false, hidden, ids, pruned: false };
  }

  const rec = deserialize(node);
  const lessons = rec
    ? ["forgotten", ...rec.lessons.filter((lesson) => lesson !== "forgotten")].slice(0, 4)
    : ["forgotten"];
  const updatedRecord = rec
    ? { ...rec, lessons, updatedAt: Date.now() }
    : undefined;

  await client.upsertNodes([
    {
      ...node,
      metadata: {
        ...node.metadata,
        pruned: true,
        ...(updatedRecord ? { record: serialize(updatedRecord) } : {}),
      },
    },
  ]);
  return { found: true, hidden, ids, pruned: true };
}

async function loadEpisodeNode(
  client: GraphClient,
  episodeId: string
): Promise<GraphNode | undefined> {
  if (client.getNodesByIds) {
    const nodes = await client.getNodesByIds([episodeId]);
    const node = nodes.find((candidate) => candidate.id === episodeId);
    if (node && isEpisodeNode(node)) return node;
  }
  const hits = await client.queryByKeyword(episodeId);
  return hits.find((candidate) => candidate.id === episodeId && isEpisodeNode(candidate));
}

export async function findSimilarEpisodes(
  client: GraphClient,
  task: string,
  limit = 3,
  embeddingProvider?: EmbeddingProvider
): Promise<EpisodeRecord[]> {
  const queryTokens = new Set(extractTaskTokens(task));
  const candidateNodes = await collectEpisodeCandidates(client, task, Array.from(queryTokens));

  // 解析候选节点为 (record, embedding) 对，过滤软删除与重复
  const pairs: Array<{ rec: EpisodeRecord; embedding: number[] | null }> = [];
  const seen = new Set<string>();
  for (const node of candidateNodes) {
    if (!isEpisodeNode(node) || seen.has(node.id)) continue;
    if (node.metadata?.pruned === true) continue;
    const rec = deserialize(node);
    if (!rec) continue;
    seen.add(node.id);
    pairs.push({ rec, embedding: extractEmbedding(node) });
  }

  // 计算查询 embedding（若 provider 可用）
  let queryEmbedding: number[] | null = null;
  if (embeddingProvider) {
    try {
      const emb = await embeddingProvider.embed(task);
      if (Array.isArray(emb) && emb.length > 0) {
        queryEmbedding = emb;
      }
    } catch {
      queryEmbedding = null;
    }
  }

  // 仅当查询向量与至少一个 episode 向量都可用时，才启用语义检索
  const hasEmbeddings = queryEmbedding !== null && pairs.some((p) => p.embedding !== null);

  // Jaccard 排名（始终计算，作为基线与降级方案）
  const jaccardScored = pairs.map((p) => {
    const recTokens = new Set(extractTaskTokens(p.rec.task));
    let inter = 0;
    for (const t of recTokens) if (queryTokens.has(t)) inter += 1;
    const union = new Set([...recTokens, ...queryTokens]).size;
    let score = union === 0 ? 0 : inter / union;
    if (p.rec.outcome === "pass") score += 0.1;
    else if (p.rec.outcome === "fail") score -= 0.1;
    return { rec: p.rec, score };
  });
  jaccardScored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.rec.updatedAt - a.rec.updatedAt;
  });
  const jaccardRanking = jaccardScored.map((s) => s.rec);

  // 无可用 embedding 时，回退到纯 Jaccard 逻辑（保持原有行为）
  if (!hasEmbeddings) {
    return jaccardRanking.slice(0, limit);
  }

  // embedding 余弦相似度排名（无向量的 episode 得分为 0，排到后面）
  const embScored = pairs.map((p) => {
    let score = p.embedding ? cosineSimilarity(queryEmbedding!, p.embedding) : 0;
    if (p.rec.outcome === "pass") score += 0.1;
    else if (p.rec.outcome === "fail") score -= 0.1;
    return { rec: p.rec, score };
  });
  embScored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.rec.updatedAt - a.rec.updatedAt;
  });
  const embRanking = embScored.map((s) => s.rec);

  // 用 RRF 融合 Jaccard 与 embedding 两种排名，兼顾词面匹配与语义相似
  return fuseEpisodeRankings([jaccardRanking, embRanking], limit);
}

/**
 * 对多路 episode 排名做 Reciprocal Rank Fusion（RRF）。
 * 与 embeddings.ts 中基于 GraphNode 的 reciprocalRankFusion 等价，但作用于 EpisodeRecord。
 */
function fuseEpisodeRankings(rankings: EpisodeRecord[][], limit: number, k = 60): EpisodeRecord[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, { rec: EpisodeRecord; order: number }>();
  let order = 0;
  for (const list of rankings) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const rec = list[rank];
      if (!rec) continue;
      scores.set(rec.id, (scores.get(rec.id) ?? 0) + 1 / (k + rank + 1));
      if (!firstSeen.has(rec.id)) {
        firstSeen.set(rec.id, { rec, order: order++ });
      }
    }
  }
  const entries = Array.from(firstSeen.values()).map(({ rec, order: o }) => ({
    rec,
    score: scores.get(rec.id) ?? 0,
    order: o,
  }));
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });
  return entries.slice(0, limit).map((e) => e.rec);
}

/**
 * Every episode in the store.
 *
 * This used to go through `queryByKeyword`, which is `LIMIT 200` in SQLite
 * (`sqlite-client.ts:280,290`) — so "all" silently stopped at 200 and anything
 * past that vanished from `memory list`, the flywheel report and outcome
 * reconciliation. The snapshot is the only complete read; the keyword path
 * stays as the fallback for clients that cannot take one.
 */
export async function loadAllEpisodes(client: GraphClient): Promise<EpisodeRecord[]> {
  const snapshot = client.readSnapshot?.();
  if (snapshot) return parseEpisodes(snapshot.nodes);
  return parseEpisodes(await client.queryByKeyword(EPISODE_SENTINEL));
}

const LESSON_PREFIX = "lesson:";

async function getLessonsForEpisode(
  client: GraphClient,
  episodeId: string
): Promise<Array<{ lesson: string }>> {
  if (typeof client.getNeighbors !== "function") return [];
  const neighbors = await client.getNeighbors([episodeId], ["improves"], "in");
  const lessons: Array<{ lesson: string }> = [];
  for (const { node } of neighbors) {
    if (!node.id.startsWith(LESSON_PREFIX)) continue;
    const raw =
      typeof node.metadata?.record === "string"
        ? (node.metadata.record as string)
        : undefined;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { lesson?: string };
      if (parsed.lesson) {
        lessons.push({ lesson: parsed.lesson });
      }
    } catch {
      // ignore malformed lesson record
    }
  }
  return lessons;
}

export async function summarizeEpisodeForPrompt(
  episode: EpisodeRecord,
  client?: GraphClient
): Promise<string> {
  const header = `Past episode (outcome=${episode.outcome}): ${truncate(episode.task, 80)}`;
  const lines: string[] = [header];
  for (const d of episode.keyDecisions.slice(0, 3)) {
    lines.push(`- decision: ${truncate(d, 80)}`);
  }
  for (const l of episode.lessons.slice(0, 2)) {
    lines.push(`- lesson: ${truncate(l, 80)}`);
  }

  if (client) {
    try {
      const lessons = await getLessonsForEpisode(client, episode.id);
      for (const { lesson } of lessons) {
        lines.push(`- lesson: ${truncate(lesson, 80)}`);
      }
    } catch {
      // ignore graph query failures
    }
  }

  let result = lines.join("\n");
  if (result.length > 200) {
    result = `${result.slice(0, 197)}...`;
  }
  return result;
}

async function collectEpisodeCandidates(
  client: GraphClient,
  task: string,
  tokens: string[]
): Promise<GraphNode[]> {
  const seen = new Map<string, GraphNode>();
  const add = (nodes: GraphNode[]) => {
    for (const n of nodes) {
      if (isEpisodeNode(n)) seen.set(n.id, n);
    }
  };

  add(await client.queryByKeyword(task));
  for (const tok of tokens) {
    add(await client.queryByKeyword(tok));
  }
  if (seen.size === 0) {
    add(await client.queryByKeyword(EPISODE_SENTINEL));
  }
  return Array.from(seen.values());
}

export function parseEpisodes(nodes: GraphNode[]): EpisodeRecord[] {
  const out: EpisodeRecord[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!isEpisodeNode(node) || seen.has(node.id)) continue;
    // 过滤已被软删除的 episode
    if (node.metadata?.pruned === true) continue;
    const rec = deserialize(node);
    if (rec) {
      seen.add(node.id);
      out.push(rec);
    }
  }
  return out;
}

function isEpisodeNode(node: GraphNode): boolean {
  return node.id.startsWith(EPISODE_PREFIX);
}

function serialize(record: EpisodeRecord): string {
  return JSON.stringify(record);
}

function deserialize(node: GraphNode): EpisodeRecord | undefined {
  const raw =
    typeof node.metadata?.record === "string"
      ? (node.metadata.record as string)
      : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<EpisodeRecord>;
    if (!parsed.id || !parsed.task || !parsed.outcome) return undefined;
    return {
      id: parsed.id,
      task: parsed.task,
      plan: Array.isArray(parsed.plan) ? parsed.plan : [],
      outcome: parsed.outcome,
      keyDecisions: Array.isArray(parsed.keyDecisions) ? parsed.keyDecisions : [],
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      attempts: parsed.attempts ?? 0,
      ...(parsed.executionRounds ? { executionRounds: parsed.executionRounds } : {}),
      createdAt: parsed.createdAt ?? 0,
      updatedAt: parsed.updatedAt ?? 0,
      ...(parsed.runFeedback !== undefined ? { runFeedback: parsed.runFeedback } : {}),
      ...(typeof parsed.result === "string" && parsed.result.length > 0 ? { result: parsed.result } : {}),
      ...(isDeviationKind(parsed.deviation) ? { deviation: parsed.deviation } : {}),
      ...(parsed.evidence ? { evidence: parsed.evidence as OutcomeEvidence } : {}),
      ...(parsed.costSummary ? { costSummary: parsed.costSummary } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * 门控判定用的 episode 文本视图：task + outcome + decisions + lessons + plan 描述。
 * outcome 计入文本，使「同一 task 的 pass 与 fail」能被门控识别为互斥结论。
 */
function episodeGateContent(record: EpisodeRecord): string {
  return [
    record.task,
    `outcome=${record.outcome}`,
    ...record.keyDecisions,
    ...record.lessons,
    ...record.plan.map((step) => step.description),
  ].join(" ");
}

/**
 * 读取既有 episode 作为门控的对照集（best-effort）：
 * 只读叶子字段，跳过软删除节点，读取失败时返回空数组 —— 门控必须容忍读路径失败，
 * 绝不因为读不到既有记忆就阻断写入。
 */
async function loadExistingEpisodeMemories(client: GraphClient): Promise<ExistingMemory[]> {
  try {
    const nodes = await client.queryByKeyword(EPISODE_SENTINEL);
    const out: ExistingMemory[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      if (!isEpisodeNode(node) || seen.has(node.id)) continue;
      if (node.metadata?.pruned === true) continue;
      const rec = deserialize(node);
      if (!rec) continue;
      seen.add(node.id);
      out.push({
        id: rec.id,
        kind: "episode",
        content: episodeGateContent(rec),
        task: rec.task,
        createdAt: rec.createdAt,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export interface PruneOptions {
  maxAge?: number;
  maxCount?: number;
}

const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 天
const DEFAULT_MAX_COUNT = 200;

/**
 * 软删除过期或超量的 episode 节点
 * 由于 GraphClient 无 deleteNode，采用 metadata.pruned 标记
 */
export async function pruneExpiredEpisodes(
  client: GraphClient,
  options?: PruneOptions
): Promise<{ pruned: number }> {
  const maxAge = options?.maxAge ?? DEFAULT_MAX_AGE;
  const maxCount = options?.maxCount ?? DEFAULT_MAX_COUNT;
  const now = Date.now();

  const allNodes = await client.queryByKeyword(EPISODE_SENTINEL);
  const episodeNodes = allNodes.filter(
    (n) => isEpisodeNode(n) && n.metadata?.pruned !== true
  );

  // 反序列化并按 createdAt 新→旧排序
  const withRecord: { node: GraphNode; createdAt: number }[] = [];
  for (const node of episodeNodes) {
    const rec = deserialize(node);
    withRecord.push({ node, createdAt: rec?.createdAt ?? 0 });
  }
  withRecord.sort((a, b) => b.createdAt - a.createdAt);

  const toPrune: GraphNode[] = [];

  // 按 maxAge 淘汰
  const cutoff = now - maxAge;
  const surviving: typeof withRecord = [];
  for (const item of withRecord) {
    if (item.createdAt < cutoff) {
      toPrune.push(item.node);
    } else {
      surviving.push(item);
    }
  }

  // 按 maxCount 淘汰（从旧到新删除多余的）
  if (surviving.length > maxCount) {
    const excess = surviving.slice(maxCount);
    for (const item of excess) {
      toPrune.push(item.node);
    }
  }

  if (toPrune.length === 0) {
    return { pruned: 0 };
  }

  // 物理删除（如果客户端支持 deleteNode）或回退到软删除
  if (client.deleteNode) {
    for (const node of toPrune) {
      await client.deleteNode(node.id);
    }
  } else {
    const updates: GraphNode[] = toPrune.map((node) => ({
      ...node,
      metadata: { ...node.metadata, pruned: true },
    }));
    await client.upsertNodes(updates);
  }

  return { pruned: toPrune.length };
}

export async function forgetEpisodes(client: GraphClient): Promise<{ removed: number }> {
  const nodes = await client.queryByKeyword(EPISODE_SENTINEL);
  const episodeNodes = nodes.filter((n) => isEpisodeNode(n));
  let removed = 0;

  for (const node of episodeNodes) {
    if (client.deleteNode) {
      await client.deleteNode(node.id);
    }
    removed += 1;
  }

  return { removed };
}
