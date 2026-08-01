import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphEdge, GraphNode } from "../core/types";
import { logger } from "../utils/logger";
import { tokenizeForIndex, nodeSearchableText } from "./graph-utils";

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

  readSnapshot(): GraphStore {
    return this.readStore();
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const store = this.readStore();
    const tokens = tokenizeForIndex(query);
    if (tokens.length === 0) {
      const normalized = query.toLowerCase();
      return store.nodes.filter((node) => nodeSearchableText(node).toLowerCase().includes(normalized));
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
      for (const tok of tokenizeForIndex(nodeSearchableText(node))) {
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

    try {
      const parsed = JSON.parse(raw) as Partial<GraphStore>;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Graph store JSON root must be an object");
      }
      return {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      };
    } catch (error) {
      logger.warn(
        { error, storePath: this.storePath },
        "Corrupt graph store JSON; returning empty store (run graphflow_rebuild to repair)"
      );
      return { nodes: [], edges: [] };
    }
  }

  private writeStore(store: GraphStore): void {
    const dir = dirname(this.storePath);
    mkdirSync(dir, { recursive: true });
    // Pretty-print so nodes/edges are human-readable in editors (not one giant line).
    const payload = `${JSON.stringify(store, null, 2)}\n`;
    const tempPath = join(
      dir,
      `.graphflow-graph-${process.pid}-${randomBytes(4).toString("hex")}.tmp`
    );
    writeFileSync(tempPath, payload, "utf8");
    // Windows 上 rename 可能因文件锁定而失败，添加重试机制
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      try {
        renameSync(tempPath, this.storePath);
        return;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === "EPERM" && i < maxRetries - 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          continue;
        }
        rmSync(tempPath, { force: true });
        throw error;
      }
    }
  }

  private edgeKey(edge: GraphEdge): string {
    return `${edge.from}::${edge.relation}::${edge.to}`;
  }

  async deleteNode(id: string): Promise<void> {
    await this.deleteNodes([id]);
  }

  async deleteNodes(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const store = this.readStore();
    store.nodes = store.nodes.filter((n) => !idSet.has(n.id));
    store.edges = store.edges.filter((e) => !(idSet.has(e.from) || idSet.has(e.to)));
    this.writeStore(store);
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    const store = this.readStore();
    store.edges = store.edges.filter(
      (e) => !(e.from === from && e.to === to && e.relation === relation)
    );
    this.writeStore(store);
  }
}
