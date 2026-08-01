import type { GraphFlowConfig } from "../config/schema";
import type { GraphEdge, GraphNode } from "../core/types";
import { resolveGraphStorePath } from "../config/paths";
import { logger } from "../utils/logger";
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
  deleteEdge?(from: string, to: string, relation: GraphEdge["relation"]): Promise<void>;
  vacuum?(): Promise<void> | void;
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

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    return this.client.deleteEdge(from, to, relation);
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
      return new GraphifyMcpClient(endpoint, config.graphPolicy.mcpApiKey, { fallbackPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, fallbackPath },
        `[graphflow] mcp-http transport unavailable, falling back to file. Reason: ${msg}`
      );
      return new GraphifyFileClient(fallbackPath);
    }
  }

  if (config.graphPolicy.transport === "file") {
    return new GraphifyFileClient(resolveGraphStorePath(config));
  }

  if (config.graphPolicy.transport === "sqlite") {
    try {
      return new GraphifySqliteClient(resolveGraphStorePath(config));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackPath = resolveGraphStorePath(config).replace(/\.sqlite$/i, ".json");
      logger.warn(
        { err, fallbackPath },
        `[graphflow] sqlite transport unavailable, falling back to file. Reason: ${msg}`
      );
      return new GraphifyFileClient(fallbackPath);
    }
  }

  if (config.graphPolicy.transport === "auto") {
    // Auto: prefer sqlite (FTS5, no whole-file read/write amplification on
    // large repos) and transparently fall back to the JSON file store when
    // better-sqlite3 is unavailable (e.g. missing optional dependency).
    const sqlitePath = resolveGraphStorePath(config).replace(/\.json$/i, ".sqlite");
    try {
      return new GraphifySqliteClient(sqlitePath);
    } catch {
      const fallbackPath = sqlitePath.replace(/\.sqlite$/i, ".json");
      logger.info(
        { fallbackPath },
        "[graphflow] auto transport: sqlite unavailable, using file store"
      );
      return new GraphifyFileClient(fallbackPath);
    }
  }

  return new InMemoryGraphClientAdapter(new GraphifyClient());
}
