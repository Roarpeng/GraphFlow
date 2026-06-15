import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import {
  buildLayeredContextPackage,
  vectorRecall,
} from "../src/graph/context-slicer";
import {
  attachEmbedding,
  cosineSimilarity,
  createHashEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  hashEmbedding,
  reciprocalRankFusion,
} from "../src/learning/embeddings";
import type { GraphNode } from "../src/core/types";

const cfg = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-5.3-codex" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 400,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly",
    canaryRatio: 10,
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

describe("M25 vector recall + RRF fusion", () => {
  it("A: hashEmbedding is deterministic and unit-norm", () => {
    const v1 = hashEmbedding("alpha beta gamma");
    const v2 = hashEmbedding("alpha beta gamma");
    const v3 = hashEmbedding("delta epsilon zeta");
    expect(v1).toEqual(v2);
    expect(v1).not.toEqual(v3);
    const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("B: cosineSimilarity baselines", () => {
    const a = hashEmbedding("orchestrator planner");
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    const b = hashEmbedding("xx_yy_zz qq_ww_ee");
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThan(0.5);
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
        hashEmbedding(c)
      )
    );
    const query = hashEmbedding(contents[2]);
    const ranked = vectorRecall(nodes, query, 5, 0);
    expect(ranked[0].id).toBe("n:2");
  });

  it("E: enableVectorRecall pulls semantically related node into summaryChannel", async () => {
    const client = createGraphClient(cfg);
    await client.upsertNodes([
      { id: "f:d", type: "File", content: "alpha only line" },
      { id: "f:related", type: "File", content: "alpha beta gamma planner" },
      { id: "f:a", type: "File", content: "beta zone" },
      { id: "f:b", type: "File", content: "gamma zone" },
    ]);

    const provider = createHashEmbeddingProvider();
    const seeded = (
      await client.queryByKeyword("alpha beta gamma")
    ).map((node) => attachEmbedding(node, hashEmbedding(node.content)));
    await client.upsertNodes(seeded);

    const pkg = await buildLayeredContextPackage(
      client,
      "alpha beta gamma",
      400,
      {
        enableVectorRecall: true,
        embeddingProvider: provider,
        enableEdgeExpansion: false,
        layerQuota: { l1: 1, l2: 0, l3: 0 },
      }
    );
    const ids = pkg.anchorChannel.map((a) => a.id);
    expect(ids).toContain("f:related");
  });

  it("F: enableVectorRecall=false matches baseline behavior", async () => {
    const client = createGraphClient(cfg);
    await client.upsertNodes([
      { id: "s:1", type: "Symbol", content: "orchestrator planner module" },
      { id: "s:2", type: "Symbol", content: "router model selection" },
      { id: "s:3", type: "Symbol", content: "validator output checks" },
    ]);

    const baseline = await buildLayeredContextPackage(client, "orchestrator", 400);
    const off = await buildLayeredContextPackage(client, "orchestrator", 400, {
      enableVectorRecall: false,
      embeddingProvider: createHashEmbeddingProvider(),
    });
    expect(off.anchorChannel.map((a) => a.id)).toEqual(
      baseline.anchorChannel.map((a) => a.id)
    );
  });

  it("G: createOpenAiEmbeddingProvider returns an object with embed()", () => {
    const provider = createOpenAiEmbeddingProvider({ apiKey: "sk-test" });
    expect(typeof provider.embed).toBe("function");
  });
});
