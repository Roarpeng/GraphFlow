import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { buildLayeredContextPackage } from "../src/graph/context-slicer";
import { recordDialogueTurn } from "../src/learning/dialogue-thread";

describe("dialogue turns packed into L3 context (Conversation Graph W2a)", () => {
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

    const pkg = await buildLayeredContextPackage(client, "graphflow mcp transport 默认", 1500);
    // The current (effective) turn is packed as an L3 anchor.
    expect(pkg.anchorChannel).toContainEqual({
      id: correction.turn!.id,
      type: "Decision",
      layer: "L3",
    });
    // The correction annotation line is present.
    expect(pkg.summaryChannel.some((line) => line.includes("已被修正"))).toBe(true);
    // The correction line mentions the superseded turn's seq, not the correction's own.
    expect(pkg.summaryChannel.some((line) => line.includes("Turn #1") && line.includes("Turn #2"))).toBe(true);
  });

  it("does not pack dialogue turns when the query does not overlap them", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "怎么部署到 k8s 集群",
      assistantReply: "用 helm chart。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const pkg = await buildLayeredContextPackage(client, "sqlite fts5 tokenizer 配置", 1500);
    expect(pkg.anchorChannel.filter((a) => a.id.startsWith("dialogue:"))).toHaveLength(0);
  });

  it("keeps dialogue anchors under the token budget (no exemption)", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "token budget token budget budget",
      assistantReply: "预算管理答案。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const pkg = await buildLayeredContextPackage(client, "token budget", 1500);
    const dialogueAnchors = pkg.anchorChannel.filter((a) => a.id.startsWith("dialogue:"));
    if (dialogueAnchors.length > 0) {
      expect(pkg.tokenEstimate).toBeLessThanOrEqual(1500);
    }
    // A tiny budget must not blow up: packing marks truncated instead.
    const tight = await buildLayeredContextPackage(client, "token budget", 12);
    expect(tight.tokenEstimate).toBeLessThanOrEqual(12 + 60); // one line may cross before truncation flag
  });

  it("respects the l3 layer quota for dialogue anchors", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "quota quota quota test",
      assistantReply: "答。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const pkg = await buildLayeredContextPackage(client, "quota test", 1500, {
      layerQuota: { l1: 5, l2: 5, l3: 0 },
    });
    expect(pkg.anchorChannel.filter((a) => a.id.startsWith("dialogue:"))).toHaveLength(0);
  });

  it("never throws when the graph has no dialogue nodes", async () => {
    const client = new GraphifyClient();
    const pkg = await buildLayeredContextPackage(client, "anything", 1500);
    expect(pkg.anchorChannel).toBeDefined();
    expect(pkg.summaryChannel).toBeDefined();
  });
});
