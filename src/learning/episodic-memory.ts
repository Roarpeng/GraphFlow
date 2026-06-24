import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";

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
}

const EPISODE_PREFIX = "episode:";
const EPISODE_SENTINEL = "episode";

let idCounter = 0;

export function extractTaskTokens(task: string): string[] {
  const out = new Set<string>();
  for (const raw of task.toLowerCase().split(/\s+/)) {
    const t = raw.replace(/[^a-z0-9_]/g, "");
    if (t.length >= 3) out.add(t);
  }
  return Array.from(out);
}

export async function recordEpisode(
  client: GraphClient,
  episode: Omit<EpisodeRecord, "id" | "createdAt" | "updatedAt">
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
  };

  const node: GraphNode = {
    id,
    type: "Decision",
    content: `${EPISODE_SENTINEL} ${truncate(episode.task, 160)}`,
    metadata: { record: serialize(record), kind: EPISODE_SENTINEL },
  };
  await client.upsertNodes([node]);
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
  lessons?: string[]
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
    updatedAt: Date.now(),
  };
  const updatedNode: GraphNode = {
    ...node,
    metadata: { ...node.metadata, record: serialize(updated) },
  };
  await client.upsertNodes([updatedNode]);
  return updated;
}

export async function findSimilarEpisodes(
  client: GraphClient,
  task: string,
  limit = 3
): Promise<EpisodeRecord[]> {
  const queryTokens = new Set(extractTaskTokens(task));
  const candidateNodes = await collectEpisodeCandidates(client, task, Array.from(queryTokens));
  const records = parseEpisodes(candidateNodes);

  const scored = records.map((rec) => {
    const recTokens = new Set(extractTaskTokens(rec.task));
    let inter = 0;
    for (const t of recTokens) if (queryTokens.has(t)) inter += 1;
    const union = new Set([...recTokens, ...queryTokens]).size;
    let score = union === 0 ? 0 : inter / union;
    if (rec.outcome === "pass") score += 0.1;
    else if (rec.outcome === "fail") score -= 0.1;
    return { rec, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.rec.updatedAt - a.rec.updatedAt;
  });

  return scored.slice(0, limit).map((s) => s.rec);
}

export async function loadAllEpisodes(client: GraphClient): Promise<EpisodeRecord[]> {
  const nodes = await client.queryByKeyword(EPISODE_SENTINEL);
  return parseEpisodes(nodes);
}

export function summarizeEpisodeForPrompt(episode: EpisodeRecord): string {
  const header = `Past episode (outcome=${episode.outcome}): ${truncate(episode.task, 80)}`;
  const lines: string[] = [header];
  for (const d of episode.keyDecisions.slice(0, 3)) {
    lines.push(`- decision: ${truncate(d, 80)}`);
  }
  for (const l of episode.lessons.slice(0, 2)) {
    lines.push(`- lesson: ${truncate(l, 80)}`);
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
    };
  } catch {
    return undefined;
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
