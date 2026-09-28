import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import type { ContextAnchorItem } from "../src/graph/context-slicer-types";
import {
  DEFAULT_ABSTENTION_FLOOR,
  evaluateAbstentionFloor,
  estimateHandleTokens,
  isAbstentionEnforced,
  resolveAnchors,
} from "../src/graph/abstention-floor";

function symbol(id: string, sourcePath: string, line?: number): GraphNode {
  return {
    id,
    type: "Symbol",
    content: `${id} does a thing`,
    metadata: { name: id, sourcePath, ...(line === undefined ? {} : { line }) },
  };
}

function file(id: string, sourcePath: string): GraphNode {
  return { id, type: "File", content: sourcePath, metadata: { sourcePath } };
}

function anchor(id: string): ContextAnchorItem {
  return { id, type: "Symbol", layer: "L1" };
}

function indexOf(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

describe("abstention floor", () => {
  it("collapses many anchors into one handle per file, keeping the earliest line", () => {
    const nodes = indexOf([
      symbol("a", "src/one.ts", 40),
      symbol("b", "src/one.ts", 12),
      symbol("c", "src/two.ts", 3),
    ]);
    const { handles, resolutions } = resolveAnchors([anchor("a"), anchor("b"), anchor("c")], nodes);
    expect(resolutions.every((entry) => entry.kind === "file")).toBe(true);
    expect(handles).toHaveLength(2);
    expect(handles[0]).toEqual({ file: "src/one.ts", line: 12, anchorIds: ["a", "b"] });
    expect(handles[1].file).toBe("src/two.ts");
  });

  it("resolves a File anchor from its id when metadata carries no sourcePath", () => {
    // The packer emits File anchors too, and these are the cheapest possible
    // delegation: the handle is the whole node.
    const nodes = indexOf([file("file:src/graph/abstention-floor.ts", "")]);
    const { handles, resolutions } = resolveAnchors([anchor("file:src/graph/abstention-floor.ts")], nodes);
    expect(resolutions[0].kind).toBe("file");
    expect(handles).toEqual([
      { file: "src/graph/abstention-floor.ts", line: 0, anchorIds: ["file:src/graph/abstention-floor.ts"] },
    ]);
  });

  it("treats a module node as covered when a handle already points at its file", () => {
    // A `module:foo` node says what the file foo.ts contains and adds nothing
    // that is not inside it, so a handle on that file already reaches it.
    const nodes = indexOf([symbol("a", "src/foo.ts", 1), { id: "module:foo", type: "Module", content: "foo" }]);
    const { handles, resolutions } = resolveAnchors([anchor("a"), anchor("module:foo")], nodes);
    expect(handles).toHaveLength(1);
    expect(resolutions).toEqual([
      { anchorId: "a", kind: "file", coveredBy: "src/foo.ts" },
      { anchorId: "module:foo", kind: "subsumed", coveredBy: "src/foo.ts" },
    ]);
  });

  it("treats a recorded decision as unreachable: no file contains it", () => {
    // A dialogue decision is something the agent learned that appears in no
    // file, so no read recovers it. This is the case the floor exists to catch.
    const nodes = indexOf([symbol("a", "src/foo.ts", 1), { id: "dialogue:ab:0001", type: "Decision", content: "we chose X" }]);
    const { resolutions } = resolveAnchors([anchor("a"), anchor("dialogue:ab:0001")], nodes);
    expect(resolutions[1]).toEqual({ anchorId: "dialogue:ab:0001", kind: "unreachable" });
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a"), anchor("dialogue:ab:0001")],
      nodesById: nodes,
      packageTokens: 300,
      readFileTokens: () => 100,
    });
    expect(floor.breachedGate).toBe("reachability");
    expect(floor.reason).toContain("dialogue");
  });

  it("rejects a degraded source path instead of counting it as reachable", () => {
    // No sourcePath in metadata: extractNodeSourcePath falls back to the node's
    // first whitespace token, which is a word, not a path.
    const nodes = indexOf([{ id: "ghost", type: "Symbol", content: "returns a number" }]);
    const { handles, resolutions } = resolveAnchors([anchor("ghost")], nodes);
    expect(handles).toEqual([]);
    expect(resolutions).toEqual([{ anchorId: "ghost", kind: "unreachable" }]);
  });

  it("passes when one small file is cheaper to read than the package it replaces", () => {
    const nodes = indexOf([symbol("a", "src/tiny.ts", 1)]);
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a")],
      nodesById: nodes,
      packageTokens: 400,
      // A 40-line file: ~15 chars/line / 4 chars per token.
      readFileTokens: () => 150,
    });
    expect(floor.pass).toBe(true);
    expect(floor.breachedGate).toBeNull();
    expect(floor.deltaTokens).toBeGreaterThan(0);
    expect(floor.delegateCostTokens).toBe(floor.handleTokens + 150);
  });

  it("vetoes on read amplification: a big file costs more than the package", () => {
    const nodes = indexOf([symbol("a", "src/big.ts", 1)]);
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a")],
      nodesById: nodes,
      packageTokens: 400,
      readFileTokens: () => 4_000,
    });
    expect(floor.pass).toBe(false);
    expect(floor.breachedGate).toBe("amplification");
    expect(floor.amplification.ratio).toBeCloseTo((4_000 + floor.handleTokens) / 400, 5);
    expect(floor.amplification.ratio).toBeGreaterThan(10);
    expect(floor.deltaTokens).toBeLessThan(0);
  });

  it("refuses a delegation that reads cheaply but still costs more than the package", () => {
    // Measured case: a 45 tok package, a 42 tok read — the read alone is under
    // the 1.1x ceiling and would pass — but the handle the agent needs in
    // order to find that file costs 9 more, making the delegation a net loss.
    const nodes = indexOf([symbol("a", "src/micro.ts", 1)]);
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a")],
      nodesById: nodes,
      packageTokens: 45,
      readFileTokens: () => 42,
    });
    expect(floor.amplification.readTokens).toBe(42);
    expect(floor.amplification.delegateTokens).toBe(floor.handleTokens + 42);
    expect(floor.pass).toBe(false);
    expect(floor.breachedGate).toBe("amplification");
    expect(floor.deltaTokens).toBeLessThan(0);
  });

  it("vetoes when evidence spans more files than the agent can be asked to open", () => {
    const nodes = indexOf([
      symbol("a", "src/one.ts", 1),
      symbol("b", "src/two.ts", 1),
      symbol("c", "src/three.ts", 1),
    ]);
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a"), anchor("b"), anchor("c")],
      nodesById: nodes,
      packageTokens: 400,
      readFileTokens: () => 10,
    });
    expect(floor.pass).toBe(false);
    expect(floor.breachedGate).toBe("fileCount");
    expect(floor.fileCount.files).toBe(3);
  });

  it("reports the decisive objection, not the last gate checked", () => {
    // Reachability fails AND the file would be too big to read: the report must
    // name reachability, and must still measure the other two so the A/B can
    // see whether the remaining problems are mild or catastrophic.
    const nodes = indexOf([symbol("a", "src/huge.ts", 1)]);
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a"), anchor("missing")],
      nodesById: nodes,
      packageTokens: 400,
      readFileTokens: () => 9_000,
    });
    expect(floor.pass).toBe(false);
    expect(floor.breachedGate).toBe("reachability");
    expect(floor.reachability.ratio).toBe(0.5);
    expect(floor.amplification.readTokens).toBe(9_000);
    expect(floor.amplification.pass).toBe(false);
    expect(floor.fileCount.pass).toBe(true);
  });

  it("refuses to abstain when there is nothing to save", () => {
    const nodes = indexOf([symbol("a", "src/one.ts", 1)]);
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a")],
      nodesById: nodes,
      packageTokens: 0,
      readFileTokens: () => 0,
    });
    expect(floor.pass).toBe(false);
    expect(floor.breachedGate).toBe("amplification");
    expect(floor.reason).toContain("nothing to save");
  });

  it("honours tightened thresholds", () => {
    const nodes = indexOf([symbol("a", "src/one.ts", 1)]);
    const inputs = {
      anchors: [anchor("a")],
      nodesById: nodes,
      packageTokens: 400,
      readFileTokens: () => 420,
    };
    expect(evaluateAbstentionFloor(inputs).pass).toBe(true);
    expect(evaluateAbstentionFloor({ ...inputs, thresholds: { maxReadAmplification: 1.0 } }).pass).toBe(false);
  });

  it("prices a handle at a rounding error next to the file it points at", () => {
    const handles = resolveAnchors(
      [anchor("a")],
      indexOf([symbol("a", "src/graph/abstention-floor.ts", 12)])
    ).handles;
    const tokens = estimateHandleTokens(handles);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it("reports unreadable pointers instead of serialising them as null", () => {
    // An unreadable file means the delegation cost is unbounded, which is the
    // honest answer — but Infinity becomes `null` on the wire, indistinguishable
    // from "not measured". The count keeps the two apart for a JSON consumer.
    const nodes = indexOf([symbol("a", "src/real.ts", 1)]);
    const floor = evaluateAbstentionFloor({
      anchors: [anchor("a")],
      nodesById: nodes,
      packageTokens: 300,
      readFileTokens: () => Number.POSITIVE_INFINITY,
    });
    expect(floor.amplification.unreadableFiles).toBe(1);
    expect(Number.isFinite(floor.amplification.readTokens)).toBe(true);
    expect(floor.amplification.pass).toBe(false);
    expect(floor.reason).toContain("could not be read");
    expect(JSON.parse(JSON.stringify(floor)).amplification.unreadableFiles).toBe(1);
  });

  it("reads the enforcement switch", () => {
    expect(isAbstentionEnforced({})).toBe(false);
    expect(isAbstentionEnforced({ GRAPHFLOW_ABSTAIN_ENFORCE: "0" })).toBe(false);
    expect(isAbstentionEnforced({ GRAPHFLOW_ABSTAIN_ENFORCE: "1" })).toBe(true);
    expect(isAbstentionEnforced({ GRAPHFLOW_ABSTAIN_ENFORCE: "TRUE" })).toBe(true);
  });

  it("ships a floor strict enough that it can actually refuse", () => {
    // Guards the threshold values themselves: a permissive default would make
    // the whole gate decorative.
    expect(DEFAULT_ABSTENTION_FLOOR.minReachability).toBeGreaterThanOrEqual(0.9);
    expect(DEFAULT_ABSTENTION_FLOOR.maxFileCount).toBeLessThanOrEqual(2);
    expect(DEFAULT_ABSTENTION_FLOOR.maxReadAmplification).toBeLessThanOrEqual(1.25);
  });
});
