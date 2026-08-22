import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/surfaces/mcp/server";
import { getToolDefinitions } from "../src/surfaces/mcp/tool-definitions";

describe("v1.12 MCP release surface", () => {
  it("keeps the ten-tool contract while declaring JSON Schema 2020-12", () => {
    const tools = getToolDefinitions();
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect(tool.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("answers stateless discovery without replacing the legacy handshake", async () => {
    const server = createMcpServer();
    const discovered = await server.handleRequest({
      jsonrpc: "2.0",
      id: "discover-1",
      method: "server/discover",
    });
    expect(discovered).toMatchObject({
      jsonrpc: "2.0",
      id: "discover-1",
      result: {
        protocolVersion: "DRAFT-2026-v1",
        serverInfo: { name: "graphflow" },
      },
    });

    const initialized = await server.handleRequest({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(initialized?.result).toMatchObject({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "graphflow" },
    });
  });
});
