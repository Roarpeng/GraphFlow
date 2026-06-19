import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphNode } from "../src/core/types";
import { attachEmbedding, hashEmbedding } from "../src/learning/embeddings";
import {
  isPlaceholderResponse,
  resolveCompressionModel,
} from "../src/graph/compression-model";
import {
  summarizeCluster,
  densifyNodeContent,
} from "../src/graph/semantic-compression";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import { validateConfig } from "../src/config/loader";

/**
 * Verifies GraphFlow works with NO model configured at all:
 * - graph-structure compression still works (zero LLM)
 * - semantic compression degrades gracefully (no placeholder pollution)
 * - context is never contaminated with "[provider:model] ..." placeholders
 */

const NO_MODEL_CONFIG = validateConfig({
  providers: {}, // no providers configured at all
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 2000,
    compression: { enabled: true, backend: "inherit" },
  },
  learningPolicy: {
    enableFlywheel: false,
    trainingCadence: "nightly",
    canaryRatio: 10,
    exportPath: "graphflow-out/ds.jsonl",
  },
});

describe("M47 No-model graceful degradation", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GRAPHFLOW_OPENBMB_MODEL_PATH;
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  });

  describe("placeholder detection", () => {
    it("detects provider fallback placeholders", () => {
      expect(isPlaceholderResponse("[openai:gpt-4.1-mini] some prompt")).toBe(true);
      expect(isPlaceholderResponse("[anthropic:claude-3] x")).toBe(true);
      expect(isPlaceholderResponse("[openbmb:minicpm-1b] y")).toBe(true);
      expect(isPlaceholderResponse("real summary text")).toBe(false);
      expect(isPlaceholderResponse("login function with 3 variants")).toBe(false);
    });
  });

  describe("compression model availability", () => {
    it("reports available=false when no API key and no embedded model", async () => {
      const model = await resolveCompressionModel(NO_MODEL_CONFIG);
      expect(model.available).toBe(false);
    });
  });

  describe("semantic compression degrades without polluting", () => {
    it("summarizeCluster keeps original content when model unavailable", async () => {
      const model = await resolveCompressionModel(NO_MODEL_CONFIG);
      const cluster = {
        representative: { id: "n1", type: "Symbol" as const, content: "function login(email)" },
        members: [
          { id: "n1", type: "Symbol" as const, content: "function login(email)" },
          { id: "n2", type: "Symbol" as const, content: "function login(phone)" },
        ],
        avgSimilarity: 0.9,
      };

      const summary = await summarizeCluster(cluster, { modelHandle: model });
      // Must NOT be a placeholder; falls back to original content.
      expect(isPlaceholderResponse(summary)).toBe(false);
      expect(summary).toBe("function login(email)");
    });

    it("densifyNodeContent keeps original content when model unavailable", async () => {
      const model = await resolveCompressionModel(NO_MODEL_CONFIG);
      const longContent = "function calculateUserProfileCompletionPercentage" + "x".repeat(700);
      const node: GraphNode = { id: "verbose", type: "Symbol", content: longContent };

      const dense = await densifyNodeContent(node, { modelHandle: model, minInputTokens: 20 });
      expect(isPlaceholderResponse(dense)).toBe(false);
      expect(dense).toBe(longContent); // unchanged
    });
  });

  describe("enhanced package works fully without any model", () => {
    it("graph-structure compression produces clean context with no model", async () => {
      const client = new GraphifyClient();
      const nodes: GraphNode[] = [
        attachEmbedding({ id: "auth.ts", type: "File", content: "authentication module" }, hashEmbedding("auth")),
        attachEmbedding({ id: "login()", type: "Symbol", content: "function login(email: string)" }, hashEmbedding("login email")),
        attachEmbedding({ id: "login2()", type: "Symbol", content: "function login(phone: string)" }, hashEmbedding("login phone")),
      ];
      await client.upsertNodes(nodes);
      await client.upsertEdges([
        { from: "auth.ts", to: "login()", relation: "defines" },
        { from: "auth.ts", to: "login2()", relation: "defines" },
      ]);

      const model = await resolveCompressionModel(NO_MODEL_CONFIG);
      const pkg = await buildEnhancedContextPackage(client, "authentication", "review auth", 2000, {
        enableGraphCompression: true,
        // Even if semantic compression is requested, degradation must keep output clean.
        enableSemanticCompression: true,
        compressionModel: model,
      });

      expect(pkg.summaryChannel.length).toBeGreaterThan(0);
      // CRITICAL: no placeholder leaked into any summary line.
      for (const line of pkg.summaryChannel) {
        expect(isPlaceholderResponse(line)).toBe(false);
        expect(line).not.toContain("[openai:");
        expect(line).not.toContain("[openbmb:");
      }
    });
  });
});
