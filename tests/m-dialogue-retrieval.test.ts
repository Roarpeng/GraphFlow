import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { searchDialogueTurns } from "../src/graph/graph-search";
import { recordDialogueTurn } from "../src/learning/dialogue-thread";

describe("dialogue turn search with correction chains (Conversation Graph W2b)", () => {
  it("returns matched effective turns with the correction annotation", async () => {
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

    const hits = await searchDialogueTurns(client, "graphflow mcp transport 默认");
    expect(hits.length).toBeGreaterThan(0);
    const correctedHit = hits.find((h) => h.id === correction.turn!.id);
    expect(correctedHit).toBeDefined();
    expect(correctedHit!.correctionLine).toContain("已被修正");
    expect(correctedHit!.superseded).toBe(false);
  });

  it("hides superseded turns by default and includes them on request", async () => {
    const client = new GraphifyClient();
    const first = await recordDialogueTurn(client, {
      userQuery: "hnsw 向量索引还在用吗",
      assistantReply: "在用。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    await recordDialogueTurn(client, {
      userQuery: "hnsw 向量索引还在用吗 再确认下",
      assistantReply: "更正：已经改成线性扫描了。",
      workspaceRoot: "/repo",
      now: 2_000,
    });

    const defaultHits = await searchDialogueTurns(client, "hnsw 向量索引");
    expect(defaultHits.some((h) => h.id === first.turn!.id)).toBe(false);

    const withHistory = await searchDialogueTurns(client, "hnsw 向量索引", {
      includeSuperseded: true,
    });
    const old = withHistory.find((h) => h.id === first.turn!.id);
    expect(old).toBeDefined();
    expect(old!.superseded).toBe(true);
  });

  it("never displaces code results: pure additive dialogue hits list", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "context slicer 压缩预算",
      assistantReply: "L1-L3 分层。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const hits = await searchDialogueTurns(client, "context slicer 压缩");
    expect(hits.length).toBeGreaterThan(0);
    // hits only contain dialogue-turn ids
    expect(hits.every((h) => h.id.startsWith("dialogue:"))).toBe(true);
  });

  it("returns empty for a query that matches nothing", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "怎么部署 helm chart",
      assistantReply: "helm install。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const hits = await searchDialogueTurns(client, "sqlite fts5 tokenizer");
    expect(hits).toHaveLength(0);
  });

  it("never throws on an empty graph", async () => {
    const client = new GraphifyClient();
    const hits = await searchDialogueTurns(client, "anything at all");
    expect(hits).toHaveLength(0);
  });
});
