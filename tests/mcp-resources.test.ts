import { describe, expect, it } from "vitest";
import { createMcpServer, type JsonRpcRequest, type JsonRpcResponse } from "../src/surfaces/mcp/server";

/**
 * P2-1 MCP resources 扩展测试：
 * - resources/list 包含新增 URI（diagnose / stats / flywheel / atp-ir）
 * - resources/read 返回正确的 mimeType 与内容
 * - 未知 URI 返回标准错误码 -32602（ErrorCode.InvalidParams）
 * - 工具面保持零改动（tools/list 仍为 10 个工具）
 */

const EXPECTED_RESOURCE_URIS = [
  "graphflow://diagnose",
  "graphflow://stats",
  "graphflow://flywheel",
  "graphflow://atp-ir",
];

interface ResourceEntry {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface ReadResult {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

function request(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) };
}

async function listResources(server: ReturnType<typeof createMcpServer>): Promise<ResourceEntry[]> {
  const response = (await server.handleRequest(request("resources/list"))) as JsonRpcResponse;
  expect(response.error).toBeUndefined();
  return (response.result as { resources: ResourceEntry[] }).resources;
}

async function readResource(
  server: ReturnType<typeof createMcpServer>,
  uri: string
): Promise<JsonRpcResponse> {
  return (await server.handleRequest(request("resources/read", { uri }))) as JsonRpcResponse;
}

function readText(result: ReadResult): string {
  const text = result.contents[0]?.text;
  expect(text).toBeDefined();
  return text!;
}

describe("P2-1 MCP resources extension", () => {
  it("resources/list exposes diagnose plus the new stats/flywheel/atp-ir URIs", async () => {
    const server = createMcpServer();
    const resources = await listResources(server);

    const uris = resources.map((resource) => resource.uri);
    for (const uri of EXPECTED_RESOURCE_URIS) {
      expect(uris).toContain(uri);
    }

    // 每个条目都必须有非空的 name / description / mimeType
    for (const resource of resources) {
      expect(resource.name.length).toBeGreaterThan(0);
      expect(resource.description.length).toBeGreaterThan(0);
      expect(resource.mimeType.length).toBeGreaterThan(0);
    }
  });

  it("tool surface stays frozen: tools/list still returns exactly 10 tools", async () => {
    const server = createMcpServer();
    const response = (await server.handleRequest(request("tools/list"))) as JsonRpcResponse;
    expect(response.error).toBeUndefined();
    const tools = (response.result as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(10);
  });

  it("resources/read mimeType matches resources/list for every resource", async () => {
    const server = createMcpServer();
    const resources = await listResources(server);

    for (const resource of resources) {
      const response = await readResource(server, resource.uri);
      expect(response.error).toBeUndefined();
      const result = response.result as ReadResult;
      expect(result.contents[0].uri).toBe(resource.uri);
      expect(result.contents[0].mimeType).toBe(resource.mimeType);
      expect(readText(result).length).toBeGreaterThan(0);
    }
  });

  it("graphflow://stats returns graph + run/token-savings statistics as JSON", async () => {
    const server = createMcpServer();
    const response = await readResource(server, "graphflow://stats");
    expect(response.error).toBeUndefined();

    const result = response.result as ReadResult;
    expect(result.contents[0].mimeType).toBe("application/json");
    const payload = JSON.parse(readText(result)) as {
      graph: { transport: string; nodeCount: number; edgeCount: number; nodeTypeCount: Record<string, number> };
      runs: { totalRuns: number; totalSavedTokens: number; recentRecords: unknown[] };
    };
    expect(typeof payload.graph.nodeCount).toBe("number");
    expect(typeof payload.graph.edgeCount).toBe("number");
    expect(typeof payload.graph.nodeTypeCount).toBe("object");
    expect(typeof payload.runs.totalRuns).toBe("number");
    expect(typeof payload.runs.totalSavedTokens).toBe("number");
    expect(Array.isArray(payload.runs.recentRecords)).toBe(true);
  });

  it("graphflow://flywheel returns skill distribution and memory attribution", async () => {
    const server = createMcpServer();
    const response = await readResource(server, "graphflow://flywheel");
    expect(response.error).toBeUndefined();

    const result = response.result as ReadResult;
    expect(result.contents[0].mimeType).toBe("application/json");
    const payload = JSON.parse(readText(result)) as {
      skills: { total: number; positive: number; neutral: number; negative: number };
      episodes: { total: number; pass: number; fail: number; pending: number };
      memoryAttribution: { memoryHits: number; staleEpisodes: number };
    };
    expect(typeof payload.skills.total).toBe("number");
    expect(typeof payload.skills.positive).toBe("number");
    expect(typeof payload.episodes.total).toBe("number");
    expect(typeof payload.memoryAttribution.memoryHits).toBe("number");
    expect(typeof payload.memoryAttribution.staleEpisodes).toBe("number");
  });

  it("graphflow://atp-ir returns static markdown with spec version and anchors", async () => {
    const server = createMcpServer();
    const response = await readResource(server, "graphflow://atp-ir");
    expect(response.error).toBeUndefined();

    const result = response.result as ReadResult;
    expect(result.contents[0].mimeType).toBe("text/markdown");
    const text = readText(result);
    expect(text).toContain("atp-ir/1.2");
    // 锚点说明包含稳定 work-item ID
    expect(text).toContain("intent-analysis");
    expect(text).toContain("plan-refinement");
    expect(text).toContain("alignment-check");
    expect(text).toContain("report_outcome");
  });

  it("graphflow://diagnose keeps working (regression) with the full payload", async () => {
    const server = createMcpServer();
    const response = await readResource(server, "graphflow://diagnose");
    expect(response.error).toBeUndefined();

    const result = response.result as ReadResult;
    expect(result.contents[0].mimeType).toBe("application/json");
    const payload = JSON.parse(readText(result)) as Record<string, unknown>;
    for (const key of ["health", "graph", "stats", "flywheel", "runtimeTimeline"]) {
      expect(payload[key]).toBeDefined();
    }
  });

  it("unknown resource URI returns the standard -32602 InvalidParams error", async () => {
    const server = createMcpServer();
    const response = await readResource(server, "graphflow://does-not-exist");
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain("Unknown resource");
    expect(response.result).toBeUndefined();
  });
});
