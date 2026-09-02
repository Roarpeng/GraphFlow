import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import {
  collectMemoryPackFromNodes,
  formatDialoguesMarkdown,
} from "../src/graph/memory-pack";

function dialogueTurnNode(partial: {
  id: string;
  seq: number;
  sessionId?: string;
  userQuery: string;
  assistantReply?: string;
  supersedesTurnIds?: string[];
  invalidAt?: number;
  updatedAt?: number;
  jumped?: boolean;
}): GraphNode {
  const record = {
    id: partial.id,
    sessionId: partial.sessionId ?? "dialogue-session:s1",
    seq: partial.seq,
    userQuery: partial.userQuery,
    assistantReply: partial.assistantReply ?? "",
    jumped: partial.jumped === true,
    relatedNodeIds: [],
    createdAt: partial.updatedAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    ...(partial.supersedesTurnIds ? { supersedesTurnIds: partial.supersedesTurnIds } : {}),
    ...(partial.invalidAt !== undefined ? { invalidAt: partial.invalidAt } : {}),
  };
  return {
    id: partial.id,
    type: "Decision",
    content: `dialogue-turn #${partial.seq}`,
    metadata: { kind: "dialogue-turn", record: JSON.stringify(record) },
  };
}

function agentTraceNode(partial: {
  id: string;
  turnSeq: number;
  sessionId?: string;
  label: string;
  status?: string;
  createdAt?: number;
}): GraphNode {
  const record = {
    id: partial.id,
    sessionId: partial.sessionId ?? "dialogue-session:s1",
    turnSeq: partial.turnSeq,
    agentKind: "subagent",
    label: partial.label,
    status: partial.status ?? "settled",
    createdAt: partial.createdAt ?? 2,
  };
  return {
    id: partial.id,
    type: "Decision",
    content: `agent-trace #${partial.turnSeq}`,
    metadata: { kind: "agent-trace", record: JSON.stringify(record) },
  };
}

describe("memory pack dialogue subgraph export (Conversation Graph W4b)", () => {
  it("collects dialogue turns (superseded included) and agent traces", () => {
    const nodes: GraphNode[] = [
      dialogueTurnNode({
        id: "dialogue:s1:0001",
        seq: 1,
        userQuery: "默认传输是什么",
        assistantReply: "默认 sqlite。",
        invalidAt: 5_000,
        updatedAt: 1_000,
      }),
      dialogueTurnNode({
        id: "dialogue:s1:0002",
        seq: 2,
        userQuery: "默认传输到底是什么",
        assistantReply: "更正：默认 auto。",
        supersedesTurnIds: ["dialogue:s1:0001"],
        updatedAt: 5_000,
      }),
      agentTraceNode({ id: "agent-trace:s1:0002:abc", turnSeq: 2, label: "in-process:research", createdAt: 4_000 }),
      { id: "file:src/a.ts", type: "File", content: "export const a = 1" },
    ];

    const pack = collectMemoryPackFromNodes(nodes);
    expect(pack.dialogues).toHaveLength(2);
    // newest first
    expect(pack.dialogues[0]!.id).toBe("dialogue:s1:0002");
    expect(pack.dialogues[0]!.supersedesTurnIds).toEqual(["dialogue:s1:0001"]);
    expect(pack.dialogues[1]!.invalidAt).toBe(5_000);
    expect(pack.traces).toHaveLength(1);
    expect(pack.traces[0]!.label).toBe("in-process:research");
  });

  it("respects the dialogue limit and skips malformed records", () => {
    const nodes: GraphNode[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        dialogueTurnNode({
          id: `dialogue:s1:000${i + 1}`,
          seq: i + 1,
          userQuery: `问题 ${i + 1}`,
          updatedAt: i + 1,
        })
      ),
      {
        id: "dialogue:bad:0001",
        type: "Decision",
        content: "dialogue-turn",
        metadata: { kind: "dialogue-turn", record: "{not json" },
      },
      {
        id: "agent-trace:bad:0001",
        type: "Decision",
        content: "agent-trace",
        metadata: { kind: "agent-trace", record: JSON.stringify({ id: 42 }) },
      },
    ];
    const pack = collectMemoryPackFromNodes(nodes, { dialogueLimit: 3 });
    expect(pack.dialogues).toHaveLength(3);
    expect(pack.traces).toHaveLength(0);
  });

  it("formatDialoguesMarkdown renders session groups, correction marks, and traces", () => {
    const md = formatDialoguesMarkdown({
      dialogues: [
        {
          id: "dialogue:s1:0001",
          sessionId: "dialogue-session:s1",
          seq: 1,
          userQuery: "默认传输是什么",
          assistantReply: "默认 sqlite。",
          jumped: false,
          invalidAt: 5_000,
          updatedAt: 1_000,
        },
        {
          id: "dialogue:s1:0002",
          sessionId: "dialogue-session:s1",
          seq: 2,
          userQuery: "默认传输到底是什么",
          assistantReply: "更正：默认 auto。",
          jumped: false,
          supersedesTurnIds: ["dialogue:s1:0001"],
          updatedAt: 5_000,
        },
      ],
      traces: [
        {
          id: "agent-trace:s1:0002:abc",
          sessionId: "dialogue-session:s1",
          turnSeq: 2,
          agentKind: "subagent",
          label: "in-process:research",
          status: "settled",
          createdAt: 4_000,
        },
      ],
    });
    expect(md).toContain("## Session `dialogue-session:s1`");
    expect(md).toContain("superseded");
    expect(md).toContain("corrects earlier");
    expect(md).toContain("更正：默认 auto。");
    expect(md).toContain("Agent traces");
    expect(md).toContain("in-process:research");
  });

  it("renders the empty state when the graph has no dialogue/traces", () => {
    const md = formatDialoguesMarkdown({ dialogues: [], traces: [] });
    expect(md).toContain("No dialogue-turn");
  });
});
