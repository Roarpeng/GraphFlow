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
}
