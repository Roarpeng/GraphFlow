import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient, GraphStoreSnapshot } from "./client-factory";

/** Node types derived from source files; everything else is memory the indexer cannot rebuild. */
const CODE_NODE_TYPES = new Set<GraphNode["type"]>(["File", "Symbol", "Module"]);

export function isMemoryNode(node: GraphNode): boolean {
  return !CODE_NODE_TYPES.has(node.type);
}

export interface MemorySubgraph {
  nodes: GraphNode[];
  /** Edges with at least one memory endpoint; code endpoints are re-checked on restore. */
  edges: GraphEdge[];
}

/**
 * Dialogue turns, workbench topics, skills, episodes and agent insights live in
 * the same store as code nodes; a full rebuild deletes the store, so capture
 * them first.
 */
export function captureMemorySubgraph(snapshot: GraphStoreSnapshot | undefined): MemorySubgraph {
  if (!snapshot) return { nodes: [], edges: [] };
  const nodes = snapshot.nodes.filter(isMemoryNode);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = snapshot.edges.filter((e) => ids.has(e.from) || ids.has(e.to));
  return { nodes, edges };
}

/**
 * Write captured memory back after re-indexing. Edges to code nodes are kept
 * only when the code node still exists (a symbol of a deleted file stays gone).
 */
export async function restoreMemorySubgraph(
  client: GraphClient,
  memory: MemorySubgraph
): Promise<{ nodes: number; edges: number; droppedEdges: number }> {
  if (memory.nodes.length === 0) return { nodes: 0, edges: 0, droppedEdges: 0 };
  const present = new Set((client.readSnapshot?.()?.nodes ?? []).map((n) => n.id));
  for (const node of memory.nodes) present.add(node.id);
  const edges = memory.edges.filter((e) => present.has(e.from) && present.has(e.to));
  if (client.upsertGraph) {
    await client.upsertGraph({ nodes: memory.nodes, edges });
  } else {
    await client.upsertNodes(memory.nodes);
    if (edges.length > 0) await client.upsertEdges(edges);
  }
  return { nodes: memory.nodes.length, edges: edges.length, droppedEdges: memory.edges.length - edges.length };
}
