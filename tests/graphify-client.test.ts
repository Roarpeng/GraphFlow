import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateConfig, validateConfigDetailed } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { GraphifyMcpClient } from "../src/graph/graphify-mcp-client";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";
import type { GraphEdge, GraphNode } from "../src/core/types";
import type { GraphFlowConfig } from "../src/config/schema";

// ---------------------------------------------------------------------------
// Local stub Graphify server (127.0.0.1, node:http) mimicking the JSON-RPC
// wire protocol used by GraphifyMcpClient. Fully offline and deterministic.
// ---------------------------------------------------------------------------

interface StubState {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

function handleMethod(payload: { method: string; params: Record<string, unknown> }, state: StubState): unknown {
  const { method, params } = payload;
  switch (method) {
    case "graph.upsert_nodes": {
      for (const node of (params.nodes as GraphNode[]) ?? []) state.nodes.set(node.id, node);
      return null;
    }
    case "graph.upsert_edges": {
      for (const edge of (params.edges as GraphEdge[]) ?? []) state.edges.push(edge);
      return null;
    }
    case "graph.query_subgraph": {
      const query = String(params.query ?? "").toLowerCase();
      const hits = Array.from(state.nodes.values()).filter(
        (n) => !query || n.content.toLowerCase().includes(query)
      );
      return { nodes: hits };
    }
    case "graph.get_nodes": {
      const want = new Set((params.ids as string[]) ?? []);
      return { nodes: Array.from(state.nodes.values()).filter((n) => want.has(n.id)) };
    }
    case "graph.get_neighbors": {
      const ids = new Set((params.nodeIds as string[]) ?? []);
      const out = state.edges
        .filter((e) => ids.has(e.from))
        .map((e) => ({ node: state.nodes.get(e.to), via: e.relation }))
        .filter((x) => x.node);
      return { neighbors: out };
    }
    case "graph.delete_node": {
      state.nodes.delete(String(params.id ?? ""));
      return null;
    }
    case "graph.delete_edge": {
      state.edges = state.edges.filter(
        (e) =>
          !(e.from === params.from && e.to === params.to && e.relation === params.relation)
      );
      return null;
    }
    default:
      throw new Error(`Unknown Graphify method: ${method}`);
  }
}

function startStubServer(): Promise<{ server: Server; port: number; baseUrl: string; state: StubState }> {
  const state: StubState = { nodes: new Map(), edges: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const send = (result: unknown, error?: { message: string }) => {
        res.writeHead(error ? 500 : 200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: JSON.parse(body).id,
            ...(result !== undefined ? { result } : {}),
            ...(error ? { error } : {}),
          })
        );
      };
      let parsed: { method: string; params: Record<string, unknown>; id: number };
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        send(undefined, { message: err instanceof Error ? err.message : "bad json" });
        return;
      }
      try {
        send(handleMethod(parsed, state));
      } catch (err) {
        send(undefined, { message: err instanceof Error ? err.message : "server error" });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}`, state });
    });
  });
}

/** A 127.0.0.1 port with nothing listening (connection refused, deterministic). */
function getDeadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const baseDir = mkdtempSync(join(tmpdir(), "graphflow-mcp-"));
const servers: Server[] = [];

afterAll(() => {
  for (const srv of servers) srv.close();
});

function buildConfig(overrides: {
  mcpEndpoint?: string;
  mcpApiKey?: string;
  graphStorePath?: string;
} = {}): GraphFlowConfig {
  return validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-5.3-codex" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 4000 },
    graphPolicy: {
      enableAutoBuild: true,
      transport: "mcp-http",
      ...(overrides.mcpEndpoint !== undefined ? { mcpEndpoint: overrides.mcpEndpoint } : {}),
      ...(overrides.mcpApiKey !== undefined ? { mcpApiKey: overrides.mcpApiKey } : {}),
      ...(overrides.graphStorePath !== undefined ? { graphStorePath: overrides.graphStorePath } : {}),
      maxContextTokens: 200,
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  });
}

const sampleNodes: GraphNode[] = [
  { id: "n1", type: "File", content: "orchestrate task pipeline alpha", metadata: { team: "core" } },
  { id: "n2", type: "Symbol", content: "orchestrate routing decision" },
  { id: "n3", type: "Symbol", content: "validator output gamma" },
];

const sampleEdges: GraphEdge[] = [
  { from: "n1", to: "n2", relation: "references" },
  { from: "n1", to: "n3", relation: "co_occurs" },
];

describe("P2-3 Graphify mcp-http team backend (pilot)", () => {
  it("A: happy path round-trip via the local stub server", async () => {
    const { server, baseUrl, state } = await startStubServer();
    servers.push(server);
    const client = new GraphifyMcpClient(baseUrl, "test-key");

    await client.upsertNodes(sampleNodes);
    await client.upsertEdges(sampleEdges);
    expect(state.nodes.size).toBe(3);
    expect(state.edges.length).toBe(2);

    const hits = await client.queryByKeyword("orchestrate");
    expect(hits.map((n) => n.id).sort()).toEqual(["n1", "n2"]);

    const byId = await client.getNodesByIds(["n1", "missing"]);
    expect(byId).toHaveLength(1);
    expect(byId[0].metadata).toEqual({ team: "core" });

    const neighbors = await client.getNeighbors(["n1"], undefined, "out");
    expect(neighbors.map((n) => n.node.id).sort()).toEqual(["n2", "n3"]);
    expect(neighbors.map((n) => n.via).sort()).toEqual(["co_occurs", "references"]);

    expect(client.isDegraded).toBe(false);
  });

  it("B: endpoint config validation rejects missing / malformed / non-http URLs", () => {
    expect(() => buildConfig({})).toThrow(/mcpEndpoint is required for mcp-http/);
    expect(() => buildConfig({ mcpEndpoint: "not-a-url" })).toThrow(/must be an http\(s\) URL/);
    expect(() => buildConfig({ mcpEndpoint: "ftp://graphify.example.com" })).toThrow(
      /must be an http\(s\) URL/
    );
    expect(() => new GraphifyMcpClient("ftp://host")).toThrow(/http\(s\) URL/);

    // validateConfigDetailed surfaces a field-level error from a config file.
    const badConfigPath = join(baseDir, `bad-endpoint-${Date.now()}.json`);
    const badConfig = {
      ...buildConfig({ mcpEndpoint: "http://127.0.0.1:1" }),
      graphPolicy: { ...buildConfig({ mcpEndpoint: "http://127.0.0.1:1" }).graphPolicy, mcpEndpoint: "not-a-url" },
    };
    writeFileSync(badConfigPath, JSON.stringify(badConfig), "utf8");
    const result = validateConfigDetailed(badConfigPath);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (i) => i.severity === "error" && i.field === "graphPolicy.mcpEndpoint"
      )
    ).toBe(true);
  });

  it("C: connection failure at operation time falls back to the file JSON store", async () => {
    const deadPort = await getDeadPort();
    const fallbackPath = join(baseDir, `fallback-c-${Date.now()}.json`);
    const client = new GraphifyMcpClient(`http://127.0.0.1:${deadPort}`, undefined, {
      fallbackPath,
    });

    await expect(client.upsertNodes(sampleNodes)).resolves.toBeUndefined();
    expect(client.isDegraded).toBe(true);

    const hits = await client.queryByKeyword("orchestrate");
    expect(hits.map((n) => n.id).sort()).toEqual(["n1", "n2"]);

    const snapshot = client.readSnapshot();
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);

    // The JSON file store physically exists and contains the mirrored data.
    expect(existsSync(fallbackPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(fallbackPath, "utf8"));
    expect(onDisk.nodes.map((n: GraphNode) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("D: client without a fallback store returns empty results instead of throwing", async () => {
    const deadPort = await getDeadPort();
    const client = new GraphifyMcpClient(`http://127.0.0.1:${deadPort}`);

    await expect(client.upsertNodes(sampleNodes)).resolves.toBeUndefined();
    await expect(client.upsertEdges(sampleEdges)).resolves.toBeUndefined();
    await expect(client.queryByKeyword("orchestrate")).resolves.toEqual([]);
    await expect(client.getNodesByIds(["n1"])).resolves.toEqual([]);
    await expect(client.getNeighbors(["n1"])).resolves.toEqual([]);
    expect(client.readSnapshot()).toEqual({ nodes: [], edges: [] });
    expect(client.isDegraded).toBe(true);
  });

  it("E: factory returns a working client when the endpoint is unreachable (file fallback)", async () => {
    const deadPort = await getDeadPort();
    const storePath = join(baseDir, `factory-e-${Date.now()}.json`);
    const cfg = buildConfig({
      mcpEndpoint: `http://127.0.0.1:${deadPort}`,
      graphStorePath: storePath,
    });

    const client = createGraphClient(cfg);
    expect(client).toBeInstanceOf(GraphifyMcpClient);

    await client.upsertNodes([{ id: "f1", type: "File", content: "factory degraded to file store" }]);
    const hits = await client.queryByKeyword("degraded");
    expect(hits.map((n) => n.id)).toEqual(["f1"]);
    expect((client as GraphifyMcpClient).isDegraded).toBe(true);
    expect(existsSync(storePath)).toBe(true);
  });

  it("F: factory throws a clear error when mcpEndpoint is missing entirely", () => {
    const cfg = {
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-5.3-codex" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 4000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "mcp-http",
        graphStorePath: join(baseDir, "missing-endpoint.json"),
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
    } as unknown as GraphFlowConfig;
    expect(() => createGraphClient(cfg)).toThrow(/mcpEndpoint is required for mcp-http/);
  });

  it("G: file fallback client produced by the factory behaves like the file transport", async () => {
    const deadPort = await getDeadPort();
    const storePath = join(baseDir, `factory-g-${Date.now()}.json`);
    const cfg = buildConfig({
      mcpEndpoint: `http://127.0.0.1:${deadPort}`,
      graphStorePath: storePath,
    });

    const client = createGraphClient(cfg) as GraphifyMcpClient;
    await client.upsertNodes(sampleNodes);
    // After degradation, the underlying store is the mirror file client.
    const mirror = new GraphifyFileClient(storePath);
    const hits = await mirror.queryByKeyword("validator");
    expect(hits.map((n) => n.id)).toEqual(["n3"]);
  });
});
