import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import {
  buildEnhancedContextPackage,
  isPinnedL3Node,
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

describe("L3 constraint pin", () => {
  it("isPinnedL3Node matches goal ids and alignment/deviation Decisions", () => {
    expect(isPinnedL3Node({ id: "goal:keep-me", type: "Decision", content: "ship it" })).toBe(true);
    expect(
      isPinnedL3Node({
        id: "decision:align",
        type: "Decision",
        content: "must preserve alignment with the requirement",
      })
    ).toBe(true);
    expect(
      isPinnedL3Node({
        id: "decision:drift",
        type: "Decision",
        content: "logged a deviation",
        metadata: { kind: "episode", record: "{\"deviation\":\"scope-creep\"}" },
      })
    ).toBe(true);
    expect(
      isPinnedL3Node({
        id: "skill:noise",
        type: "Skill",
        content: "random skill about packing",
      })
    ).toBe(false);
  });

  it("pinned goal node survives a tiny maxTokens package when enableAlwaysOnLayers", async () => {
    const client = createGraphClient(baseConfig);
    const nodes: GraphNode[] = [
      {
        id: "file:huge.ts",
        type: "File",
        content: `pack context file body ${"x".repeat(4000)}`,
      },
      {
        id: "skill:noisy-pack",
        type: "Skill",
        content: `pack context skill filler ${"y".repeat(4000)}`,
      },
      {
        id: "goal:keep-alignment",
        type: "Decision",
        content: "goal: keep alignment",
        metadata: { kind: "goal" },
      },
    ];
    await client.upsertNodes(nodes);

    const pkg = await buildEnhancedContextPackage(client, "pack context", "pack context", 20, {
      enableAlwaysOnLayers: true,
      enableEdgeExpansion: false,
      enableGraphCompression: false,
    });

    const ids = pkg.anchorChannel.map((a) => a.id);
    expect(ids).toContain("goal:keep-alignment");
    const goal = pkg.anchorChannel.find((a) => a.id === "goal:keep-alignment");
    expect(goal?.layer).toBe("L3");
    expect(pkg.summaryChannel.some((line) => line.includes("keep alignment"))).toBe(true);
  });
});
