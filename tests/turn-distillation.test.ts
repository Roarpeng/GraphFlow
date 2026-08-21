import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve";
import { resolveRuntimeWorkspaceRoot } from "../src/config/workspace-root";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import type { GraphNode } from "../src/core/types";
import { dialogueSessionIdFor, dialogueTurnIdFor } from "../src/learning/dialogue-thread";
import {
  CONCLUSION_MARKERS,
  TITLE_STOP_PREFIXES,
  deriveTurnSummary,
  deriveTurnTitle,
} from "../src/learning/turn-distillation";
import {
  distillDialogueTurnsRuntime,
  listDialogueTurnsRuntime,
  recordDialogueTurnRuntime,
} from "../src/surfaces/cli/runtime";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("deriveTurnTitle (offline heuristic)", () => {
  it("strips greeting and imperative prefixes down to the first clause", () => {
    const title = deriveTurnTitle("你好，帮我看看这个报错");
    expect(title).toContain("这个报错");
    for (const greeting of ["你好", "您好", "帮我", "帮我看看", "请"]) {
      expect(title).not.toContain(greeting);
    }
  });

  it("strips polite prefixes and keeps the substantive clause", () => {
    expect(deriveTurnTitle("请问 GraphFlow 如何配置")).toBe("GraphFlow 如何配置");
    expect(deriveTurnTitle("您好！请问这个怎么解决")).toBe("这个怎么解决");
  });

  it("does not mangle compound words that merely start with 请", () => {
    expect(deriveTurnTitle("请求超时怎么解决")).toBe("请求超时怎么解决");
  });

  it("handles English queries by trimming and truncating", () => {
    expect(deriveTurnTitle("How do I fix this bug")).toBe("How do I fix this bug");
    const long = deriveTurnTitle("This is a very long english query that exceeds thirty characters");
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.endsWith("…")).toBe(true);
  });

  it("falls back to the clipped original when only a greeting remains", () => {
    expect(deriveTurnTitle("你好")).toBe("你好");
  });

  it("returns empty for empty or punctuation-only input", () => {
    expect(deriveTurnTitle("")).toBe("");
    expect(deriveTurnTitle("！！！")).toBe("");
    expect(deriveTurnTitle("   ")).toBe("");
  });
});

describe("deriveTurnSummary (offline heuristic)", () => {
  it("prefers the sentence carrying a conclusion marker", () => {
    const summary = deriveTurnSummary("我们先尝试了 A 方案。最终改用 B 方案。");
    expect(summary).toContain("最终改用 B 方案");
    expect(summary).not.toContain("尝试了 A 方案");
  });

  it("falls back to the last non-empty paragraph", () => {
    expect(deriveTurnSummary("第一段内容\n第二段内容")).toBe("第二段内容");
  });

  it("clips long summaries to ~200 chars with an ellipsis", () => {
    const summary = deriveTurnSummary("字".repeat(300));
    expect(summary.length).toBe(200);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("returns empty for empty or punctuation-only replies", () => {
    expect(deriveTurnSummary("")).toBe("");
    expect(deriveTurnSummary("！！！")).toBe("");
  });

  it("exports the marker and prefix tables for inspection", () => {
    expect(CONCLUSION_MARKERS).toContain("综上");
    expect(CONCLUSION_MARKERS).toContain("建议");
    expect(TITLE_STOP_PREFIXES).toContain("你好");
    expect(TITLE_STOP_PREFIXES).toContain("帮我看看");
  });
});

describe("dialogue distill backfill (end-to-end)", () => {
  interface Sandbox {
    configPath: string;
    dir: string;
    client: GraphClient;
  }

  function makeSandbox(): Sandbox {
    const dir = makeTempRoot("graphflow-distill-");
    const configPath = join(dir, "graphflow.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          providers: {},
          tiers: {
            smart: { provider: "openai", model: "gpt-4.1" },
            economy: { provider: "openai", model: "gpt-4.1-mini" },
          },
          budgetPolicy: { runTokenCap: 2000 },
          learningPolicy: { enableFlywheel: true, trainingCadence: "nightly" },
          embeddingPolicy: { enabled: false },
          graphPolicy: {
            transport: "file",
            graphStorePath: join(dir, "graph-store.json"),
            workspaceRoot: dir,
            autoIndexOnRun: false,
            autoIndexOnPreview: false,
            autoIndexOnSave: false,
          },
        },
        null,
        2
      ),
      "utf8"
    );
    return { configPath, dir, client: createGraphClient(resolveConfig(configPath)) };
  }

  /** Write a legacy turn (no title/summary) plus its session hub, as pre-distill data would look. */
  async function seedLegacyTurn(
    sandbox: Sandbox,
    sessionName: string,
    seq: number,
    input: { userQuery: string; assistantReply: string }
  ): Promise<void> {
    // The runtime dialogue surfaces re-resolve the workspace root from cwd
    // (see listDialogueTurnsRuntime / distillDialogueTurnsRuntime), so the seed
    // must key sessions on the same root the runtime will use.
    const sessionId = dialogueSessionIdFor(sessionName, resolveRuntimeWorkspaceRoot());
    const turnId = dialogueTurnIdFor(sessionId, seq);
    const sessionNode: GraphNode = {
      id: sessionId,
      type: "Decision",
      content: `dialogue-session ${sessionName} turns=${seq}`,
      metadata: {
        kind: "dialogue-session",
        name: sessionName,
        record: JSON.stringify({
          id: sessionId,
          name: sessionName,
          turnCount: seq,
          topicTokens: [],
          createdAt: 1,
          updatedAt: seq,
        }),
      },
    };
    const turnNode: GraphNode = {
      id: turnId,
      type: "Decision",
      content: `dialogue-turn #${seq} Q: ${input.userQuery} | A: ${input.assistantReply}`,
      metadata: {
        kind: "dialogue-turn",
        seq,
        sessionId,
        jumped: false,
        record: JSON.stringify({
          id: turnId,
          sessionId,
          seq,
          userQuery: input.userQuery,
          assistantReply: input.assistantReply,
          jumped: false,
          relatedNodeIds: [],
          createdAt: seq,
          updatedAt: seq,
        }),
      },
    };
    await sandbox.client.upsertNodes([sessionNode, turnNode]);
  }

  it("records turns and round-trips distilled title/summary through list", async () => {
    const sandbox = makeSandbox();
    await recordDialogueTurnRuntime("你好，帮我看看这个报错", {
      configPath: sandbox.configPath,
      sessionId: "main",
      assistantReply: "排查后发现是权限问题。结论：给目录加写权限即可。",
    });
    await recordDialogueTurnRuntime("请问 HNSW 还在用吗", {
      configPath: sandbox.configPath,
      sessionId: "main",
      assistantReply: "已经改成线性扫描，因为数据量小。",
    });

    const items = await listDialogueTurnsRuntime(sandbox.configPath, { sessionId: "main", limit: 20 });
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toContain("这个报错");
    expect(items[0]?.summary).toContain("结论");
    expect(items[1]?.title).toContain("HNSW");
    expect(items[1]?.summary).toContain("线性扫描");
  });

  it("backfills legacy turns missing title/summary and is idempotent", async () => {
    const sandbox = makeSandbox();
    await seedLegacyTurn(sandbox, "main", 1, {
      userQuery: "你好，帮我看看这个报错",
      assistantReply: "排查后发现是权限问题。结论：给目录加写权限即可。",
    });
    await seedLegacyTurn(sandbox, "main", 2, {
      userQuery: "请问 HNSW 还在用吗",
      assistantReply: "已经改成线性扫描，因为数据量小。",
    });

    const first = await distillDialogueTurnsRuntime(sandbox.configPath, { all: true });
    expect(first).toEqual({ updated: 2, unchanged: 0, total: 2 });

    const items = await listDialogueTurnsRuntime(sandbox.configPath, { sessionId: "main", limit: 20 });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.title).toBeTruthy();
      expect(item.summary).toBeTruthy();
    }
    expect(items[0]?.title).toContain("这个报错");
    expect(items[0]?.summary).toContain("结论");
    expect(items[1]?.title).toContain("HNSW");
    expect(items[1]?.summary).toContain("线性扫描");

    // Running again is a no-op: existing values are never overwritten.
    const second = await distillDialogueTurnsRuntime(sandbox.configPath, { all: true });
    expect(second).toEqual({ updated: 0, unchanged: 2, total: 2 });
  });

  it("defaults to the main session when neither --session nor --all is given", async () => {
    const sandbox = makeSandbox();
    await seedLegacyTurn(sandbox, "main", 1, {
      userQuery: "帮我看看构建失败的原因",
      assistantReply: "最终发现是缓存损坏，清理后重跑即可。",
    });
    await seedLegacyTurn(sandbox, "other", 1, {
      userQuery: "另一个会话的问题",
      assistantReply: "另一个会话的结论。",
    });

    const result = await distillDialogueTurnsRuntime(sandbox.configPath);
    expect(result).toEqual({ updated: 1, unchanged: 0, total: 1 });

    const mainItems = await listDialogueTurnsRuntime(sandbox.configPath, { sessionId: "main" });
    expect(mainItems[0]?.title).toContain("构建失败");
    expect(mainItems[0]?.summary).toContain("最终");

    // The other session is untouched without --all / --session.
    const otherItems = await listDialogueTurnsRuntime(sandbox.configPath, { sessionId: "other" });
    expect(otherItems[0]?.title).toBeUndefined();
    expect(otherItems[0]?.summary).toBeUndefined();
  });
});
