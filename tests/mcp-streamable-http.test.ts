import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  readMcpHttpOptionsFromArgv,
  startStreamableHttpServer,
} from "../src/surfaces/mcp/server";

const RPC_ACCEPT = "application/json, text/event-stream";

async function postJson(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: RPC_ACCEPT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GraphFlow MCP Streamable HTTP matrix", () => {
  it("supports the draft stateless core over HTTP JSON responses", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      enableJsonResponse: true,
    });

    try {
      expect(started.stateful).toBe(false);
      const discoveryResponse = await postJson(`${started.url}`, {
        jsonrpc: "2.0",
        id: "discover-http",
        method: "server/discover",
      });
      expect(discoveryResponse.status).toBe(200);
      const discovery = await discoveryResponse.json();
      expect(discovery).toMatchObject({
        jsonrpc: "2.0",
        id: "discover-http",
        result: {
          protocolVersion: "DRAFT-2026-v1",
          serverInfo: { name: "graphflow" },
        },
      });

      const transport = new StreamableHTTPClientTransport(new URL(started.url));
      const client = new Client({ name: "graphflow-matrix", version: "1.0.0" });
      await client.connect(transport);

      expect(client.getServerCapabilities()).toMatchObject({
        tools: {},
        logging: {},
        resources: {},
      });
      expect(await client.ping()).toEqual({});

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("graphflow://atp-ir");

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("graphflow_context");

      const resource = await client.readResource({ uri: "graphflow://atp-ir" });
      expect(resource.contents[0]?.mimeType).toBe("text/markdown");
      expect(resource.contents[0]?.text).toContain("ATP/IR");

      const toolResult = await client.callTool({
        name: "graphflow_skill_guide",
        arguments: { section: "tools" },
      });
      expect(toolResult.structuredContent).toMatchObject({ section: "tools" });

      await transport.terminateSession();
      await client.close();
    } finally {
      await started.close();
    }
  });

  it("maintains a stateful SSE session through initialize, calls, and explicit DELETE", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      stateful: true,
      enableJsonResponse: false,
    });

    try {
      const transport = new StreamableHTTPClientTransport(new URL(started.url));
      const client = new Client({ name: "graphflow-stateful", version: "1.0.0" });
      await client.connect(transport);
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();

      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(10);
      const guide = await client.callTool({
        name: "graphflow_skill_guide",
        arguments: { section: "workflows" },
      });
      expect(guide.structuredContent).toMatchObject({ section: "workflows" });

      await transport.terminateSession();
      await client.close();

      const stalePing = await postJson(
        started.url,
        { jsonrpc: "2.0", id: "stale-ping", method: "ping" },
        { "Mcp-Session-Id": sessionId! }
      );
      expect(stalePing.status).toBe(404);
    } finally {
      await started.close();
    }
  });

  it("rejects browser origins, unknown paths, unsafe binds, and invalid CLI ports", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      enableJsonResponse: true,
    });
    try {
      const forbiddenOrigin = await postJson(
        started.url,
        { jsonrpc: "2.0", id: "origin", method: "ping" },
        { Origin: "https://evil.example" }
      );
      expect(forbiddenOrigin.status).toBe(403);

      const unknownPath = await postJson(`${started.url}/not-mcp`, {
        jsonrpc: "2.0",
        id: "unknown",
        method: "ping",
      });
      expect(unknownPath.status).toBe(404);
    } finally {
      await started.close();
    }

    await expect(
      startStreamableHttpServer(undefined, { host: "0.0.0.0", port: 0 })
    ).rejects.toThrow(/non-loopback/i);
    expect(() =>
      readMcpHttpOptionsFromArgv(["--http", "--port", "70000"])
    ).toThrow(/--port/);
  });
});
