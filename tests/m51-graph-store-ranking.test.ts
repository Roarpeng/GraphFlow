import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";
import { rankNodesForContextQuery } from "../src/graph/graph-utils";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("M51 graph store resilience and retrieval ranking", () => {
  it("returns empty store when graph JSON is corrupt", async () => {
    const root = createTempRoot("graphflow-corrupt-store");
    const storePath = join(root, "graphflow-out", "graphflow-graph.json");
    mkdirSync(join(root, "graphflow-out"), { recursive: true });
    writeFileSync(storePath, '{\n  "nodes": [],\n  invalid\n}\n', "utf8");

    const client = new GraphifyFileClient(storePath);
    const snapshot = client.readSnapshot();
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
    await expect(client.queryByKeyword("orchestrator")).resolves.toEqual([]);
  });

  it("writes graph store atomically via temp rename", async () => {
    const root = createTempRoot("graphflow-atomic-store");
    const storePath = join(root, "graphflow-out", "graphflow-graph.json");
    const client = new GraphifyFileClient(storePath);

    await client.upsertNodes([
      {
        id: "file:src/core/orchestrator.ts",
        type: "File",
        content: "src/core/orchestrator.ts orchestrator bridge mode",
      },
    ]);

    const raw = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as { nodes: Array<{ id: string }> };
    expect(parsed.nodes.some((node) => node.id === "file:src/core/orchestrator.ts")).toBe(true);
  });

  it("prefers src symbols over integration mcp.json noise", () => {
    const nodes: GraphNode[] = [
      {
        id: "file:.cursor/mcp.json",
        type: "File",
        content: ".cursor/mcp.json graphflow mcp server orchestrator",
      },
      {
        id: "file:src/core/orchestrator.ts",
        type: "File",
        content: "src/core/orchestrator.ts orchestrator bridge mode",
      },
      {
        id: "symbol:src/agents/planner.ts:abc",
        type: "Symbol",
        content: "function planTasks orchestrator planner",
      },
    ];

    const ranked = rankNodesForContextQuery(nodes, "orchestrator architecture planner");
    expect(ranked[0]?.id).toContain("src/");
    expect(ranked.some((node) => node.id.includes("mcp.json"))).toBe(true);
    expect(ranked.findIndex((node) => node.id.includes("mcp.json"))).toBeGreaterThan(0);
  });

  it("prefers src/core and src/graph over vscode-extension for core engine queries", () => {
    const nodes: GraphNode[] = [
      {
        id: "file:vscode-extension/src/extension.ts",
        type: "File",
        content: "vscode-extension/src/extension.ts activate orchestrator mcp graphflow",
      },
      {
        id: "symbol:vscode-extension/src/extension.ts:ext1",
        type: "Symbol",
        content: "function activate orchestrator planner context",
      },
      {
        id: "file:src/core/orchestrator.ts",
        type: "File",
        content: "src/core/orchestrator.ts orchestrator bridge mode planner",
      },
      {
        id: "symbol:src/graph/context-slicer.ts:slicer1",
        type: "Symbol",
        content: "function buildContextPackage context slicer orchestrator",
      },
      {
        id: "file:.agent/skills/graphflow/SKILL.md",
        type: "File",
        content: ".agent/skills/graphflow/SKILL.md orchestrator context planner",
      },
    ];

    const ranked = rankNodesForContextQuery(nodes, "orchestrator architecture context-slicer planner", {
      scoreTokens: [
        "orchestrator",
        "architecture",
        "context",
        "slicer",
        "planner",
      ],
    });

    expect(ranked[0]?.id).toMatch(/src\/(core|graph)\//);
    expect(ranked.some((node) => node.id.includes("vscode-extension"))).toBe(true);
    expect(
      ranked.findIndex((node) => node.id.includes("vscode-extension"))
    ).toBeGreaterThan(
      ranked.findIndex((node) => /src\/(core|graph)\//.test(node.id))
    );
  });

  it("demotes packaged vendor and build output below core src for architecture queries", () => {
    const nodes: GraphNode[] = [
      {
        id: "symbol:vendor/graphflow/src/core/orchestrator.ts:vend1",
        type: "Symbol",
        content: "function packagedOrchestrator graphflow architecture orchestrator planner context mcp graph",
      },
      {
        id: "file:node_modules/@roarpeng/graphflow/dist/graph/context-slicer.js",
        type: "File",
        content: "node_modules graphflow architecture orchestrator planner context mcp graph slicer",
      },
      {
        id: "file:dist/core/orchestrator.js",
        type: "File",
        content: "dist graphflow architecture orchestrator planner context mcp graph",
      },
      {
        id: "file:src/core/orchestrator.ts",
        type: "File",
        content: "src/core/orchestrator.ts orchestrator planner context engine",
      },
      {
        id: "symbol:src/graph/context-slicer.ts:slicer1",
        type: "Symbol",
        content: "function buildContextPackage context slicer graph architecture",
      },
    ];

    const ranked = rankNodesForContextQuery(nodes, "graphflow architecture orchestrator planner context mcp graph");
    const firstNoiseIndex = ranked.findIndex((node) =>
      /(?:^|:)(?:vendor|node_modules|dist)\//.test(node.id)
    );
    const firstCoreIndex = ranked.findIndex((node) => /src\/(?:core|graph)\//.test(node.id));

    expect(firstCoreIndex).toBeGreaterThanOrEqual(0);
    expect(firstNoiseIndex).toBeGreaterThan(firstCoreIndex);
  });
});
