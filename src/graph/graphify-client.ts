import type { GraphEdge, GraphNode } from "../core/types";

const TOKEN_SPLIT = /[^a-z0-9_]+/g;

export function tokenizeForIndex(text: string): string[] {
  if (!text) return [];
  const tokens = text.toLowerCase().split(TOKEN_SPLIT);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length >= 2) out.push(t);
  }
  return out;
}

export class GraphifyClient {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly index = new Map<string, Set<string>>();
  private readonly edgesByFrom = new Map<string, GraphEdge[]>();
  private readonly edgesByTo = new Map<string, GraphEdge[]>();

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) {
      // 节点已存在时先清理旧 token 的倒排条目，防止索引膨胀
      if (this.nodes.has(node.id)) {
        const old = this.nodes.get(node.id)!;
        this.removeNodeFromIndex(old);
      }
      this.nodes.set(node.id, node);
      this.indexNode(node);
    }
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      this.edges.push(edge);
      const outList = this.edgesByFrom.get(edge.from) ?? [];
      outList.push(edge);
      this.edgesByFrom.set(edge.from, outList);
      const inList = this.edgesByTo.get(edge.to) ?? [];
      inList.push(edge);
      this.edgesByTo.set(edge.to, inList);
    }
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const tokens = tokenizeForIndex(query);
    if (tokens.length === 0) {
      const normalized = query.toLowerCase();
      return Array.from(this.nodes.values()).filter((node) =>
        node.content.toLowerCase().includes(normalized)
      );
    }

    const matchedIds = new Set<string>();
    for (const tok of tokens) {
      const ids = this.index.get(tok);
      if (!ids) continue;
      for (const id of ids) matchedIds.add(id);
    }

    const result: GraphNode[] = [];
    for (const id of matchedIds) {
      const node = this.nodes.get(id);
      if (node) result.push(node);
    }
    return result;
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    const out: GraphNode[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  readSnapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction: "out" | "in" | "both" = "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    const relFilter = relations && relations.length > 0 ? new Set(relations) : null;
    const seen = new Set<string>();
    const out: { node: GraphNode; via: GraphEdge["relation"] }[] = [];

    for (const id of nodeIds) {
      if (direction === "out" || direction === "both") {
        for (const edge of this.edgesByFrom.get(id) ?? []) {
          if (relFilter && !relFilter.has(edge.relation)) continue;
          if (seen.has(edge.to)) continue;
          const node = this.nodes.get(edge.to);
          if (!node) continue;
          seen.add(edge.to);
          out.push({ node, via: edge.relation });
        }
      }
      if (direction === "in" || direction === "both") {
        for (const edge of this.edgesByTo.get(id) ?? []) {
          if (relFilter && !relFilter.has(edge.relation)) continue;
          if (seen.has(edge.from)) continue;
          const node = this.nodes.get(edge.from);
          if (!node) continue;
          seen.add(edge.from);
          out.push({ node, via: edge.relation });
        }
      }
    }
    return out;
  }

  snapshot(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }

  private removeNodeFromIndex(node: GraphNode): void {
    for (const tok of tokenizeForIndex(node.content)) {
      const set = this.index.get(tok);
      if (set) {
        set.delete(node.id);
        if (set.size === 0) {
          this.index.delete(tok);
        }
      }
    }
  }

  private indexNode(node: GraphNode): void {
    for (const tok of tokenizeForIndex(node.content)) {
      let set = this.index.get(tok);
      if (!set) {
        set = new Set();
        this.index.set(tok, set);
      }
      set.add(node.id);
    }
  }

  async deleteNode(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) return;
    this.removeNodeFromIndex(node);

    for (let i = this.edges.length - 1; i >= 0; i--) {
      const edge = this.edges[i];
      if (edge.from === id || edge.to === id) {
        this.edges.splice(i, 1);
      }
    }

    this.edgesByFrom.delete(id);
    this.edgesByTo.delete(id);

    for (const [k, v] of this.edgesByFrom.entries()) {
      this.edgesByFrom.set(k, v.filter((e) => e.to !== id));
    }
    for (const [k, v] of this.edgesByTo.entries()) {
      this.edgesByTo.set(k, v.filter((e) => e.from !== id));
    }

    this.nodes.delete(id);
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i];
      if (e.from === from && e.to === to && e.relation === relation) {
        this.edges.splice(i, 1);
      }
    }
    const fromList = this.edgesByFrom.get(from);
    if (fromList) {
      this.edgesByFrom.set(
        from,
        fromList.filter((e) => !(e.to === to && e.relation === relation))
      );
    }
    const toList = this.edgesByTo.get(to);
    if (toList) {
      this.edgesByTo.set(
        to,
        toList.filter((e) => !(e.from === from && e.relation === relation))
      );
    }
  }
}
