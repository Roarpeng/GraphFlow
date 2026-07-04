import type { GraphClient } from "../graph/client-factory";
import { indexChanges, type ChangeRecord } from "../graph/graph-indexer";

export async function syncGraphAfterRun(
  client: GraphClient,
  changes: ChangeRecord[],
  _configPath?: string
): Promise<{ indexed: number; enriched: number }> {
  if (changes.length === 0) {
    return { indexed: 0, enriched: 0 };
  }

  await indexChanges(client, changes);
  const indexed = changes.length;

  // Semantic enrichment removed (module deleted).
  const enriched = 0;

  return { indexed, enriched };
}
