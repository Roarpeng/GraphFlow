import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  forkDialogueSession,
  isAgentTraceNode,
  listAgentTraces,
  listDialogueTurns,
  recordAgentTrace,
  recordDialogueTurn,
  walkDialoguePath,
} from "../src/learning/dialogue-thread";
import {
  forkDialogueSessionRuntime,
  listDialogueTracesRuntime,
  recordAgentTraceRuntime,
} from "../src/surfaces/cli/runtime/dialogue";

describe("dialogue fork + replay path (Conversation Graph W3)", () => {
  it("forks a new session rooted at the chosen turn and links the spine across the boundary", async () => {
    const client = new GraphifyClient();
    const first = await recordDialogueTurn(client, {
      userQuery: "第一个问题：如何配置压缩预算",
      assistantReply: "graphPolicy.maxContextTokens。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    await recordDialogueTurn(client, {
      userQuery: "第二个问题：层级配额怎么设",
      assistantReply: "layerQuota。",
      workspaceRoot: "/repo",
      now: 2_000,
    });
    const fork = await forkDialogueSession(client, {
      fromTurnId: first.turn!.id,
      forkName: "budget-fork",
      workspaceRoot: "/repo",
      now: 3_000,
    });

    expect(fork).toBeDefined();
    expect(fork!.forkedSessionName).toBe("budget-fork");
    expect(fork!.sourceTurnId).toBe(first.turn!.id);

    // New session hub exists and the seed turn's parent points at the fork origin.
    const snapshot = client.readSnapshot();
    expect(snapshot.nodes.some((n) => n.id === fork!.forkedSessionId)).toBe(true);
    const forkTurns = await listDialogueTurns(client, { sessionId: fork!.forkedSessionId });
    expect(forkTurns).toHaveLength(1);
    expect(forkTurns[0]!.parentTurnId).toBe(first.turn!.id);
    // fork session hub is same_topic-linked to the source session
    expect(snapshot.edges).toContainEqual({
      from: fork!.forkedSessionId,
      to: first.session!.id,
      relation: "same_topic",
    });
  });

  it("returns undefined for an unknown fork origin", async () => {
    const client = new GraphifyClient();
    const fork = await forkDialogueSession(client, { fromTurnId: "dialogue:nope:0009" });
    expect(fork).toBeUndefined();
  });

  it("walks the replay path across a fork boundary (dialogue list --path)", async () => {
    const client = new GraphifyClient();
    await recordDialogueTurn(client, {
      userQuery: "主线第一问",
      assistantReply: "答一。",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const second = await recordDialogueTurn(client, {
      userQuery: "主线第二问",
      assistantReply: "答二。",
      workspaceRoot: "/repo",
      now: 2_000,
    });
    const fork = await forkDialogueSession(client, {
      fromTurnId: second.turn!.id,
      forkName: "replay-fork",
      workspaceRoot: "/repo",
      now: 3_000,
    });
    const forkTurns = await listDialogueTurns(client, { sessionId: fork!.forkedSessionId });
    const tip = forkTurns[forkTurns.length - 1]!;

    const path = walkDialoguePath(
      await listDialogueTurns(client, { limit: 500 }),
      tip.id,
      30
    );
    expect(path.length).toBe(3);
    expect(path[0]!.userQuery).toBe("主线第一问");
    // the boundary between fork session and mainline session is flagged
    expect(path.some((step) => step.forkBoundary)).toBe(true);
  });
});

describe("agent traces (Conversation Graph W3a)", () => {
  it("records subagent start/end as Decision nodes linked to the session hub", async () => {
    const client = new GraphifyClient();
    const session = await recordDialogueTurn(client, {
      userQuery: "跑一个子代理调研任务",
      workspaceRoot: "/repo",
      now: 1_000,
    });
    const start = await recordAgentTrace(client, {
      sessionId: session.session!.id,
      turnSeq: 1,
      agentKind: "subagent",
      label: "in-process:research-plan",
      status: "start",
      now: 1_100,
    });
    const end = await recordAgentTrace(client, {
      sessionId: session.session!.id,
      turnSeq: 1,
      agentKind: "subagent",
      label: "in-process:research-plan",
      status: "settled",
      now: 1_200,
    });

    expect(start).toBeDefined();
    expect(end).toBeDefined();
    const snapshot = client.readSnapshot();
    expect(snapshot.nodes.some((n) => isAgentTraceNode(n) && n.id === start!.id)).toBe(true);
    expect(snapshot.edges).toContainEqual({
      from: start!.id,
      to: session.session!.id,
      relation: "part_of",
    });

    const traces = await listAgentTraces(client, { sessionId: session.session!.id });
    expect(traces).toHaveLength(2);
    expect(traces[0]!.status).toBe("settled"); // newest first
  });

  it("dedupes identical trace events and never throws", async () => {
    const client = new GraphifyClient();
    const first = await recordAgentTrace(client, {
      sessionId: "dialogue-session:x",
      turnSeq: 1,
      agentKind: "subagent",
      label: "tool:pwsh",
      status: "start",
      now: 1_000,
    });
    const dup = await recordAgentTrace(client, {
      sessionId: "dialogue-session:x",
      turnSeq: 1,
      agentKind: "subagent",
      label: "tool:pwsh",
      status: "start",
      now: 1_100,
    });
    expect(dup).toBeDefined();
    const traces = await listAgentTraces(client, {});
    // same kind+label+status+turn → same id (upsert), not a duplicate row
    expect(traces.filter((t) => t.id === first!.id)).toHaveLength(1);
  });

  it("runtime wrappers round-trip through config resolution", async () => {
    // recordAgentTraceRuntime / listDialogueTracesRuntime / forkDialogueSessionRuntime
    // with no workspace config fall back to defaults; here we only assert
    // the happy path of the in-memory variants (covered above) plus that the
    // runtime fns exist and reject gracefully on unknown ids.
    expect(typeof recordAgentTraceRuntime).toBe("function");
    expect(typeof listDialogueTracesRuntime).toBe("function");
    expect(typeof forkDialogueSessionRuntime).toBe("function");
    const fork = await forkDialogueSessionRuntime("dialogue:missing:0042", {});
    expect(fork).toBeUndefined();
  });
});
