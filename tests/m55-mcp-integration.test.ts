import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { createMcpServer, executeToolCall } from "../src/surfaces/mcp/server";

function parseToolText(response: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = response.content[0]?.text;
  if (text === undefined) {
    const errorMsg = `MCP 响应无 text 内容，content 长度=${response.content.length}，` +
      `types=${response.content.map((c) => c.type).join(",")}`;
    throw new Error(errorMsg);
  }
  return JSON.parse(text);
}

/** 创建隔离的临时配置（file transport + 唯一路径），确保全量测试时不被其他测试干扰 */
function createIsolatedConfig(): { configPath: string; cleanup: () => void } {
  const tmpRoot = mkdtempSync(join(tmpdir(), "gf-m55-"));
  const configPath = join(tmpRoot, "graphflow.config.json");
  const graphStorePath = join(tmpRoot, "graphflow-out", "graphflow-graph.json");
  const config = {
    ...getDefaultConfig(),
    graphPolicy: {
      ...getDefaultConfig().graphPolicy,
      transport: "file" as const,
      graphStorePath,
      autoIndexOnPreview: true,
      autoIndexOnRun: true,
      workspaceRoot: process.cwd(),
    },
  };
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return {
    configPath,
    cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

describe("M55 MCP integration flows", () => {
  it("preview_context → expand_anchor chain", async () => {
    const { configPath, cleanup } = createIsolatedConfig();
    try {
      const server = createMcpServer();
      const preview = await executeToolCall(
        {
          name: "graphflow_preview_context",
          arguments: { query: "orchestrator bridge mode", configPath },
        },
        server
      );

      const pkg = parseToolText(preview) as {
        anchors?: Array<{ id: string }>;
      };
      expect(pkg.anchors?.length).toBeGreaterThan(0);

      const anchorId = pkg.anchors![0]!.id;
      const expanded = await executeToolCall(
        {
          name: "graphflow_expand_anchor",
          arguments: { anchorId, configPath },
        },
        server
      );

      const anchor = parseToolText(expanded) as { anchorId: string };
      expect(anchor.anchorId).toBe(anchorId);
    } finally {
      cleanup();
    }
  }, 60000);

  it("plan_insight returns agent-delegated mode without API credentials", async () => {
    const configPath = join(tmpdir(), `gf-m55-${Date.now()}.json`);
    writeFileSync(configPath, JSON.stringify({ ...getDefaultConfig(), providers: {} }), "utf8");
    try {
      const response = await executeToolCall(
        {
          name: "graphflow_plan_insight",
          arguments: {
            task: "refactor architecture module across graph layer",
            configPath,
          },
        },
        createMcpServer()
      );

      const result = parseToolText(response) as {
        mode: string;
        agentWorkItems?: unknown[];
        plan: unknown[];
      };
      expect(result.mode).toBe("agent-delegated");
      expect(result.agentWorkItems?.length).toBeGreaterThan(0);
      expect(result.plan.length).toBeGreaterThan(0);
    } finally {
      unlinkSync(configPath);
    }
  });

  it("inspect_graph returns node and edge counts", async () => {
    const { configPath, cleanup } = createIsolatedConfig();
    try {
      // 先触发 preview 以确保图谱已索引到 file 后端
      await executeToolCall(
        {
          name: "graphflow_preview_context",
          arguments: { query: "orchestrator", configPath },
        },
        createMcpServer()
      );

      const response = await executeToolCall(
        {
          name: "graphflow_inspect_graph",
          arguments: { nodeLimit: 5, edgeLimit: 5, configPath },
        },
        createMcpServer()
      );

      const graph = parseToolText(response) as { nodeCount: number; edgeCount: number };
      expect(graph.nodeCount).toBeGreaterThan(0);
      expect(graph.edgeCount).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  }, 60000);
});
