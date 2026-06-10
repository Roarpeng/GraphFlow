import { logger } from "../utils/logger";
import type { GraphClient } from "../graph/client-factory";
import { indexChanges, type ChangeRecord } from "../graph/graph-indexer";
import { enrichGraphSemanticsSilent } from "../graph/semantic-enricher";
import { prepareSemanticEnrichmentRuntime } from "../surfaces/cli/runtime";

export async function syncGraphAfterRun(
  client: GraphClient,
  changes: ChangeRecord[],
  configPath?: string
): Promise<{ indexed: number; enriched: number }> {
  if (changes.length === 0) {
    return { indexed: 0, enriched: 0 };
  }

  await indexChanges(client, changes);
  const indexed = changes.length;

  let enriched = 0;
  try {
    prepareSemanticEnrichmentRuntime(configPath);
    const result = await enrichGraphSemanticsSilent(client, { batchSize: 3 });
    enriched = result.enrichedCount;
  } catch (error) {
    logger.error({ error }, "Caught error");
    // 富化失败不影响主流程
  }

  return { indexed, enriched };
}
