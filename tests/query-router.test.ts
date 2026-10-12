import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { buildEnhancedContextPackage, buildLayeredContextPackage } from "../src/graph/context-slicer";
import {
  boostL2Quota,
  classifyQueryIntent,
  INTENT_ROUTE_CONFIDENCE_THRESHOLD,
  MODULE_OVERVIEW_L2_QUOTA_FLOOR,
  routeLayeredOptions,
} from "../src/graph/query-router";
import type { LayeredPackageOptions } from "../src/graph/context-slicer-types";

describe("classifyQueryIntent (deterministic heuristics)", () => {
  interface Row {
    query: string;
    englishQuery?: string;
    intent: "symbol" | "module-overview" | "impact" | "general";
    routes: boolean; // confidence >= 0.6 ?
  }

  const TABLE: Row[] = [
    // ── symbol ──────────────────────────────────────────────────────────────
    { query: 'where is "expandSubgraph" declared', intent: "symbol", routes: true }, // quoted + definition
    { query: '"createContextRefillManager"', intent: "symbol", routes: true }, // quoted identifier alone
    { query: "expandSubgraph 的定义在哪", intent: "symbol", routes: true }, // CJK 定义
    { query: "expandSubgraph", intent: "symbol", routes: true }, // single distinctive identifier
    { query: "bm25_search", intent: "symbol", routes: true },
    { query: "logger.warn", intent: "symbol", routes: true },
    // ── module-overview ─────────────────────────────────────────────────────
    { query: "涉及哪些文件", intent: "module-overview", routes: true },
    { query: "模块 overview", intent: "module-overview", routes: true }, // two weak signals combine
    { query: "architecture 架构", intent: "module-overview", routes: true },
    { query: "repo map module overview", intent: "module-overview", routes: true }, // golden query: 0.5 + 0.1
    { query: "context slicer utils module derive", intent: "module-overview", routes: false }, // lone "module": 0.5
    // ── impact (multi-hop) ──────────────────────────────────────────────────
    { query: "谁调用了 buildLayeredContextPackage", intent: "impact", routes: true },
    { query: "callers of vectorRecall", intent: "impact", routes: true },
    { query: "used by sqlite client", intent: "impact", routes: true },
    { query: "references of triage symbol", intent: "impact", routes: true },
    { query: "bm25 引用", intent: "impact", routes: true }, // 0.6 exactly at threshold
    { query: "影响 dag engine", intent: "impact", routes: true },
    { query: "impact of removing taskrun", intent: "impact", routes: false }, // bare EN "impact": 0.55
    { query: "depends on provider health", intent: "impact", routes: false }, // bare "depends": 0.55
    // ── general ─────────────────────────────────────────────────────────────
    { query: "cli help flags", intent: "general", routes: false },
    { query: "orchestrate task routing", intent: "general", routes: false },
    { query: "what is this", intent: "general", routes: false },
    // englishQuery participates as a signal source (CJK query + EN terms)
    { query: "哪些文件", englishQuery: "module structure", intent: "module-overview", routes: true },
  ];

  for (const { query, englishQuery, intent, routes } of TABLE) {
    it(`classifies ${JSON.stringify(query)}${englishQuery ? ` (+${JSON.stringify(englishQuery)})` : ""} as ${intent}`, () => {
      const result = classifyQueryIntent(query, englishQuery);
      expect(result.intent).toBe(intent);
      if (intent === "general") {
        expect(result.confidence).toBeLessThan(INTENT_ROUTE_CONFIDENCE_THRESHOLD);
      } else if (routes) {
        expect(result.confidence).toBeGreaterThanOrEqual(INTENT_ROUTE_CONFIDENCE_THRESHOLD);
      } else {
        expect(result.confidence).toBeLessThan(INTENT_ROUTE_CONFIDENCE_THRESHOLD);
      }
      // pure function: identical output on repeat calls
      expect(classifyQueryIntent(query, englishQuery)).toEqual(result);
    });
  }

  it("scales confidence with match strength (quoted identifier > lone pattern > none)", () => {
    const quoted = classifyQueryIntent('"rerankHitsByEmbedding"');
    const loneDefinition = classifyQueryIntent("definition of refills");
    const none = classifyQueryIntent("cli help flags");
    expect(quoted.confidence).toBeGreaterThan(loneDefinition.confidence);
    expect(loneDefinition.confidence).toBeGreaterThan(0);
    expect(none.intent).toBe("general");
    expect(none.confidence).toBeLessThan(INTENT_ROUTE_CONFIDENCE_THRESHOLD);
    expect(none.signals).toEqual([]);
  });

  it("returns zero confidence for an empty query", () => {
    expect(classifyQueryIntent("")).toEqual({ intent: "general", confidence: 0, signals: [] });
    expect(classifyQueryIntent("", "").confidence).toBe(0);
  });
});

describe("routeLayeredOptions (integration contract)", () => {
  it("routes confident impact queries to ppr expansion when the caller set none", () => {
    const routed = routeLayeredOptions("谁调用了 buildLayeredContextPackage", undefined, undefined);
    expect(routed).toEqual({ expansionStrategy: "ppr" });

    const withExtras: LayeredPackageOptions = { enableGraphCompression: true };
    const routedExtras = routeLayeredOptions("callers of vectorRecall", undefined, withExtras);
    expect(routedExtras).toEqual({ enableGraphCompression: true, expansionStrategy: "ppr" });
  });

  it("never overrides an explicit expansionStrategy (caller wins)", () => {
    const explicit: LayeredPackageOptions = { expansionStrategy: "bfs" };
    expect(routeLayeredOptions("谁调用 vectorRecall", undefined, explicit)).toBe(explicit);
  });

  it("routes confident module-overview queries to an L2-boosted quota", () => {
    const routed = routeLayeredOptions("涉及哪些文件", undefined, undefined);
    expect(routed?.layerQuota).toBeDefined();
    expect(routed?.layerQuota?.l2).toBeGreaterThanOrEqual(MODULE_OVERVIEW_L2_QUOTA_FLOOR);
    // l1/l3 stay at the packer's effective defaults — the boost never tightens anything
    expect(routed?.layerQuota?.l1).toBe(Number.POSITIVE_INFINITY);
    expect(routed?.layerQuota?.l3).toBe(Number.POSITIVE_INFINITY);
  });

  it("never overrides an explicit layerQuota (caller wins)", () => {
    const explicit: LayeredPackageOptions = { layerQuota: { l1: 3, l2: 1, l3: 1 } };
    expect(routeLayeredOptions("涉及哪些文件", undefined, explicit)).toBe(explicit);
  });

  it("returns the same options reference for general, symbol, and low-confidence queries", () => {
    const options: LayeredPackageOptions = { enableGraphCompression: true };
    expect(routeLayeredOptions("cli help flags", undefined, options)).toBe(options); // general
    expect(routeLayeredOptions("expandSubgraph", undefined, options)).toBe(options); // symbol: deliberate no-op
    expect(routeLayeredOptions("context slicer utils module derive", undefined, options)).toBe(options); // 0.5 < 0.6
    expect(routeLayeredOptions("impact of removing taskrun", undefined, options)).toBe(options); // 0.55 < 0.6
    expect(routeLayeredOptions("", undefined, undefined)).toBe(undefined);
  });

  it("boostL2Quota raises without ever lowering", () => {
    expect(boostL2Quota({ l1: 5, l2: 1, l3: 2 })).toEqual({ l1: 5, l2: MODULE_OVERVIEW_L2_QUOTA_FLOOR, l3: 2 });
    expect(boostL2Quota({ l1: 5, l2: 12, l3: 2 }, 8).l2).toBe(12); // above the floor: untouched
    const infinities = {
      l1: Number.POSITIVE_INFINITY,
      l2: Number.POSITIVE_INFINITY,
      l3: Number.POSITIVE_INFINITY,
    };
    expect(boostL2Quota(infinities)).toEqual(infinities); // default quotas: provable no-op
  });
});

describe("intent routing end-to-end (builders)", () => {
  const config = validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-5.3-codex" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 4000 },
    graphPolicy: { enableAutoBuild: true, transport: "memory", maxContextTokens: 200 },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      canaryRatio: 10,
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  });

  async function seededClient(): Promise<ReturnType<typeof createGraphClient>> {
    const client = createGraphClient(config);
    await client.upsertNodes([
      { id: "symbol:widget", type: "Symbol", content: "widget core" },
      { id: "symbol:intermediate", type: "Symbol", content: "intermediate renderer adapter" },
      { id: "symbol:terminal", type: "Symbol", content: "terminal invoker gateway" },
    ]);
    await client.upsertEdges([
      { from: "symbol:intermediate", to: "symbol:widget", relation: "calls" },
      { from: "symbol:terminal", to: "symbol:intermediate", relation: "calls" },
    ]);
    return client;
  }

  it("impact query routes to ppr: layered package reaches the 2-hop caller", async () => {
    const client = await seededClient();
    // "callers" classifies as impact (0.65) -> expansionStrategy "ppr" (hops 2)
    const pkg = await buildLayeredContextPackage(client, "widget callers", 2000);
    const ids = pkg.anchorChannel.map((a) => a.id);
    expect(ids).toContain("symbol:widget");
    expect(ids).toContain("symbol:intermediate"); // 1-hop: every strategy reaches
    expect(ids).toContain("symbol:terminal"); // 2-hop: only ppr expansion admits
  });

  it("explicit bfs beats routing: the 2-hop caller stays out", async () => {
    const client = await seededClient();
    const pkg = await buildLayeredContextPackage(client, "widget callers", 2000, {
      expansionStrategy: "bfs",
    });
    const ids = pkg.anchorChannel.map((a) => a.id);
    expect(ids).toContain("symbol:intermediate");
    expect(ids).not.toContain("symbol:terminal");
  });

  it("enhanced builder honors the same impact routing", async () => {
    const client = await seededClient();
    const pkg = await buildEnhancedContextPackage(client, "widget callers", "widget callers", 2000);
    expect(pkg.anchorChannel.map((a) => a.id)).toContain("symbol:terminal");
  });
});
