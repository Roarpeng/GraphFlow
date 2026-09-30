import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { GraphEdge, GraphNode } from "../src/core/types";
import { resolveConfig } from "../src/config/resolve";
import { createGraphClient } from "../src/graph/client-factory";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import { previewContext } from "../src/surfaces/cli/runtime/graph";
import type { ContextPreviewResult } from "../src/surfaces/cli/runtime/types";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";
import { createTempProjectRoot, rmTrackedRoots } from "./helpers/temp-workspace";

/**
 * Byte-stable context prefix / 上下文字节稳定性验收.
 *
 * `graphflow_context` is a prompt prefix: a host that caches it only gets a hit
 * while the leading bytes repeat. It did not repeat — the same query on an
 * unchanged repo produced different bytes, for two reasons this suite pins
 * closed:
 *
 * 1. score-only sorts. V8 sort is stable, so equal-score nodes kept whichever
 *    row order SQLite/FTS returned, and "which 20 of 5000" was not reproducible.
 * 2. per-call fields sitting in the middle of the envelope: post-packaging token
 *    accounting, the `degraded` trace, and `economics.churn` (a diff against
 *    what THIS process sent last time) each re-wrote every byte behind them.
 *
 * The stable ordering policy (whether `anchors` should lead, which defaults are
 * ON) is deliberately NOT decided here — see `src/graph/project-brief.ts`, the
 * repo's existing example of a genuinely content-derived stable block, whose
 * "is byte-identical across calls and across input ordering" test in
 * `tests/project-brief.test.ts` is the pattern this file follows.
 *
 * Hermetic: a temp workspace + `no-llm-config`, so nothing is written into this
 * repo's graph store, its `graphflow-out` artifacts, or its benchmarks.
 */

const STABLE_KEYS = ["query", "summary", "anchors", "tokenBudget", "refillPreview"] as const;
const VOLATILE_KEYS = [
  "anchorsByLayer",
  "unbudgetedTokens",
  "accountedTokens",
  "degraded",
  "dialogueHits",
  "dialogueThread",
  "dialogueCapture",
  "workbench",
  "economics",
  "cacheLayout",
] as const;

/** The cacheable head, serialized in the declared key order. */
function stablePrefixOf(result: ContextPreviewResult): string {
  const ordered: Record<string, unknown> = {};
  for (const key of STABLE_KEYS) {
    ordered[key] = result[key];
  }
  return JSON.stringify(ordered);
}

function volatileKeysPresent(result: ContextPreviewResult): string[] {
  const keys = Object.keys(result);
  return VOLATILE_KEYS.filter((key) => keys.includes(key));
}

function assertVolatileKeysTrailStableHead(result: ContextPreviewResult): void {
  const keys = Object.keys(result);
  const lastStable = Math.max(...STABLE_KEYS.map((key) => keys.indexOf(key)));
  const present = volatileKeysPresent(result);
  expect(present.length).toBeGreaterThanOrEqual(0);
  for (const key of present) {
    expect(
      keys.indexOf(key) > lastStable,
      `volatile field "${key}" must sit after the stable head, got order ${keys.join(",")}`
    ).toBe(true);
  }
}

const QUERY = "prefix stability probe alpha beta";
/** Insertion order is deliberately the reverse of id order (row order != id order). */
const TIED_IDS = [
  "file:src/tied/epsilon.ts",
  "file:src/tied/delta.ts",
  "file:src/tied/gamma.ts",
  "file:src/tied/beta.ts",
  "file:src/tied/alpha.ts",
];

function tiedNode(id: string): GraphNode {
  // Identical content, so every scorer in the pipeline rates them the same: the
  // only thing that can order them is the comparator's final tiebreaker.
  return { id, type: "File", content: "prefix stability probe alpha beta" };
}

describe("context preview prefix stability", () => {
  const roots: string[] = [];
  let configPath = "";
  let workspaceRoot = "";

  beforeAll(async () => {
    workspaceRoot = createTempProjectRoot("graphflow-prefix-stability", roots);
    configPath = createNoLlmConfigPath({
      graphPolicy: {
        transport: "sqlite",
        graphStorePath: join(workspaceRoot, "graphflow-graph.sqlite"),
        workspaceRoot,
        autoIndexOnPreview: false,
        autoIndexOnRun: false,
        autoIndexOnSave: false,
        maxContextTokens: 1_000,
      },
    });

    const client = createGraphClient(resolveConfig(configPath));
    // Insertion (= rowid) order is the REVERSE of id order, so a comparator that
    // only looks at scores hands the tied group back last-in-first-out.
    await client.upsertNodes([
      { id: "file:src/tied/anchor.ts", type: "File", content: "prefix stability probe alpha beta hub" },
      ...[...TIED_IDS].reverse().map(tiedNode),
    ]);
    const edges: GraphEdge[] = TIED_IDS.map((id) => ({
      from: "file:src/tied/anchor.ts",
      to: id,
      relation: "references" as const,
    }));
    await client.upsertEdges(edges);
  });

  afterAll(() => {
    rmTrackedRoots(roots);
  });

  it("two identical previews emit byte-identical stable prefixes with the volatile fields trailing", async () => {
    const first = await previewContext(QUERY, configPath, workspaceRoot, undefined, {
      recordDialogue: false,
    });
    const second = await previewContext(QUERY, configPath, workspaceRoot, undefined, {
      recordDialogue: false,
    });

    // Not vacuous: the tied store really does produce anchors.
    expect(second.anchors.length).toBeGreaterThan(0);
    expect(stablePrefixOf(first)).toBe(stablePrefixOf(second));
    assertVolatileKeysTrailStableHead(first);
    assertVolatileKeysTrailStableHead(second);
  });

  it("keeps the stable prefix identical while economics.churn changes between calls", async () => {
    // The hard case: `economics.churn` is a diff against the package THIS process
    // sent last time, so the first call reports a first observation and every
    // later call reports a measured ratio. Observed pressure is passed so both
    // calls rebuild (the shared context cache would otherwise hand back call 1's
    // object and prove nothing).
    process.env.GRAPHFLOW_CONTEXT_ECONOMICS = "1";
    try {
      const usage = { usedTokens: 50, maxTokens: 1_000, remainingTurnsEstimate: 10 };
      const warm = await previewContext(QUERY, configPath, workspaceRoot, undefined, {
        recordDialogue: false,
      }, usage);
      const again = await previewContext(QUERY, configPath, workspaceRoot, undefined, {
        recordDialogue: false,
      }, usage);

      expect(warm.economics).toBeDefined();
      expect(again.economics).toBeDefined();
      // The proof that the relocation buys something: churn differs, head does not.
      expect(again.economics!.churn.firstObservation).not.toBe(warm.economics!.churn.firstObservation);
      expect(stablePrefixOf(warm)).toBe(stablePrefixOf(again));
      assertVolatileKeysTrailStableHead(again);
    } finally {
      delete process.env.GRAPHFLOW_CONTEXT_ECONOMICS;
    }
  });

  it("orders equal-score anchors by node id, not by store row order", async () => {
    const built = async (): Promise<string[]> => {
      const client = createGraphClient(resolveConfig(configPath));
      const pkg = await buildEnhancedContextPackage(client, QUERY, QUERY, 1_000, {
        workspaceRoot,
      });
      return pkg.anchorChannel.map((anchor) => anchor.id);
    };

    const first = await built();
    const second = await built();

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);

    const tiedReturned = first.filter((id) => TIED_IDS.includes(id));
    expect(tiedReturned.length).toBeGreaterThanOrEqual(2);
    expect(tiedReturned).toEqual([...tiedReturned].sort((a, b) => a.localeCompare(b)));
  });
});
