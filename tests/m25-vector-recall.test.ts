import { describe, expect, it } from "vitest";
import {
  vectorRecall,
} from "../src/graph/context-slicer";
import {
  attachEmbedding,
  cosineSimilarity,
  createOpenAiEmbeddingProvider,
  reciprocalRankFusion,
} from "../src/learning/embeddings";
import type { GraphNode } from "../src/core/types";

function simpleEmbedding(text: string, dim = 384): number[] {
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] = (vec[i % dim] ?? 0) + text.charCodeAt(i);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  if (norm === 0) return vec;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) * inv;
  return vec;
}

describe("M25 vector recall + RRF fusion", () => {
  it("A: simpleEmbedding is deterministic and unit-norm", () => {
    const v1 = simpleEmbedding("alpha beta gamma");
    const v2 = simpleEmbedding("alpha beta gamma");
    const v3 = simpleEmbedding("delta epsilon zeta");
    expect(v1).toEqual(v2);
    expect(v1).not.toEqual(v3);
    const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("B: cosineSimilarity baselines", () => {
    const a = simpleEmbedding("orchestrator planner");
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    const b = simpleEmbedding("xx_yy_zz qq_ww_ee");
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThan(1);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [1])).toBe(0);
  });

  it("C: reciprocalRankFusion ranks common items above unique ones", () => {
    const n = (id: string): GraphNode => ({ id, type: "Symbol", content: id });
    const A = n("A");
    const B = n("B");
    const C = n("C");
    const D = n("D");
    const r1 = [A, B, C];
    const r2 = [A, D, B];
    const fused = reciprocalRankFusion([r1, r2]);
    expect(fused[0].id).toBe("A");
    const ids = fused.map((x) => x.id);
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("C"));
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("D"));
  });

  it("D: vectorRecall ranks the matching node first", () => {
    const contents = [
      "router selects model",
      "planner decomposes tasks",
      "validator checks output",
      "skill flywheel synthesis",
      "decision log persistence",
    ];
    const nodes: GraphNode[] = contents.map((c, i) =>
      attachEmbedding(
        { id: `n:${i}`, type: "Symbol", content: c },
        simpleEmbedding(c)
      )
    );
    const query = simpleEmbedding(contents[2]);
    const ranked = vectorRecall(nodes, query, 5, 0);
    expect(ranked[0].id).toBe("n:2");
  });

  it("G: createOpenAiEmbeddingProvider returns an object with embed()", () => {
    const provider = createOpenAiEmbeddingProvider({ apiKey: "sk-test" });
    expect(typeof provider.embed).toBe("function");
  });
});
