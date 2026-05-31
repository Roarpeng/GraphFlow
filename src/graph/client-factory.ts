import type { GraphFlowConfig } from "../config/schema";
import type { GraphEdge, GraphNode } from "../core/types";
import { GraphifyClient } from "./graphify-client";
import { GraphifyFileClient } from "./graphify-file-client";
import { GraphifyMcpClient } from "./graphify-mcp-client";
import { GraphifySqliteClient } from "./sqlite-client";

export interface GraphClient {
  upsertNodes(nodes: GraphNode[]): Promise<void>;
  upsertEdges(edges: GraphEdge[]): Promise<void>;
  queryByKeyword(query: string): Promise<GraphNode[]>;
  getNodesByIds?(ids: string[]): Promise<GraphNode[]>;
  getNeighbors?(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction?: "out" | "in" | "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]>;
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
}

export function createGraphClient(config: GraphFlowConfig): GraphClient {
  if (config.graphPolicy.transport === "mcp-http") {
    return new GraphifyMcpClient(config.graphPolicy.mcpEndpoint!, config.graphPolicy.mcpApiKey);
  }

  if (config.graphPolicy.transport === "file") {
    return new GraphifyFileClient(config.graphPolicy.graphStorePath!);
  }

  if (config.graphPolicy.transport === "sqlite") {
    return new GraphifySqliteClient(config.graphPolicy.graphStorePath ?? "tmp/graphflow-graph.sqlite");
  }

  return new InMemoryGraphClientAdapter(new GraphifyClient());
}
