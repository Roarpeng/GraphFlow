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
  ListToolsRequestSchema,
  McpError,
  SetLevelRequestSchema,
  type CallToolResult,
  type LoggingLevel,
} from "@modelcontextprotocol/sdk/types.js";
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
              },
              serverInfo: wrapper.serverInfo,
            });
          case "ping":
            return respond(request.id ?? null, {});
          case "tools/list":
            return respond(request.id ?? null, { tools });
          case "tools/call":
            return respond(request.id ?? null, await callTool(request.params ?? {}));
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
