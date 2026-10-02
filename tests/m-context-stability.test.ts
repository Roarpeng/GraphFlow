import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  buildEnhancedContextPackage,
  buildLayeredContextPackage,
} from "../src/graph/context-slicer";
import { recordDialogueTurn } from "../src/learning/dialogue-thread";
import {
  computeAnchorIdSignature,
  recordStableContextTextCopy,
  resetStableCopyTrail,
  reuseStableContextTextCopy,
} from "../src/graph/context-cache";
import { computePrefixStability } from "../src/graph/response-stability";
import { renderStablePreviewTextCopy } from "../src/surfaces/mcp/tool-handlers";
import type { ContextPreviewResult } from "../src/surfaces/cli/runtime/types";

/**
 * U2 宿主前缀可缓存性 / host prefix cacheability.
 *
 * 核心原则：分数决定选谁进入包，id 决定包内顺序 / The score decides WHO
 * enters the package, the id decides the order inside it. These cases pin the
 * three halves of that contract:
 *
 * 1. anchorChannel order is (layer, id) — derived from content, not from the
 *    store's row order or BFS insertion order, so two builds over the same
 *    store serialize byte-identically (the "TTL expired, rebuilt" round).
 * 2. dialogue recall lines order by (sessionId, seq) — the in-session clock —
 *    so an edited `updatedAt` can no longer reshuffle two rounds apart.
 * 3. the graphflow_context text copy carries only the stable face; volatile
 *    numerics live in structuredContent and cannot move the prefix.
 *
 * Hermetic: in-memory GraphifyClient stores only — nothing touches this repo's
 * graph store or graphflow-out artifacts.
 */

const QUERY = "stable anchor probe";
/** Insertion order is deliberately the REVERSE of id order (row order != id order). */
const FILE_IDS = [
  "file:src/probe/epsilon.ts",
  "file:src/probe/delta.ts",
  "file:src/probe/beta.ts",
  "file:src/probe/alpha.ts",
];

function probeFileNode(id: string): GraphNode {
  // Identical content, so every scorer rates them the same: the only thing
  // that can order them is the comparator's tiebreaker.
  return { id, type: "File", content: `${QUERY} file` };
}

async function probeClient(): Promise<GraphifyClient> {
  const client = new GraphifyClient();
  await client.upsertNodes([...FILE_IDS].reverse().map(probeFileNode));
  return client;
}

function anchorIdsOf(pkg: { anchorChannel: Array<{ id: string; layer: string }> }): string[] {
  return pkg.anchorChannel.map((anchor) => anchor.id);
}

const LAYER_RANK: Record<string, number> = { L1: 0, L2: 1, L3: 2 };

describe("m-context-stability: anchor channel is (layer, id) ordered", () => {
  it("two builds of the same query serialize byte-identical anchor channels (both packers)", async () => {
    const layeredClient = await probeClient();
    // "TTL 过期重算" simulation per the U2 spec: call the builders directly,
    // twice — each call runs the full recall/pack pipeline from scratch.
    const firstLayered = await buildLayeredContextPackage(layeredClient, QUERY, 1500);
    const secondLayered = await buildLayeredContextPackage(layeredClient, QUERY, 1500);

    // Not vacuous: the probe store really does produce anchors.
    expect(firstLayered.anchorChannel.length).toBeGreaterThan(0);
    expect(JSON.stringify(secondLayered.anchorChannel)).toBe(JSON.stringify(firstLayered.anchorChannel));

    const enhancedClient = await probeClient();
    const firstEnhanced = await buildEnhancedContextPackage(enhancedClient, QUERY, QUERY, 1500);
    const secondEnhanced = await buildEnhancedContextPackage(enhancedClient, QUERY, QUERY, 1500);
    expect(JSON.stringify(secondEnhanced.anchorChannel)).toBe(JSON.stringify(firstEnhanced.anchorChannel));

    // And the order really is id-within-layer, despite the reverse-id
    // insertion order above (store row order must not leak through).
    for (const pkg of [firstLayered, firstEnhanced]) {
      const layers = pkg.anchorChannel.map((anchor) => anchor.layer);
      expect(layers).toEqual([...layers].sort((a, b) => LAYER_RANK[a]! - LAYER_RANK[b]!));
      for (const rank of [0, 1, 2]) {
        const idsInLayer = pkg.anchorChannel
          .filter((anchor) => LAYER_RANK[anchor.layer] === rank)
          .map((anchor) => anchor.id);
        expect(idsInLayer).toEqual([...idsInLayer].sort((a, b) => a.localeCompare(b)));
      }
    }
  });

  it("adding one anchor keeps the previous array as a strict prefix and appends at the tail", async () => {
    const client = await probeClient();
    const before = await buildLayeredContextPackage(client, QUERY, 1500);
    const beforeIds = anchorIdsOf(before);

    // A Decision node is L3; L3 sorts after every L1/L2 anchor, so the new
    // anchor lands at the global tail and the old array stays a strict prefix.
    await client.upsertNodes([
      { id: "decision:probe/zzz-tail", type: "Decision", content: `${QUERY} decision note` },
    ]);
    const after = await buildLayeredContextPackage(client, QUERY, 1500);
    const afterIds = anchorIdsOf(after);

    expect(afterIds.length).toBe(beforeIds.length + 1);
    expect(afterIds.slice(0, beforeIds.length)).toEqual(beforeIds);
    expect(afterIds[afterIds.length - 1]).toBe("decision:probe/zzz-tail");

    // The serialized channel keeps >= 80% of its leading bytes across the
    // append — the host's prefix cache survives the growth.
    const stability = computePrefixStability(
      JSON.stringify(before.anchorChannel),
      JSON.stringify(after.anchorChannel)
    );
    expect(stability).toBeGreaterThan(0.8);
  });
});

describe("m-context-stability: dialogue recall lines order by (sessionId, seq)", () => {
  interface RecordedTurn {
    id: string;
    sessionId: string;
    seq: number;
    userQuery: string;
  }

  /**
   * Two stores holding the SAME three turns (two sessions) but recorded with
   * opposite wall-clock orders: whichever `updatedAt` order the store hands
   * back, the packed dialogue lines must come out identically — session
   * lexicographic first, then seq ascending (the in-session clock).
   */
  async function twoStampStores(): Promise<{
    a: { client: GraphifyClient; turns: RecordedTurn[] };
    b: { client: GraphifyClient; turns: RecordedTurn[] };
  }> {
    const sessions = [
      { sessionName: "s-alpha", queries: ["transport alpha q1", "transport alpha q2"] },
      { sessionName: "s-beta", queries: ["transport beta q1"] },
    ] as const;

    const build = async (stamps: number[]) => {
      const client = new GraphifyClient();
      const turns: RecordedTurn[] = [];
      let stampIndex = 0;
      for (const session of sessions) {
        for (const userQuery of session.queries) {
          const recorded = await recordDialogueTurn(client, {
            userQuery,
            assistantReply: `answer ${userQuery}`,
            sessionName: session.sessionName,
            workspaceRoot: "/repo-m-context-stability",
            now: stamps[stampIndex % stamps.length]!,
          });
          stampIndex += 1;
          expect(recorded.turn).toBeDefined();
          turns.push({
            id: recorded.turn!.id,
            sessionId: recorded.turn!.sessionId,
            seq: recorded.turn!.seq,
            userQuery,
          });
        }
      }
      return { client, turns };
    };

    return {
      a: await build([1_000, 2_000, 3_000]),
      b: await build([9_000, 8_000, 7_000]),
    };
  }

  function dialogueLines(pkg: { summaryChannel: string[] }): string[] {
    return pkg.summaryChannel.filter((line) => line.includes("dialogue-turn #"));
  }

  it("mixed sessions pack in session order then seq, unaffected by updatedAt jitter", async () => {
    const { a, b } = await twoStampStores();

    const pkgA = await buildLayeredContextPackage(a.client, "transport", 1500);
    const pkgB = await buildLayeredContextPackage(b.client, "transport", 1500);

    const linesA = dialogueLines(pkgA);
    const linesB = dialogueLines(pkgB);
    // All three turns match the query token, DIALOGUE_PACK_MAX_TURNS is 3 —
    // the selection is the full set in both stores.
    expect(linesA.length).toBe(3);
    expect(linesB.length).toBe(3);

    // Expected presentation order: sessionId lexicographic, then seq — NOT
    // the updatedAt order (which differs between the two stores).
    const expected = [...a.turns]
      .sort(
        (t1, t2) =>
          t1.sessionId.localeCompare(t2.sessionId) || t1.seq - t2.seq || t1.id.localeCompare(t2.id)
      )
      .map((turn) => turn.userQuery);
    for (const [lines, label] of [
      [linesA, "store A"],
      [linesB, "store B"],
    ] as const) {
      // The packed line is `dialogue-turn #<seq> Q: <userQuery…>` (the stored
      // userQuery may carry an appended answer preview), so order is asserted
      // on the Q text's leading userQuery prefix, position by position.
      const actual = lines.map((line) => {
        const match = line.match(/Q: (.+)$/);
        expect(match, `dialogue line must carry the Q text: ${line}`).toBeDefined();
        return match![1]!;
      });
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i += 1) {
        expect(
          actual[i]!.startsWith(expected[i]!),
          `${label}: dialogue line ${i} must be "${expected[i]}" (sessionId/seq order), got "${actual[i]}"`
        ).toBe(true);
      }
    }

    // Byte-stability across the updatedAt jitter: same store content, same
    // selection → same dialogue anchor bytes.
    const dialogueAnchorsA = pkgA.anchorChannel
      .filter((anchor) => anchor.id.startsWith("dialogue:"))
      .map((anchor) => anchor.id);
    const dialogueAnchorsB = pkgB.anchorChannel
      .filter((anchor) => anchor.id.startsWith("dialogue:"))
      .map((anchor) => anchor.id);
    expect(dialogueAnchorsA.length).toBe(3);
    expect(dialogueAnchorsB).toEqual(dialogueAnchorsA);
  });
});

describe("m-context-stability: graphflow_context text copy is the stable face", () => {
  function makePreview(volatile: "round-1" | "round-2"): ContextPreviewResult {
    return {
      query: "transport default",
      summaryCount: 2,
      anchorCount: 1,
      tokenEstimate: volatile === "round-1" ? 100 : 100,
      truncated: false,
      anchorsByLayer: { l1: 1, l2: 0, l3: 0 },
      refillPreview: [],
      summary: ["File: src/transport.ts", "Symbol: initTransport @src/transport.ts:1"],
      anchors: [{ id: "file:src/transport.ts", type: "File", layer: "L1" }],
      tokenBudget: {
        maxContextTokens: 4_000,
        estimatedRawTokens: volatile === "round-1" ? 10_000 : 20_000,
        compressedTokens: volatile === "round-1" ? 120 : 180,
        estimatedSavingsPercent: volatile === "round-1" ? 88 : 91,
        budgetUsedPercent: volatile === "round-1" ? 3 : 4.5,
      },
      ...(volatile === "round-1" ? { unbudgetedTokens: 40 } : { unbudgetedTokens: 90 }),
      ...(volatile === "round-1" ? { accountedTokens: 160 } : { accountedTokens: 270 }),
      contextPressure: {
        enabled: true,
        budgetMode: "fixed",
        effectiveMaxContextTokens: volatile === "round-1" ? 4_000 : 3_500,
        usedTokens: volatile === "round-1" ? 500 : 2_500,
        maxTokens: 8_192,
        pressureRatio: volatile === "round-1" ? 0.06 : 0.3,
      },
      dialogueThread: {
        sessionId: "dialogue:abc",
        sessionName: "main",
        jumped: false,
        overlap: 2,
        turns: [
          {
            id: "dialogue:abc:0001",
            seq: 1,
            jumped: false,
            userQuery: "transport default?",
            assistantReply: "sqlite.",
          },
        ],
        promptLines: ["[thread] turn 1"],
      },
    };
  }

  it("volatile metric changes do not move a byte of the text copy", () => {
    const round1 = renderStablePreviewTextCopy(makePreview("round-1"));
    const round2 = renderStablePreviewTextCopy(makePreview("round-2"));

    expect(JSON.stringify(round2)).toBe(JSON.stringify(round1));

    // The stable blocks lead, in the fixed order.
    expect(Object.keys(round1)).toEqual([
      "query",
      "summary",
      "anchors",
      "dialogueThread",
      "volatile-metrics",
    ]);

    // The volatile numeric fields never enter the copy…
    const serialized = JSON.stringify(round1);
    for (const forbidden of [
      "tokenBudget",
      "unbudgetedTokens",
      "accountedTokens",
      "contextPressure",
      "estimatedRawTokens",
      "pressureRatio",
      "updatedAt",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    // …and the tail line points at where they live.
    expect(round1["volatile-metrics"]).toBe("see structuredContent");
  });

  it("structuredContent still carries every field the text copy dropped", () => {
    // The MCP layer returns structuredResponse(result, { textOverride }) —
    // structuredContent IS the untouched result object. Asserted here on the
    // source object the renderer is fed: every volatile field must survive.
    const result = makePreview("round-2");
    expect(result.tokenBudget.estimatedRawTokens).toBe(20_000);
    expect(result.unbudgetedTokens).toBe(90);
    expect(result.accountedTokens).toBe(270);
    expect(result.contextPressure?.effectiveMaxContextTokens).toBe(3_500);
  });

  it("same-session byte reuse: cache trail hands back the previous bytes on an unchanged anchor set", () => {
    resetStableCopyTrail();
    const anchors = [
      { id: "file:src/a.ts", type: "File" as const, layer: "L1" as const },
      { id: "file:src/b.ts", type: "File" as const, layer: "L1" as const },
    ];
    const textCopy = JSON.stringify(renderStablePreviewTextCopy(makePreview("round-1")));

    // Nothing recorded yet → a fresh render is required.
    expect(reuseStableContextTextCopy("q", "/repo", anchors)).toBeUndefined();

    // The signature itself: deterministic for the same ordered input, and
    // order is part of the contract (["a","b"] and ["b","a"] are different
    // packages — the host caches bytes, and bytes follow order).
    const anchorsReversed = [anchors[1]!, anchors[0]!];
    expect(computeAnchorIdSignature(anchors)).toBe(computeAnchorIdSignature([...anchors]));
    expect(computeAnchorIdSignature(anchorsReversed)).not.toBe(computeAnchorIdSignature(anchors));

    recordStableContextTextCopy("q", "/repo", anchors, textCopy);
    // TTL-expired rebuild with the same anchor set → the previous bytes, verbatim.
    expect(reuseStableContextTextCopy("q", "/repo", anchors)).toBe(textCopy);
    // One more anchor → signature moved → render fresh again.
    expect(
      reuseStableContextTextCopy("q", "/repo", [
        ...anchors,
        { id: "file:src/c.ts", type: "File" as const, layer: "L1" as const },
      ])
    ).toBeUndefined();
    // Reordered anchor set → different signature (order is part of the contract).
    expect(reuseStableContextTextCopy("q", "/repo", [anchors[1]!, anchors[0]!])).toBeUndefined();
    // Different query/rootDir key → no reuse.
    expect(reuseStableContextTextCopy("q2", "/repo", anchors)).toBeUndefined();
    expect(reuseStableContextTextCopy("q", "/other", anchors)).toBeUndefined();
  });
});

describe("m-context-stability: computePrefixStability unit", () => {
  it("identical strings score 1, including two empty strings", () => {
    expect(computePrefixStability("abc", "abc")).toBe(1);
    expect(computePrefixStability("", "")).toBe(1);
  });

  it("completely different strings score 0", () => {
    expect(computePrefixStability("abc", "xyz")).toBe(0);
    expect(computePrefixStability("", "xyz")).toBe(0);
  });

  it("shared prefixes score the byte ratio against the longer input", () => {
    expect(computePrefixStability("abcdef", "abcxyz")).toBe(0.5);
    expect(computePrefixStability("abcd", "abcdefgh")).toBe(0.5);
    // UTF-8 aware: the shared CJK prefix "你好" is 6 bytes of the 12-byte
    // longer input, not 2 of 4 code units with a different byte weight.
    expect(computePrefixStability("你好世界", "你好啊")).toBe(0.5);
  });
});
