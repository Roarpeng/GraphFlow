import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import {
  createPackState,
  isPinnedL3Node,
  packPrimaryHits,
  toLayeredPackage,
} from "../src/graph/context-package-core";
import {
  buildEnhancedContextPackage,
  buildLayeredContextPackage,
  isPinnedL3Node as isPinnedL3NodeFromSlicer,
} from "../src/graph/context-slicer";
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

function seedClient() {
  const client = createGraphClient(baseConfig);
  return client;
}

describe("R4 shared context packaging core", () => {
  it("re-exports isPinnedL3Node from context-slicer without changing the predicate", () => {
    const goal: GraphNode = { id: "goal:ship", type: "Decision", content: "ship the release" };
    const alignment: GraphNode = {
      id: "decision:align",
      type: "Decision",
      content: "alignment: keep L3 pins",
    };
    const file: GraphNode = { id: "file:a", type: "File", content: "src/a.ts" };

    expect(isPinnedL3NodeFromSlicer).toBe(isPinnedL3Node);
    expect(isPinnedL3Node(goal)).toBe(true);
    expect(isPinnedL3Node(alignment)).toBe(true);
    expect(isPinnedL3Node(file)).toBe(false);
  });

  it("packPrimaryHits stops at the token budget and marks truncated", () => {
    const hits: GraphNode[] = [
      { id: "file:a", type: "File", content: "alpha" },
      { id: "file:b", type: "File", content: "beta" },
      { id: "file:c", type: "File", content: "gamma" },
    ];
    const state = createPackState(6);
    const budget = { tokens: 0, truncated: false };
    packPrimaryHits(hits, state, budget);
    const pkg = toLayeredPackage(state, budget);

    expect(pkg.truncated).toBe(true);
    expect(pkg.tokenEstimate).toBeLessThanOrEqual(6);
    expect(pkg.anchorChannel.length).toBeGreaterThan(0);
    expect(pkg.anchorChannel.length).toBeLessThan(hits.length);
  });

  it("layered and enhanced share the same pack for a simple graph when extras are off", async () => {
    const client = seedClient();
    await client.upsertNodes([
      { id: "file:src/auth.ts", type: "File", content: "auth login session" },
      { id: "symbol:src/auth.ts:login", type: "Symbol", content: "login authenticates the user" },
      { id: "decision:auth", type: "Decision", content: "prefer session cookies for auth" },
    ]);

    const sharedOptions = { enableEdgeExpansion: false as const };
    const layered = await buildLayeredContextPackage(client, "auth login", 400, sharedOptions);
    const enhanced = await buildEnhancedContextPackage(client, "auth login", "auth login", 400, {
      ...sharedOptions,
      maxAnchors: Number.POSITIVE_INFINITY,
    });

    expect(enhanced.summaryChannel).toEqual(layered.summaryChannel);
    expect(enhanced.anchorChannel).toEqual(layered.anchorChannel);
    expect(enhanced.tokenEstimate).toBe(layered.tokenEstimate);
    expect(enhanced.truncated).toBe(layered.truncated);
  });

  it("keeps public builder contracts: dual-channel package under budget", async () => {
    const client = seedClient();
    await client.upsertNodes([
      { id: "symbol:orchestrate", type: "Symbol", content: "orchestrate handles task routing" },
      { id: "file:readme", type: "File", content: "README contains architecture overview" },
    ]);

    const layered = await buildLayeredContextPackage(client, "orchestrate", 40);
    const enhanced = await buildEnhancedContextPackage(client, "orchestrate", "orchestrate", 40);

    expect(layered.summaryChannel.length).toBeGreaterThan(0);
    expect(layered.anchorChannel.length).toBeGreaterThan(0);
    expect(layered.tokenEstimate).toBeLessThanOrEqual(40);
    expect(enhanced.summaryChannel.length).toBeGreaterThan(0);
    expect(enhanced.anchorChannel.length).toBeGreaterThan(0);
    expect(enhanced.tokenEstimate).toBeLessThanOrEqual(40);
  });
});
