import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import { ARCHITECTURE_QUERY } from "../src/graph/context-slicer-types";
import {
  composeContextQuery,
  rankNodesForContextQuery,
} from "../src/graph/graph-utils";

describe("M62 architecture / CJK overview ranking", () => {
  it("expands ARCHITECTURE_QUERY to cover hubs and CJK overview terms", () => {
    expect(ARCHITECTURE_QUERY.test("project architecture overview")).toBe(true);
    expect(ARCHITECTURE_QUERY.test("orchestrator package structure")).toBe(true);
    expect(ARCHITECTURE_QUERY.test("mcp surface readme")).toBe(true);
    expect(ARCHITECTURE_QUERY.test("顶层模块架构与发布")).toBe(true);
    expect(ARCHITECTURE_QUERY.test("random typo fix")).toBe(false);
  });

  it("composeContextQuery merges CJK query with englishQuery", () => {
    expect(composeContextQuery("项目架构概览", "architecture orchestrator mcp readme")).toBe(
      "项目架构概览 architecture orchestrator mcp readme"
    );
    expect(composeContextQuery("architecture", "architecture")).toBe("architecture");
    expect(composeContextQuery("", "mcp readme")).toBe("mcp readme");
  });

  it("prefers orchestrator / mcp / README hubs over peripheral types errors panels", () => {
    const nodes: GraphNode[] = [
      {
        id: "file:src/core/types.ts",
        type: "File",
        content: "src/core/types.ts GraphNode architecture types",
      },
      {
        id: "file:src/graph/context-slicer-types.ts",
        type: "File",
        content: "src/graph/context-slicer-types.ts LayeredPackageOptions architecture",
      },
      {
        id: "file:src/surfaces/mcp/errors.ts",
        type: "File",
        content: "src/surfaces/mcp/errors.ts McpToolError architecture mcp",
      },
      {
        id: "file:vscode-extension/src/panels.ts",
        type: "File",
        content: "vscode-extension/src/panels.ts architecture panel webview",
      },
      {
        id: "file:src/core/orchestrator.ts",
        type: "File",
        content: "src/core/orchestrator.ts orchestrator bridge architecture",
      },
      {
        id: "symbol:src/surfaces/mcp/server.ts:mcp1",
        type: "Symbol",
        content: "function createMcpServer mcp architecture",
        metadata: { sourcePath: "src/surfaces/mcp/server.ts", name: "createMcpServer" },
      },
      {
        id: "file:README.md",
        type: "File",
        content: "README.md GraphFlow architecture overview",
      },
    ];

    const ranked = rankNodesForContextQuery(nodes, "项目顶层架构模块概览", {
      englishQuery: "architecture orchestrator mcp readme package structure",
      scoreTokens: [
        "项目",
        "顶层",
        "架构",
        "模块",
        "概览",
        "architecture",
        "orchestrator",
        "mcp",
        "readme",
        "package",
        "structure",
      ],
      matchQueries: ["项目顶层架构模块概览", "architecture orchestrator mcp readme package structure"],
    });

    const hubIndex = ranked.findIndex(
      (node) =>
        /src\/core\/orchestrator/.test(node.id) ||
        /src\/surfaces\/mcp\//.test(node.id) ||
        /README/i.test(node.id)
    );
    const peripheralIndex = ranked.findIndex(
      (node) =>
        /types\.ts/.test(node.id) ||
        /error/i.test(node.id) ||
        /panels\.ts/.test(node.id)
    );

    expect(hubIndex).toBeGreaterThanOrEqual(0);
    expect(peripheralIndex).toBeGreaterThanOrEqual(0);
    expect(hubIndex).toBeLessThan(peripheralIndex);
    expect(ranked[0]?.id).toMatch(/orchestrator|surfaces\/mcp|README/i);
  });

  it("does not demote types/errors for ordinary code search", () => {
    const nodes: GraphNode[] = [
      {
        id: "file:src/core/types.ts",
        type: "File",
        content: "src/core/types.ts GraphNode GraphEdge export types",
      },
      {
        id: "file:src/surfaces/mcp/errors.ts",
        type: "File",
        content: "src/surfaces/mcp/errors.ts McpToolError throw errors",
      },
      {
        id: "file:src/core/orchestrator.ts",
        type: "File",
        content: "src/core/orchestrator.ts orchestrator bridge mode",
      },
    ];

    const ranked = rankNodesForContextQuery(nodes, "GraphNode GraphEdge types errors", {
      scoreTokens: ["graphnode", "graphedge", "types", "errors"],
      matchQueries: ["GraphNode GraphEdge types errors"],
    });

    // Without architecture intent, types/errors remain competitive.
    expect(ranked.findIndex((node) => node.id.includes("types.ts"))).toBeLessThan(3);
    expect(ranked.some((node) => node.id.includes("errors.ts"))).toBe(true);
  });

  it("detects architecture intent via englishQuery alone for CJK queries", () => {
    const nodes: GraphNode[] = [
      {
        id: "file:vscode-extension/src/panels.ts",
        type: "File",
        content: "panels webview ui",
      },
      {
        id: "file:src/core/orchestrator.ts",
        type: "File",
        content: "orchestrator runtime bridge",
      },
      {
        id: "file:README.md",
        type: "File",
        content: "README project overview",
      },
    ];

    const ranked = rankNodesForContextQuery(nodes, "这个仓库怎么组织的", {
      englishQuery: "architecture package structure overview readme orchestrator",
      scoreTokens: ["仓库", "组织", "architecture", "package", "structure", "overview", "readme", "orchestrator"],
      matchQueries: ["这个仓库怎么组织的", "architecture package structure overview readme orchestrator"],
    });

    expect(ranked[0]?.id).toMatch(/orchestrator|README/i);
    expect(ranked.findIndex((n) => n.id.includes("panels.ts"))).toBeGreaterThan(
      ranked.findIndex((n) => /orchestrator|README/i.test(n.id))
    );
  });
});
