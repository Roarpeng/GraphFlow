#!/usr/bin/env node
process.env.GRAPHFLOW_MCP_STDIO ??= "1";
process.env.GRAPHFLOW_LOG_JSON ??= "1";

import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

if (require.main === module) {
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

  // Respond to initialize immediately; watcher is background-only.
  void startStdioServer(server).catch((error) => {
    console.error("[GraphFlow MCP] Failed to start stdio server:", error);
    process.exit(1);
  });
}
