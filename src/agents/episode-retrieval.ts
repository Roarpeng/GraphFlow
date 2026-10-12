/**
 * episode-retrieval.ts — similar-episode lookup for planning.
 *
 * Before a plan is generated, retrieve the past episodes (and resolved
 * dialogue turns) most similar to the incoming task, so the planner can reuse
 * approaches that passed and avoid recorded failure lessons (ExpeEl-style
 * case injection). Sources and exclusions:
 *
 * - Episode nodes: id prefix `episode:` (written by recordEpisode), carrying a
 *   serialized `EpisodeRecord` in metadata.record. Soft-pruned episodes
 *   (metadata.pruned) and not-yet-resolved outcomes ("pending") are excluded.
 * - Dialogue turns: `dialogue:` nodes (kind "dialogue-turn") are an optional
 *   secondary source; pending turns (no assistantReply) and superseded turns
 *   (invalidAt set by a supersedes edge) are excluded.
 *
 * Similarity = 0.5 * token overlap (Jaccard over symbol-name-style tokens,
 * camelCase/snake split + CJK bigrams) + 0.5 * character-bigram Dice on the
 * task text. Pure and dependency-light: never throws, returns [] on any
 * client failure or empty graph.
 */

import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { isDialogueRecordNode } from "../graph/dialogue-node-match";

export interface RetrievedEpisode {
  episodeId: string;
  taskPreview: string;
  success: boolean;
  lessons: string[];
  deviation?: string;
  relatedSymbols: string[];
  similarity: number;
}

export interface RetrieveSimilarEpisodesOptions {
  limit?: number;
}

const DEFAULT_EPISODE_LIMIT = 3;
const EPISODE_ID_PREFIX = "episode:";
const DIALOGUE_SESSION_ID_PREFIX = "dialogue-session:";
const MAX_LESSONS_PER_EPISODE = 3;
const MAX_RELATED_SYMBOLS = 6;
const TASK_PREVIEW_CHARS = 160;

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}

/**
 * Symbol-name-style tokens: ASCII runs split on camelCase / snake / kebab
 * boundaries (so "planTasks" and "plan tasks" share tokens), plus CJK bigrams
 * (a lone CJK char is kept as its own token).
 */
export function tokenizeTaskText(text: string): Set<string> {
  const out = new Set<string>();
  const asciiRuns = text.match(/[A-Za-z0-9]+/g) ?? [];
  for (const run of asciiRuns) {
    const split = run
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_-]+/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 2);
    for (const token of split) {
      out.add(token);
    }
  }

  let cjkRun = "";
  const flushCjk = () => {
    if (!cjkRun) return;
    if (cjkRun.length === 1) {
      out.add(cjkRun);
    } else {
      for (let index = 0; index + 1 < cjkRun.length; index += 1) {
        out.add(cjkRun.slice(index, index + 2));
      }
    }
    cjkRun = "";
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      cjkRun += ch;
    } else {
      flushCjk();
    }
  }
  flushCjk();
  return out;
}

/** Character bigrams of alphanumeric + CJK content; boundaries never bridge. */
function charBigrams(text: string): Set<string> {
  const out = new Set<string>();
  let previous = "";
  for (const ch of text.toLowerCase()) {
    const cp = ch.codePointAt(0) ?? 0;
    const keep = (cp >= 48 && cp <= 57) || (cp >= 97 && cp <= 122) || isCjkCodePoint(cp);
    if (!keep) {
      previous = "";
      continue;
    }
    if (previous) {
      out.add(previous + ch);
    }
    previous = ch;
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of b) {
    if (a.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function diceBigrams(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const gram of b) {
    if (a.has(gram)) intersection += 1;
  }
  const total = a.size + b.size;
  return total === 0 ? 0 : (2 * intersection) / total;
}

/** Combined similarity of two task texts; deterministic, in [0, 1]. */
export function taskTextSimilarity(query: string, candidate: string): number {
  const score =
    0.5 * jaccard(tokenizeTaskText(query), tokenizeTaskText(candidate)) +
    0.5 * diceBigrams(charBigrams(query), charBigrams(candidate));
  // Round to keep ordering stable against float noise on identical inputs.
  return Math.round(score * 10_000) / 10_000;
}

interface EpisodeCandidate {
  source: "episode" | "dialogue";
  episodeId: string;
  taskText: string;
  success: boolean;
  lessons: string[];
  deviation?: string;
  relatedSymbols: string[];
}

function parseRecord(node: GraphNode): Record<string, unknown> | undefined {
  const raw = node.metadata?.record;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed record → treat as absent
  }
  return undefined;
}

function asStringArray(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, cap);
}

function truncatePreview(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function toEpisodeCandidate(node: GraphNode): EpisodeCandidate | undefined {
  const record = parseRecord(node);
  const outcome = typeof record?.outcome === "string" ? record.outcome : undefined;
  // Unresolved episodes carry no verdict yet — they are not usable precedents.
  if (outcome === "pending") return undefined;
  const taskText =
    typeof record?.task === "string" && record.task.trim().length > 0
      ? record.task
      : node.content.replace(/^episode\s*/i, "");
  if (!taskText.trim()) return undefined;
  return {
    source: "episode",
    episodeId: node.id,
    taskText,
    success: outcome === "pass",
    lessons: asStringArray(record?.lessons, MAX_LESSONS_PER_EPISODE),
    ...(typeof record?.deviation === "string" && record.deviation ? { deviation: record.deviation } : {}),
    relatedSymbols: [],
  };
}

function toDialogueCandidate(node: GraphNode): EpisodeCandidate | undefined {
  if (node.id.startsWith(DIALOGUE_SESSION_ID_PREFIX)) return undefined;
  const record = parseRecord(node);
  const userQuery = typeof record?.userQuery === "string" ? record.userQuery : "";
  if (!userQuery.trim()) return undefined;
  // Pending turns have no answer to learn from; superseded turns carry
  // invalidAt (a later turn corrected their conclusion).
  const assistantReply = typeof record?.assistantReply === "string" ? record.assistantReply : "";
  if (!assistantReply.trim()) return undefined;
  if (typeof record?.invalidAt === "number") return undefined;
  const summary = typeof record?.summary === "string" && record.summary.trim() ? record.summary : undefined;
  return {
    source: "dialogue",
    episodeId: node.id,
    taskText: userQuery,
    success: true,
    lessons: summary ? [summary] : [],
    relatedSymbols: asStringArray(record?.relatedNodeIds, MAX_RELATED_SYMBOLS),
  };
}

function parseCandidates(nodes: GraphNode[]): EpisodeCandidate[] {
  const out: EpisodeCandidate[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node || seen.has(node.id)) continue;
    let candidate: EpisodeCandidate | undefined;
    if (node.id.startsWith(EPISODE_ID_PREFIX)) {
      // Soft-pruned episodes stay auditable but must not inform new plans.
      if (node.metadata?.pruned === true) continue;
      candidate = toEpisodeCandidate(node);
    } else if (isDialogueRecordNode(node)) {
      candidate = toDialogueCandidate(node);
    }
    if (candidate) {
      seen.add(node.id);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Complete node set: prefer the store snapshot (keyword channels are
 * LIMIT-bounded on sqlite); fall back to the sentinel + task keywords.
 */
async function collectCandidateNodes(client: GraphClient, task: string): Promise<GraphNode[]> {
  try {
    const snapshot = client.readSnapshot?.();
    if (snapshot && Array.isArray(snapshot.nodes)) {
      return snapshot.nodes;
    }
  } catch {
    // fall through to keyword channels
  }
  const seen = new Map<string, GraphNode>();
  for (const query of ["episode", "dialogue", task]) {
    try {
      for (const node of await client.queryByKeyword(query)) {
        seen.set(node.id, node);
      }
    } catch {
      // one dead channel must not kill the others
    }
  }
  return Array.from(seen.values());
}

/**
 * Best-effort symbol enrichment for one episode: derived_from edges written
 * by linkEpisodeToEngineeringNodes point at Symbol/File/Requirement targets.
 */
async function fetchRelatedSymbols(client: GraphClient, episodeId: string): Promise<string[]> {
  if (typeof client.getNeighbors !== "function") return [];
  try {
    const neighbors = await client.getNeighbors([episodeId], ["derived_from"], "out");
    const out: string[] = [];
    for (const { node } of neighbors) {
      if (!node) continue;
      if (node.type === "Symbol" || node.id.startsWith("symbol:")) {
        out.push(node.id);
      }
      if (out.length >= MAX_RELATED_SYMBOLS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Top-k past episodes similar to `task`, sorted by similarity desc with a
 * deterministic id tie-break. Never rejects: client failures and empty graphs
 * resolve to [].
 */
export async function retrieveSimilarEpisodes(
  client: GraphClient,
  task: string,
  options?: RetrieveSimilarEpisodesOptions
): Promise<RetrievedEpisode[]> {
  const rawLimit = options?.limit ?? DEFAULT_EPISODE_LIMIT;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_EPISODE_LIMIT;
  const query = task.trim();
  if (!query || !client) return [];

  try {
    const nodes = await collectCandidateNodes(client, query);
    const candidates = parseCandidates(nodes);
    const scored = candidates
      .map((candidate) => ({ candidate, similarity: taskTextSimilarity(query, candidate.taskText) }))
      .filter((entry) => entry.similarity > 0);
    scored.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return a.candidate.episodeId < b.candidate.episodeId
        ? -1
        : a.candidate.episodeId > b.candidate.episodeId
          ? 1
          : 0;
    });

    const results: RetrievedEpisode[] = [];
    for (const { candidate, similarity } of scored.slice(0, limit)) {
      let relatedSymbols = candidate.relatedSymbols;
      if (candidate.source === "episode") {
        const enriched = await fetchRelatedSymbols(client, candidate.episodeId);
        if (enriched.length > 0) relatedSymbols = enriched;
      }
      results.push({
        episodeId: candidate.episodeId,
        taskPreview: truncatePreview(candidate.taskText, TASK_PREVIEW_CHARS),
        success: candidate.success,
        lessons: candidate.lessons.slice(0, MAX_LESSONS_PER_EPISODE),
        ...(candidate.deviation ? { deviation: candidate.deviation } : {}),
        relatedSymbols: relatedSymbols.slice(0, MAX_RELATED_SYMBOLS),
        similarity,
      });
    }
    return results;
  } catch {
    // Retrieval is advisory: any failure degrades to "no similar episodes".
    return [];
  }
}
