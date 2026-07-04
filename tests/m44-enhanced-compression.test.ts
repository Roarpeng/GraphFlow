import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphNode } from "../src/core/types";
import { orchestrate } from "../src/core/orchestrator";
import { triageTask } from "../src/core/triage";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import {
  extractConnectedSubgraph,
  computePageRank,
  blendWithCentrality,
} from "../src/graph/graph-compression";
import { buildRepoMap, formatRepoMapString } from "../src/graph/repo-map";
import { estimateContextBudget } from "../src/graph/adaptive-budget";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import { attachEmbedding, hashEmbedding } from "../src/learning/embeddings";

describe("M44 Enhanced Context Compression", () => {
  // ── Graph Compression Tests ────────────────────────────────────
  describe("Graph structure compression", () => {
    it("should extract connected subgraph with edge weights", async () => {
      const client = new GraphifyClient();
      const nodes: GraphNode[] = [
        { id: "auth.ts", type: "File", content: "authentication module" },
        { id: "login()", type: "Symbol", content: "function login() -> User" },
        { id: "logout()", type: "Symbol", content: "function logout() -> void" },
        { id: "config.ts", type: "File", content: "configuration module" },
      ];
      await client.upsertNodes(nodes);
      await client.upsertEdges([
        { from: "auth.ts", to: "login()", relation: "defines" },
        { from: "auth.ts", to: "logout()", relation: "defines" },
        { from: "login()", to: "config.ts", relation: "imports" },
      ]);

      const seeds = [nodes[0]]; // auth.ts
      const ranked = await extractConnectedSubgraph(client, seeds, { maxNodes: 10, hops: 2 });

      expect(ranked.length).toBeGreaterThan(1);
      expect(ranked[0]?.node.id).toBe("auth.ts"); // Seed has highest score
      expect(ranked.some((r) => r.node.id === "login()")).toBe(true);
    });

    it("should compute PageRank centrality", () => {
      const nodes: GraphNode[] = [
        { id: "A", type: "Symbol", content: "node A" },
        { id: "B", type: "Symbol", content: "node B" },
        { id: "C", type: "Symbol", content: "node C" },
      ];
      const edges = [
        { from: "A", to: "B", relation: "references" as const },
        { from: "A", to: "C", relation: "references" as const },
        { from: "B", to: "C", relation: "references" as const },
      ];

      const pageRank = computePageRank(nodes, edges);

      // Node C is referenced by both A and B, should have highest rank.
      const ranks = Array.from(pageRank.entries()).sort((a, b) => b[1] - a[1]);
      expect(ranks[0]?.[0]).toBe("C");
    });

    it("should blend retrieval order with centrality", () => {
      const nodes: GraphNode[] = [
        { id: "A", type: "Symbol", content: "node A" },
        { id: "B", type: "Symbol", content: "node B" },
        { id: "C", type: "Symbol", content: "node C" },
      ];
      const pageRank = new Map([
        ["A", 0.1],
        ["B", 0.2],
        ["C", 0.7], // C is most central
      ]);

      const blended = blendWithCentrality(nodes, pageRank, 0.5);

      // C should move up due to centrality.
      expect(blended[0]?.id).toBe("C");
    });
  });

  // ── RepoMap Tests ────────────────────────────────────────
  describe("RepoMap overview mode", () => {
    it("should generate module-level overview", async () => {
      const client = new GraphifyClient();
      const modules: GraphNode[] = [
        {
          id: "mod:auth",
          type: "Module",
          content: "module: src/auth.ts",
          metadata: { exports: ["login", "logout", "validateToken"] },
        },
        {
          id: "mod:config",
          type: "Module",
          content: "module: src/config.ts",
          metadata: { exports: ["loadConfig", "saveConfig"] },
        },
      ];
      await client.upsertNodes(modules);

      const repoMap = await buildRepoMap(client);
      const formatted = formatRepoMapString(repoMap);

      expect(repoMap.length).toBe(2);
      expect(formatted).toContain("src/auth.ts");
      expect(formatted).toContain("exports login, logout, validateToken");
      expect(formatted).toContain("src/config.ts");
    });
  });

  // ── Adaptive Budget Tests ────────────────────────────────────
  describe("Adaptive budget estimation", () => {
    it("should estimate higher budget for refactor tasks", () => {
      const simple = estimateContextBudget("fix typo in readme", "simple");
      const refactor = estimateContextBudget("refactor authentication module and add OAuth2", "complex");

      expect(refactor.tokens).toBeGreaterThan(simple.tokens);
      expect(refactor.rationale).toContain("refactor");
    });

    it("should estimate lower budget for localized fixes", () => {
      const bug = estimateContextBudget("fix bug in login function", "simple");
      const base = estimateContextBudget("update readme", "simple");

      expect(bug.tokens).toBeLessThan(base.tokens);
      expect(bug.rationale).toContain("localized fix");
    });

    it("should cap budget at reasonable limits", () => {
      const huge = estimateContextBudget(
        "refactor and migrate and redesign and reorganize entire architecture",
        "complex"
      );

      expect(huge.tokens).toBeLessThanOrEqual(4000);
    });

    it("auto-enables adaptive budget for complex orchestrator tasks", async () => {
      const complexTask = "Refactor module A and update module B";
      expect(triageTask(complexTask)).toBe("complex");

      const config = validateConfig({
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 4000 },
        graphPolicy: {
          enableAutoBuild: true,
          enableNearLosslessMode: true,
          transport: "memory",
          maxContextTokens: 200,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: "graphflow-out/learning-dataset.jsonl",
        },
      });

      const graphClient = createGraphClient(config);
      const nodes: GraphNode[] = [];
      for (let i = 0; i < 20; i += 1) {
        nodes.push({
          id: `symbol:mod${i}`,
          type: "Symbol",
          content: `function module${i}Handler(data: Data) processes module ${i} logic`,
        });
      }
      await graphClient.upsertNodes(nodes);

      let withAdaptive = 0;
      await orchestrate(
        { task: complexTask },
        {
          graphClient,
          enableNearLosslessMode: true,
          maxContextTokens: 200,
          executionMode: "bridge",
          onContextPackage: (pkg) => {
            withAdaptive = pkg.tokenEstimate;
          },
        }
      );

      let withoutAdaptive = 0;
      await orchestrate(
        { task: complexTask },
        {
          graphClient,
          enableNearLosslessMode: true,
          maxContextTokens: 200,
          enableAdaptiveBudget: false,
          executionMode: "bridge",
          onContextPackage: (pkg) => {
            withoutAdaptive = pkg.tokenEstimate;
          },
        }
      );

      expect(withAdaptive).toBeGreaterThan(withoutAdaptive);
      expect(withAdaptive).toBeGreaterThan(200);
    });
  });

  // ── End-to-End Enhanced Package Tests ────────────────────────────────────
  describe("Enhanced context package integration", () => {
    it("should build enhanced package with all compression layers", async () => {
      const client = new GraphifyClient();
      const nodes: GraphNode[] = [
        { id: "auth.ts", type: "File", content: "authentication module" },
        { id: "login()", type: "Symbol", content: "function login(email: string) -> User" },
        { id: "logout()", type: "Symbol", content: "function logout() -> void" },
        { id: "config.ts", type: "File", content: "configuration loader" },
      ];

      // Add embeddings for graph compression.
      const withEmbeddings = nodes.map((n) => attachEmbedding(n, hashEmbedding(n.content)));
      await client.upsertNodes(withEmbeddings);
      await client.upsertEdges([
        { from: "auth.ts", to: "login()", relation: "defines" },
        { from: "auth.ts", to: "logout()", relation: "defines" },
      ]);

      const pkg = await buildEnhancedContextPackage(
        client,
        "authentication",
        "refactor authentication module",
        2000,
        {
          enableGraphCompression: true,
          enableRepoMapFallback: false,
          taskMode: "complex",
        }
      );

      expect(pkg.summaryChannel.length).toBeGreaterThan(0);
      expect(pkg.tokenEstimate).toBeLessThanOrEqual(2000);
    });

    it("should fallback to RepoMap for low budgets", async () => {
      const client = new GraphifyClient();
      const modules: GraphNode[] = [
        {
          id: "mod:auth",
          type: "Module",
          content: "module: src/auth.ts",
          metadata: { exports: ["login"] },
        },
      ];
      await client.upsertNodes(modules);

      const pkg = await buildEnhancedContextPackage(client, "auth", "quick check", 500, {
        enableRepoMapFallback: true,
      });

      expect(pkg.summaryChannel.length).toBeGreaterThan(0);
      expect(pkg.summaryChannel[0]).toContain("Repository Map");
    });
  });

  // ── Compression Ratio Benchmark ────────────────────────────────────
  describe("Compression benchmarks", () => {
    it("should demonstrate compression ratio improvement", async () => {
      const client = new GraphifyClient();
      // Simulate 50 nodes with redundant content.
      const nodes: GraphNode[] = [];
      for (let i = 0; i < 50; i += 1) {
        nodes.push(
          attachEmbedding(
            {
              id: `node${i}`,
              type: "Symbol",
              content: `function process${i % 10}(data: Data) -> Result`,
            },
            hashEmbedding(`process data function ${i % 10}`)
          )
        );
      }
      await client.upsertNodes(nodes);

      // Baseline: no compression.
      const baseline = await buildEnhancedContextPackage(client, "process", "process data", 3000, {
        enableGraphCompression: false,
      });

      // Enhanced: with graph compression.
      const compressed = await buildEnhancedContextPackage(client, "process", "process data", 3000, {
        enableGraphCompression: true,
      });

      // Graph compression should reduce nodes via centrality pruning.
      expect(compressed.summaryChannel.length).toBeLessThanOrEqual(baseline.summaryChannel.length);
      expect(compressed.tokenEstimate).toBeLessThanOrEqual(baseline.tokenEstimate);
    });
  });
});
