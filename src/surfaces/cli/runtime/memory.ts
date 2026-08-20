import { resolveConfig } from "../../../config/resolve";
import { createEmbeddingProviderFromConfig } from "../../../config/embedding-factory";
import { createGraphClient } from "../../../graph/client-factory";
import {
  extractTaskTokens,
  findSimilarEpisodes,
  forgetEpisode as forgetEpisodeRecord,
  parseEpisodes,
  type EpisodeRecord,
} from "../../../learning/episodic-memory";

/**
 * Memory audit runtime (v1.9+): cross-session episodic memory must be
 * "evidence, not judge" — auditable and attributable. These functions expose
 * the raw evidence records (list), a semantic similarity view (search), and a
 * single-record forget path (quarantine descendant skills, then prune the
 * episode) so the graph store stays transparent and controllable.
 */

/** Outcomes surfaced by the audit CLI. "human_review" is shown as pending, matching the flywheel report. */
export type MemoryOutcome = "pass" | "fail" | "pending";

/** One evidence record from the episodic memory store. */
export interface MemoryEpisodeItem {
  id: string;
  task: string;
  outcome: MemoryOutcome;
  lessons: number;
  /** Present when the goal moved and this episode was flagged stale (goal-anchor). */
  staleGoal?: string;
  updatedAt: number;
}

/** One ranked hit from memory search. */
export interface MemorySearchHit {
  id: string;
  task: string;
  /** Jaccard token-overlap with the query (0..1); the auditable lexical evidence behind the ranking. */
  score: number;
  outcome: MemoryOutcome;
}

export interface MemoryForgetResult {
  found: boolean;
  removed: boolean;
  /** Skills soft-hidden via provenance.episodeId (SkillJack descendant revoke). */
  skillsHidden: number;
  skillIds: string[];
  reason?: string;
}

export interface ListEpisodesOptions {
  limit?: number;
  outcome?: MemoryOutcome;
}

/**
 * List episodes as evidence records, sorted by updatedAt descending.
 * Reads raw node metadata so the staleGoal flag (set by goal-anchor when a
 * pending episode is invalidated by a new goal) is visible next to the record.
 */
export async function listEpisodes(
  configPath?: string,
  options?: ListEpisodesOptions
): Promise<MemoryEpisodeItem[]> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);

  const nodes = await graphClient.queryByKeyword("episode");
  const items: MemoryEpisodeItem[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const [rec] = parseEpisodes([node]);
    if (!rec || seen.has(rec.id)) {
      continue;
    }
    seen.add(rec.id);
    const outcome = normalizeOutcome(rec.outcome);
    if (options?.outcome && outcome !== options.outcome) {
      continue;
    }
    items.push({
      id: rec.id,
      task: truncate(rec.task, 80),
      outcome,
      lessons: rec.lessons.length,
      ...(typeof node.metadata?.staleGoal === "string"
        ? { staleGoal: node.metadata.staleGoal }
        : {}),
      updatedAt: rec.updatedAt,
    });
  }

  // Deterministic audit order: updatedAt desc, then id asc (recordings can
  // share the same millisecond — ties must not make output order unstable).
  items.sort((a, b) => {
    const byTime = b.updatedAt - a.updatedAt;
    if (byTime !== 0) {
      return byTime;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (options?.limit && options.limit > 0) {
    return items.slice(0, options.limit);
  }
  return items;
}

/**
 * Semantic similarity search over episodes. Ranking reuses findSimilarEpisodes
 * (embedding cosine when the provider is available, FNV-hash/Jaccard fallback
 * otherwise); each hit carries its Jaccard token-overlap score as evidence.
 */
export async function searchEpisodes(
  query: string,
  configPath?: string,
  limit = 10
): Promise<MemorySearchHit[]> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const embeddingProvider = createEmbeddingProviderFromConfig(config);
  const episodes = await findSimilarEpisodes(graphClient, query, limit, embeddingProvider);

  const queryTokens = new Set(extractTaskTokens(query));
  return episodes.map((rec) => ({
    id: rec.id,
    task: truncate(rec.task, 80),
    score: jaccardScore(rec.task, queryTokens),
    outcome: normalizeOutcome(rec.outcome),
  }));
}

/**
 * Forget one episode: quarantine skills derived from it, then prune the
 * episode node (auditable, not hard-delete). Unknown ids are a clean no-op.
 */
export async function forgetEpisode(
  episodeId: string,
  configPath?: string
): Promise<MemoryForgetResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);

  if (!episodeId.startsWith("episode:")) {
    return { found: false, removed: false, skillsHidden: 0, skillIds: [], reason: "not-an-episode" };
  }

  const result = await forgetEpisodeRecord(graphClient, episodeId);
  return {
    found: result.found,
    removed: result.pruned,
    skillsHidden: result.hidden,
    skillIds: result.ids,
    ...(result.found ? {} : { reason: "not-found" }),
  };
}

function normalizeOutcome(outcome: EpisodeRecord["outcome"]): MemoryOutcome {
  if (outcome === "pass" || outcome === "fail") {
    return outcome;
  }
  return "pending";
}

function jaccardScore(task: string, queryTokens: Set<string>): number {
  const recTokens = new Set(extractTaskTokens(task));
  let intersection = 0;
  for (const token of recTokens) {
    if (queryTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...recTokens, ...queryTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}
