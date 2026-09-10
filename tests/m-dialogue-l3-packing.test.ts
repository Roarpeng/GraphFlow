import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  buildEnhancedContextPackage,
  buildLayeredContextPackage,
} from "../src/graph/context-slicer";
import type {
  ContextAnchorItem,
  LayeredContextPackage,
  LayeredPackageOptions,
} from "../src/graph/context-slicer";
import { recordDialogueTurn } from "../src/learning/dialogue-thread";

interface BothPackages {
  layered: LayeredContextPackage;
  enhanced: LayeredContextPackage;
}

/**
 * Build with BOTH packers over the same fixture.
 *
 * `buildEnhancedContextPackage` is the PRODUCTION path (MCP `graphflow_context`
 * -> previewContext); `buildLayeredContextPackage` is the reference packer.
 * The v1.14 L3 dialogue feature shipped dead in production because every case
 * in this file used to assert the layered packer only — so from v1.16 on every
 * case must assert both.
 */
async function buildWithBothPackers(
  client: GraphifyClient,
  query: string,
  maxTokens: number,
  options?: LayeredPackageOptions
): Promise<BothPackages> {
  const layered = await buildLayeredContextPackage(client, query, maxTokens, options);
  const enhanced = await buildEnhancedContextPackage(client, query, query, maxTokens, options);
  return { layered, enhanced };
}

function dialogueAnchorsOf(pkg: LayeredContextPackage): ContextAnchorItem[] {
  return pkg.anchorChannel.filter((a) => a.id.startsWith("dialogue:"));
}

describe("dialogue turns packed into L3 context (Conversation Graph W2a, layered + enhanced)", () => {
  it("returns matched dialogue-turn anchors with correction annotation", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "graphflow mcp transport 默认是什么",
      assistantReply: "默认是 sqlite。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const correction = await recordDialogueTurn(client, {
      userQuery: "graphflow mcp transport 到底默认什么",
      assistantReply: "更正：默认 transport 是 auto。",
      workspaceRoot: "/repo",
      now: 2_000,
    });

    const { layered, enhanced } = await buildWithBothPackers(
      client,
      "graphflow mcp transport 默认",
      1500
    );
    for (const pkg of [layered, enhanced]) {
      // The current (effective) turn is packed as an L3 anchor.
      expect(pkg.anchorChannel).toContainEqual({
        id: correction.turn!.id,
        type: "Decision",
        layer: "L3",
      });
      // The correction annotation line is present.
      expect(pkg.summaryChannel.some((line) => line.includes("已被修正"))).toBe(true);
      // The correction line mentions the superseded turn's seq, not the correction's own.
      expect(
        pkg.summaryChannel.some((line) => line.includes("Turn #1") && line.includes("Turn #2"))
      ).toBe(true);
    }
  });

  it("does not pack dialogue turns when the query does not overlap them", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "怎么部署到 k8s 集群",
      assistantReply: "用 helm chart。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const { layered, enhanced } = await buildWithBothPackers(
      client,
      "sqlite fts5 tokenizer 配置",
      1500
    );
    for (const pkg of [layered, enhanced]) {
      expect(dialogueAnchorsOf(pkg)).toHaveLength(0);
    }
  });

  it("keeps dialogue anchors under the token budget (no exemption)", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "token budget token budget budget",
      assistantReply: "预算管理答案。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const { layered, enhanced } = await buildWithBothPackers(client, "token budget", 1500);
    for (const pkg of [layered, enhanced]) {
      const dialogueAnchors = dialogueAnchorsOf(pkg);
      if (dialogueAnchors.length > 0) {
        expect(pkg.tokenEstimate).toBeLessThanOrEqual(1500);
      }
    }
    // A tiny budget must not blow up: packing marks truncated instead.
    const tight = await buildWithBothPackers(client, "token budget", 12);
    for (const pkg of [tight.layered, tight.enhanced]) {
      expect(pkg.tokenEstimate).toBeLessThanOrEqual(12 + 60); // one line may cross before truncation flag
    }
  });

  it("respects the l3 layer quota for dialogue anchors", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "quota quota quota test",
      assistantReply: "答。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const { layered, enhanced } = await buildWithBothPackers(client, "quota test", 1500, {
      layerQuota: { l1: 5, l2: 5, l3: 0 },
    });
    for (const pkg of [layered, enhanced]) {
      expect(dialogueAnchorsOf(pkg)).toHaveLength(0);
    }
  });

  it("never throws when the graph has no dialogue nodes", async () => {
    const client = new GraphifyClient();
    const { layered, enhanced } = await buildWithBothPackers(client, "anything", 1500);
    for (const pkg of [layered, enhanced]) {
      expect(pkg.anchorChannel).toBeDefined();
      expect(pkg.summaryChannel).toBeDefined();
    }
  });

  it("caps dialogue turns at 3 under a tight budget without displacing code anchors", async () => {
    const client = new GraphifyClient();
    // Code anchors: packed as L1 primary hits BEFORE the L3 dialogue stage,
    // so dialogue turns can only ever consume what is left of the budget.
    await client.upsertNodes([
      { id: "file:src/cache.ts", type: "File", content: "cache eviction policy" },
      {
        id: "symbol:src/cache.ts:evict",
        type: "Symbol",
        content: "evict implements LRU cache eviction",
      },
    ]);

    // The matching tokens sit past the 160-char clip that compactTurnContent
    // applies to the stored turn node, so the dialogue turns are invisible to
    // keyword recall and reachable ONLY through the L3 dialogue stage
    // (collectDialogueContextLines scores the full turn record). The filler
    // must not contain any query token, nor /alignment|deviation|goal/i
    // (which would make the turns governance pins).
    const filler =
      "the team discussed the nightly release pipeline for the mobile dashboard service " +
      "and how the on call rotation should handle rollback windows while the infra squad " +
      "prepares the new staging cluster with better observability tooling and clearer " +
      "runbooks for the support engineers who rotate through the incident response queue " +
      "every two weeks during the quarter end freeze period and the platform guild reviews " +
      "the deployment calendar before the holiday freeze";
    expect(filler.length).toBeGreaterThanOrEqual(160);
    for (const token of ["cache", "eviction", "policy", "lru"]) {
      expect(filler.toLowerCase()).not.toContain(token);
    }

    // Five matching turns — more than DIALOGUE_PACK_MAX_TURNS (3). Distinct
    // suffixes keep recordDialogueTurn from deduping them into one turn, and
    // the replies carry no correction markers so all five stay effective.
    const turnIds: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const res = await recordDialogueTurn(client, {
        userQuery: `${filler} cache eviction policy lru question ${i}`,
        assistantReply: `answer ${i}`,
        workspaceRoot: "/repo",
        now: i * 1_000,
      });
      expect(res.recorded).toBe(true);
      turnIds.push(res.turn!.id);
    }

    // Fixture premise: the clipped turn nodes are NOT keyword hits for the
    // query, so every dialogue: anchor below can only come from the L3
    // dialogue stage — the cap assertion is about DIALOGUE_PACK_MAX_TURNS.
    const keywordDialogueHits = (
      await client.queryByKeyword("cache eviction policy lru")
    ).filter((n) => n.id.startsWith("dialogue:"));
    expect(keywordDialogueHits).toHaveLength(0);

    // Roomy budget: all 5 turns match, but the documented cap packs exactly 3.
    const roomy = await buildWithBothPackers(client, "cache eviction policy lru", 2000);
    for (const pkg of [roomy.layered, roomy.enhanced]) {
      const dialogueAnchors = dialogueAnchorsOf(pkg);
      expect(dialogueAnchors).toHaveLength(3);
      for (const anchor of dialogueAnchors) {
        expect(turnIds).toContain(anchor.id);
        expect(anchor.type).toBe("Decision");
        expect(anchor.layer).toBe("L3");
      }
      // Code anchors packed before the L3 stage survive.
      expect(pkg.anchorChannel).toContainEqual({
        id: "file:src/cache.ts",
        type: "File",
        layer: "L1",
      });
      expect(pkg.anchorChannel).toContainEqual({
        id: "symbol:src/cache.ts:evict",
        type: "Symbol",
        layer: "L1",
      });
      expect(pkg.tokenEstimate).toBeLessThanOrEqual(2000);
      expect(pkg.truncated).toBe(false);
    }

    // Tight budget: dialogue turns yield to the shared budget (never exempt)
    // while the code anchors stay packed — dialogue cannot displace them.
    const tight = await buildWithBothPackers(client, "cache eviction policy lru", 100);
    for (const pkg of [tight.layered, tight.enhanced]) {
      expect(dialogueAnchorsOf(pkg).length).toBeLessThanOrEqual(3);
      expect(pkg.anchorChannel).toContainEqual({
        id: "file:src/cache.ts",
        type: "File",
        layer: "L1",
      });
      expect(pkg.anchorChannel).toContainEqual({
        id: "symbol:src/cache.ts:evict",
        type: "Symbol",
        layer: "L1",
      });
      expect(pkg.tokenEstimate).toBeLessThanOrEqual(100);
      expect(pkg.truncated).toBe(true);
    }
  });
});
