import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../src/core/types";
import {
  enrichNodeForSnapshot,
  folderGroupFromPath,
  sampleGraphForSnapshot,
  viewLayerForType,
} from "../src/graph/snapshot-view.js";

describe("M42 snapshot view enrichment", () => {
  it("enriches file and symbol nodes with readable labels and source paths", () => {
    const fileNode: GraphNode = {
      id: "file:src/graph/snapshot-view.ts",
      type: "File",
      content: "src/graph/snapshot-view.ts",
      metadata: { path: "src/graph/snapshot-view.ts", language: "typescript" },
    };
    const symbolNode: GraphNode = {
      id: "symbol:src/graph/snapshot-view.ts:abc",
      type: "Symbol",
      content: "function enrichNodeForSnapshot @src/graph/snapshot-view.ts:12",
      metadata: {
        name: "enrichNodeForSnapshot",
        kind: "function",
        file: "src/graph/snapshot-view.ts",
        line: 12,
      },
    };

    const file = enrichNodeForSnapshot(fileNode);
    const symbol = enrichNodeForSnapshot(symbolNode);

    expect(file.displayLabel).toBe("snapshot-view.ts");
    expect(file.displayPath).toBe("src/graph/snapshot-view.ts");
    expect(file.sourcePath).toBe("src/graph/snapshot-view.ts");
    expect(file.folderGroup).toBe("src");
    expect(file.viewLayer).toBe("code");

    expect(symbol.displayLabel).toBe("function enrichNodeForSnapshot");
    expect(symbol.sourcePath).toBe("src/graph/snapshot-view.ts");
    expect(symbol.sourceLine).toBe(12);
    expect(symbol.viewLayer).toBe("code");
  });

  it("maps learning node types to learning layer", () => {
    expect(viewLayerForType("Skill")).toBe("learning");
    expect(viewLayerForType("File")).toBe("code");
    expect(folderGroupFromPath("src/a/b.ts")).toBe("src");
    expect(folderGroupFromPath("index.ts")).toBe(".");
  });

  it("samples nodes with folder diversity and enriched edges", () => {
    const nodes: GraphNode[] = [
      { id: "file:src/a.ts", type: "File", content: "src/a.ts" },
      { id: "file:src/b.ts", type: "File", content: "src/b.ts" },
      { id: "file:tests/a.test.ts", type: "File", content: "tests/a.test.ts" },
      { id: "module:src", type: "Module", content: "src" },
      { id: "symbol:src/a.ts:run", type: "Symbol", content: "function run @src/a.ts:1", metadata: { name: "run", file: "src/a.ts", line: 1 } },
      { id: "skill:add-tests", type: "Skill", content: "add tests", metadata: { name: "add tests" } },
    ];
    const edges: GraphEdge[] = [
      { from: "file:src/a.ts", to: "module:src", relation: "depends_on" },
      { from: "file:src/a.ts", to: "symbol:src/a.ts:run", relation: "defines" },
      { from: "file:src/b.ts", to: "module:src", relation: "depends_on" },
      { from: "file:tests/a.test.ts", to: "file:src/a.ts", relation: "references" },
    ];

    const sample = sampleGraphForSnapshot(nodes, edges, 6, 8);

    expect(sample.sampleNodes.length).toBeGreaterThan(0);
    expect(sample.sampleNodes.every((node) => node.displayLabel.length > 0)).toBe(true);
    expect(sample.sampleNodes.some((node) => node.folderGroup === "src")).toBe(true);
    expect(sample.sampleNodes.some((node) => node.viewLayer === "learning")).toBe(true);
    expect(sample.sampleEdges.length).toBeGreaterThan(0);
    expect(sample.sampleEdges.every((edge) => edge.relation.length > 0)).toBe(true);
  });
});
