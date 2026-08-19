import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  activateTopic,
  appendTopicMessage,
  buildWorkbenchOutlines,
  formatWorkbenchOutlineLines,
  formatWorkbenchPrompt,
  loadWorkbenchContext,
  seedWorkbenchFromPlan,
} from "../src/learning/workbench-topic";

const TASK = "KUKA 与西门子 PLC 做 IO 映射并支持 EtherCAT 回零";

const STEPS = [
  { id: "task-1", description: "分析 IO 映射需求", dependencies: [] },
  { id: "task-2", description: "实现 GVL 与 IO 表", dependencies: ["task-1"] },
  { id: "task-3", description: "验证 EtherCAT 回零", dependencies: ["task-2"] },
];

describe("workbench topic containers", () => {
  it("seeds a mainline canvas from the plan DAG", async () => {
    const client = new GraphifyClient();
    const seeded = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: "/repo",
      now: 1_000,
    });

    expect(seeded.topics).toHaveLength(3);
    expect(seeded.topics.every((topic) => topic.mainline && !topic.isolated)).toBe(true);
    expect(seeded.root.activeTopicId).toBe(seeded.topics[0]?.id);

    const snapshot = client.readSnapshot();
    expect(snapshot.edges).toContainEqual({
      from: seeded.topics[1]!.id,
      to: seeded.topics[0]!.id,
      relation: "depends_on",
    });
    expect(snapshot.edges.filter((edge) => edge.relation === "part_of")).toHaveLength(3);
  });

  it("keeps refinement messages inside the clicked topic instead of creating a new node", async () => {
    const client = new GraphifyClient();
    const seeded = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const ioTopic = seeded.topics[1]!;

    const first = await appendTopicMessage(client, {
      query: "GVL 里数字量输入怎么命名",
      topicId: ioTopic.id,
      now: 2_000,
    });
    const second = await appendTopicMessage(client, {
      query: "再补一列诊断地址",
      topicId: ioTopic.id,
      assistantReply: "在 GVL 增加 diagAddr。",
      now: 3_000,
    });

    expect(first?.forked).toBe(false);
    expect(second?.forked).toBe(false);
    expect(second?.topic.id).toBe(ioTopic.id);
    expect(second?.topic.messages).toHaveLength(3);
    expect(client.readSnapshot().nodes.filter((node) => node.id.startsWith("topic:")).length).toBe(3);
  });

  it("fills the pending assistant reply without duplicating the user question", async () => {
    const client = new GraphifyClient();
    const seeded = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const asked = await appendTopicMessage(client, {
      query: "GVL 里数字量输入怎么命名",
      topicId: seeded.topics[1]!.id,
      now: 2_000,
    });
    expect(asked?.topic.messages).toHaveLength(1);
    expect(asked?.filled).toBe(false);

    const filled = await appendTopicMessage(client, {
      query: "GVL 里数字量输入怎么命名",
      assistantReply: "建议 DI_ + 槽位号，原文不要改成摘要。",
      topicId: seeded.topics[1]!.id,
      now: 2_500,
    });
    expect(filled?.filled).toBe(true);
    expect(filled?.forked).toBe(false);
    expect(filled?.topic.messages).toHaveLength(2);
    expect(filled?.topic.messages[1]?.role).toBe("assistant");
    expect(filled?.topic.messages[1]?.content).toContain("DI_");

    const replyOnly = await appendTopicMessage(client, {
      assistantReply: "补充：保持与 IO 表列名一致。",
      topicId: seeded.topics[1]!.id,
      now: 2_800,
    });
    expect(replyOnly).toBeUndefined();

    const nextQ = await appendTopicMessage(client, {
      query: "诊断地址放哪一列",
      topicId: seeded.topics[1]!.id,
      now: 3_000,
    });
    const nextA = await appendTopicMessage(client, {
      assistantReply: "放在 diagAddr 列，保留原文。",
      topicId: seeded.topics[1]!.id,
      now: 3_100,
    });
    expect(nextQ?.topic.messages).toHaveLength(3);
    expect(nextA?.filled).toBe(true);
    expect(nextA?.topic.messages).toHaveLength(4);
    expect(nextA?.topic.messages[3]?.content).toContain("diagAddr");
  });

  it("forks an isolated side node when the question drifts off the mainline topic", async () => {
    const client = new GraphifyClient();
    const seeded = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: "/repo",
      now: 1_000,
    });
    await appendTopicMessage(client, {
      query: "IO 映射的 BYTE 偏移怎么对齐",
      topicId: seeded.topics[1]!.id,
      now: 2_000,
    });

    const drifted = await appendTopicMessage(client, {
      query: "鱼缸青苔怎么治理比较彻底",
      now: 3_000,
    });

    expect(drifted?.forked).toBe(true);
    expect(drifted?.topic.isolated).toBe(true);
    expect(drifted?.topic.mainline).toBe(false);
    expect(drifted?.topic.id).not.toBe(seeded.topics[1]!.id);

    const snapshot = client.readSnapshot();
    expect(snapshot.edges).toContainEqual({
      from: drifted!.topic.id,
      to: seeded.topics[1]!.id,
      relation: "co_occurs",
    });
  });

  it("clicking a mainline topic restores the trunk context", async () => {
    const client = new GraphifyClient();
    const seeded = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: "/repo",
      now: 1_000,
    });
    await appendTopicMessage(client, {
      query: "先把 IO 表列出来",
      topicId: seeded.topics[1]!.id,
      now: 2_000,
    });
    await appendTopicMessage(client, {
      query: "Ubuntu 虚拟机磁盘怎么扩容",
      now: 3_000,
    });

    const restored = await activateTopic(client, seeded.topics[1]!.id, 4_000);
    expect(restored?.id).toBe(seeded.topics[1]!.id);
    expect(restored?.isolated).toBe(false);

    const view = await loadWorkbenchContext(client, restored!.id);
    expect(view?.isolated).toBe(false);
    expect(view?.active.messages.some((message) => message.content.includes("IO 表"))).toBe(true);
    const lines = formatWorkbenchPrompt(view!);
    expect(lines.some((line) => line.startsWith("Active: 主线"))).toBe(true);
    expect(lines.some((line) => line.includes("topicId"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Q:") && line.includes("IO 表"))).toBe(true);
    expect(lines.some((line) => /^Summary:/.test(line))).toBe(false);
  });

  it("builds an on-demand outline tree from the plan DAG with side branches nested", async () => {
    const client = new GraphifyClient();
    const seeded = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: "/repo",
      now: 1_000,
    });
    await appendTopicMessage(client, {
      query: "先把 IO 表列出来",
      topicId: seeded.topics[1]!.id,
      now: 2_000,
    });
    const drifted = await appendTopicMessage(client, {
      query: "Ubuntu 虚拟机磁盘怎么扩容",
      now: 3_000,
    });

    const snapshot = client.readSnapshot();
    const outlines = buildWorkbenchOutlines(snapshot.nodes, snapshot.edges);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]?.nodes.map((node) => node.title)).toEqual([
      "分析 IO 映射需求",
      "实现 GVL 与 IO 表",
      "验证 EtherCAT 回零",
    ]);
    const ioNode = outlines[0]?.nodes.find((node) => node.id === seeded.topics[1]!.id);
    expect(ioNode?.kind).toBe("mainline");
    expect(ioNode?.children).toHaveLength(1);
    expect(ioNode?.children[0]?.kind).toBe("side");
    expect(ioNode?.children[0]?.id).toBe(drifted?.topic.id);
    expect(ioNode?.children[0]?.active).toBe(true);

    const lines = formatWorkbenchOutlineLines(outlines);
    expect(lines.some((line) => line.startsWith("Workbench:"))).toBe(true);
    expect(lines.some((line) => line.includes("旁支") && line.includes("Ubuntu"))).toBe(true);
    expect(lines.some((line) => line.includes("topicId"))).toBe(true);
  });
});
