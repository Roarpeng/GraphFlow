import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import { recordDialogueTurn } from "../src/learning/dialogue-thread";
import { previewContext, searchDialogueTurnsRuntime } from "../src/surfaces/cli/runtime";

describe("dialogue turn recall wired into preview + CLI runtime (Conversation Graph W2b)", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-dialogue-recall-"));
  const configPath = join(root, "graphflow.config.json");
  const storePath = join(root, "graph-store.json");

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
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: storePath,
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

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("previewContext attaches additive dialogueHits even when not recording", async () => {
    const client = createGraphClient(resolveConfig(configPath));
    const first = await recordDialogueTurn(client, {
      userQuery: "graphflow mcp transport 默认是什么",
      assistantReply: "默认是 sqlite。",
      workspaceRoot: root,
      now: 1_000,
    });
    await recordDialogueTurn(client, {
      userQuery: "graphflow mcp transport 到底默认什么",
      assistantReply: "更正：默认 transport 是 auto。",
      workspaceRoot: root,
      now: 2_000,
    });
    expect(first.turn).toBeDefined();

    const preview = await previewContext("graphflow mcp transport 默认", configPath, root, undefined, {
      recordDialogue: false,
    });

    // Read-only recall still runs on the recordDialogue=false path.
    expect(preview.dialogueHits).toBeDefined();
    expect(preview.dialogueHits!.length).toBeGreaterThan(0);
    const corrected = preview.dialogueHits!.find((hit) => hit.correctionLine);
    expect(corrected).toBeDefined();
    expect(corrected!.superseded).toBe(false);
    // The correction chain surfaces as exactly one summary prompt line.
    expect(preview.summary.some((line) => line.startsWith("Dialogue recall:"))).toBe(true);
  });

  it("searchDialogueTurnsRuntime hides superseded turns by default and can look back", async () => {
    const client = createGraphClient(resolveConfig(configPath));
    await recordDialogueTurn(client, {
      userQuery: "retrieval golden 数据集怎么生成",
      assistantReply: "硬编码词集。",
      workspaceRoot: root,
      now: 3_000,
    });
    await recordDialogueTurn(client, {
      userQuery: "retrieval golden 数据集到底怎么生成",
      assistantReply: "更正：由检索数据集与运行时证据动态生成。",
      workspaceRoot: root,
      now: 4_000,
    });

    const effective = await searchDialogueTurnsRuntime("retrieval golden 数据集", { configPath });
    expect(effective.length).toBeGreaterThan(0);
    expect(effective.every((hit) => !hit.superseded)).toBe(true);

    const withHistory = await searchDialogueTurnsRuntime("retrieval golden 数据集", {
      configPath,
      includeSuperseded: true,
    });
    expect(withHistory.some((hit) => hit.superseded)).toBe(true);

    const miss = await searchDialogueTurnsRuntime("kubernetes helm chart 部署", { configPath });
    expect(miss).toHaveLength(0);
  });
});
