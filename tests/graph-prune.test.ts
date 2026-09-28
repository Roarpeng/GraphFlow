import { describe, expect, it, vi } from "vitest";
import type { GraphEdge, GraphNode } from "../src/core/types";
import {
  classifyPrunableNode,
  planGraphPrune,
  pruneGraph,
  type PruneCategory,
} from "../src/graph/graph-prune";

const fileNode = (id: string): GraphNode => ({ id, type: "File", content: id.replace(/^file:/, "") });
const moduleNode = (id: string): GraphNode => ({ id, type: "Module", content: id.replace(/^module:/, "") });
const symbolNode = (id: string): GraphNode => ({ id, type: "Symbol", content: "function f() {}" });

const edge = (from: string, to: string): GraphEdge => ({ from, to, relation: "defines" });

describe("graph prune", () => {
  it("catches the cross-project leak by path escape", () => {
    const hit = classifyPrunableNode(fileNode("file:../LightNav-0/tests/test_deproject.py"));
    expect(hit?.category).toBe("workspace-escape");
    expect(classifyPrunableNode(moduleNode("module:../other/x"))?.category).toBe("workspace-escape");
    expect(classifyPrunableNode(symbolNode("symbol:../other/x.py:abc"))?.category).toBe("workspace-escape");
  });

  it("catches a module node that is really a scraped link", () => {
    // There is no project whose module is a shields.io badge.
    const hit = classifyPrunableNode(moduleNode("module:https://img.shields.io/badge/npm-1.9.5-blue"));
    expect(hit?.category).toBe("link-module");
    expect(classifyPrunableNode(moduleNode("module:https://github.com/a/b"))?.category).toBe("link-module");
  });

  it("catches a serialized graph stored as if it were source", () => {
    const hit = classifyPrunableNode({
      id: "file:benchmarks/.cache/x.json",
      type: "File",
      content: '{"nodes": [{"id": "file:a.ts"}], "edges": []}',
    });
    expect(hit?.category).toBe("foreign-artifact");
  });

  it("keeps legitimate content, including edge-less module nodes", () => {
    // The tempting shortcut is "delete orphans", but PLC program units and
    // freshly indexed projects both produce module nodes with no edges. Deleting
    // on orphanhood would damage real content.
    expect(classifyPrunableNode(moduleNode("module:src/graph"))).toBeNull();
    expect(classifyPrunableNode(moduleNode("module:pou:TON"))).toBeNull();
    expect(classifyPrunableNode(fileNode("file:src/graph/a.ts"))).toBeNull();
    expect(classifyPrunableNode(symbolNode("symbol:src/a.ts:abc"))).toBeNull();
    // A real module directory named like a URL scheme is still kept: only
    // `module:` ids are judged, and a genuine one never carries http.
    expect(classifyPrunableNode(moduleNode("module:src/http-client"))).toBeNull();
  });

  it("plans by category and counts the edges that would dangle", () => {
    const nodes = [
      fileNode("file:src/a.ts"),
      fileNode("file:../other/b.ts"),
      moduleNode("module:https://example.com/x"),
      moduleNode("module:src/graph"),
    ];
    const edges = [edge("file:../other/b.ts", "module:https://example.com/x"), edge("file:src/a.ts", "module:src/graph")];
    const plan = planGraphPrune(nodes, edges);
    expect(plan.classifications).toHaveLength(2);
    expect(plan.byCategory["workspace-escape"]).toBe(1);
    expect(plan.byCategory["link-module"]).toBe(1);
    expect(plan.danglingEdges).toBe(1);
    expect(plan.kept).toBe(2);
  });

  it("never deletes on a dry run", async () => {
    const deleteNodes = vi.fn();
    const client = {
      readSnapshot: () => ({ nodes: [fileNode("file:../other/b.ts")], edges: [] }),
      deleteNodes,
    };
    const result = await pruneGraph(client as never);
    expect(result.applied).toBe(false);
    expect(result.deletedNodes).toBe(0);
    expect(result.classifications).toHaveLength(1);
    expect(deleteNodes).not.toHaveBeenCalled();
  });

  it("deletes the planned ids and their edges when applied", async () => {
    const deleted: string[] = [];
    const deletedEdges: Array<[string, string]> = [];
    const client = {
      readSnapshot: () => ({
        nodes: [fileNode("file:src/a.ts"), fileNode("file:../other/b.ts")],
        edges: [edge("file:../other/b.ts", "file:src/a.ts")],
      }),
      deleteNodes: vi.fn(async (ids: string[]) => { deleted.push(...ids); }),
      deleteEdge: vi.fn(async (from: string, to: string) => { deletedEdges.push([from, to]); }),
    };
    const result = await pruneGraph(client as never, { apply: true });
    expect(result.applied).toBe(true);
    expect(deleted).toEqual(["file:../other/b.ts"]);
    expect(deletedEdges).toEqual([["file:../other/b.ts", "file:src/a.ts"]]);
  });

  it("reports instead of throwing when the backend cannot delete", async () => {
    const client = {
      readSnapshot: () => ({ nodes: [fileNode("file:../other/b.ts")], edges: [] }),
    };
    const result = await pruneGraph(client as never, { apply: true });
    expect(result.applied).toBe(false);
    expect(result.error).toContain("does not support node deletion");
  });

  it("reports instead of throwing when deletion fails", async () => {
    const client = {
      readSnapshot: () => ({ nodes: [fileNode("file:../other/b.ts")], edges: [] }),
      deleteNodes: vi.fn(async () => { throw new Error("store locked"); }),
    };
    const result = await pruneGraph(client as never, { apply: true });
    expect(result.applied).toBe(false);
    expect(result.error).toContain("store locked");
  });

  it("says so when there is no snapshot rather than reporting a clean graph", () => {
    const client = {};
    return expect(pruneGraph(client as never)).resolves.toMatchObject({
      applied: false,
      error: expect.stringContaining("snapshot unavailable"),
    });
  });

  it("covers every category it claims to", () => {
    const categories: PruneCategory[] = ["workspace-escape", "link-module", "foreign-artifact"];
    const plan = planGraphPrune([], []);
    expect(Object.keys(plan.byCategory).sort()).toEqual([...categories].sort());
  });
});
