import type { GraphFlowConfig } from "../config/schema";
import type { GraphEdge, GraphNode } from "../core/types";
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
    return new GraphifyMcpClient(config.graphPolicy.mcpEndpoint!, config.graphPolicy.mcpApiKey);
  }

  if (config.graphPolicy.transport === "file") {
    return new GraphifyFileClient(config.graphPolicy.graphStorePath!);
  }

  if (config.graphPolicy.transport === "sqlite") {
    try {
      return new GraphifySqliteClient(
        config.graphPolicy.graphStorePath ?? "tmp/graphflow-graph.sqlite"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackPath =
        config.graphPolicy.graphStorePath?.replace(/\.sqlite$/, ".json") ??
        "tmp/graphflow-graph.json";
      logger.warn(
        { err, fallbackPath },
        `[graphflow] sqlite transport unavailable, falling back to file. Reason: ${msg}`
      );
      return new GraphifyFileClient(fallbackPath);
    }
  }

  return new InMemoryGraphClientAdapter(new GraphifyClient());
}
