import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { createMcpServer, executeToolCall } from "../src/surfaces/mcp/server";

function parseToolText(response: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = response.content[0]?.text;
  expect(text).toBeDefined();
  return JSON.parse(text!);
}

describe("M55 MCP integration flows", () => {
  it("preview_context → expand_anchor chain", async () => {
    const preview = await executeToolCall(
      {
        name: "graphflow_preview_context",
        arguments: { query: "orchestrator bridge mode" },
      },
      createMcpServer()
    );

    const pkg = parseToolText(preview) as {
      anchors?: Array<{ id: string }>;
    };
    expect(pkg.anchors?.length).toBeGreaterThan(0);

    const anchorId = pkg.anchors![0]!.id;
    const expanded = await executeToolCall(
      {
        name: "graphflow_expand_anchor",
        arguments: { anchorId },
      },
      createMcpServer()
    );

    const anchor = parseToolText(expanded) as { anchorId: string };
    expect(anchor.anchorId).toBe(anchorId);
  });

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
    const response = await executeToolCall(
      {
        name: "graphflow_inspect_graph",
        arguments: { nodeLimit: 5, edgeLimit: 5 },
      },
      createMcpServer()
    );

    const graph = parseToolText(response) as { nodeCount: number; edgeCount: number };
    expect(graph.nodeCount).toBeGreaterThan(0);
    expect(graph.edgeCount).toBeGreaterThan(0);
  });
});
