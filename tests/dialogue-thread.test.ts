import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  dialogueSessionIdFor,
  formatDialogueThreadLines,
  isDialogueTurnNode,
  listDialogueTurns,
  loadDialogueThread,
  parseDialogueTurn,
  recordDialogueTurn,
  scoreTopicOverlap,
} from "../src/learning/dialogue-thread";

describe("dialogue-thread knowledge graph", () => {
  it("records a user question as a Decision node linked to a session hub", async () => {
    const client = new GraphifyClient();
    const result = await recordDialogueTurn(client, {
      userQuery: "GraphFlow 还能保证确定性输入吗？",
      workspaceRoot: "/repo",
      now: 1_000,
    });

    expect(result.recorded).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.jumped).toBe(false);
    expect(result.turn?.seq).toBe(1);
    expect(result.turn?.userQuery).toContain("确定性输入");
    expect(result.session?.turnCount).toBe(1);

    const snapshot = client.readSnapshot();
    const turnNode = snapshot.nodes.find((node) => node.id === result.turn?.id);
    expect(turnNode?.type).toBe("Decision");
    expect(isDialogueTurnNode(turnNode!)).toBe(true);
    expect(snapshot.edges).toContainEqual({
      from: result.turn!.id,
      to: result.session!.id,
      relation: "part_of",
    });
  });

  it("chains sequential turns with next_section even when the topic jumps", async () => {
    const client = new GraphifyClient();
    const first = await recordDialogueTurn(client, {
      userQuery: "确定性输入还能保证吗",
      assistantReply: "索引层可以，打包层不能保证。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const second = await recordDialogueTurn(client, {
      userQuery: "把每次对话提炼成知识图谱节点，防止偏离主线",
      workspaceRoot: "/repo",
      now: 2_000,
    });

    expect(second.turn?.parentTurnId).toBe(first.turn?.id);
    expect(second.turn?.seq).toBe(2);

    const snapshot = client.readSnapshot();
    expect(snapshot.edges).toContainEqual({
      from: first.turn!.id,
      to: second.turn!.id,
      relation: "next_section",
    });
  });

  it("links a click-to-resume jump to the chosen turn and still keeps the session connected", async () => {
    const client = new GraphifyClient();
    const first = await recordDialogueTurn(client, {
      userQuery: "什么是 near-lossless 压缩",
      assistantReply: "元数据投影，不是源码正文。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const second = await recordDialogueTurn(client, {
      userQuery: "HNSW 还在用吗",
      assistantReply: "已经改成线性扫描。",
      workspaceRoot: "/repo",
      now: 2_000,
    });
    const branched = await recordDialogueTurn(client, {
      userQuery: "那 File 锚点展开为什么没有正文",
      resumeFromTurnId: first.turn!.id,
      workspaceRoot: "/repo",
      now: 3_000,
    });

    expect(branched.jumped).toBe(true);
    expect(branched.turn?.parentTurnId).toBe(first.turn?.id);
    expect(branched.turn?.seq).toBe(3);

    const snapshot = client.readSnapshot();
    expect(snapshot.edges).toContainEqual({
      from: first.turn!.id,
      to: branched.turn!.id,
      relation: "next_section",
    });
    expect(snapshot.edges).toContainEqual({
      from: second.turn!.id,
      to: branched.turn!.id,
      relation: "co_occurs",
    });
    expect(snapshot.edges.filter((edge) => edge.to === branched.session!.id && edge.relation === "part_of")).toHaveLength(
      3
    );
  });

  it("dedupes the same question in the window and fills in the LLM reply later", async () => {
    const client = new GraphifyClient();
    const pending = await recordDialogueTurn(client, {
      userQuery: "如何把对话写成图谱节点",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const filled = await recordDialogueTurn(client, {
      userQuery: "如何把对话写成图谱节点",
      assistantReply: "Decision + dialogue-turn，next_section 串主线。",
      workspaceRoot: "/repo",
      now: 1_500,
    });

    expect(filled.reused).toBe(true);
    expect(filled.turn?.id).toBe(pending.turn?.id);
    expect(filled.turn?.assistantReply).toContain("dialogue-turn");
    expect(filled.session?.turnCount).toBe(1);

    const turns = await listDialogueTurns(client, { sessionId: pending.session!.id });
    expect(turns).toHaveLength(1);
    expect(parseDialogueTurn(client.readSnapshot().nodes.find((node) => node.id === turns[0]!.id)!)?.assistantReply).toContain(
      "next_section"
    );
  });

  it("fills the pending tip when only assistantReply is provided", async () => {
    const client = new GraphifyClient();
    const pending = await recordDialogueTurn(client, {
      userQuery: "对话入图怎么把回答补回去",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const filled = await recordDialogueTurn(client, {
      userQuery: "",
      assistantReply: "用原文回答回填 pending turn，不要写 80 字摘要。",
      workspaceRoot: "/repo",
      now: 1_200,
    });

    expect(filled.reused).toBe(true);
    expect(filled.turn?.id).toBe(pending.turn?.id);
    expect(filled.turn?.assistantReply).toContain("原文回答");
    expect(filled.session?.turnCount).toBe(1);
  });

  it("skips tiny queries and keeps session ids stable for the same workspace", async () => {
    const client = new GraphifyClient();
    const skipped = await recordDialogueTurn(client, { userQuery: "hi", workspaceRoot: "/repo" });
    expect(skipped.recorded).toBe(false);
    expect(skipped.skipped).toBe("query-too-short");

    expect(dialogueSessionIdFor("main", "/repo")).toBe(dialogueSessionIdFor("main", "/repo"));
    expect(dialogueSessionIdFor("main", "/repo")).not.toBe(dialogueSessionIdFor("main", "/other"));
  });

  it("injects a compact thread spine for the next model call", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "确定性输入",
      assistantReply: "不能保证全文确定。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    await recordDialogueTurn(client, {
      userQuery: "做成对话图谱节点",
      workspaceRoot: "/repo",
      now: 2_000,
    });

    const thread = await loadDialogueThread(client, { workspaceRoot: "/repo" });
    expect(thread?.turns).toHaveLength(2);
    const lines = formatDialogueThreadLines(thread!);
    expect(lines[0]).toMatch(/^Thread:/);
    expect(lines.some((line) => line.includes("Turn #1"))).toBe(true);
    expect(lines.some((line) => line.includes("resumeFromTurnId"))).toBe(true);
  });

  it("scores topic overlap so jumps are visible without being blocked", () => {
    expect(scoreTopicOverlap(["deterministic", "context"], "deterministic context package")).toBeGreaterThan(0.5);
    expect(scoreTopicOverlap(["deterministic", "context"], "install robotic arm firmware")).toBe(0);
  });
});
