import type { GraphFlowConfig } from "../config/schema";
import type { GraphEdge, GraphNode } from "../core/types";
import { GraphifyClient } from "./graphify-client";
import { GraphifyMcpClient } from "./graphify-mcp-client";

export interface GraphClient {
  upsertNodes(nodes: GraphNode[]): Promise<void>;
  upsertEdges(edges: GraphEdge[]): Promise<void>;
  queryByKeyword(query: string): Promise<GraphNode[]>;
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
}

export function createGraphClient(config: GraphFlowConfig): GraphClient {
  if (config.graphPolicy.transport === "mcp-http") {
    return new GraphifyMcpClient(config.graphPolicy.mcpEndpoint!, config.graphPolicy.mcpApiKey);
  }

  return new InMemoryGraphClientAdapter(new GraphifyClient());
}
