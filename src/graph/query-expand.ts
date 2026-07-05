import type { GraphNode } from "../core/types.js";
import type { GraphClient } from "./client-factory.js";
import { reciprocalRankFusion } from "../learning/embeddings.js";
import { expandSearchQueries } from "./graph-utils.js";
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
  const queries = expandSearchQueries(query, workspaceRoot, englishQuery);
  const rankings: GraphNode[][] = [];

  for (const q of queries) {
    const hits = await client.queryByKeyword(q);
    rankings.push(rankNodesForContextQuery(hits, query));
  }

  if (rankings.length <= 1) {
    return rankings[0] ?? [];
  }

  return reciprocalRankFusion(rankings);
}
