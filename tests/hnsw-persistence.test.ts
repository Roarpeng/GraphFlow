import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  computeVectorSetFingerprint,
  getSharedVectorIndex,
  resetSharedVectorIndex,
} from "../src/learning/hnsw-index";
import { attachEmbedding } from "../src/learning/embeddings";
import type { GraphNode } from "../src/core/types";

function makeEmbeddedNodes(count: number): GraphNode[] {
  return Array.from({ length: count }, (_, i) => {
    const vec = new Array(384).fill(0);
    vec[i % 384] = 1;
    vec[(i * 7) % 384] = 0.5;
    return attachEmbedding(
      { id: `symbol:mod${i}.ts:fn${i}`, type: "Symbol" as const, content: `function fn${i}() {}` },
      vec
    );
  });
}

const persistDir = mkdtempSync(join(tmpdir(), "graphflow-hnsw-"));
const persistPath = join(persistDir, "vectors.hnsw");

afterAll(() => {
  rmSync(persistDir, { recursive: true, force: true });
});

describe("vector index memoization + disk persistence", () => {
  it("reuses the memoized index for an unchanged candidate set", () => {
    resetSharedVectorIndex();
    const nodes = makeEmbeddedNodes(50);

    const first = getSharedVectorIndex(nodes);
    expect(first.reused).toBe(false);

    const second = getSharedVectorIndex(nodes);
    expect(second.reused).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("persists to disk and restores with matching fingerprint", async () => {
    resetSharedVectorIndex();
    const nodes = makeEmbeddedNodes(80);

    const built = getSharedVectorIndex(nodes, persistPath);
    expect(built.reused).toBe(false);
    expect(built.restoredFromDisk).toBe(false);
    expect(existsSync(persistPath)).toBe(true);

    const query = new Array(384).fill(0);
    query[3 % 384] = 1;
    query[(3 * 7) % 384] = 0.5;
    const expected = (await built.index.search(query, 5)).map((r) => r.node.id);

    // Simulate process restart: clear memo, restore from disk.
    resetSharedVectorIndex();
    const restored = getSharedVectorIndex(nodes, persistPath);
    expect(restored.reused).toBe(false);
    expect(restored.restoredFromDisk).toBe(true);

    const actual = (await restored.index.search(query, 5)).map((r) => r.node.id);
    expect(actual).toEqual(expected);
  });

  it("rebuilds when the candidate set changes (fingerprint mismatch)", () => {
    resetSharedVectorIndex();
    const nodesV1 = makeEmbeddedNodes(30);
    const nodesV2 = [...makeEmbeddedNodes(30), ...makeEmbeddedNodes(5).map((n, i) => ({
      ...n,
      id: `symbol:extra${i}.ts:fn${i}`,
    }))];

    expect(computeVectorSetFingerprint(nodesV1)).not.toBe(computeVectorSetFingerprint(nodesV2));

    getSharedVectorIndex(nodesV1, persistPath);
    resetSharedVectorIndex();
    const rebuilt = getSharedVectorIndex(nodesV2, persistPath);
    expect(rebuilt.restoredFromDisk).toBe(false); // stale persisted fingerprint rejected
    expect(rebuilt.index.size).toBe(35);
  });
});
