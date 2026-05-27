import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphifyClient } from "./graphify-client";

export interface ChangeRecord {
  filePath: string;
  summary: string;
}

export function indexChanges(client: GraphifyClient, changes: ChangeRecord[]): void {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const change of changes) {
    const fileNodeId = `file:${change.filePath}`;
    const decisionNodeId = `decision:${change.filePath}:${change.summary.slice(0, 24)}`;

    nodes.push({ id: fileNodeId, type: "File", content: change.filePath });
    nodes.push({ id: decisionNodeId, type: "Decision", content: change.summary });
    edges.push({ from: decisionNodeId, to: fileNodeId, relation: "changes" });
  }

  client.upsertNodes(nodes);
  client.upsertEdges(edges);
}
