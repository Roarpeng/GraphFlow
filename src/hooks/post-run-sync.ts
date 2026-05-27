import type { GraphifyClient } from "../graph/graphify-client";
import { indexChanges, type ChangeRecord } from "../graph/graph-indexer";

export function syncGraphAfterRun(client: GraphifyClient, changes: ChangeRecord[]): void {
  if (changes.length === 0) {
    return;
  }

  indexChanges(client, changes);
}
