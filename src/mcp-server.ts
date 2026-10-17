#!/usr/bin/env node
/**
 * GraphFlow 3.1 — Ultra-Lean MCP Server (`src/mcp-server.ts`)
 *
 * Exposes the 4 Token-First Surgical Tools (`gf_read`, `gf_edit`, `gf_exec`, `gf_macro`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { V3_TOOL_DEFINITIONS, executeV3ToolCall } from "./mcp-tools.js";

export function resolvePackageVersion(): string {
  const candidates = [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
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

  return "3.5.0";
}

export const PACKAGE_VERSION = resolvePackageVersion();

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export type GraphFlowToolRisk = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

export type GraphFlowToolCapability =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.connect"
  | "git.write"
  | "package.install"
  | "secret.read"
  | "agent.spawn";

export interface ToolGovernanceMeta {
  "graphflow/risk": GraphFlowToolRisk;
  "graphflow/capabilities": GraphFlowToolCapability[];
  "graphflow/writeScope": "none" | "graphflow-state" | "caller-path";
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  $schema?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: ToolAnnotations;
  _meta?: ToolGovernanceMeta;
}

const TOOL_GOVERNANCE: Record<string, { annotations: ToolAnnotations; _meta: ToolGovernanceMeta }> = {
  gf_read: {
    annotations: {
      title: "GraphFlow Surgical Read (AST Skeleton & Symbol Slice)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R0",
      "graphflow/capabilities": ["filesystem.read"],
      "graphflow/writeScope": "none",
    },
  },
  gf_edit: {
    annotations: {
      title: "GraphFlow Surgical Edit (In-Place Symbol/Line Edit & Rename)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write"],
      "graphflow/writeScope": "caller-path",
    },
  },
  gf_exec: {
    annotations: {
      title: "GraphFlow Dehydrated Command & Affected-Test Runner",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "process.exec"],
      "graphflow/writeScope": "graphflow-state",
    },
  },
  gf_macro: {
    annotations: {
      title: "GraphFlow Habit Macro & Git Co-Change Engine",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write", "process.exec"],
      "graphflow/writeScope": "graphflow-state",
    },
  },
};

export function getV3ToolDefinitions(): ToolDefinition[] {
  return V3_TOOL_DEFINITIONS.map((t) => {
    const governance = TOOL_GOVERNANCE[t.name];
    return {
      ...t,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...(governance
        ? {
            title: governance.annotations.title,
            annotations: { ...governance.annotations },
            _meta: {
              ...governance._meta,
              "graphflow/capabilities": [...governance._meta["graphflow/capabilities"]],
            },
          }
        : {}),
    };
  });
}

/**
 * Wire-optimal definitions sent on `tools/list` (~459 tokens for all 4 tools).
 * The richer `getV3ToolDefinitions()` keeps titles/annotations/`_meta` for API
 * consumers that need governance metadata; MCP clients do not, and the extra
 * fields nearly double the per-turn schema tax.
 */
export function getToolDefinitions(): ToolDefinition[] {
  return V3_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  progressToken?: string | number;
}

export interface ToolCallResponse {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: Record<string, unknown>;
}

export async function executeToolCall(
  call: ToolCall
): Promise<ToolCallResponse & { structuredContent: Record<string, unknown> }> {
  const args = call.arguments ?? {};
  const rootDir =
    (typeof args.rootDir === "string" && args.rootDir.trim()) ||
    process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim() ||
    process.cwd();

  const v3Res = executeV3ToolCall(call.name, args, rootDir);
  const text = v3Res.content[0]?.text ?? "";
  const ok = !text.startsWith("ERR ") && !text.startsWith("FAIL ") && !text.startsWith("REJECTED ");
  return {
    ...v3Res,
    structuredContent: {
      tool: call.name,
      ok,
    },
  };
}

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

export interface McpServer {
  handleRequest: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>;
  sdkServer: Server;
}

export function createMcpServer(): McpServer {
  const tools = getToolDefinitions();

  const sdkServer = new Server(
    {
      name: "graphflow",
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  sdkServer.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === "string" ? params.name : "";
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, "Missing tool name");
    }
    // Newer SDK CallToolRequest handler signatures type the result against the
    // full ServerResult union (tasks et al.); our shape satisfies the wire
    // contract, so assert through it.
    const result = await executeToolCall({ name, arguments: args });
    return result as unknown as import("@modelcontextprotocol/sdk/types.js").CallToolResult;
  });

  const handleRequest = async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    const id = request.id ?? null;
    if (request.method === "notifications/initialized" || request.id === undefined) {
      return undefined;
    }
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "graphflow", version: PACKAGE_VERSION },
        },
      };
    }
    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools },
      };
    }
    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const res = await executeToolCall({ name, arguments: args });
        return { jsonrpc: "2.0", id, result: res };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: ErrorCode.InternalError,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: ErrorCode.MethodNotFound,
        message: `Method not found: ${request.method}`,
      },
    };
  };

  return { handleRequest, sdkServer };
}

async function runStdioServer(): Promise<void> {
  const { sdkServer } = createMcpServer();
  const transport = new StdioServerTransport();
  await sdkServer.connect(transport);
}

if (require.main === module) {
  runStdioServer().catch((err) => {
    console.error("[GraphFlow MCP] Fatal error:", err);
    process.exit(1);
  });
}
