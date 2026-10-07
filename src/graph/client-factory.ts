import type { GraphFlowConfig } from "../config/schema";
import type { GraphEdge, GraphNode } from "../core/types";
import { resolveGraphStorePath } from "../config/paths";
import { logger } from "../utils/logger";
import { markGraphMutated } from "./graph-compression";
import { GraphifyClient } from "./graphify-client";
import { GraphifyFileClient } from "./graphify-file-client";
import { GraphifyMcpClient } from "./graphify-mcp-client";
import { GraphifySqliteClient } from "./sqlite-client";
import { mergeSiblingJsonStoreIntoSqlite } from "./store-migration";
import { CACHE_FILE, SQLITE_INDEX_MANIFEST } from "./file-indexer-cache";
import { existsSync } from "node:fs";
import { isDialogueRecordNode } from "./dialogue-node-match";

export interface GraphStoreSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphClient {
  /** Incremental-index manifest under `.graphflow-cache/` for this store; default `index-state.json`. */
  readonly indexManifestName?: string | undefined;
  upsertNodes(nodes: GraphNode[]): Promise<void>;
  upsertEdges(edges: GraphEdge[]): Promise<void>;
  /**
   * Merge nodes and edges in ONE backend round trip.
   *
   * Backends whose write rewrites the whole store (the file transport: one JSON
   * document) must implement this — indexing a single file otherwise rewrites
   * the entire store twice (read + write each time), which dominates incremental
   * indexing on large workspaces. Implementations must treat an empty batch as a
   * no-op and never touch storage.
   */
  upsertGraph?(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }): Promise<void>;
  queryByKeyword(query: string): Promise<GraphNode[]>;
  readSnapshot?(): GraphStoreSnapshot;
  /**
   * Dialogue turns and sessions without materializing the rest of the graph.
   * Backends that cannot project fall back to `readSnapshot` at the call site.
   */
  listDialogueNodes?(): Promise<GraphNode[]>;
  /**
   * When true, `upsertEdges` is idempotent and callers must not `readSnapshot`
   * solely to drop duplicate edges (that read is the large-graph OOM).
   */
  edgesAreIdempotent?(): boolean;
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

  async upsertGraph(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }): Promise<void> {
    const nodes = batch.nodes ?? [];
    const edges = batch.edges ?? [];
    if (nodes.length === 0 && edges.length === 0) return;
    if (nodes.length > 0) this.client.upsertNodes(nodes);
    if (edges.length > 0) this.client.upsertEdges(edges);
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

  get indexManifestName(): string | undefined {
    return this.inner.indexManifestName;
  }

  edgesAreIdempotent(): boolean {
    return this.inner.edgesAreIdempotent?.() === true;
  }

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

  async upsertGraph(batch: { nodes?: GraphNode[]; edges?: GraphEdge[] }): Promise<void> {
    const nodes = batch.nodes ?? [];
    const edges = batch.edges ?? [];
    if (nodes.length === 0 && edges.length === 0) return;
    if (this.inner.upsertGraph) {
      await this.inner.upsertGraph(batch);
    } else {
      if (nodes.length > 0) await this.inner.upsertNodes(nodes);
      if (edges.length > 0) await this.inner.upsertEdges(edges);
    }
    const touched = new Set<string>(nodes.map((node) => node.id));
    for (const edge of edges) {
      touched.add(edge.from);
      touched.add(edge.to);
    }
    markGraphMutated(touched);
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    return this.inner.queryByKeyword(query);
  }

  async listDialogueNodes(): Promise<GraphNode[]> {
    if (this.inner.listDialogueNodes) return this.inner.listDialogueNodes();
    return this.readSnapshot().nodes.filter((node) => isDialogueRecordNode(node));
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

export type GraphStoreBackend = "sqlite" | "file" | "memory" | "mcp-http";

let lastStoreBackend: { backend: GraphStoreBackend; path?: string; fallbackReason?: string } | undefined;

/** Backend chosen by the most recent createGraphClient call (for diagnose). */
export function getLastGraphStoreBackend(): typeof lastStoreBackend {
  return lastStoreBackend;
}

/**
 * Manifest name for callers that only hold a config (freshness checks): the
 * backend this process opened, else what the transport would open.
 */
export function resolveIndexManifestName(config: GraphFlowConfig): string {
  const last = lastStoreBackend;
  if (last) return last.backend === "sqlite" ? SQLITE_INDEX_MANIFEST : CACHE_FILE;
  const transport = config.graphPolicy.transport;
  if (transport !== "sqlite" && transport !== "auto") return CACHE_FILE;
  const sqlitePath = resolveGraphStorePath(config).replace(/\.json$/i, ".sqlite");
  return existsSync(sqlitePath) ? SQLITE_INDEX_MANIFEST : CACHE_FILE;
}

function openSqliteStore(sqlitePath: string): GraphifySqliteClient {
  const client = new GraphifySqliteClient(sqlitePath);
  mergeSiblingJsonStoreIntoSqlite(client, sqlitePath);
  lastStoreBackend = { backend: "sqlite", path: sqlitePath };
  return client;
}

const warnedSplitStores = new Set<string>();

/**
 * A SQLite store written by another host exists but this runtime cannot load
 * better-sqlite3: writes go to a JSON store the other hosts do not read.
 */
function warnIfSqliteStoreExists(sqlitePath: string, fallbackPath: string): void {
  lastStoreBackend = {
    backend: "file",
    path: fallbackPath,
    fallbackReason: "better-sqlite3 unavailable — run 'graphflow deps install'",
  };
  if (!existsSync(sqlitePath) || warnedSplitStores.has(sqlitePath)) return;
  warnedSplitStores.add(sqlitePath);
  logger.warn(
    { sqlitePath, fallbackPath },
    "[graphflow] another host keeps this project's graph in SQLite, but better-sqlite3 is unavailable here; " +
      "writes go to the JSON store until 'graphflow deps install' succeeds (the JSON store is merged back on the next SQLite open)"
  );
}

/**
 * Every client created this process, so test teardown can release sqlite
 * handles before deleting temp dirs — Windows cannot unlink open files
 * (EBUSY), and previewContext/runTaskResult create internal clients the
 * caller never sees. Held weakly: runtime paths rarely close their clients, and
 * a strong set kept every one (~17MB with its caches) alive for the life of a
 * long-running MCP server.
 */
const liveClients = new Set<WeakRef<GraphClient>>();
const liveClientRegistry = new FinalizationRegistry<WeakRef<GraphClient>>((ref) => {
  liveClients.delete(ref);
});

/** Close every live client created via createGraphClient (test teardown). */
export async function closeAllGraphClients(): Promise<void> {
  for (const ref of liveClients) {
    const client = ref.deref();
    if (!client) continue;
    try {
      await client.close?.();
    } catch {
      // already closed — teardown must be best-effort
    }
  }
  liveClients.clear();
}

export function createGraphClient(config: GraphFlowConfig): GraphClient {
  const client = buildGraphClient(config);
  const ref = new WeakRef(client);
  liveClients.add(ref);
  liveClientRegistry.register(client, ref);
  return client;
}

function buildGraphClient(config: GraphFlowConfig): GraphClient {
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
    // Operational knob: on hosts where a connection to a dead endpoint hangs
    // instead of being refused (Windows firewall / loaded CI), the default 15s
    // per-request timeout multiplies across graph operations. Set
    // GRAPHFLOW_MCP_TIMEOUT_MS to fail fast (e.g. 500 in tests).
    const envTimeout = Number.parseInt(process.env.GRAPHFLOW_MCP_TIMEOUT_MS ?? "", 10);
    const timeoutOptions =
      Number.isFinite(envTimeout) && envTimeout > 0 ? { timeoutMs: envTimeout } : {};
    lastStoreBackend = { backend: "mcp-http", path: endpoint };
    try {
      // mcp-http 是远程试点后端：PageRank 影响面标记只作用于本地图，
      // 且远程 client 有 isDegraded 等特有契约，这里不做装饰器包装。
      return new GraphifyMcpClient(endpoint, config.graphPolicy.mcpApiKey, {
        fallbackPath,
        ...(config.graphPolicy.mcpTenant ? { tenant: config.graphPolicy.mcpTenant } : {}),
        ...timeoutOptions,
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
    lastStoreBackend = { backend: "file", path: resolveGraphStorePath(config) };
    return new MutationAwareGraphClient(new GraphifyFileClient(resolveGraphStorePath(config)));
  }

  if (config.graphPolicy.transport === "sqlite") {
    const sqlitePath = resolveGraphStorePath(config);
    try {
      return new MutationAwareGraphClient(openSqliteStore(sqlitePath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackPath = sqlitePath.replace(/\.sqlite$/i, ".json");
      warnIfSqliteStoreExists(sqlitePath, fallbackPath);
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
      return new MutationAwareGraphClient(openSqliteStore(sqlitePath));
    } catch {
      const fallbackPath = sqlitePath.replace(/\.sqlite$/i, ".json");
      warnIfSqliteStoreExists(sqlitePath, fallbackPath);
      logger.info(
        { fallbackPath },
        "[graphflow] auto transport: sqlite unavailable, using file store"
      );
      return new MutationAwareGraphClient(new GraphifyFileClient(fallbackPath));
    }
  }

  lastStoreBackend = { backend: "memory" };
  return new MutationAwareGraphClient(new InMemoryGraphClientAdapter(new GraphifyClient()));
}
