import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import {
  MAX_ECHO_TURN_CHARS,
  dialogueSessionIdFor,
  dialogueTurnIdFor,
  recordDialogueTurn,
  toDialogueThreadEchoView,
  type DialogueThreadView,
} from "../src/learning/dialogue-thread";
import {
  MAX_ECHO_MESSAGE_CHARS,
  appendTopicMessage,
  loadWorkbenchContext,
  seedWorkbenchFromPlan,
  toWorkbenchEchoView,
  type WorkbenchContextView,
} from "../src/learning/workbench-topic";
import {
  estimateSummaryLinesTokens,
  estimateUnbudgetedPayloadTokens,
  expandAnchor,
  previewContext,
} from "../src/surfaces/cli/runtime/graph";
import { calculateSavingsPercent } from "../src/surfaces/cli/runtime/helpers";
import type { ContextPreviewResult } from "../src/surfaces/cli/runtime/types";

/**
 * 回显瘦身 + 打包外负载如实记账 / Response-echo slimming and honest accounting.
 *
 * `graphflow_context` used to echo the active workbench topic's full messages
 * (40 × 4000 stored chars, worst case ~160KB) and the dialogue thread's full
 * turns verbatim, while counting none of it in the token budget. These tests
 * pin the fixed contract: the response carries a bounded echo view (ids and
 * structural marks verbatim, text clipped to previews), promptLines stay
 * budgeted summary lines, and the echo payload is measured into
 * `unbudgetedTokens` / `accountedTokens` exactly as sent.
 */

const TASK = "KUKA 与西门子 PLC 做 IO 映射并支持 EtherCAT 回零";
const STEPS = [
  { id: "task-1", description: "分析 IO 映射需求", dependencies: [] },
  { id: "task-2", description: "实现 GVL 与 IO 表", dependencies: ["task-1"] },
  { id: "task-3", description: "验证 EtherCAT 回零", dependencies: ["task-2"] },
];

const LONG_QUERY = `Q细节${"占位正文".repeat(900)}`; // ~3600 chars, clipped everywhere it is echoed
const LONG_REPLY = `A结论${"回复正文".repeat(900)}`;

function writeTempConfig(root: string): string {
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          enableNearLosslessMode: true,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          autoIndexOnSave: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: join(root, "graph-store.json"),
          maxContextTokens: 400,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
}

/** Unbudgeted payload the response actually carried, excluding already-budgeted promptLines. */
function echoUnbudgeted(echo: { promptLines: string[] }): number {
  return estimateUnbudgetedPayloadTokens([{ ...echo, promptLines: [] }]);
}

/** All unbudgeted payloads of a preview (echo view + dialogue hits, when present). */
function expectedUnbudgeted(preview: ContextPreviewResult): number {
  let total = 0;
  if (preview.workbench) total += echoUnbudgeted(preview.workbench);
  if (preview.dialogueThread) {
    // Spine-injected promptLines are budgeted; otherwise they ride in the view.
    const spineInjected = preview.summary.some((line) => line.startsWith("Thread:"));
    total += spineInjected
      ? echoUnbudgeted(preview.dialogueThread)
      : estimateUnbudgetedPayloadTokens([preview.dialogueThread]);
  }
  if (preview.dialogueHits) total += estimateUnbudgetedPayloadTokens(preview.dialogueHits);
  return total;
}

describe("workbench echo view slimming (pure)", () => {
  it("clips messages to previews with a truncated marker and keeps ids verbatim", () => {
    const view: WorkbenchContextView = {
      rootId: "workbench:abc",
      task: `任务${"很长".repeat(200)}`,
      active: {
        id: "topic:abc:task-2",
        rootId: "workbench:abc",
        title: "实现 GVL 与 IO 表",
        description: `描述${"很长".repeat(200)}`,
        mainline: true,
        isolated: false,
        planStepId: "task-2",
        messages: [
          { role: "user", content: "短问题保持原样", at: 1_000 },
          { role: "assistant", content: LONG_REPLY, at: 1_100 },
        ],
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      ancestors: [
        { id: "topic:abc:task-1", title: "分析 IO 映射需求", description: "祖先描述不回显" },
      ],
      isolated: false,
      promptLines: ["Workbench: demo", "Active: 主线"],
    };

    const echo = toWorkbenchEchoView(view);

    // Structural ids and marks survive verbatim (topicId navigation).
    expect(echo.rootId).toBe("workbench:abc");
    expect(echo.active.id).toBe("topic:abc:task-2");
    expect(echo.active.mainline).toBe(true);
    expect(echo.active.isolated).toBe(false);
    expect(echo.active.createdAt).toBe(1_000);
    expect(echo.active.updatedAt).toBe(2_000);
    // planStepId is internal wiring and is not echoed.
    expect("planStepId" in echo.active).toBe(false);
    // Long text fields are clipped previews.
    expect(echo.task.length).toBeLessThanOrEqual(200);
    expect(echo.active.description.length).toBeLessThanOrEqual(200);
    // Messages: short one untouched and unmarked, long one clipped + truncated.
    expect(echo.active.messages[0]).toEqual({ role: "user", content: "短问题保持原样", at: 1_000 });
    expect(echo.active.messages[1]!.content.length).toBeLessThanOrEqual(MAX_ECHO_MESSAGE_CHARS);
    expect(echo.active.messages[1]!.content.startsWith("A结论")).toBe(true);
    expect(echo.active.messages[1]!.truncated).toBe(true);
    // Ancestors keep only {id, title}.
    expect(echo.ancestors).toEqual([{ id: "topic:abc:task-1", title: "分析 IO 映射需求" }]);
    expect(echo.promptLines).toEqual(["Workbench: demo", "Active: 主线"]);
    // Pure: the input view is never mutated.
    expect(view.active.messages[1]!.content).toBe(LONG_REPLY);
    expect(view.active.description.length).toBeGreaterThan(200);
  });
});

describe("dialogue thread echo view slimming (pure)", () => {
  it("keeps turn id/seq/jumped verbatim and clips Q/A to previews", () => {
    const thread: DialogueThreadView = {
      sessionId: "dialogue-session:s1",
      sessionName: "main",
      tipTurnId: "dialogue:s1:0002",
      jumped: false,
      overlap: 0.55,
      turns: [
        {
          id: "dialogue:s1:0001",
          sessionId: "dialogue-session:s1",
          seq: 1,
          userQuery: "短问题保持原样",
          assistantReply: "短回答保持原样",
          jumped: false,
          relatedNodeIds: [],
          createdAt: 1_000,
          updatedAt: 1_000,
        },
        {
          id: "dialogue:s1:0002",
          sessionId: "dialogue-session:s1",
          seq: 2,
          userQuery: LONG_QUERY,
          assistantReply: LONG_REPLY,
          jumped: true,
          relatedNodeIds: [],
          createdAt: 2_000,
          updatedAt: 2_000,
        },
      ],
      promptLines: ["Thread: main turns=2"],
    };

    const echo = toDialogueThreadEchoView(thread);

    expect(echo.sessionId).toBe("dialogue-session:s1");
    expect(echo.sessionName).toBe("main");
    expect(echo.tipTurnId).toBe("dialogue:s1:0002");
    expect(echo.jumped).toBe(false);
    expect(echo.overlap).toBe(0.55);
    // resumeFromTurnId depends on verbatim turn ids; seq/jumped marks survive.
    expect(echo.turns.map((turn) => turn.id)).toEqual(["dialogue:s1:0001", "dialogue:s1:0002"]);
    expect(echo.turns.map((turn) => turn.seq)).toEqual([1, 2]);
    expect(echo.turns.map((turn) => turn.jumped)).toEqual([false, true]);
    // Short turn untouched and unmarked.
    expect(echo.turns[0]).toEqual({
      id: "dialogue:s1:0001",
      seq: 1,
      jumped: false,
      userQuery: "短问题保持原样",
      assistantReply: "短回答保持原样",
    });
    expect("truncated" in echo.turns[0]!).toBe(false);
    // Long turn clipped on both sides and marked.
    expect(echo.turns[1]!.userQuery.length).toBeLessThanOrEqual(MAX_ECHO_TURN_CHARS);
    expect(echo.turns[1]!.assistantReply.length).toBeLessThanOrEqual(MAX_ECHO_TURN_CHARS);
    expect(echo.turns[1]!.truncated).toBe(true);
    expect(echo.promptLines).toEqual(["Thread: main turns=2"]);
    // Pure: the input thread is never mutated.
    expect(thread.turns[1]!.userQuery).toBe(LONG_QUERY);
  });
});

describe("previewContext workbench echo: bounded payload, honest accounting", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-m105-workbench-"));
  const configPath = writeTempConfig(root);
  let topicId = "";

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("seeds a 40-message topic whose full text stays in the store", async () => {
    const client = createGraphClient(resolveConfig(configPath));
    const seeded = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: root,
      now: 1_000,
    });
    topicId = seeded.topics[1]!.id;

    // 20 Q/A pairs = 40 stored messages, each side ~3600 chars.
    for (let i = 0; i < 20; i += 1) {
      await appendTopicMessage(client, {
        query: `第${i}问 ${LONG_QUERY}`,
        topicId,
        now: 2_000 + i * 10,
      });
      await appendTopicMessage(client, {
        assistantReply: `第${i}答 ${LONG_REPLY}`,
        topicId,
        now: 2_001 + i * 10,
      });
    }

    const stored = await loadWorkbenchContext(client, topicId);
    expect(stored?.active.messages).toHaveLength(40);
    expect(stored!.active.messages.every((message) => message.content.length > 3_000)).toBe(true);
  });

  it("echoes a bounded preview and accounts the echo payload as unbudgeted", async () => {
    // The preview query itself becomes the newest echoed message — keep it
    // long so every echoed message in this test is a clipped preview.
    const preview = await previewContext(
      `IO 映射 GVL 列名 ${LONG_QUERY}`,
      configPath,
      root,
      undefined,
      { topicId }
    );

    expect(preview.workbench).toBeDefined();
    const echo = preview.workbench!;
    // Bounded echo: 40 previews × ≤160 chars + envelope stays far below the
    // ~160KB full-text worst case (raw stored text is >120KB on its own).
    const echoJson = JSON.stringify(echo);
    expect(echoJson.length).toBeLessThan(16 * 1024);
    const rawJson = JSON.stringify(
      (await loadWorkbenchContext(createGraphClient(resolveConfig(configPath)), topicId))!.active
        .messages
    );
    expect(rawJson.length).toBeGreaterThan(10 * echoJson.length);

    // Slim shape: every echoed message is a clipped preview marked truncated.
    expect(echo.active.id).toBe(topicId);
    expect(echo.active.messages.length).toBeGreaterThan(0);
    for (const message of echo.active.messages) {
      expect(message.content.length).toBeLessThanOrEqual(MAX_ECHO_MESSAGE_CHARS);
      expect(message.truncated).toBe(true);
    }

    // promptLines are still budgeted summary lines (prepended, counted).
    expect(preview.summary.slice(0, echo.promptLines.length)).toEqual(echo.promptLines);
    expect(estimateSummaryLinesTokens(echo.promptLines)).toBeGreaterThan(0);
    expect(preview.tokenEstimate).toBe(preview.tokenBudget.compressedTokens);
    expect(preview.tokenBudget.compressedTokens).toBeGreaterThanOrEqual(
      estimateSummaryLinesTokens(echo.promptLines)
    );

    // The echo view rides outside the package and is measured exactly as sent
    // (promptLines excluded from the measurement — they are already budgeted).
    expect(preview.unbudgetedTokens).toBe(expectedUnbudgeted(preview));
    expect(preview.unbudgetedTokens!).toBeGreaterThan(0);
    // True total = budgeted + unbudgeted; raw keeps its floor; savings use it.
    expect(preview.accountedTokens).toBe(
      preview.tokenBudget.compressedTokens + preview.unbudgetedTokens!
    );
    expect(preview.tokenBudget.estimatedRawTokens).toBeGreaterThanOrEqual(
      preview.accountedTokens!
    );
    expect(preview.tokenBudget.estimatedSavingsPercent).toBe(
      calculateSavingsPercent(preview.tokenBudget.estimatedRawTokens, preview.accountedTokens!)
    );
    // Strictly less optimistic than savings computed against the budgeted part only.
    expect(preview.tokenBudget.estimatedSavingsPercent).toBeLessThan(
      calculateSavingsPercent(
        preview.tokenBudget.estimatedRawTokens,
        preview.tokenBudget.compressedTokens
      )
    );
  });

  it("expandAnchor echoes the slim workbench view too", async () => {
    const expanded = await expandAnchor(topicId, configPath, root);
    expect(expanded).toBeDefined();
    const echo = expanded!.metadata?.workbench as ReturnType<typeof toWorkbenchEchoView>;
    expect(echo).toBeDefined();
    expect(echo.active.id).toBe(topicId);
    expect(echo.active.messages.length).toBeGreaterThan(0);
    for (const message of echo.active.messages) {
      expect(message.content.length).toBeLessThanOrEqual(MAX_ECHO_MESSAGE_CHARS);
      expect(message.truncated).toBe(true);
    }
    expect(JSON.stringify(echo).length).toBeLessThan(16 * 1024);
    // expanded.content still joins the promptLines unchanged.
    expect(expanded!.content).toContain("Workbench:");
    expect(expanded!.content).toContain("Active:");
  });
});

describe("previewContext dialogue thread echo: slim turns, honest accounting", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-m105-dialogue-"));
  const configPath = writeTempConfig(root);
  const sessionId = dialogueSessionIdFor("main", root);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("seeds two long dialogue turns", async () => {
    const client = createGraphClient(resolveConfig(configPath));
    await recordDialogueTurn(client, {
      userQuery: `第一问 ${LONG_QUERY}`,
      assistantReply: `第一答 ${LONG_REPLY}`,
      workspaceRoot: root,
      now: 1_000,
    });
    await recordDialogueTurn(client, {
      userQuery: `第二问 ${LONG_QUERY}`,
      assistantReply: `第二答 ${LONG_REPLY}`,
      workspaceRoot: root,
      now: 2_000,
    });
  });

  it("echoes slim turns (ids verbatim) and accounts the echo view", async () => {
    // recordDialogue stays ON: with `recordDialogue: false` the preview skips
    // the whole workbench/dialogue-thread attach stage. The query itself
    // becomes turn #3, so keep it long — every echoed turn is a clipped preview.
    const preview = await previewContext(
      `第二问讲什么 ${LONG_QUERY}`,
      configPath,
      root,
      undefined
    );

    expect(preview.workbench).toBeUndefined();
    expect(preview.dialogueThread).toBeDefined();
    const echo = preview.dialogueThread!;

    // resumeFromTurnId depends on verbatim ids; seq/jumped survive. The
    // preview itself recorded the long query as turn #3.
    expect(echo.turns.map((turn) => turn.id)).toEqual([
      dialogueTurnIdFor(sessionId, 1),
      dialogueTurnIdFor(sessionId, 2),
      dialogueTurnIdFor(sessionId, 3),
    ]);
    expect(echo.turns.map((turn) => turn.seq)).toEqual([1, 2, 3]);
    expect(echo.turns.map((turn) => turn.jumped)).toEqual([false, false, false]);
    for (const turn of echo.turns) {
      expect(turn.userQuery.length).toBeLessThanOrEqual(MAX_ECHO_TURN_CHARS);
      expect(turn.assistantReply.length).toBeLessThanOrEqual(MAX_ECHO_TURN_CHARS);
      expect(turn.truncated).toBe(true);
    }
    expect(JSON.stringify(echo).length).toBeLessThan(8 * 1024);

    // Spine injected into summary (budgeted) → excluded from the unbudgeted
    // measurement of the echo view; the view itself is measured as sent.
    expect(preview.summary.some((line) => line.startsWith("Thread:"))).toBe(true);
    expect(preview.unbudgetedTokens).toBe(expectedUnbudgeted(preview));
    expect(preview.unbudgetedTokens!).toBeGreaterThan(0);
    expect(preview.accountedTokens).toBe(
      preview.tokenBudget.compressedTokens + preview.unbudgetedTokens!
    );
    expect(preview.tokenBudget.estimatedRawTokens).toBeGreaterThanOrEqual(
      preview.accountedTokens!
    );
  });

  it("expandAnchor echoes the slim dialogue thread too", async () => {
    const turnId = dialogueTurnIdFor(sessionId, 2);
    const expanded = await expandAnchor(turnId, configPath, root);
    expect(expanded).toBeDefined();
    const echo = expanded!.dialogueThread;
    expect(echo).toBeDefined();
    expect(echo!.turns.map((turn) => turn.id)).toEqual([
      dialogueTurnIdFor(sessionId, 1),
      dialogueTurnIdFor(sessionId, 2),
      dialogueTurnIdFor(sessionId, 3),
    ]);
    for (const turn of echo!.turns) {
      expect(turn.userQuery.length).toBeLessThanOrEqual(MAX_ECHO_TURN_CHARS);
      expect(turn.assistantReply.length).toBeLessThanOrEqual(MAX_ECHO_TURN_CHARS);
      expect(turn.truncated).toBe(true);
    }
    // expanded.content keeps its original promptLines-splicing behaviour.
    expect(expanded!.content).toContain(`resumeFromTurnId: ${turnId}`);
    expect(expanded!.content).toContain("Thread:");
  });
});
