#!/usr/bin/env node
process.env.GRAPHFLOW_MCP_STDIO ??= "1";
process.env.GRAPHFLOW_LOG_JSON ??= "1";

import type { Readable, Writable } from "node:stream";
import { ensureMcpWorkspaceEnv } from "../../config/discover-workspace.js";
import { getToolDefinitions, type ToolDefinition } from "./tool-definitions.js";
import {
  executeToolCall as executeToolCallImpl,
  isRecord,
  readRequiredString,
  type ToolCall,
  type ToolCallResponse,
} from "./tool-handlers.js";
import { PACKAGE_VERSION } from "./version.js";

export { getToolDefinitions } from "./tool-definitions.js";
export type { ToolCall, ToolCallResponse } from "./tool-handlers.js";

export async function executeToolCall(
  call: ToolCall,
  server: McpServer = createMcpServer()
): Promise<ToolCallResponse> {
  return executeToolCallImpl(call, server);
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
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

export interface McpServer {
  serverInfo: {
    name: string;
    version: string;
  };
  tools: ToolDefinition[];
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

export function createMcpServer(
  _emitNotification?: (notification: JsonRpcNotification) => void
): McpServer {
  const tools = getToolDefinitions();

  return {
    serverInfo: {
      name: "graphflow",
      version: PACKAGE_VERSION,
    },
    tools,
    async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
      if (request.method === "notifications/initialized") {
        return undefined;
      }

      if (request.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "graphflow",
              version: PACKAGE_VERSION,
            },
          },
        };
      }

      if (request.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            tools,
          },
        };
      }

      if (request.method === "tools/call") {
        try {
          const params = request.params ?? {};
          const result = await executeToolCallImpl({
            name: readRequiredString(params.name, "name"),
            arguments: isRecord(params.arguments) ? params.arguments : {},
          }, undefined);
          return {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result,
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id: request.id ?? null,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : "Unknown tool execution error",
            },
          };
        }
      }

      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
    },
  };
}

export function startStdioServer(
  server: McpServer = createMcpServer((notification) => writeMessage(process.stdout, notification)),
  input: Readable = process.stdin,
  output: Writable = process.stdout
): void {
  let buffer = "";

  input.setEncoding("utf8");
  input.on("data", async (chunk: string) => {
    buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const response = await server.handleRequest(request);
        if (response) {
          writeMessage(output, response);
        }
      } catch (err) {
        // Ignore parse errors from invalid JSON lines
        console.error("[GraphFlow MCP] Error parsing incoming message:", err);
      }
    }
  });
}

function writeMessage(output: Writable, response: JsonRpcResponse | JsonRpcNotification): void {
  const payload = JSON.stringify(response);
  output.write(`${payload}\n`);
}

function installMcpProcessGuards(): void {
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
    // Stop accepting new stdin input so in-flight requests can settle.
    process.stdin.pause();
    // Give in-flight handlers a brief window to flush before exiting.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  installMcpProcessGuards();
  const workspaceRoot = ensureMcpWorkspaceEnv();

  // Start file watcher only when we resolved a real project root.
  // Cursor often spawns MCP with cwd=user home; watching that freezes startup
  // by indexing AppData/Chrome/OneDrive and flooding stderr.
  void (async () => {
    if (!workspaceRoot) {
      console.error(
        "[GraphFlow MCP] No safe workspace root resolved; skipping auto file watcher. " +
          "Pass rootDir on tools or set GRAPHFLOW_WORKSPACE_ROOT."
      );
      return;
    }
    try {
      const { isUnsafeWorkspaceFallback } = await import("../../config/discover-workspace.js");
      if (isUnsafeWorkspaceFallback(workspaceRoot)) {
        console.error(
          `[GraphFlow MCP] Refusing to watch unsafe workspace root: ${workspaceRoot}`
        );
        return;
      }
      const { resolveConfig } = await import("../../config/resolve.js");
      const { startFileWatcherIfEnabled } = await import("../cli/runtime/graph.js");
      const config = resolveConfig();
      startFileWatcherIfEnabled(config);
    } catch (error) {
      console.error(
        "[GraphFlow MCP] File watcher not started:",
        error instanceof Error ? error.message : error
      );
    }
  })();

  // Respond to initialize immediately; watcher is background-only.
  startStdioServer();
}
