import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  closeGraphFlowClients,
  fetchGraphFlowContext,
  graphFlowClientCount,
  prewarmGraphFlowClient,
  resolveGraphFlowServer,
  type GraphFlowServerCommand,
} from "../src/host/graphflow-mcp-client.js";

// Minimal newline-delimited JSON-RPC MCP server: records its pid per spawn and
// answers graphflow_context with its own pid so tests can tell servers apart.
const FAKE_SERVER = String.raw`
const fs = require("node:fs");
const [, , spawnLog, mode] = process.argv;
fs.appendFileSync(spawnLog, process.pid + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-graphflow", version: "0.0.0" },
    } });
  } else if (msg.method === "tools/call") {
    if (mode === "hang") return;
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({
      summary: ["pid " + process.pid, "warmup " + (process.env.GRAPHFLOW_MCP_WARMUP || "")],
      anchors: [{ id: "file:src/a.ts", relevance: 1 }],
    }) }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}
`;

const T = 30_000;
const dirs: string[] = [];
const savedPool = process.env.EFF_GRAPHFLOW_POOL;

function fakeServer(mode = "ok"): { server: GraphFlowServerCommand; rootDir: string; spawnLog: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "eff-gf-client-"));
  dirs.push(rootDir);
  const script = join(rootDir, "fake-server.cjs");
  const spawnLog = join(rootDir, "spawns.log");
  writeFileSync(script, FAKE_SERVER);
  writeFileSync(spawnLog, "");
  return { server: { command: process.execPath, args: [script, spawnLog, mode] }, rootDir, spawnLog };
}

function spawnedPids(spawnLog: string): number[] {
  return readFileSync(spawnLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

afterEach(async () => {
  await closeGraphFlowClients();
  if (savedPool === undefined) delete process.env.EFF_GRAPHFLOW_POOL;
  else process.env.EFF_GRAPHFLOW_POOL = savedPool;
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a killed child may still hold the directory on Windows
    }
  }
});

describe("fetchGraphFlowContext connection pool", () => {
  it(
    "reuses one server across calls and closeGraphFlowClients ends it",
    async () => {
      const { server, rootDir, spawnLog } = fakeServer();
      const first = await fetchGraphFlowContext({ task: "a", rootDir, server });
      const second = await fetchGraphFlowContext({ task: "b", rootDir, server });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.context.summary[0]).toBe(second.context.summary[0]);
      expect(first.context.anchorFiles).toEqual(["src/a.ts"]);
      expect(first.context.summary[1]).toBe("warmup 1");
      const pids = spawnedPids(spawnLog);
      expect(pids).toHaveLength(1);
      expect(graphFlowClientCount()).toBe(1);

      await closeGraphFlowClients();
      expect(graphFlowClientCount()).toBe(0);
      expect(await waitFor(() => !alive(pids[0]!))).toBe(true);
    },
    T
  );

  it(
    "pooled:false and EFF_GRAPHFLOW_POOL=0 spawn one server per call and leave none behind",
    async () => {
      const unpooled = fakeServer();
      await fetchGraphFlowContext({ task: "a", rootDir: unpooled.rootDir, server: unpooled.server, pooled: false });
      await fetchGraphFlowContext({ task: "b", rootDir: unpooled.rootDir, server: unpooled.server, pooled: false });
      expect(spawnedPids(unpooled.spawnLog)).toHaveLength(2);

      process.env.EFF_GRAPHFLOW_POOL = "0";
      const viaEnv = fakeServer();
      prewarmGraphFlowClient({ rootDir: viaEnv.rootDir, server: viaEnv.server });
      expect(graphFlowClientCount()).toBe(0);
      await fetchGraphFlowContext({ task: "a", rootDir: viaEnv.rootDir, server: viaEnv.server });
      await fetchGraphFlowContext({ task: "b", rootDir: viaEnv.rootDir, server: viaEnv.server });
      expect(spawnedPids(viaEnv.spawnLog)).toHaveLength(2);
      expect(graphFlowClientCount()).toBe(0);

      const all = [...spawnedPids(unpooled.spawnLog), ...spawnedPids(viaEnv.spawnLog)];
      expect(await waitFor(() => all.every((pid) => !alive(pid)))).toBe(true);
    },
    T
  );

  it(
    "prewarm starts the server once and the next fetch uses it",
    async () => {
      const { server, rootDir, spawnLog } = fakeServer();
      prewarmGraphFlowClient({ rootDir, server });
      prewarmGraphFlowClient({ rootDir, server });
      expect(graphFlowClientCount()).toBe(1);
      const result = await fetchGraphFlowContext({ task: "a", rootDir, server });
      expect(result.ok).toBe(true);
      expect(spawnedPids(spawnLog)).toHaveLength(1);
    },
    T
  );

  it(
    "drops a timed-out server and kills it",
    async () => {
      const { server, rootDir, spawnLog } = fakeServer("hang");
      const result = await fetchGraphFlowContext({ task: "a", rootDir, server, timeoutMs: 1_500 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/timed out/);
      expect(graphFlowClientCount()).toBe(0);
      const [pid] = spawnedPids(spawnLog);
      expect(await waitFor(() => !alive(pid!))).toBe(true);
    },
    T
  );

  it(
    "closes an idle server after idleMs",
    async () => {
      const { server, rootDir, spawnLog } = fakeServer();
      const result = await fetchGraphFlowContext({ task: "a", rootDir, server, idleMs: 200 });
      expect(result.ok).toBe(true);
      expect(await waitFor(() => graphFlowClientCount() === 0)).toBe(true);
      const [pid] = spawnedPids(spawnLog);
      expect(await waitFor(() => !alive(pid!))).toBe(true);
    },
    T
  );
});

describe("resident GraphFlow server over Streamable HTTP", () => {
  it("resolves loopback URLs, and refuses remote ones without a bearer token", () => {
    const local = resolveGraphFlowServer(undefined, { EFF_GRAPHFLOW_MCP: "http://127.0.0.1:7357/mcp" });
    expect(local).toMatchObject({ url: "http://127.0.0.1:7357/mcp", args: [] });
    expect(local?.rejected).toBeUndefined();

    const remote = resolveGraphFlowServer(undefined, { EFF_GRAPHFLOW_MCP: "https://graphflow.example.com/mcp" });
    expect(remote?.rejected).toMatch(/non-loopback.*EFF_GRAPHFLOW_MCP_TOKEN/);

    const remoteWithToken = resolveGraphFlowServer(undefined, {
      EFF_GRAPHFLOW_MCP: "https://graphflow.example.com/mcp",
      EFF_GRAPHFLOW_MCP_TOKEN: "t0ken",
    });
    expect(remoteWithToken).toMatchObject({ url: "https://graphflow.example.com/mcp", token: "t0ken" });
    expect(remoteWithToken?.rejected).toBeUndefined();

    expect(resolveGraphFlowServer("node server.js", {})).toEqual({ command: "node", args: ["server.js"] });
  });

  it("a rejected URL fails the fetch with its reason instead of spawning", async () => {
    const server = resolveGraphFlowServer("http://10.1.2.3:7357/mcp", {})!;
    const result = await fetchGraphFlowContext({ task: "a", rootDir: tmpdir(), server });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/refusing non-loopback/);
    expect(graphFlowClientCount()).toBe(0);
  });

  it(
    "reuses one HTTP connection across calls, sends the bearer token and spawns nothing",
    async () => {
      const seen: Array<{ method?: string; auth?: string }> = [];
      const http = createServer((req: IncomingMessage, res) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => (raw += chunk));
        req.on("end", () => {
          void (async () => {
            const body = raw ? (JSON.parse(raw) as { method?: string }) : undefined;
            seen.push({ ...(body?.method ? { method: body.method } : {}), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
            const mcp = new Server({ name: "fake-http-graphflow", version: "0.0.0" }, { capabilities: { tools: {} } });
            mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
            mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
              content: [{ type: "text", text: JSON.stringify({ summary: [`query ${String(request.params.arguments?.query)}`], anchors: [{ id: "file:src/b.ts" }] }) }],
            }));
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            res.on("close", () => {
              void transport.close();
              void mcp.close();
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res, body);
          })();
        });
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = http.address() as AddressInfo;
        const server = resolveGraphFlowServer(undefined, {
          EFF_GRAPHFLOW_MCP: `http://127.0.0.1:${port}/mcp`,
          EFF_GRAPHFLOW_MCP_TOKEN: "local-secret",
        })!;
        const rootDir = mkdtempSync(join(tmpdir(), "eff-gf-http-"));
        dirs.push(rootDir);
        const first = await fetchGraphFlowContext({ task: "alpha", rootDir, server });
        const second = await fetchGraphFlowContext({ task: "beta", rootDir, server });
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(first.context.summary).toEqual(["query alpha"]);
        expect(second.context.anchorFiles).toEqual(["src/b.ts"]);
        expect(graphFlowClientCount()).toBe(1);
        expect(seen.filter((s) => s.method === "initialize")).toHaveLength(1);
        expect(seen.filter((s) => s.method === "tools/call")).toHaveLength(2);
        expect(seen.every((s) => s.auth === "Bearer local-secret")).toBe(true);
        await closeGraphFlowClients();
        expect(graphFlowClientCount()).toBe(0);
      } finally {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
      }
    },
    T
  );
});
