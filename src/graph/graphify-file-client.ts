import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphEdge, GraphNode } from "../core/types";

interface GraphStore {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphifyFileClient {
  constructor(private readonly storePath: string) {}

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    const store = this.readStore();
    const map = new Map(store.nodes.map((node) => [node.id, node]));

    for (const node of nodes) {
      map.set(node.id, node);
    }

    this.writeStore({
      nodes: Array.from(map.values()),
      edges: store.edges,
    });
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    const store = this.readStore();
    const edgeKeys = new Set(store.edges.map((edge) => this.edgeKey(edge)));

    for (const edge of edges) {
      const key = this.edgeKey(edge);
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        store.edges.push(edge);
      }
    }

    this.writeStore(store);
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const normalized = query.toLowerCase();
    const store = this.readStore();
    return store.nodes.filter((node) => node.content.toLowerCase().includes(normalized));
  }

  private readStore(): GraphStore {
    if (!existsSync(this.storePath)) {
      return { nodes: [], edges: [] };
    }

    const raw = readFileSync(this.storePath, "utf8");
    if (!raw.trim()) {
      return { nodes: [], edges: [] };
    }

    const parsed = JSON.parse(raw) as Partial<GraphStore>;
    return {
      nodes: parsed.nodes ?? [],
      edges: parsed.edges ?? [],
    };
  }

  private writeStore(store: GraphStore): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), "utf8");
  }

  private edgeKey(edge: GraphEdge): string {
    return `${edge.from}::${edge.relation}::${edge.to}`;
  }
}
