import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import {
  buildEnhancedContextPackage,
  buildLayeredContextPackage,
  createContextRefillManager,
  rerankHitsByEmbedding,
  rerankTopHitsForPackage,
  type RerankEmbeddingProvider,
} from "../src/graph/context-slicer";
import { estimateTokens } from "../src/graph/context-slicer-utils";
import type { GraphNode } from "../src/core/types";

const baseConfig = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-5.3-codex" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 200,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly",
    canaryRatio: 10,
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Fake deterministic embedding provider: 4-axis bag-of-words over VOCAB.
// ─────────────────────────────────────────────────────────────────────────────
const VOCAB = ["router", "config", "vector", "auth"] as const;

function bagVector(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
}

interface FakeProvider {
  provider: RerankEmbeddingProvider;
  calls(): number;
}

function fakeProvider(options?: {
  fingerprint?: string;
  failOn?: string[];
  override?: (text: string) => number[];
}): FakeProvider {
  let count = 0;
  const opts = options ?? {};
  const provider: RerankEmbeddingProvider = {
    embed: async (text: string) => {
      count += 1;
      if (opts.failOn?.includes(text)) {
        throw new Error(`embed failed for ${text}`);
      }
      return opts.override ? opts.override(text) : bagVector(text);
    },
  };
  if (opts.fingerprint !== undefined) {
    provider.fingerprint = () => opts.fingerprint as string;
  }
  return { provider, calls: () => count };
}

const hitConfig = { id: "symbol:config", type: "Symbol" as const, content: "config loader merge defaults" };
const hitVector = { id: "symbol:vector", type: "Symbol" as const, content: "vector index scan" };
const hitRouter = { id: "symbol:router", type: "Symbol" as const, content: "router chooses model by tier" };

describe("rerankHitsByEmbedding", () => {
  it("reorders by cosine similarity with a usable provider (stable: sim desc, id asc)", async () => {
    const { provider } = fakeProvider({ fingerprint: "test-model-v1" });
    const out = await rerankHitsByEmbedding(
      [hitConfig, hitVector, hitRouter],
      "router",
      provider
    );
    expect(out.map((n) => n.id)).toEqual(["symbol:router", "symbol:config", "symbol:vector"]);
  });

  it("GATE: returns hits unchanged when the provider fingerprint is hash-like", async () => {
    const { provider, calls } = fakeProvider({ fingerprint: "fnv1a-384" });
    const hits = [hitConfig, hitVector, hitRouter];
    const out = await rerankHitsByEmbedding(hits, "router", provider);
    expect(out.map((n) => n.id)).toEqual(hits.map((n) => n.id));
    expect(calls()).toBe(0);
  });

  it("GATE: returns hits unchanged when the provider has no fingerprint", async () => {
    const { provider, calls } = fakeProvider({});
    const hits = [hitConfig, hitRouter];
    const out = await rerankHitsByEmbedding(hits, "router", provider);
    expect(out).toEqual(hits);
    expect(calls()).toBe(0);
  });

  it("GATE: returns hits unchanged for a missing provider or a single hit", async () => {
    expect(await rerankHitsByEmbedding([hitConfig, hitRouter], "router", undefined)).toEqual([
      hitConfig,
      hitRouter,
    ]);
    expect(await rerankHitsByEmbedding([hitRouter], "router", fakeProvider({ fingerprint: "m" }).provider)).toEqual([
      hitRouter,
    ]);
  });

  it("GATE: query embed failure returns the input unchanged", async () => {
    const { provider } = fakeProvider({ fingerprint: "test-model-v1", failOn: ["router"] });
    const hits = [hitConfig, hitRouter];
    const out = await rerankHitsByEmbedding(hits, "router", provider);
    expect(out).toEqual(hits);
  });

  it("keeps a hit whose embed fails, sunk below every scored hit (id order)", async () => {
    // hitConfig's searchable text embed fails -> sim -1, sorted after the 0-sim ties by id
    // (nodeSearchableText = content + id minus the "symbol:" prefix, space-joined)
    const { provider } = fakeProvider({
      fingerprint: "test-model-v1",
      failOn: ["config loader merge defaults config"],
    });
    const out = await rerankHitsByEmbedding([hitConfig, hitVector, hitRouter], "router", provider);
    expect(out.map((n) => n.id)).toEqual(["symbol:router", "symbol:vector", "symbol:config"]);
  });

  it("breaks similarity ties by node id (deterministic total order)", async () => {
    const { provider } = fakeProvider({ fingerprint: "test-model-v1" });
    const a = { id: "symbol:zz", type: "Symbol" as const, content: "router relay" };
    const b = { id: "symbol:aa", type: "Symbol" as const, content: "router gateway" };
    const out = await rerankHitsByEmbedding([a, b], "router", provider);
    expect(out.map((n) => n.id)).toEqual(["symbol:aa", "symbol:zz"]);
  });

  it("topN keeps only the leading N; keepOrder restores input order of survivors", async () => {
    const { provider } = fakeProvider({ fingerprint: "test-model-v1" });
    const byTopN = await rerankHitsByEmbedding([hitConfig, hitVector, hitRouter], "router", provider, {
      topN: 2,
    });
    expect(byTopN.map((n) => n.id)).toEqual(["symbol:router", "symbol:config"]);

    const keptOrder = await rerankHitsByEmbedding([hitConfig, hitVector, hitRouter], "router", provider, {
      topN: 2,
      keepOrder: true,
    });
    expect(keptOrder.map((n) => n.id)).toEqual(["symbol:config", "symbol:router"]);
  });

  it("rerankTopHitsForPackage leaves the full list untouched for an unusable provider", async () => {
    const { provider } = fakeProvider({ fingerprint: "fnv1a-384" });
    const hits = [hitConfig, hitVector, hitRouter];
    const out = await rerankTopHitsForPackage(hits, "router", provider);
    expect(out).toEqual(hits);
  });
});

describe("enableRerank integration (default off, gated)", () => {
  it("default: provider.embed is never called when enableRerank is unset", async () => {
    const client = createGraphClient(baseConfig);
    await client.upsertNodes([hitConfig, hitVector, hitRouter]);
    const { provider, calls } = fakeProvider({ fingerprint: "test-model-v1" });

    await buildLayeredContextPackage(client, "router", 400, { embeddingProvider: provider });
    await buildEnhancedContextPackage(client, "router", "router", 400, {
      embeddingProvider: provider,
    });
    expect(calls()).toBe(0);
  });

  it("enableRerank + hash provider: gate skips the stage (no embeds), package still builds", async () => {
    const client = createGraphClient(baseConfig);
    await client.upsertNodes([hitConfig, hitRouter]);
    const { provider, calls } = fakeProvider({ fingerprint: "fnv1a-384" });

    const pkg = await buildLayeredContextPackage(client, "router", 400, {
      enableRerank: true,
      embeddingProvider: provider,
    });
    expect(calls()).toBe(0);
    expect(pkg.anchorChannel.length).toBeGreaterThan(0);
  });

  it("enableRerank + usable provider: rerank decides which hit leads the pack", async () => {
    const client = createGraphClient(baseConfig);
    // Keyword-wise the config node dominates the query "router config" (whole
    // query matches its text, both terms hit), so the legacy pack admits it
    // into the single L1 slot. Embedding-wise (provider override: the query
    // sits on the "router" axis) symbol:router is the closer hit — rerank must
    // promote it into that slot instead.
    await client.upsertNodes([
      { id: "symbol:config", type: "Symbol", content: "router config gateway relay" },
      { id: "symbol:router", type: "Symbol", content: "router" },
    ]);
    const { provider, calls } = fakeProvider({
      fingerprint: "test-model-v1",
      override: (text) => (text.trim().toLowerCase() === "router config" ? [1, 0, 0, 0] : bagVector(text)),
    });
    const baseOptions = {
      layerQuota: { l1: 1, l2: 0, l3: 0 },
      enableEdgeExpansion: false,
    };

    const baseline = await buildLayeredContextPackage(client, "router config", 400, baseOptions);
    expect(baseline.anchorChannel.map((a) => a.id)).toEqual(["symbol:config"]);

    const reranked = await buildLayeredContextPackage(client, "router config", 400, {
      ...baseOptions,
      enableRerank: true,
      embeddingProvider: provider,
    });
    expect(reranked.anchorChannel.map((a) => a.id)).toEqual(["symbol:router"]);
    expect(calls()).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refill cost-model ladder
// ─────────────────────────────────────────────────────────────────────────────
function refillClientConfig() {
  return baseConfig;
}

describe("createContextRefillManager escalation ladder", () => {
  it("stage 1 lexical: first unseen keyword hit per hint (legacy behavior, weight 1)", async () => {
    const client = createGraphClient(refillClientConfig());
    await client.upsertNodes([
      { id: "symbol:router", type: "Symbol", content: "router chooses model by tier" },
      { id: "symbol:validator", type: "Symbol", content: "validator checks requirement alignment" },
    ]);

    const refill = createContextRefillManager(client, 200);
    const initial = await refill.initialPackage("router");
    const extra = await refill.refill(["validator"]);

    expect(initial.summaryChannel.length).toBeGreaterThan(0);
    expect(extra.length).toBe(1);
    expect(extra[0]!.startsWith("symbol:validator | Symbol:")).toBe(true);
    expect(refill.lastStages).toEqual([
      {
        hint: "validator",
        stage: "lexical",
        anchorId: "symbol:validator",
        tokens: estimateTokens(extra[0]!),
      },
    ]);

    // same hint again: every stage misses (node already seen) -> "none"
    const again = await refill.refill(["validator"]);
    expect(again).toEqual([]);
    expect(refill.lastStages?.[0]?.stage).toBe("none");
  });

  it("stage 2 vector: only when lexical misses and a non-hash provider is supplied", async () => {
    const client = createGraphClient(refillClientConfig());
    await client.upsertNodes([
      {
        id: "symbol:router",
        type: "Symbol",
        content: "router chooses model by tier",
        metadata: { embedding: [1, 0, 0, 0] },
      },
      { id: "file:readme", type: "File", content: "readme overview" },
    ]);

    // "failover" shares no index token with any node (lexical misses), but the
    // provider maps it onto the router axis (semantic stand-in).
    const { provider, calls } = fakeProvider({
      fingerprint: "test-model-v1",
      override: (text) => (text.toLowerCase().includes("failover") ? [1, 0, 0, 0] : bagVector(text)),
    });
    const refill = createContextRefillManager(client, 200, undefined, {
      embeddingProvider: provider,
    });
    const items = await refill.refill(["failover"]);

    expect(items.length).toBe(1);
    expect(items[0]!.startsWith("symbol:router | Symbol:")).toBe(true);
    expect(refill.lastStages?.[0]?.stage).toBe("vector");
    expect(refill.lastStages?.[0]?.anchorId).toBe("symbol:router");
    // default vector weight 2: charged cost = estimate * 2
    expect(refill.lastStages?.[0]?.tokens).toBe(estimateTokens(items[0]!) * 2);
    expect(calls()).toBe(1); // one hint embed, nothing else
  });

  it("stage 2 skipped for a hash-fingerprint provider (falls through to file/none)", async () => {
    const client = createGraphClient(refillClientConfig());
    await client.upsertNodes([
      { id: "symbol:router", type: "Symbol", content: "router chooses model by tier" },
    ]);
    const { provider, calls } = fakeProvider({
      fingerprint: "fnv1a-384",
      override: () => [1, 0, 0, 0],
    });
    const refill = createContextRefillManager(client, 200, undefined, {
      embeddingProvider: provider,
    });
    const items = await refill.refill(["failover"]);

    expect(items).toEqual([]);
    expect(refill.lastStages?.[0]?.stage).toBe("none");
    expect(calls()).toBe(0); // hash gate: the hint is never embedded
  });

  it("stage 3 file: a path-like hint resolves to its File node anchor", async () => {
    const fileNode: GraphNode = {
      id: "file:src/graph/bm25.ts",
      type: "File",
      content: "bm25 lexical search helpers",
    };
    const stub = {
      upsertNodes: async () => {},
      upsertEdges: async () => {},
      queryByKeyword: async () => [] as GraphNode[],
      readSnapshot: () => ({ nodes: [fileNode], edges: [] }),
    };
    const refill = createContextRefillManager(stub as unknown as GraphClient, 200);
    const items = await refill.refill(["src/graph/bm25.ts"]);

    expect(items.length).toBe(1);
    expect(items[0]!.startsWith("file:src/graph/bm25.ts | File:")).toBe(true);
    expect(refill.lastStages?.[0]).toEqual({
      hint: "src/graph/bm25.ts",
      stage: "file",
      anchorId: "file:src/graph/bm25.ts",
      tokens: estimateTokens(items[0]!) * 4, // default file weight 4
    });

    // path normalization: backslashes and quotes still resolve
    const slashRefill = createContextRefillManager(stub as unknown as GraphClient, 200);
    expect((await slashRefill.refill(["src\\graph\\bm25.ts"])).length).toBe(1);
    const quotedRefill = createContextRefillManager(stub as unknown as GraphClient, 200);
    expect((await quotedRefill.refill(['"src/graph/bm25.ts"'])).length).toBe(1);
  });

  it("failure-safe: a throwing keyword query escalates instead of rejecting", async () => {
    const fileNode: GraphNode = { id: "file:src/a.ts", type: "File", content: "alpha" };
    const stub = {
      upsertNodes: async () => {},
      upsertEdges: async () => {},
      queryByKeyword: async () => {
        throw new Error("keyword backend down");
      },
      readSnapshot: () => ({ nodes: [fileNode], edges: [] }),
    };
    const refill = createContextRefillManager(stub as unknown as GraphClient, 200);
    const items = await refill.refill(["src/a.ts"]);
    expect(items.length).toBe(1);
    expect(refill.lastStages?.[0]?.stage).toBe("file");
  });

  it("tracks cumulative refill spend across calls and never exceeds maxTokens", async () => {
    const client = createGraphClient(refillClientConfig());
    await client.upsertNodes([
      { id: "symbol:alpha", type: "Symbol", content: "alpha anchor one" },
      { id: "symbol:beta", type: "Symbol", content: "beta anchor two" },
    ]);
    const lineAlpha = "symbol:alpha | Symbol: alpha anchor one";
    const refill = createContextRefillManager(client, estimateTokens(lineAlpha));

    const first = await refill.refill(["alpha"]); // spends the entire budget
    expect(first.length).toBe(1);

    const second = await refill.refill(["beta"]); // cumulative spend leaves nothing
    expect(second).toEqual([]);

    // mid-call budget stop: the second hint's candidate does not fit
    const refill2 = createContextRefillManager(client, estimateTokens(lineAlpha));
    const mixed = await refill2.refill(["alpha", "beta"]);
    expect(mixed.length).toBe(1);
    expect(mixed[0]!.startsWith("symbol:alpha")).toBe(true);
  });

  it("costWeights are additive and do not break the legacy three-arg call", async () => {
    const client = createGraphClient(refillClientConfig());
    await client.upsertNodes([
      { id: "symbol:alpha", type: "Symbol", content: "alpha anchor one" },
      { id: "symbol:beta", type: "Symbol", content: "beta anchor two" },
    ]);

    // lexical weight 0.5 halves the charged cost, so both fit the tight budget
    const lineAlpha = "symbol:alpha | Symbol: alpha anchor one";
    const refill = createContextRefillManager(client, estimateTokens(lineAlpha), undefined, {
      costWeights: { lexical: 0.5 },
    });
    const items = await refill.refill(["alpha", "beta"]);
    expect(items.length).toBe(2);
    expect(refill.lastStages?.[0]?.tokens).toBe(estimateTokens(lineAlpha) * 0.5);

    // legacy shape: (client, maxTokens) only — no refillOptions
    const legacy = createContextRefillManager(client, 200);
    const legacyItems = await legacy.refill(["alpha"]);
    expect(legacyItems.length).toBe(1);
    expect(legacyItems[0]!.startsWith("symbol:alpha | Symbol:")).toBe(true);
  });
});
