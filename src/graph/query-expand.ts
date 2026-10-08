import type { GraphNode } from "../core/types.js";
import type { GraphClient } from "./client-factory.js";
import { reciprocalRankFusion } from "../learning/embeddings.js";
import { buildSearchScoreTokens, expandSearchQueriesWeighted, extractPathTokens } from "./graph-utils.js";
import { rankNodesForContextQuery } from "./graph-utils.js";

/**
 * Run keyword retrieval for the original query plus CJK/path expansions,
 * then fuse rankings with RRF so Chinese questions still hit English code symbols.
 */
export async function collectExpandedKeywordHits(
  client: GraphClient,
  query: string,
  workspaceRoot?: string,
  englishQuery?: string
): Promise<GraphNode[]> {
  const expanded = expandSearchQueriesWeighted(query, workspaceRoot, englishQuery);
  const queries = expanded.map((entry) => entry.query);
  const weights = expanded.map((entry) => entry.weight);
  const baseScoreTokens = buildSearchScoreTokens(query, englishQuery);
  const matchQueries = englishQuery?.trim() ? [query, englishQuery.trim()] : [query];
  const pathHints = extractPathTokens(workspaceRoot);
  const rankings: GraphNode[][] = [];

  for (const q of queries) {
    const hits = await client.queryByKeyword(q);
    const scoreTokens = buildSearchScoreTokens(query, englishQuery, q);
    rankings.push(
      rankNodesForContextQuery(hits, query, {
        scoreTokens: scoreTokens.length > 0 ? scoreTokens : baseScoreTokens,
        matchQueries,
        pathHints,
        ...(englishQuery !== undefined ? { englishQuery } : {}),
      })
    );
  }

  if (rankings.length <= 1) {
    return rankings[0] ?? [];
  }

  return reciprocalRankFusion(rankings, 60, weights);
}
