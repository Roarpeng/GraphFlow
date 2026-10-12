import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient } from "../src/graph/client-factory";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import { collectKeywordHits } from "../src/graph/context-package-core";
import type { GraphNode } from "../src/core/types";

/**
 * Focused regression: one hub file whose symbols match every query token must
 * not monopolize retrieval and crowd the true target out of the package.
 *
 * Reproduces the "orchestrate task routing" golden failure mode: a runtime
 * routing helper file with dozens of task/routing-matching symbols flooded
 * the candidate pool, and same-file expansion re-added the rest afterwards,
 * so the anchor channel became 100% hub file and the target never entered.
 *
 * Guards two mechanisms:
 *   1. candidate-stage diversification (CANDIDATE_MAX_SYMBOLS_PER_FILE) keeps
 *      a cross-file candidate pool visible to compression and packing;
 *   2. the dominance guard in injectSameFileAndImportExpansion stops re-adding
 *      hub symbols once the hub owns half the anchor channel.
 */
const baseConfig = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 3000,
  },
  learningPolicy: {
    enableFlywheel: false,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

const QUERY = "orchestrate task routing";
/** Enough hub symbols to fill the compression window (30 nodes) on their own. */
const HUB_SYMBOL_COUNT = 34;

function floodNodes(): GraphNode[] {
  const nodes: GraphNode[] = [
    {
      id: "file:src/runtime/hub.ts",
      type: "File",
      content: "runtime hub task routing orchestrate dispatch helpers",
    },
  ];
  for (let i = 0; i < HUB_SYMBOL_COUNT; i += 1) {
    nodes.push({
      id: `symbol:src/runtime/hub.ts:handler${i}`,
      type: "Symbol",
      content: `hub handler ${i} task routing orchestrate dispatch`,
    });
  }
  nodes.push(
    { id: "file:src/core/target.ts", type: "File", content: "core target orchestrate module" },
    {
      id: "symbol:src/core/target.ts:orchestrate",
      type: "Symbol",
      content: "orchestrate task routing for the core target module",
    }
  );
  return nodes;
}

describe("hit flood guard: single-file candidate flooding", () => {
  it("keeps a cross-file candidate pool when one file floods the keyword hits", async () => {
    const client = createGraphClient(baseConfig);
    await client.upsertNodes(floodNodes());

    const candidates = await collectKeywordHits(client, QUERY, {});
    const hubSymbols = candidates.filter(
      (n) => n.type === "Symbol" && n.id.startsWith("symbol:src/runtime/hub.ts:")
    ).length;
    const hasTarget = candidates.some((n) => n.id.includes("src/core/target.ts"));

    // The hub is capped in the candidate pool, and the target survives into it.
    expect(hubSymbols).toBeLessThan(HUB_SYMBOL_COUNT);
    expect(hasTarget).toBe(true);
  });

  it("surfaces the strong-match target file in the enhanced package", async () => {
    const client = createGraphClient(baseConfig);
    await client.upsertNodes(floodNodes());

    const pkg = await buildEnhancedContextPackage(client, QUERY, QUERY, 800, {
      enableGraphCompression: true,
    });
    const ids = pkg.anchorChannel.map((a) => a.id);

    expect(ids.some((id) => id.includes("src/core/target.ts"))).toBe(true);

    // And the hub may not own the whole channel: same-file expansion stops
    // once the hub holds half the anchors (absolute cap 6 aside).
    const hubAnchors = ids.filter((id) => id.includes("src/runtime/hub.ts")).length;
    expect(hubAnchors).toBeLessThan(ids.length);
    expect(hubAnchors).toBeLessThanOrEqual(6 + 1); // 6 symbols + the File anchor
  });
});
