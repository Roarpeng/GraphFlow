import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import {
  extractTaskTokens,
  loadAllEpisodes,
  type EpisodeRecord,
} from "./episodic-memory";

export interface LessonRecord {
  id: string;
  lesson: string;
  episodeIds: string[];
  supportCount: number;
  outcomes: { pass: number; fail: number };
  updatedAt: number;
}

export interface ReflectOptions {
  taskCluster?: string;
  minCluster?: number;
  maxLessons?: number;
}

const LESSON_PREFIX = "lesson:";
const LESSON_SENTINEL = "lesson";

export async function reflectOnEpisodes(
  client: GraphClient,
  options?: ReflectOptions
): Promise<LessonRecord[]> {
  const minCluster = options?.minCluster ?? 2;
  const maxLessons = options?.maxLessons ?? 3;

  const episodes = await loadAllEpisodes(client);
  const filtered = options?.taskCluster
    ? episodes.filter((ep) =>
        haveTokenOverlap(extractTaskTokens(ep.task), extractTaskTokens(options.taskCluster!), 1)
      )
    : episodes;

  const clusters = buildClusters(filtered);
  const lessons: LessonRecord[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = Date.now();

  for (const cluster of clusters) {
    if (cluster.length < minCluster) continue;

    type Agg = { decision: string; passCount: number; failCount: number; episodeIds: string[] };
    const byDecision = new Map<string, Agg>();
    for (const ep of cluster) {
      const isPass = ep.outcome === "pass";
      const isFail = ep.outcome === "fail";
      for (const decisionRaw of ep.keyDecisions) {
        const decision = decisionRaw.trim();
        if (!decision) continue;
        let agg = byDecision.get(decision);
        if (!agg) {
          agg = { decision, passCount: 0, failCount: 0, episodeIds: [] };
          byDecision.set(decision, agg);
        }
        if (isPass) agg.passCount += 1;
        if (isFail) agg.failCount += 1;
        if (!agg.episodeIds.includes(ep.id)) agg.episodeIds.push(ep.id);
      }
    }

    const eligible = Array.from(byDecision.values()).filter(
      (a) => a.passCount >= 1 && a.failCount <= a.passCount
    );

    eligible.sort((a, b) => {
      const supportDiff = b.episodeIds.length - a.episodeIds.length;
      if (supportDiff !== 0) return supportDiff;
      const passDiff = b.passCount - a.passCount;
      if (passDiff !== 0) return passDiff;
      return a.decision.localeCompare(b.decision);
    });

    for (const agg of eligible.slice(0, maxLessons)) {
      const id = `${LESSON_PREFIX}${hashText(agg.decision)}`;
      const record: LessonRecord = {
        id,
        lesson: agg.decision,
        episodeIds: [...agg.episodeIds],
        supportCount: agg.episodeIds.length,
        outcomes: { pass: agg.passCount, fail: agg.failCount },
        updatedAt: now,
      };
      lessons.push(record);
      nodes.push({
        id,
        type: "Decision",
        content: `${LESSON_SENTINEL} ${truncate(agg.decision, 160)}`,
        metadata: { record: JSON.stringify(record), kind: LESSON_SENTINEL },
      });
      for (const episodeId of agg.episodeIds) {
        edges.push({ from: id, to: episodeId, relation: "improves" });
      }
    }
  }

  if (nodes.length > 0) await client.upsertNodes(nodes);
  if (edges.length > 0) await client.upsertEdges(edges);

  return lessons;
}

function buildClusters(episodes: EpisodeRecord[]): EpisodeRecord[][] {
  const unassigned = episodes.map((ep) => ({ ep, tokens: new Set(extractTaskTokens(ep.task)) }));
  const clusters: EpisodeRecord[][] = [];

  while (unassigned.length > 0) {
    const seed = unassigned.shift()!;
    const cluster: EpisodeRecord[] = [seed.ep];
    for (let i = unassigned.length - 1; i >= 0; i -= 1) {
      const item = unassigned[i]!;
      let inter = 0;
      for (const t of item.tokens) {
        if (seed.tokens.has(t)) {
          inter += 1;
          if (inter >= 2) break;
        }
      }
      if (inter >= 2) {
        cluster.push(item.ep);
        unassigned.splice(i, 1);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function haveTokenOverlap(a: string[], b: string[], min: number): boolean {
  const setB = new Set(b);
  let count = 0;
  for (const t of a) {
    if (setB.has(t)) {
      count += 1;
      if (count >= min) return true;
    }
  }
  return false;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
