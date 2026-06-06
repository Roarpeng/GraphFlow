import { logger } from "../utils/logger";
import type { GraphEdge, GraphNode } from "../core/types";

interface JsonRpcResult<T> {
  result?: T;
  error?: { message: string };
}

interface McpQueryResponse {
  nodes: GraphNode[];
}

export class GraphifyMcpClient {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey?: string
  ) {}

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    await this.call("graph.upsert_nodes", { nodes });
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    await this.call("graph.upsert_edges", { edges });
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    const response = await this.call<McpQueryResponse>("graph.query_subgraph", { query });
    return response.nodes ?? [];
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    try {
      const response = await this.call<McpQueryResponse>("graph.get_nodes", { ids });
      return response.nodes ?? [];
    } catch (error) {
    logger.error({ error }, "Caught error");
      return [];
    }
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction: "out" | "in" | "both" = "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    try {
      const response = await this.call<{
        neighbors?: { node: GraphNode; via: GraphEdge["relation"] }[];
      }>("graph.get_neighbors", { nodeIds, relations, direction });
      return response.neighbors ?? [];
    } catch (error) {
    logger.error({ error }, "Caught error");
      return [];
    }
  }

  private async call<T = unknown>(method: string, params: object): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${Date.now()}-${method}`,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`Graphify MCP request failed: ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResult<T>;
    if (payload.error) {
      throw new Error(`Graphify MCP error: ${payload.error.message}`);
    }

    return payload.result as T;
  }

  async deleteNode(id: string): Promise<void> {
    await this.call("graph.delete_node", { id });
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    await this.call("graph.delete_edge", { from, to, relation });
  }
}
