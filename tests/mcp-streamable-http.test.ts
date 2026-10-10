import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("graphflow-mcp --http (server entry point)", () => {
  it("serves more than one stateless request", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gf-http-cli-"));
    writeFileSync(join(workspace, "a.ts"), "export const a = 1;\n");
    const child = spawn(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/surfaces/mcp/server.ts"), "--http", "--port", "0"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GRAPHFLOW_WORKSPACE_ROOT: workspace,
          GRAPHFLOW_SKIP_EMBEDDING_WARMUP: "1",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      }
    );
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error(`server did not listen: ${stderr.slice(-500)}`)), 45_000);
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (chunk: string) => {
          stderr += chunk;
          const match = /Streamable HTTP listening on (\S+)/.exec(stderr);
          if (match) {
            clearTimeout(timer);
            resolveUrl(match[1]!);
          }
        });
        child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr.slice(-500)}`)));
      });
      const client = new Client({ name: "graphflow-cli-http", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect(await client.ping()).toEqual({});
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("graphflow_context");
      const guide = await client.callTool({ name: "graphflow_skill_guide", arguments: { section: "tools" } });
      expect(guide.isError).not.toBe(true);
      await client.close();
    } finally {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 60_000);
});

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
    await expect(
      startStreamableHttpServer(undefined, {
        host: "0.0.0.0",
        port: 0,
        allowedHosts: ["graphflow.example"],
      })
    ).rejects.toThrow(/without bearer\/JWT authentication/i);
    expect(() =>
      readMcpHttpOptionsFromArgv(["--http", "--port", "70000"])
    ).toThrow(/--port/);
  });

  it("rejects malformed tenant identifiers even without a tenant allowlist", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      enableJsonResponse: true,
    });
    try {
      for (const tenant of ["..", ".", "../outside", "bad tenant", "x".repeat(65)]) {
        const response = await postJson(
          started.url,
          { jsonrpc: "2.0", id: "tenant", method: "ping" },
          { "X-GraphFlow-Tenant": tenant }
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error.message).toMatch(/tenant is not allowed/i);
      }
    } finally {
      await started.close();
    }
  });

  it("enforces RBAC on tools/call when bearer roles are configured", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      enableJsonResponse: true,
      rbac: true,
      auth: {
        bearerRoleMap: { view: "viewer", write: "contributor" },
      },
    });
    try {
      const denied = await postJson(
        started.url,
        {
          jsonrpc: "2.0",
          id: "index",
          method: "tools/call",
          params: { name: "graphflow_index", arguments: { mode: "incremental" } },
        },
        { Authorization: "Bearer view" }
      );
      expect(denied.status).toBe(200);
      const deniedBody = await denied.json();
      expect(deniedBody.error?.message).toMatch(/RBAC denied|graph.write/);

      const allowed = await postJson(
        started.url,
        {
          jsonrpc: "2.0",
          id: "guide",
          method: "tools/call",
          params: { name: "graphflow_skill_guide", arguments: { section: "tools" } },
        },
        { Authorization: "Bearer view" }
      );
      expect(allowed.status).toBe(200);
      const allowedBody = await allowed.json();
      expect(allowedBody.error).toBeUndefined();
      expect(allowedBody.result?.structuredContent).toMatchObject({ section: "tools" });

      const parsed = readMcpHttpOptionsFromArgv([
        "--http",
        "--http-token",
        "admin:secret",
        "--rbac",
      ]);
      expect(parsed?.auth?.bearerRoleMap?.secret).toBe("admin");
      expect(parsed?.rbac).toBe(true);
    } finally {
      await started.close();
    }
  });
});
