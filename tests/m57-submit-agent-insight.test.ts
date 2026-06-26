import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import {
  parseAgentInsightResponse,
  submitAgentInsight,
} from "../src/core/submit-agent-insight";
import { GraphifyClient } from "../src/graph/graphify-client";
import { createMcpServer, executeToolCall } from "../src/surfaces/mcp/server";

function writeMemoryConfig(): string {
  const config = getDefaultConfig();
  const path = join(tmpdir(), `graphflow-m57-${Date.now()}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...config,
      providers: {},
      graphPolicy: { ...config.graphPolicy, transport: "memory" },
    }),
    "utf8"
  );
  return path;
}

describe("M57 submit agent insight", () => {
  it("submit hat response creates Decision node in GraphifyClient", async () => {
    const client = new GraphifyClient();
    const response = JSON.stringify({
      observation: "Tree-sitter WASM may fail on ARM Windows",
      certainty: 0.7,
      criticalInsight: "Binary compatibility risk for tree-sitter grammars",
    });

    const result = await submitAgentInsight(client, {
      task: "add rust indexer",
      workItemId: "hat-4-black",
      hat: "Black Hat",
      response,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toMatch(/^decision:agent-insight:/);
    expect(result.parsed.observation).toBe("Tree-sitter WASM may fail on ARM Windows");

    const snapshot = client.snapshot();
    const node = snapshot.nodes.find((n) => n.id === result.nodeId);
    expect(node?.type).toBe("Decision");
    expect(node?.metadata?.kind).toBe("agent-insight");
    expect(node?.metadata?.workItemId).toBe("hat-4-black");
    expect(node?.metadata?.hat).toBe("Black Hat");
    expect(node?.content).toContain("hat-4-black");
  });

  it("parses fenced JSON responses", () => {
    const fenced = [
      "```json",
      JSON.stringify({ observation: "test", certainty: 0.5, criticalInsight: "insight" }),
      "```",
    ].join("\n");

    const parsed = parseAgentInsightResponse(fenced);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.parsed.observation).toBe("test");
    }
  });

  it("invalid JSON returns ok:false", async () => {
    const client = new GraphifyClient();
    const result = await submitAgentInsight(client, {
      task: "refactor module",
      workItemId: "hat-1-white",
      response: "not valid json at all",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("Invalid JSON response");
    expect(client.snapshot().nodes.length).toBe(0);
  });

  it("MCP executeToolCall works", async () => {
    const configPath = writeMemoryConfig();
    try {
      const response = await executeToolCall(
        {
          name: "graphflow_submit_insight",
          arguments: {
            task: "refactor planner module",
            workItemId: "hat-2-red",
            response: JSON.stringify({
              observation: "Intuition suggests incremental refactor",
              certainty: 0.6,
              criticalInsight: "Prefer small PRs over big-bang rewrite",
            }),
            configPath,
          },
        },
        createMcpServer()
      );

      const text = response.content[0]?.text;
      expect(text).toBeDefined();
      const result = JSON.parse(text!) as { ok: boolean; nodeId?: string };
      expect(result.ok).toBe(true);
      expect(result.nodeId).toMatch(/^decision:agent-insight:/);
    } finally {
      unlinkSync(configPath);
    }
  });
});
