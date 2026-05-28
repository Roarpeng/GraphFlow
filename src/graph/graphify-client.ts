import type { GraphEdge, GraphNode } from "../core/types";

export class GraphifyClient {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    this.edges.push(...edges);
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const normalized = query.toLowerCase();
    return Array.from(this.nodes.values()).filter((node) =>
      node.content.toLowerCase().includes(normalized)
    );
  }

  snapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }
}
