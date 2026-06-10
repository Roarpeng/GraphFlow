#!/usr/bin/env node
process.env.GRAPHFLOW_MCP_STDIO ??= "1";
process.env.GRAPHFLOW_LOG_JSON ??= "1";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  diagnoseRoutingResult,
  downloadOpenBmbModel,
  enrichSemanticsSilent,
  getSkillInsights,
  indexGraph,
  type ModelDownloadProgress,
  inspectGraph,
  planAndBrainstormResult,
  previewContext,
  rebuildGraph,
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

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface ExecutionHooks {
  onModelDownloadProgress?: (progress: ModelDownloadProgress) => void;
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
      name: "graphflow_rebuild",
      description: "Clear graph store and index cache, then perform a full workspace re-index.",
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
      name: "graphflow_enrich_graph",
      description: "Run semantic enrichment for pending Symbol nodes using MiniCPM/OpenBMB provider.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          batchSize: { type: "number", description: "Optional enrichment batch size." },
          sleepMs: { type: "number", description: "Optional delay between node enrichments." },
          timeoutMs: { type: "number", description: "Optional provider timeout per enrichment call." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_model_download",
      description: "Download MiniCPM/OpenBMB model file to local path with optional checksum verification.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          model: { type: "string", description: "Model name, default minicpm5-1b." },
          url: { type: "string", description: "Optional model URL override." },
          sha256: { type: "string", description: "Optional expected sha256 checksum." },
          targetPath: { type: "string", description: "Optional target file path." },
          force: { type: "boolean", description: "Force re-download even if file exists." },
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
  _server: McpServer = createMcpServer(),
  hooks?: ExecutionHooks
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
    case "graphflow_rebuild":
      return textResponse(
        await rebuildGraph(readOptionalString(args.rootDir), readOptionalString(args.configPath))
      );
    case "graphflow_enrich_graph":
      {
        const enrichOptions: { batchSize?: number; sleepMs?: number; timeoutMs?: number } = {};
        const batchSize = readOptionalNumber(args.batchSize);
        if (batchSize !== undefined) {
          enrichOptions.batchSize = batchSize;
        }
        const sleepMs = readOptionalNumber(args.sleepMs);
        if (sleepMs !== undefined) {
          enrichOptions.sleepMs = sleepMs;
        }
        const timeoutMs = readOptionalNumber(args.timeoutMs);
        if (timeoutMs !== undefined) {
          enrichOptions.timeoutMs = timeoutMs;
        }

      return textResponse(
        await enrichSemanticsSilent(readOptionalString(args.configPath), enrichOptions)
      );
      }
    case "graphflow_model_download":
      {
        const downloadOptions: {
          model?: string;
          url?: string;
          sha256?: string;
          targetPath?: string;
          force?: boolean;
        } = {};
        const model = readOptionalString(args.model);
        if (model) {
          downloadOptions.model = model;
        }
        const url = readOptionalString(args.url);
        if (url) {
          downloadOptions.url = url;
        }
        const sha256 = readOptionalString(args.sha256);
        if (sha256) {
          downloadOptions.sha256 = sha256;
        }
        const targetPath = readOptionalString(args.targetPath);
        if (targetPath) {
          downloadOptions.targetPath = targetPath;
        }
        if (typeof args.force === "boolean") {
          downloadOptions.force = args.force;
        }

      return textResponse(
        await downloadOpenBmbModel(readOptionalString(args.configPath), {
          ...downloadOptions,
          ...(hooks?.onModelDownloadProgress ? { onProgress: hooks.onModelDownloadProgress } : {}),
        })
      );
      }
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

export function createMcpServer(
  emitNotification?: (notification: JsonRpcNotification) => void
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
          const progressToken = readProgressToken(params);
          const result = await executeToolCall({
            name: readRequiredString(params.name, "name"),
            arguments: isRecord(params.arguments) ? params.arguments : {},
          }, undefined, progressToken && emitNotification
            ? {
                onModelDownloadProgress: (progress) => {
                  emitNotification({
                    jsonrpc: "2.0",
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: progress.percent ?? 0,
                      total: 100,
                      message: `${progress.stage} ${progress.model} ${formatProgressMessage(progress)}`,
                      data: progress,
                    },
                  });
                },
              }
            : undefined);
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

function readProgressToken(params: Record<string, unknown>): string | number | undefined {
  const direct = params.progressToken;
  if (typeof direct === "string" || typeof direct === "number") {
    return direct;
  }
  const meta = params._meta;
  if (!isRecord(meta)) {
    return undefined;
  }
  const token = meta.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

function formatProgressMessage(progress: ModelDownloadProgress): string {
  const current = formatBytes(progress.downloadedBytes);
  const total = progress.totalBytes !== undefined ? formatBytes(progress.totalBytes) : "unknown";
  const percent = progress.percent !== undefined ? `${progress.percent.toFixed(1)}%` : "...";
  return `${percent} ${current}/${total}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function resolvePackageVersion(): string {
  const candidates = [
    join(__dirname, "..", "..", "..", "package.json"),
    join(__dirname, "..", "..", "..", "..", "package.json"),
  ];

  for (const packageJsonPath of candidates) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
      if (packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // try next candidate
    }
  }

  return "0.0.0";
}

if (require.main === module) {
  startStdioServer();
}
