import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphEdge, GraphNode } from "../core/types";
import { tokenizeForIndex } from "./graphify-client";

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
    const store = this.readStore();
    const tokens = tokenizeForIndex(query);
    if (tokens.length === 0) {
      const normalized = query.toLowerCase();
      return store.nodes.filter((node) => node.content.toLowerCase().includes(normalized));
    }

    const index = this.buildIndex(store.nodes);
    const matched = new Set<string>();
    for (const tok of tokens) {
      const ids = index.get(tok);
      if (!ids) continue;
      for (const id of ids) matched.add(id);
    }
    return store.nodes.filter((n) => matched.has(n.id));
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    const store = this.readStore();
    const want = new Set(ids);
    return store.nodes.filter((n) => want.has(n.id));
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction: "out" | "in" | "both" = "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    const store = this.readStore();
    const nodeMap = new Map(store.nodes.map((n) => [n.id, n]));
    const relFilter = relations && relations.length > 0 ? new Set(relations) : null;
    const seedSet = new Set(nodeIds);
    const seen = new Set<string>();
    const out: { node: GraphNode; via: GraphEdge["relation"] }[] = [];

    for (const edge of store.edges) {
      if (relFilter && !relFilter.has(edge.relation)) continue;

      if ((direction === "out" || direction === "both") && seedSet.has(edge.from)) {
        if (!seen.has(edge.to)) {
          const node = nodeMap.get(edge.to);
          if (node) {
            seen.add(edge.to);
            out.push({ node, via: edge.relation });
          }
        }
      }
      if ((direction === "in" || direction === "both") && seedSet.has(edge.to)) {
        if (!seen.has(edge.from)) {
          const node = nodeMap.get(edge.from);
          if (node) {
            seen.add(edge.from);
            out.push({ node, via: edge.relation });
          }
        }
      }
    }
    return out;
  }

  private buildIndex(nodes: GraphNode[]): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    for (const node of nodes) {
      for (const tok of tokenizeForIndex(node.content)) {
        let set = index.get(tok);
        if (!set) {
          set = new Set();
          index.set(tok, set);
        }
        set.add(node.id);
      }
    }
    return index;
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
