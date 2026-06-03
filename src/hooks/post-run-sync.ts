import type { GraphClient } from "../graph/client-factory";
import { indexChanges, type ChangeRecord } from "../graph/graph-indexer";
import { enrichGraphSemanticsSilent } from "../graph/semantic-enricher";

export async function syncGraphAfterRun(
  client: GraphClient,
  changes: ChangeRecord[]
): Promise<{ indexed: number; enriched: number }> {
  if (changes.length === 0) {
    return { indexed: 0, enriched: 0 };
  }

  await indexChanges(client, changes);
  const indexed = changes.length;

  let enriched = 0;
  try {
    const result = await enrichGraphSemanticsSilent(client, { batchSize: 3 });
    enriched = result.enrichedCount;
  } catch {
    // 富化失败不影响主流程
  }

  return { indexed, enriched };
}
