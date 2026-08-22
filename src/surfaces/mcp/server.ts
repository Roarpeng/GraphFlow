#!/usr/bin/env node
process.env.GRAPHFLOW_MCP_STDIO ??= "1";
process.env.GRAPHFLOW_LOG_JSON ??= "1";

import type { Readable, Writable } from "node:stream";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  type CallToolResult,
  type LoggingLevel,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  diagnoseRoutingResult,
  getFlywheelReport,
  getTokenSavingsStats,
  inspectGraph,
} from "../cli/runtime";
import { getRuntimeTimelineSummary } from "../../core/cancellation";
import { ensureMcpWorkspaceEnv } from "../../config/discover-workspace.js";
import { attachMcpLogSink } from "../../utils/logger.js";
import { getToolDefinitions, type ToolDefinition } from "./tool-definitions.js";
import {
  executeToolCall as executeToolCallImpl,
  isRecord,
  readProgressToken,
  readRequiredString,
  type ToolCall,
  type ToolCallResponse,
} from "./tool-handlers.js";
import { PACKAGE_VERSION } from "./version.js";

export { getToolDefinitions } from "./tool-definitions.js";
export type { ToolCall, ToolCallResponse } from "./tool-handlers.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** Servers whose SDK transport is currently connected, so notifications can be emitted. */
const connectedServers = new WeakSet<McpServer>();

const DIAGNOSE_RESOURCE_URI = "graphflow://diagnose";
const STATS_RESOURCE_URI = "graphflow://stats";
const FLYWHEEL_RESOURCE_URI = "graphflow://flywheel";
const ATP_IR_RESOURCE_URI = "graphflow://atp-ir";
/**
 * SDK 1.30 ships the draft stateless spec types while its runtime still
 * negotiates the stable handshake protocol. Keep both paths explicit until the
 * SDK promotes the draft runtime constants.
 */
const STATELESS_DISCOVERY_PROTOCOL_VERSION = "DRAFT-2026-v1";

/**
 * 资源面注册表（P2-1）：在 graphflow://diagnose 基础上新增 stats / flywheel /
 * atp-ir 三个只读资源。资源面与工具面相互独立，10 个工具定义保持零改动；
 * resources/list 的 name/description/mimeType 与 resources/read 返回保持一致。
 */
const GRAPHFLOW_RESOURCES = [
  {
    uri: DIAGNOSE_RESOURCE_URI,
    name: "GraphFlow Diagnose",
    description:
      "Provider health, graph statistics, token savings, and flywheel report for the bound workspace.",
    mimeType: "application/json",
  },
  {
    uri: STATS_RESOURCE_URI,
    name: "GraphFlow Stats",
    description:
      "Graph statistics, cumulative run and token-savings statistics for the bound workspace.",
    mimeType: "application/json",
  },
  {
    uri: FLYWHEEL_RESOURCE_URI,
    name: "GraphFlow Flywheel Report",
    description:
      "Skill flywheel report: skill distribution, episode outcomes, and memory attribution for the bound workspace.",
    mimeType: "application/json",
  },
  {
    uri: ATP_IR_RESOURCE_URI,
    name: "GraphFlow ATP/IR Specification",
    description:
      "ATP/IR protocol version and work-item anchor reference for the agent-bridge submit/merge flow (static text).",
    mimeType: "text/markdown",
  },
];

const resourceByUri = new Map(GRAPHFLOW_RESOURCES.map((resource) => [resource.uri, resource]));

/** 静态文本资源：ATP/IR 规范版本与锚点说明（完整契约见 docs/atp-ir-spec-v1.md）。 */
const ATP_IR_RESOURCE_TEXT = `# ATP/IR — Agent Thinking Protocol Intermediate Representation

Protocol version: **atp-ir/1.2** (additive over v1.0 / v1.1)
Reference implementation: GraphFlow (@roarpeng/graphflow) v1.8+

## Roles
- Producer: emits AgentWorkItem sets (GraphFlow graphflow_plan / graphflow_run / graphflow_insight)
- Agent: answers work items with its own model, submits answers back
- Consumer: validates completeness and merges answers into insight + final DAG plan

## Work-item anchors (stable machine IDs)
| ID | kind | required |
| --- | --- | --- |
| intent-analysis | intent | required (complex set) |
| requirement-analysis | requirement | required (complex set) |
| hat-1-white .. hat-6-blue | six-hats | required (complex set) |
| why-1-white .. why-6-blue | five-whys | required (complex set) |
| first-principles | first-principles | required (complex set) |
| decision-matrix | decision-matrix | required (complex set) |
| plan-refinement | plan-refinement | required (complex set) |
| simple-plan-intent | intent | required (simple-plan set) |
| simple-plan-decomposition | plan-refinement | required (simple-plan set) |
| clarification | clarification | conditional (intent confidence < 0.6) |
| alignment-check | alignment | optional (post-execution) |

## Submit / merge flow
producer: plan(task) -> { agentWorkItems, agentInstructions, status: "awaiting-agent" }
agent:    insight submit { task, workItemId, response }  (per required item)
agent:    insight merge { task }                         -> { plan, insight }
agent:    report_outcome(episodeId, success, lessons[], deviation?, requirementIds?, conceptIds?, codeHints?)  (post-execution, closes the flywheel; optional eng KG links)

## v1.2 increments (optional, see docs/atp-ir-spec-v1.md §8)
- memory-recall: recall similar episodic memories into packaged context (auto-injected)
- memory-backfill: report_outcome auto-backfills the episode record + skill scoring`;

async function readDiagnoseResource(): Promise<unknown> {
  const health = diagnoseRoutingResult(undefined);
  const graph = await inspectGraph(undefined);
  const stats = getTokenSavingsStats(undefined, undefined);
  const flywheel = getFlywheelReport(undefined, undefined);
  return {
    health,
    graph,
    stats,
    flywheel,
    runtimeTimeline: getRuntimeTimelineSummary(),
  };
}

/** 图统计 + 运行/token 节省统计（与 graphflow_diagnose 同源，聚焦统计视图）。 */
async function readStatsResource(): Promise<unknown> {
  const graph = await inspectGraph(undefined);
  const stats = getTokenSavingsStats(undefined, undefined);
  return {
    graph: {
      transport: graph.transport,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      nodeTypeCount: graph.nodeTypeCount,
    },
    runs: stats,
  };
}

async function readResource(uri: string): Promise<ReadResourceResult> {
  const resource = resourceByUri.get(uri);
  if (!resource) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  }
  if (uri === DIAGNOSE_RESOURCE_URI) {
    return toResourceResult(uri, resource.mimeType, await readDiagnoseResource());
  }
  if (uri === STATS_RESOURCE_URI) {
    return toResourceResult(uri, resource.mimeType, await readStatsResource());
  }
  if (uri === FLYWHEEL_RESOURCE_URI) {
    return toResourceResult(uri, resource.mimeType, getFlywheelReport(undefined, undefined));
  }
  return toResourceResult(uri, resource.mimeType, ATP_IR_RESOURCE_TEXT);
}

function toResourceResult(uri: string, mimeType: string, payload: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export interface McpServer {
  serverInfo: {
    name: string;
    version: string;
  };
  tools: ToolDefinition[];
  /** SDK-backed server used by startStdioServer for the wire connection. */
  sdkServer: Server;
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
  /** Emit a notifications/progress update for a long-running tool call (no-op when not connected). */
  sendProgress(progressToken: string | number, progress: number, total: number): void;
  /** Emit a notifications/message log entry (no-op when not connected). */
  sendLogNotification(level: LoggingLevel, message: string): void;
}

export interface McpHttpServerOptions {
  /** Defaults to loopback. Non-loopback binds require explicit allowedHosts. */
  host?: string;
  port?: number;
  endpoint?: string;
  /** false keeps every HTTP request independent (MCP stateless core). */
  stateful?: boolean;
  enableJsonResponse?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  signal?: AbortSignal;
}

export interface StartedMcpHttpServer {
  httpServer: HttpServer;
  url: string;
  endpoint: string;
  host: string;
  port: number;
  stateful: boolean;
  close(): Promise<void>;
}

interface HttpMcpSession {
  id?: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export async function executeToolCall(
  call: ToolCall,
  server: McpServer = createMcpServer()
): Promise<ToolCallResponse> {
  return executeToolCallImpl(call, server);
}

export function createMcpServer(
  _emitNotification?: (notification: JsonRpcNotification) => void
): McpServer {
  const tools = getToolDefinitions();

  const sdkServer = new Server(
    {
      name: "graphflow",
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
        logging: {},
        resources: {},
      },
    }
  );

  // SDK transports dispatch protocol requests directly to the low-level
  // Server, so the draft stateless discovery method must live beside the
  // initialized handshake handlers rather than only in the stdio JSON-RPC shim.
  sdkServer.fallbackRequestHandler = async (request) => {
    if (request.method === "server/discover") {
      return {
        protocolVersion: STATELESS_DISCOVERY_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          logging: {},
          resources: {},
        },
        serverInfo: wrapper.serverInfo,
      };
    }
    throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`);
  };

  const wrapper: McpServer = {
    serverInfo: {
      name: "graphflow",
      version: PACKAGE_VERSION,
    },
    tools,
    sdkServer,
    sendProgress(progressToken: string | number, progress: number, total: number): void {
      if (!connectedServers.has(wrapper)) {
        return;
      }
      void sdkServer
        .notification({
          method: "notifications/progress",
          params: { progressToken, progress, total },
        })
        .catch(() => {
          // Notification is best-effort; drop failures (e.g. transport closing).
        });
    },
    sendLogNotification(level: LoggingLevel, message: string): void {
      if (!connectedServers.has(wrapper)) {
        return;
      }
      void sdkServer
        .notification({
          method: "notifications/message",
          params: { level, data: message, loggerName: "graphflow" },
        })
        .catch(() => {
          // Best-effort log notification; stderr remains the fallback channel.
        });
    },
    async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
      if (request.method === "notifications/initialized") {
        return undefined;
      }
      try {
        switch (request.method) {
          case "server/discover":
            return respond(request.id ?? null, {
              protocolVersion: STATELESS_DISCOVERY_PROTOCOL_VERSION,
              capabilities: {
                tools: {},
                logging: {},
                resources: {},
              },
              serverInfo: wrapper.serverInfo,
            });
          case "initialize":
            return respond(request.id ?? null, {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {
                tools: {},
                logging: {},
                resources: {},
              },
              serverInfo: wrapper.serverInfo,
            });
          case "ping":
            return respond(request.id ?? null, {});
          case "tools/list":
            return respond(request.id ?? null, { tools });
          case "tools/call":
            return respond(request.id ?? null, await callTool(request.params ?? {}));
          case "resources/list":
            return respond(request.id ?? null, { resources: GRAPHFLOW_RESOURCES });
          case "resources/read":
            return respond(
              request.id ?? null,
              await readResource(readRequiredString((request.params ?? {}).uri, "uri"))
            );
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`);
        }
      } catch (error) {
        return respondError(request.id ?? null, error);
      }
    },
  };

  async function callTool(params: Record<string, unknown>): Promise<CallToolResult> {
    const progressToken = readProgressToken(params);
    const call: ToolCall = {
      name: readRequiredString(params.name, "name"),
      arguments: isRecord(params.arguments) ? params.arguments : {},
      ...(progressToken !== undefined ? { progressToken } : {}),
    };
    try {
      return await executeToolCallImpl(call, wrapper);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tool execution error";
      wrapper.sendLogNotification("error", `Tool '${call.name}' failed: ${message}`);
      throw new McpError(ErrorCode.InternalError, message);
    }
  }

  sdkServer.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  sdkServer.setRequestHandler(CallToolRequestSchema, (request) => callTool(request.params as Record<string, unknown>));
  sdkServer.setRequestHandler(SetLevelRequestSchema, () => ({}));
  sdkServer.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: GRAPHFLOW_RESOURCES }));
  sdkServer.setRequestHandler(ReadResourceRequestSchema, (request) => readResource(request.params.uri));

  return wrapper;
}

function respond(id: number | string | null, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function respondError(id: number | string | null, error: unknown): JsonRpcResponse {
  const code = error instanceof McpError ? error.code : ErrorCode.InternalError;
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

export async function startStdioServer(
  server: McpServer = createMcpServer(),
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Promise<void> {
  const transport = new StdioServerTransport(input, output);
  await server.sdkServer.connect(transport);
  connectedServers.add(server);
}

function normalizeHttpEndpoint(endpoint: string | undefined): string {
  const value = endpoint?.trim() || "/mcp";
  if (!value.startsWith("/")) throw new Error("MCP HTTP endpoint must begin with '/'");
  if (value.includes("*") || value.includes("?")) throw new Error("MCP HTTP endpoint must be an exact path");
  return value.endsWith("/") && value !== "/" ? value.slice(0, -1) : value;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function writeHttpJsonError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  requestId: number | string | null = null
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    error: { code, message },
  }));
}

function validateHttpOrigin(req: IncomingMessage, allowedOrigins: string[] | undefined): boolean {
  const origin = req.headers.origin;
  // No Origin means a non-browser MCP client. Browser clients must be explicitly allowed.
  if (typeof origin !== "string" || origin.length === 0) return true;
  return Boolean(allowedOrigins?.some((allowed) => allowed.toLowerCase() === origin.toLowerCase()));
}

function validateHttpHost(req: IncomingMessage, host: string, allowedHosts: string[] | undefined): boolean {
  const header = req.headers.host;
  if (!header) return false;
  if (!allowedHosts?.length) {
    const hostname = header.split(":", 2)[0] ?? "";
    return isLoopbackHost(host) && isLoopbackHost(hostname);
  }
  const normalized = header.toLowerCase();
  return allowedHosts.some((allowed) => {
    const value = allowed.toLowerCase();
    return value === normalized || (value === "*" && false);
  });
}

async function handleWithHttpMcpSession(
  req: IncomingMessage,
  res: ServerResponse,
  session: HttpMcpSession,
  options?: {
    sessions?: Map<string, HttpMcpSession>;
    stateful?: boolean;
  }
): Promise<void> {
  connectedServers.add(session.server);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    connectedServers.delete(session.server);
    if (options?.sessions && session.id) options.sessions.delete(session.id);
    void session.transport.close().catch(() => undefined);
  };
  const stateful = options?.stateful === true;
  session.transport.onclose = dispose;
  // Stateful sessions survive the HTTP response; DELETE or transport close owns
  // their lifecycle. Uninitialized stateful attempts are cleaned with the response.
  res.once("close", () => {
    // The predicate is checked when the response closes because an initialize
    // request assigns its stateful session id while the response is open.
    if (!stateful || !session.id) dispose();
  });
  try {
    await session.transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      writeHttpJsonError(res, 500, ErrorCode.InternalError, "Internal GraphFlow MCP HTTP error");
    } else {
      res.destroy();
    }
    session.server.sendLogNotification(
      "error",
      `GraphFlow MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function startStreamableHttpServer(
  createServerInstance: () => McpServer = () => createMcpServer(),
  options: McpHttpServerOptions = {}
): Promise<StartedMcpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? Number(process.env.GRAPHFLOW_MCP_HTTP_PORT ?? 0);
  const stateful = options.stateful ?? process.env.GRAPHFLOW_MCP_HTTP_STATEFUL === "1";
  const enableJsonResponse = options.enableJsonResponse ?? process.env.GRAPHFLOW_MCP_HTTP_JSON_RESPONSE !== "0";
  const endpoint = normalizeHttpEndpoint(options.endpoint ?? process.env.GRAPHFLOW_MCP_HTTP_ENDPOINT);
  const sessions = new Map<string, HttpMcpSession>();

  if (!isLoopbackHost(host) && !options.allowedHosts?.length) {
    throw new Error(`Refusing to bind MCP HTTP to non-loopback ${host} without explicit allowedHosts`);
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
      if (!validateHttpHost(req, host, options.allowedHosts)) {
        writeHttpJsonError(res, 403, ErrorCode.InvalidRequest, "Invalid GraphFlow MCP HTTP Host");
        return;
      }
      if (!validateHttpOrigin(req, options.allowedOrigins)) {
        writeHttpJsonError(res, 403, ErrorCode.InvalidRequest, "Origin is not allowed by GraphFlow MCP HTTP");
        return;
      }
      // Host was validated above; use a trusted base solely to parse pathname/search.
      const url = new URL(req.url ?? "/", "http://graphflow.invalid");
      if (url.pathname !== endpoint) {
        writeHttpJsonError(res, 404, ErrorCode.InvalidRequest, `Unknown GraphFlow MCP HTTP endpoint: ${url.pathname}`);
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      if (stateful && typeof sessionId === "string" && sessionId.length > 0) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          writeHttpJsonError(res, 404, -32001, "GraphFlow MCP session not found", null);
          return;
        }
        await handleWithHttpMcpSession(req, res, existing, { sessions, stateful });
        return;
      }

      let session!: HttpMcpSession;
      const transport = new StreamableHTTPServerTransport({
        ...(stateful
          ? {
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (initializedId: string) => {
                session.id = initializedId;
                sessions.set(initializedId, session);
              },
            }
          : {}),
        enableJsonResponse,
        ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
        ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
      });
      const serverInstance = createServerInstance();
      session = { server: serverInstance, transport };
      // SDK 1.30 types optional callbacks as `T | undefined`, which its own
      // exactOptionalPropertyTypes build rejects structurally despite runtime
      // compatibility. Keep the narrow local cast at this SDK boundary.
      type ConnectableTransport = Parameters<typeof serverInstance.sdkServer.connect>[0];
      await serverInstance.sdkServer.connect(transport as ConnectableTransport);
      await handleWithHttpMcpSession(req, res, session, { sessions, stateful });
    })().catch((error) => {
      console.error("[GraphFlow MCP] Unexpected HTTP error:", error);
      if (!res.headersSent) {
        writeHttpJsonError(res, 500, ErrorCode.InternalError, "Unexpected GraphFlow MCP HTTP error");
      } else {
        res.destroy();
      }
    });
  });

  if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => {
        void httpServer.close();
      },
      { once: true }
    );
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, host, resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("GraphFlow MCP HTTP listener did not return a TCP address");
  }

  return {
    httpServer,
    url: `http://${host === "::1" ? `[${host}]` : host}:${address.port}${endpoint}`,
    endpoint,
    host,
    port: address.port,
    stateful,
    async close(): Promise<void> {
      for (const session of [...sessions.values()]) {
        connectedServers.delete(session.server);
        await session.transport.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export function readMcpHttpOptionsFromArgv(
  argv: string[] = process.argv.slice(2)
): McpHttpServerOptions | undefined {
  if (!argv.includes("--http")) return undefined;
  const readFlag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1]?.trim() : undefined;
  };
  const collectFlags = (name: string): string[] => {
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === name) {
        const value = argv[index + 1]?.trim();
        if (value) values.push(value);
      }
    }
    return values;
  };
  const rawPort = readFlag("--port");
  const port = rawPort ? Number.parseInt(rawPort, 10) : undefined;
  const hostFlag = readFlag("--host");
  const endpointFlag = readFlag("--endpoint");
  const allowedHostsFlag = readFlag("--allow-host");
  const allowedOriginsFlag = readFlag("--allow-origin");
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return {
    ...(hostFlag ? { host: hostFlag } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(endpointFlag ? { endpoint: endpointFlag } : {}),
    stateful: argv.includes("--stateful"),
    enableJsonResponse: !argv.includes("--sse-only"),
    ...(allowedHostsFlag ? { allowedHosts: collectFlags("--allow-host") } : {}),
    ...(allowedOriginsFlag ? { allowedOrigins: collectFlags("--allow-origin") } : {}),
  };
}

function installMcpProcessGuards(server: McpServer): void {
  process.on("uncaughtException", (error) => {
    console.error("[GraphFlow MCP] uncaughtException:", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[GraphFlow MCP] unhandledRejection:", reason);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`[GraphFlow MCP] Received ${signal}, shutting down gracefully...`);
    void server.sdkServer
      .close()
      .catch(() => {
        // Best-effort close; fall through to exit.
      })
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function runMcpServerCli(): void {
  const argv = process.argv.slice(2);
  const httpOptions = readMcpHttpOptionsFromArgv(argv);
  const server = createMcpServer();
  installMcpProcessGuards(server);
  attachMcpLogSink((level, message) => server.sendLogNotification(level as LoggingLevel, message));

  // Start file watcher only when we resolved a real project root.
  // Cursor often spawns MCP with cwd=user home; watching that freezes startup
  // by indexing AppData/Chrome/OneDrive and flooding stderr.
  const workspaceRoot = ensureMcpWorkspaceEnv();
  void (async () => {
    if (!workspaceRoot) {
      const message =
        "[GraphFlow MCP] No safe workspace root resolved; skipping auto file watcher. " +
        "Pass rootDir on tools or set GRAPHFLOW_WORKSPACE_ROOT.";
      console.error(message);
      server.sendLogNotification("warning", message);
      return;
    }
    try {
      const { isUnsafeWorkspaceFallback } = await import("../../config/discover-workspace.js");
      if (isUnsafeWorkspaceFallback(workspaceRoot)) {
        const message = `[GraphFlow MCP] Refusing to watch unsafe workspace root: ${workspaceRoot}`;
        console.error(message);
        server.sendLogNotification("warning", message);
        return;
      }
      const { resolveConfig } = await import("../../config/resolve.js");
      const { startFileWatcherIfEnabled } = await import("../cli/runtime/graph.js");
      const config = resolveConfig();
      const started = startFileWatcherIfEnabled(config);
      if (started) {
        server.sendLogNotification("info", "[GraphFlow MCP] File watcher started");
      }
    } catch (error) {
      const message =
        "[GraphFlow MCP] File watcher not started: " +
        (error instanceof Error ? error.message : error);
      console.error(message);
      server.sendLogNotification("error", message);
    }
  })();

  if (httpOptions) {
    void startStreamableHttpServer(() => server, httpOptions)
      .then((started) => {
        console.error(
          `[GraphFlow MCP] Streamable HTTP listening on ${started.url} (${started.stateful ? "stateful" : "stateless"})`
        );
      })
      .catch((error) => {
        console.error("[GraphFlow MCP] Failed to start Streamable HTTP server:", error);
        process.exit(1);
      });
    return;
  }

  // Respond to initialize immediately; watcher is background-only.
  void startStdioServer(server).catch((error) => {
    console.error("[GraphFlow MCP] Failed to start stdio server:", error);
    process.exit(1);
  });
}

if (require.main === module) {
  runMcpServerCli();
}
