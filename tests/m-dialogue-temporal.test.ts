import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  detectSameTopicLinks,
  detectSupersession,
  dialogueSessionIdFor,
  effectiveTurns,
  formatSupersessionLine,
  listDialogueTurns,
  recordDialogueTurn,
} from "../src/learning/dialogue-thread";

describe("dialogue temporal edges (Conversation Graph W1a)", () => {
  it("links a correction reply to the earlier same-topic turn with a supersedes edge", async () => {
    const client = new GraphifyClient();
    const first = await recordDialogueTurn(client, {
      userQuery: "graphflow 的 MCP 传输默认是 sqlite 吗",
      assistantReply: "是的，默认 sqlite。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const correction = await recordDialogueTurn(client, {
      userQuery: "graphflow 的 MCP 传输到底默认是什么",
      assistantReply: "更正：默认 transport 是 auto，sqlite 优先、file 回退。",
      workspaceRoot: "/repo",
      now: 3_000,
    });

    // record + detect
    expect(correction.turn?.supersedesTurnIds).toBeDefined();
    expect(correction.turn?.supersedesTurnIds).toContain(first.turn!.id);
    expect(correction.turn?.validAt).toBe(3_000);

    // graph edge
    const snapshot = client.readSnapshot();
    expect(snapshot.edges).toContainEqual({
      from: correction.turn!.id,
      to: first.turn!.id,
      relation: "supersedes",
    });

    // the superseded turn gains invalidAt (no longer current)
    const turns = await listDialogueTurns(client, { sessionId: first.session!.id });
    const superseded = turns.find((t) => t.id === first.turn!.id);
    expect(superseded?.invalidAt).toBe(3_000);
    expect(effectiveTurns(turns).map((t) => t.id)).not.toContain(first.turn!.id);
    expect(effectiveTurns(turns, { includeSuperseded: true })).toHaveLength(2);
  });

  it("does not supersede when the reply has no correction marker", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "graphflow 的 MCP 传输默认是 sqlite 吗",
      assistantReply: "是的，默认 sqlite。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const next = await recordDialogueTurn(client, {
      userQuery: "graphflow 的 MCP 传输还能改吗",
      assistantReply: "可以改，在 graphPolicy.transport。",
      workspaceRoot: "/repo",
      now: 3_000,
    });
    expect(next.turn?.supersedesTurnIds ?? []).toHaveLength(0);
    const snapshot = client.readSnapshot();
    expect(snapshot.edges.filter((e) => e.relation === "supersedes")).toHaveLength(0);
  });

  it("does not supersede pending (unanswered) or off-topic turns", () => {
    const turns = [
      {
        id: "dialogue:a:0001",
        sessionId: "dialogue-session:a",
        seq: 1,
        userQuery: "graphflow 的 MCP 传输默认是 sqlite 吗",
        assistantReply: "", // pending — cannot be superseded
        jumped: false,
        relatedNodeIds: [],
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      {
        id: "dialogue:a:0002",
        sessionId: "dialogue-session:a",
        seq: 2,
        userQuery: "怎么安装 npm 依赖",
        assistantReply: "npm install 即可。",
        jumped: false,
        relatedNodeIds: [],
        createdAt: 2_000,
        updatedAt: 2_000,
      },
    ];
    const ids = detectSupersession(
      turns,
      "graphflow 的 MCP 传输到底默认是什么",
      "更正：默认 transport 是 auto。",
      3
    );
    expect(ids).toHaveLength(0);
  });

  it("skips turns already marked invalidAt and caps links at the limit", () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({
      id: `dialogue:a:000${i + 1}`,
      sessionId: "dialogue-session:a",
      seq: i + 1,
      userQuery: "graphflow mcp transport 默认值",
      assistantReply: `答案 ${i + 1}`,
      jumped: false,
      relatedNodeIds: [],
      createdAt: i * 1000,
      updatedAt: i * 1000,
      // first three already off the current chain
      ...(i < 3 ? { invalidAt: 99_000 } : {}),
    }));
    const ids = detectSupersession(
      turns,
      "graphflow mcp transport 默认值到底是什么",
      "更正：transport 默认 auto。",
      6,
      2
    );
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain("dialogue:a:0001");
    expect(ids).not.toContain("dialogue:a:0002");
    expect(ids).not.toContain("dialogue:a:0003");
  });

  it("links cross-session same_topic turns but never within the same session id chain", async () => {
    const client = new GraphifyClient();
    // session A records a turn about HNSW
    const a = await recordDialogueTurn(client, {
      userQuery: "HNSW 向量索引在 graphflow 里怎么用",
      assistantReply: "用于语义召回。",
      workspaceRoot: "/repo",
      sessionName: "a",
      now: 1_000,
    });
    // session B asks a highly overlapping question
    const b = await recordDialogueTurn(client, {
      userQuery: "HNSW 向量索引 graphflow 用了吗",
      assistantReply: "在用。",
      workspaceRoot: "/repo",
      sessionName: "b",
      now: 2_000,
    });

    const snapshot = client.readSnapshot();
    const sameTopic = snapshot.edges.filter((e) => e.relation === "same_topic");
    expect(sameTopic.length).toBeGreaterThan(0);
    expect(sameTopic).toContainEqual({
      from: b.turn!.id,
      to: a.turn!.id,
      relation: "same_topic",
    });
    // session ids stay distinct
    expect(a.session!.id).not.toBe(b.session!.id);
  });

  it("detectSameTopicLinks ranks by overlap and respects the limit", () => {
    const turns = [
      {
        id: "t1",
        sessionId: "s1",
        seq: 1,
        userQuery: "context slicer 预算压缩",
        assistantReply: "ok",
        jumped: false,
        relatedNodeIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "t2",
        sessionId: "s2",
        seq: 1,
        userQuery: "context slicer budget",
        assistantReply: "ok",
        jumped: false,
        relatedNodeIds: [],
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "t3",
        sessionId: "s3",
        seq: 1,
        userQuery: "完全无关的安装问题",
        assistantReply: "ok",
        jumped: false,
        relatedNodeIds: [],
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const links = detectSameTopicLinks(
      turns,
      { id: "t0", userQuery: "context slicer 预算 budget 压缩" },
      [],
      { limit: 2 }
    );
    expect(links).toHaveLength(2);
    const targets = links.map((l) => l.to);
    expect(targets).toContain("t1");
    expect(targets).toContain("t2");
    expect(targets).not.toContain("t3");
  });

  it("formatSupersessionLine renders the old and new conclusions", async () => {
    const client = new GraphifyClient();
    const first = await recordDialogueTurn(client, {
      userQuery: "默认传输是什么",
      assistantReply: "默认 sqlite。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const correction = await recordDialogueTurn(client, {
      userQuery: "默认传输到底是什么",
      assistantReply: "更正：默认是 auto。",
      workspaceRoot: "/repo",
      now: 2_000,
    });
    const line = formatSupersessionLine(first.turn!, correction.turn!);
    expect(line).toContain("Turn #1");
    expect(line).toContain("Turn #2");
    expect(line).toContain("已被修正");
  });

  it("keeps session ids stable so same_workspace sessions are deterministic", () => {
    expect(dialogueSessionIdFor("main", "/repo")).toBe(dialogueSessionIdFor("main", "/repo"));
    expect(dialogueSessionIdFor("a", "/repo")).not.toBe(dialogueSessionIdFor("b", "/repo"));
  });
});
