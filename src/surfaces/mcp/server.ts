#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  diagnoseRoutingResult,
  getSkillInsights,
  indexGraph,
  inspectGraph,
  planAndBrainstormResult,
  previewContext,
  runTaskResult,
} from "../cli/runtime";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

interface ToolCallResponse {
  content: Array<{
    type: "text";
    text: string;
  }>;
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

interface McpServer {
  serverInfo: {
    name: string;
    version: string;
  };
  tools: ToolDefinition[];
  handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

const PACKAGE_VERSION = resolvePackageVersion();

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "graphflow_run",
      description: "Run a task through GraphFlow orchestration and return structured execution status.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description to run." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_plan",
      description: "Generate brainstorming ideas and a DAG-style task plan for a request.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description to plan." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_preview_context",
      description: "Preview GraphFlow near-lossless context packaging for a query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Query to preview." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_index",
      description: "Index a workspace path into the GraphFlow graph store.",
      inputSchema: {
        type: "object",
        properties: {
          rootDir: { type: "string", description: "Optional workspace path to index." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_inspect_graph",
      description: "Inspect current graph snapshot statistics and sample nodes/edges.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          nodeLimit: { type: "number", description: "Max sample nodes." },
          edgeLimit: { type: "number", description: "Max sample edges." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_skill_insights",
      description: "Return top learned skill insights from the graph store.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          limit: { type: "number", description: "Maximum skills to return." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_diagnose",
      description: "Return provider health, routing priority, and resolved planner/worker/validator models.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        additionalProperties: false,
      },
    },
  ];
}

export async function executeToolCall(
  call: ToolCall,
  _server: McpServer = createMcpServer()
): Promise<ToolCallResponse> {
  const args = call.arguments ?? {};

  switch (call.name) {
    case "graphflow_run":
      return textResponse(
        await runTaskResult(readRequiredString(args.task, "task"), readOptionalString(args.configPath))
      );
    case "graphflow_plan":
      return textResponse(planAndBrainstormResult(readRequiredString(args.task, "task")));
    case "graphflow_preview_context":
      return textResponse(
        await previewContext(readRequiredString(args.query, "query"), readOptionalString(args.configPath))
      );
    case "graphflow_index":
      return textResponse(
        await indexGraph(readOptionalString(args.rootDir), readOptionalString(args.configPath))
      );
    case "graphflow_inspect_graph":
      return textResponse(
        await inspectGraph(readOptionalString(args.configPath), buildInspectOptions(args))
      );
    case "graphflow_skill_insights":
      return textResponse(
        await getSkillInsights(readOptionalString(args.configPath), readOptionalNumber(args.limit))
      );
    case "graphflow_diagnose":
      return textResponse(diagnoseRoutingResult(readOptionalString(args.configPath)));
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

export function createMcpServer(): McpServer {
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
          const result = await executeToolCall({
            name: readRequiredString(params.name, "name"),
            arguments: isRecord(params.arguments) ? params.arguments : {},
          });
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
  server: McpServer = createMcpServer(),
  input: Readable = process.stdin,
  output: Writable = process.stdout
): void {
  let buffer = Buffer.alloc(0);

  input.on("data", async (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(headerText);
      const frameEnd = headerEnd + 4 + contentLength;
      if (buffer.length < frameEnd) {
        return;
      }

      const body = buffer.subarray(headerEnd + 4, frameEnd).toString("utf8");
      buffer = buffer.subarray(frameEnd);

      const request = JSON.parse(body) as JsonRpcRequest;
      const response = await server.handleRequest(request);
      if (response) {
        writeMessage(output, response);
      }
    }
  });
}

function writeMessage(output: Writable, response: JsonRpcResponse): void {
  const payload = JSON.stringify(response);
  output.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
}

function parseContentLength(headerText: string): number {
  const line = headerText
    .split("\r\n")
    .find((entry) => entry.toLowerCase().startsWith("content-length:"));

  if (!line) {
    throw new Error("Missing Content-Length header.");
  }

  const value = Number(line.split(":")[1]?.trim() ?? "0");
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid Content-Length header.");
  }

  return value;
}

function textResponse(data: unknown): ToolCallResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Field '${field}' must be a non-empty string.`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildInspectOptions(args: Record<string, unknown>): { nodeLimit?: number; edgeLimit?: number } {
  const nodeLimit = readOptionalNumber(args.nodeLimit);
  const edgeLimit = readOptionalNumber(args.edgeLimit);

  return {
    ...(nodeLimit !== undefined ? { nodeLimit } : {}),
    ...(edgeLimit !== undefined ? { edgeLimit } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")
    ) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (require.main === module) {
  startStdioServer();
}
