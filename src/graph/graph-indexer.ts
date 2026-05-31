import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

export interface ChangeRecord {
  filePath: string;
  summary: string;
}

export async function indexChanges(client: GraphClient, changes: ChangeRecord[]): Promise<void> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const change of changes) {
    const fileNodeId = `file:${change.filePath}`;
    const decisionNodeId = `decision:${change.filePath}:${change.summary.slice(0, 24)}`;
    const summary = change.summary.slice(0, 120);

    nodes.push({
      id: fileNodeId,
      type: "File",
      content: change.filePath,
      metadata: { path: change.filePath },
    });
    nodes.push({
      id: decisionNodeId,
      type: "Decision",
      content: summary,
      metadata: {
        filePath: change.filePath,
        summary: change.summary,
        capturedAt: Date.now(),
      },
    });
    edges.push({ from: decisionNodeId, to: fileNodeId, relation: "changes" });
  }

  await client.upsertNodes(nodes);
  await client.upsertEdges(edges);
}
