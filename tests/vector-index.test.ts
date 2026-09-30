import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  computeVectorSetFingerprint,
  getSharedVectorIndex,
  resetSharedVectorIndex,
} from "../src/learning/vector-index";
import { attachEmbedding } from "../src/learning/embeddings";
import type { GraphNode } from "../src/core/types";

function makeEmbeddedNodes(count: number, offset = 0): GraphNode[] {
  return Array.from({ length: count }, (_, i) => {
    const vec = new Array(384).fill(0);
    vec[(i + offset) % 384] = 1;
    vec[((i + offset) * 7) % 384] = 0.5;
    return attachEmbedding(
      { id: `symbol:mod${i + offset}.ts:fn${i + offset}`, type: "Symbol" as const, content: `function fn${i + offset}() {}` },
      vec
    );
  });
}

const scratchDir = mkdtempSync(join(tmpdir(), "graphflow-vector-index-"));
const scratchPath = join(scratchDir, "vectors.hnsw");

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("vector index memoization", () => {
  it("reuses the memoized index for an unchanged candidate set", async () => {
    resetSharedVectorIndex();
    const nodes = makeEmbeddedNodes(50);

    const first = getSharedVectorIndex(nodes);
    expect(first.reused).toBe(false);

    const second = getSharedVectorIndex(nodes);
    expect(second.reused).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);

    const query = new Array(384).fill(0);
    query[3 % 384] = 1;
    query[(3 * 7) % 384] = 0.5;
    expect(second.index.search(query, 5).map((r) => r.node.id)).toEqual(
      first.index.search(query, 5).map((r) => r.node.id)
    );
  });

  it("rebuilds when the candidate set changes (fingerprint mismatch)", () => {
    resetSharedVectorIndex();
    const nodesV1 = makeEmbeddedNodes(30);
    const nodesV2 = [...makeEmbeddedNodes(30), ...makeEmbeddedNodes(5, 30)];

    expect(computeVectorSetFingerprint(nodesV1)).not.toBe(computeVectorSetFingerprint(nodesV2));

    getSharedVectorIndex(nodesV1);
    resetSharedVectorIndex();
    const rebuilt = getSharedVectorIndex(nodesV2);
    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.index.size).toBe(35);
  });

  it("writes nothing to disk: node metadata is the only copy of a vector", () => {
    // The recall candidate set is query-scoped, so a persisted index keyed by it
    // was rewritten by the next query and never read back. It is gone for good.
    writeFileSync(scratchPath, JSON.stringify({ version: 1, fingerprint: "stale", dim: 384, ids: [], data: "" }));
    resetSharedVectorIndex();
    const built = getSharedVectorIndex(makeEmbeddedNodes(20));
    expect(built.index.backend).toBe("linear");
    expect(built.index.size).toBe(20);
    expect(readFileSync(scratchPath, "utf8")).toContain("stale");
  });

  it("skips nodes without a usable embedding and mixed dimensions", () => {
    resetSharedVectorIndex();
    const nodes = [
      ...makeEmbeddedNodes(4),
      { id: "file:loose.ts", type: "File" as const, content: "no vector" },
      attachEmbedding({ id: "file:short.ts", type: "File" as const, content: "wrong dim" }, [1, 0]),
    ];
    const { index } = getSharedVectorIndex(nodes);
    expect(index.size).toBe(4);
  });
});
