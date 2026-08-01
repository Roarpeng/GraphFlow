import { logger } from "../utils/logger";
import { validateGraphifyEndpoint } from "../config/graphify-endpoint";
import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient, GraphStoreSnapshot } from "./client-factory";
import { GraphifyFileClient } from "./graphify-file-client";

interface JsonRpcResult<T> {
  result?: T;
  error?: { message: string };
}

interface McpQueryResponse {
  nodes: GraphNode[];
}

export interface GraphifyMcpOptions {
  /**
   * Local JSON store path. When set, any request failure (endpoint down,
   * network error, protocol error) transparently degrades to this file store,
   * mirroring the sqlite -> file fallback of the other transports.
   */
  fallbackPath?: string;
  /** Per-request timeout in ms. Defaults to 15_000. */
  timeoutMs?: number;
}

/**
 * GraphClient backend for the `mcp-http` transport: talks to a remote
 * Graphify team server over the Graphify JSON-RPC wire protocol.
 *
 * Degradation philosophy: the Graphify protocol is a pilot, not a full SaaS —
 * where it lacks a capability (full snapshot, or the server itself), this
 * client degrades gracefully (logged warning + local file store or empty
 * results) instead of throwing.
 */
export class GraphifyMcpClient implements GraphClient {
  private readonly apiKey: string | undefined;
  private readonly fallback: GraphifyFileClient | null;
  private readonly fallbackPath: string | undefined;
  private readonly timeoutMs: number;
  private degraded = false;
  private snapshotWarned = false;

  constructor(
    private readonly endpoint: string,
    apiKey?: string,
    options: GraphifyMcpOptions = {}
  ) {
    const invalid = validateGraphifyEndpoint(endpoint);
    if (invalid) {
      throw new Error(`[graphflow] Invalid Graphify mcp-http endpoint: ${invalid}`);
    }
    this.apiKey = apiKey;
    this.fallbackPath = options.fallbackPath;
    this.fallback = options.fallbackPath ? new GraphifyFileClient(options.fallbackPath) : null;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** True once any request has failed and later operations serve from the local fallback store. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** Startup connectivity probe; returns false when the endpoint is unreachable. */
  async ping(): Promise<boolean> {
    try {
      await this.call<McpQueryResponse>("graph.query_subgraph", { query: "" });
      return true;
    } catch {
      return false;
    }
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    await this.withFallback(
      "graph.upsert_nodes",
      () => this.call("graph.upsert_nodes", { nodes }),
      (fb) => fb.upsertNodes(nodes),
      undefined
    );
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    await this.withFallback(
      "graph.upsert_edges",
      () => this.call("graph.upsert_edges", { edges }),
      (fb) => fb.upsertEdges(edges),
      undefined
    );
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    return this.withFallback(
      "graph.query_subgraph",
      async () => {
        const response = await this.call<McpQueryResponse>("graph.query_subgraph", { query });
        return response.nodes ?? [];
      },
      (fb) => fb.queryByKeyword(query),
      []
    );
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    return this.withFallback(
      "graph.get_nodes",
      async () => {
        const response = await this.call<McpQueryResponse>("graph.get_nodes", { ids });
        return response.nodes ?? [];
      },
      (fb) => fb.getNodesByIds(ids),
      []
    );
  }

  async getNeighbors(
    nodeIds: string[],
    relations?: GraphEdge["relation"][],
    direction: "out" | "in" | "both" = "both"
  ): Promise<{ node: GraphNode; via: GraphEdge["relation"] }[]> {
    return this.withFallback(
      "graph.get_neighbors",
      async () => {
        const response = await this.call<{
          neighbors?: { node: GraphNode; via: GraphEdge["relation"] }[];
        }>("graph.get_neighbors", { nodeIds, relations, direction });
        return response.neighbors ?? [];
      },
      (fb) => fb.getNeighbors(nodeIds, relations, direction),
      []
    );
  }

  /**
   * The Graphify wire protocol has no full-snapshot endpoint. Degrade
   * gracefully: serve the local mirror file when one is configured (it may be
   * stale), otherwise log once and return an empty snapshot.
   */
  readSnapshot(): GraphStoreSnapshot {
    if (this.fallback) {
      if (!this.snapshotWarned) {
        this.snapshotWarned = true;
        logger.warn(
          { endpoint: this.endpoint },
          "[graphflow] Graphify protocol has no full-snapshot endpoint; serving local mirror file (may be stale)"
        );
      }
      return this.fallback.readSnapshot();
    }
    if (!this.snapshotWarned) {
      this.snapshotWarned = true;
      logger.warn(
        { endpoint: this.endpoint },
        "[graphflow] Graphify protocol has no full-snapshot endpoint; returning empty snapshot"
      );
    }
    return { nodes: [], edges: [] };
  }

  async deleteNode(id: string): Promise<void> {
    await this.withFallback(
      "graph.delete_node",
      () => this.call("graph.delete_node", { id }),
      (fb) => fb.deleteNode(id),
      undefined
    );
  }

  async deleteEdge(from: string, to: string, relation: GraphEdge["relation"]): Promise<void> {
    await this.withFallback(
      "graph.delete_edge",
      () => this.call("graph.delete_edge", { from, to, relation }),
      (fb) => fb.deleteEdge(from, to, relation),
      undefined
    );
  }

  /**
   * Run a remote request; on failure log one warning and transparently serve
   * the request from the local fallback file store (or return `empty` when no
   * fallback is configured) instead of throwing.
   */
  private async withFallback<T>(
    method: string,
    run: () => Promise<T>,
    fallbackRun: (fb: GraphifyFileClient) => Promise<T>,
    empty: T
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.degradeOnce(error, method);
      return this.fallback ? fallbackRun(this.fallback) : Promise.resolve(empty);
    }
  }

  private degradeOnce(error: unknown, method: string): void {
    if (this.degraded) return;
    this.degraded = true;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(
      { endpoint: this.endpoint, method, fallbackPath: this.fallbackPath ?? null },
      `[graphflow] Graphify mcp-http request failed; falling back to file store. Reason: ${msg}`
    );
  }

  private async call<T = unknown>(method: string, params: object): Promise<T> {
    const signal =
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(this.timeoutMs)
        : undefined;

    const init: RequestInit = {
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
    };
    if (signal) init.signal = signal;

    const response = await fetch(this.endpoint, init);

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
