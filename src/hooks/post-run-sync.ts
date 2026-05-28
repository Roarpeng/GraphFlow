import type { GraphClient } from "../graph/client-factory";
import { indexChanges, type ChangeRecord } from "../graph/graph-indexer";

export async function syncGraphAfterRun(client: GraphClient, changes: ChangeRecord[]): Promise<void> {
  if (changes.length === 0) {
    return;
  }

  await indexChanges(client, changes);
}
