import type { GraphFlowConfig } from "../config/schema";
import type { GraphEdge, GraphNode } from "../core/types";
import { resolveGraphStorePath } from "../config/paths";
import { logger } from "../utils/logger";
import { markGraphMutated } from "./graph-compression";
import { GraphifyClient } from "./graphify-client";
import { GraphifyFileClient } from "./graphify-file-client";
import { GraphifyMcpClient } from "./graphify-mcp-client";
import { GraphifySqliteClient } from "./sqlite-client";

export interface GraphStoreSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphClient {
  upsertNodes(nodes: GraphNode[]): Promise<void>;
  upsertEdges(edges: GraphEdge[]): Promise<void>;
  queryByKeyword(query: string): Promise<GraphNode[]>;
  readSnapshot?(): GraphStoreSnapshot;
  getNodesByIds?(ids: string[]): Promise<GraphNode[]>;
  getNeighbors?(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction?: "out" | "in" | "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]>;
  deleteNode?(id: string): Promise<void>;
  /** Batch delete nodes (and dangling edges). Backends implement this to avoid
   *  the read-modify-write amplification of per-node deleteNode loops. */
  deleteNodes?(ids: string[]): Promise<void>;
  deleteEdge?(from: string, to: string, relation: GraphEdge["relation"]): Promise<void>;
  vacuum?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

class InMemoryGraphClientAdapter implements GraphClient {
  constructor(private readonly client: GraphifyClient) {}

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    this.client.upsertNodes(nodes);
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    this.client.upsertEdges(edges);
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    return this.client.queryByKeyword(query);
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    return this.client.getNodesByIds(ids);
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction?: "out" | "in" | "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    return this.client.getNeighbors(nodeIds, relations, direction);
  }

  readSnapshot(): GraphStoreSnapshot {
    return this.client.readSnapshot();
  }

  async deleteNode(id: string): Promise<void> {
    return this.client.deleteNode(id);
  }

  async deleteNodes(ids: string[]): Promise<void> {
    return this.client.deleteNodes(ids);
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    return this.client.deleteEdge(from, to, relation);
  }
}

/**
 * 变更感知装饰器：把图写入/删除转发给底层 client，同时调用 markGraphMutated()
 * 维护 PageRank 缓存的影响面失效标记（见 graph-compression.ts）。
 * 纯增量装饰：读路径（queryByKeyword / readSnapshot / getNodesByIds /
 * getNeighbors / vacuum）原样透传，写路径在成功后按触及节点打标记。
 */
class MutationAwareGraphClient implements GraphClient {
  constructor(private readonly inner: GraphClient) {}

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    await this.inner.upsertNodes(nodes);
    markGraphMutated(nodes.map((n) => n.id));
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    await this.inner.upsertEdges(edges);
    const touched = new Set<string>();
    for (const edge of edges) {
      touched.add(edge.from);
      touched.add(edge.to);
    }
    markGraphMutated(touched);
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    return this.inner.queryByKeyword(query);
  }

  readSnapshot(): GraphStoreSnapshot {
    // 所有被包装的后端（file/sqlite/memory/mcp）均实现 readSnapshot，
    // `?.` 仅作防御；接口此处为可选方法，调用方先做存在性检查。
    return this.inner.readSnapshot?.() as GraphStoreSnapshot;
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    return this.inner.getNodesByIds?.(ids) ?? [];
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction?: "out" | "in" | "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    return this.inner.getNeighbors?.(nodeIds, relations, direction) ?? [];
  }

  async deleteNode(id: string): Promise<void> {
    if (this.inner.deleteNode) {
      await this.inner.deleteNode(id);
      markGraphMutated([id]);
    }
  }

  async deleteNodes(ids: string[]): Promise<void> {
    if (this.inner.deleteNodes) {
      await this.inner.deleteNodes(ids);
      markGraphMutated(ids);
    } else if (this.inner.deleteNode) {
      for (const id of ids) {
        await this.inner.deleteNode(id);
      }
      markGraphMutated(ids);
    }
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    if (this.inner.deleteEdge) {
      await this.inner.deleteEdge(from, to, relation);
      markGraphMutated([from, to]);
    }
  }

  vacuum(): Promise<void> | void {
    return this.inner.vacuum?.();
  }

  close(): Promise<void> | void {
    // sqlite 后端必须显式 close 释放文件句柄，否则 Windows 上删除/解锁会 EBUSY
    return this.inner.close?.();
  }
}

export function createGraphClient(config: GraphFlowConfig): GraphClient {
  if (config.graphPolicy.transport === "mcp-http") {
    // Team backend pilot: remote Graphify server, transparently falling back
    // to the local JSON file store when the endpoint is missing, malformed,
    // or unreachable at operation time (mirrors the sqlite -> file pattern).
    const endpoint = config.graphPolicy.mcpEndpoint;
    if (!endpoint) {
      throw new Error(
        "[graphflow] graphPolicy.mcpEndpoint is required for mcp-http transport. " +
          'Add it to graphflow.config.json, e.g. "http://graphify.team.internal:8080".'
      );
    }
    const fallbackPath = resolveGraphStorePath(config);
    try {
      // mcp-http 是远程试点后端：PageRank 影响面标记只作用于本地图，
      // 且远程 client 有 isDegraded 等特有契约，这里不做装饰器包装。
      return new GraphifyMcpClient(endpoint, config.graphPolicy.mcpApiKey, {
        fallbackPath,
        ...(config.graphPolicy.mcpTenant ? { tenant: config.graphPolicy.mcpTenant } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, fallbackPath },
        `[graphflow] mcp-http transport unavailable, falling back to file. Reason: ${msg}`
      );
      return new MutationAwareGraphClient(new GraphifyFileClient(fallbackPath));
    }
  }

  if (config.graphPolicy.transport === "file") {
    return new MutationAwareGraphClient(new GraphifyFileClient(resolveGraphStorePath(config)));
  }

  if (config.graphPolicy.transport === "sqlite") {
    try {
      return new MutationAwareGraphClient(new GraphifySqliteClient(resolveGraphStorePath(config)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackPath = resolveGraphStorePath(config).replace(/\.sqlite$/i, ".json");
      logger.warn(
        { err, fallbackPath },
        `[graphflow] sqlite transport unavailable, falling back to file. Reason: ${msg}`
      );
      return new MutationAwareGraphClient(new GraphifyFileClient(fallbackPath));
    }
  }

  if (config.graphPolicy.transport === "auto") {
    // Auto: prefer sqlite (FTS5, no whole-file read/write amplification on
    // large repos) and transparently fall back to the JSON file store when
    // better-sqlite3 is unavailable (e.g. missing optional dependency).
    const sqlitePath = resolveGraphStorePath(config).replace(/\.json$/i, ".sqlite");
    try {
      return new MutationAwareGraphClient(new GraphifySqliteClient(sqlitePath));
    } catch {
      const fallbackPath = sqlitePath.replace(/\.sqlite$/i, ".json");
      logger.info(
        { fallbackPath },
        "[graphflow] auto transport: sqlite unavailable, using file store"
      );
      return new MutationAwareGraphClient(new GraphifyFileClient(fallbackPath));
    }
  }

  return new MutationAwareGraphClient(new InMemoryGraphClientAdapter(new GraphifyClient()));
}
