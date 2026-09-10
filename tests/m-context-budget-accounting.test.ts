import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import type { DialogueSearchHit } from "../src/graph/graph-search";
import { recordDialogueTurn } from "../src/learning/dialogue-thread";
import {
  estimateSummaryLinesTokens,
  estimateUnbudgetedPayloadTokens,
  withPostPackageAccounting,
} from "../src/surfaces/cli/runtime/graph";
import {
  calculateBudgetUsedPercent,
  calculateSavingsPercent,
  estimateTokenCount,
} from "../src/surfaces/cli/runtime/helpers";
import { getTokenSavingsStats, previewContext } from "../src/surfaces/cli/runtime";
import type { ContextPreviewResult } from "../src/surfaces/cli/runtime/types";

/**
 * 打包后追加负载的 token 记账测试 / Post-packaging token accounting.
 *
 * The layered package budget is computed before dialogue recall / workbench /
 * thread-spine lines are prepended to `summary` and before `dialogueHits` ride
 * alongside the package. These tests pin the contract that every addition is
 * accounted: budgeted lines land in `compressedTokens` + `budgetUsedPercent`,
 * out-of-package payload lands in `unbudgetedTokens`, and savings percent is
 * computed against the true accounted total.
 */

/**
 * Minimal pre-attach preview fixture: mirrors what `previewContext` caches
 * before the dialogue recall / workbench / spine attach stages run.
 */
function makeBasePreview(): ContextPreviewResult {
  return {
    query: "demo query",
    summaryCount: 2,
    anchorCount: 1,
    tokenEstimate: 100,
    truncated: false,
    anchorsByLayer: { l1: 1, l2: 0, l3: 0 },
    refillPreview: [],
    summary: ["L1 file:src/demo.ts", "L2 symbol:src/demo.ts:fn"],
    anchors: [{ id: "file:src/demo.ts", type: "File", layer: "L1" }],
    tokenBudget: {
      maxContextTokens: 400,
      estimatedRawTokens: 1000,
      compressedTokens: 100,
      estimatedSavingsPercent: calculateSavingsPercent(1000, 100),
      budgetUsedPercent: calculateBudgetUsedPercent(100, 400),
    },
  };
}

function makeDialogueHits(): DialogueSearchHit[] {
  return [
    {
      id: "dialogue:s1:1",
      seq: 1,
      sessionId: "s1",
      userQuery: "graphflow mcp transport 默认是什么",
      updatedAt: 1_000,
      superseded: false,
    },
    {
      id: "dialogue:s1:2",
      seq: 2,
      sessionId: "s1",
      userQuery: "graphflow mcp transport 到底默认什么",
      updatedAt: 2_000,
      superseded: false,
      title: "transport 默认值",
      summary: "默认是 sqlite。",
      correctionLine: "结论「默认 sqlite」已被修正为「默认 auto」",
    },
  ];
}

describe("post-packaging token accounting helpers (budget covers the whole payload)", () => {
  it("measures prepended lines with the shared estimator", () => {
    const lines = ["Dialogue recall: 结论 A 已被修正为 B", "Workbench topic: demo"];
    expect(estimateSummaryLinesTokens(lines)).toBe(
      lines.reduce((total, line) => total + estimateTokenCount(line), 0)
    );
    expect(estimateSummaryLinesTokens([])).toBe(0);
  });

  it("measures unbudgeted payloads as the JSON actually sent", () => {
    const hits = makeDialogueHits();
    expect(estimateUnbudgetedPayloadTokens(hits)).toBe(
      hits.reduce((total, hit) => total + estimateTokenCount(JSON.stringify(hit)), 0)
    );
    expect(estimateUnbudgetedPayloadTokens(hits)).toBeGreaterThan(0);
  });

  it("(a) prepending N summary lines raises the reported token count by exactly their cost", () => {
    const base = makeBasePreview();
    const lines = ["line one adds cost", "line two adds more cost", "第三行同样计入成本"];
    const added = estimateSummaryLinesTokens(lines);
    expect(added).toBeGreaterThan(0);

    const next = withPostPackageAccounting(base, lines, 0);

    expect(next.tokenBudget.compressedTokens).toBe(base.tokenBudget.compressedTokens + added);
    expect(next.tokenEstimate).toBe(next.tokenBudget.compressedTokens);
    expect(next.summary).toEqual([...lines, ...base.summary]);
    expect(next.summaryCount).toBe(base.summaryCount + lines.length);
    expect(next.tokenBudget.budgetUsedPercent).toBe(
      calculateBudgetUsedPercent(
        base.tokenBudget.compressedTokens + added,
        base.tokenBudget.maxContextTokens
      )
    );
    expect(next.tokenBudget.budgetUsedPercent).toBeGreaterThan(base.tokenBudget.budgetUsedPercent);
    // Budgeted-only addition: nothing rides outside the layer quota.
    expect(next.unbudgetedTokens).toBeUndefined();
    expect(next.accountedTokens).toBe(next.tokenBudget.compressedTokens);
    // Pure helper: the cached base result is never mutated.
    expect(base.tokenBudget.compressedTokens).toBe(100);
    expect(base.tokenEstimate).toBe(100);
    expect(base.summaryCount).toBe(2);
    expect(base.summary).toHaveLength(2);
    expect(base.accountedTokens).toBeUndefined();
  });

  it("returns the input untouched when there is nothing to account", () => {
    const base = makeBasePreview();
    expect(withPostPackageAccounting(base, [], 0)).toBe(base);
  });

  it("(b) dialogue hits are reported as unbudgeted, never folded into the L1-L3 budget", () => {
    const base = makeBasePreview();
    const hits = makeDialogueHits();
    const hitsTokens = estimateUnbudgetedPayloadTokens(hits);

    const next = withPostPackageAccounting(base, [], hitsTokens);

    expect(next.unbudgetedTokens).toBe(hitsTokens);
    // The layer-governed budget is unchanged by out-of-package payload.
    expect(next.tokenBudget.compressedTokens).toBe(base.tokenBudget.compressedTokens);
    expect(next.tokenEstimate).toBe(base.tokenEstimate);
    expect(next.tokenBudget.budgetUsedPercent).toBe(base.tokenBudget.budgetUsedPercent);
    // True total = budgeted + unbudgeted.
    expect(next.accountedTokens).toBe(base.tokenBudget.compressedTokens + hitsTokens);
  });

  it("combines a budgeted recall line with unbudgeted hits and accumulates across stages", () => {
    const base = makeBasePreview();
    const hits = makeDialogueHits();
    const hitsTokens = estimateUnbudgetedPayloadTokens(hits);
    const recallLine = `Dialogue recall: ${hits[1].correctionLine}`;

    // Stage 1: dialogue recall (one summary line + unbudgeted hits).
    const stage1 = withPostPackageAccounting(base, [recallLine], hitsTokens);
    expect(stage1.tokenBudget.compressedTokens).toBe(100 + estimateTokenCount(recallLine));
    expect(stage1.unbudgetedTokens).toBe(hitsTokens);
    expect(stage1.summary[0]).toBe(recallLine);
    expect(stage1.summaryCount).toBe(base.summaryCount + 1);

    // Stage 2: workbench prompt lines on top of stage 1.
    const workbenchLines = ["Workbench topic: demo", "Forked: 当前问法偏离主线"];
    const stage2 = withPostPackageAccounting(stage1, workbenchLines, 0);
    expect(stage2.tokenBudget.compressedTokens).toBe(
      stage1.tokenBudget.compressedTokens + estimateSummaryLinesTokens(workbenchLines)
    );
    expect(stage2.unbudgetedTokens).toBe(hitsTokens);
    expect(stage2.accountedTokens).toBe(stage2.tokenBudget.compressedTokens + hitsTokens);
    expect(stage2.summaryCount).toBe(base.summaryCount + 1 + workbenchLines.length);
    expect(stage2.summary.slice(0, workbenchLines.length)).toEqual(workbenchLines);
  });

  it("(c) savings percent is computed against the true accounted total", () => {
    const base = makeBasePreview();
    const lines = ["prepended spine line with some cost"];
    const unbudgeted = 40;

    const next = withPostPackageAccounting(base, lines, unbudgeted);

    const accounted = next.tokenBudget.compressedTokens + unbudgeted;
    expect(next.accountedTokens).toBe(accounted);
    expect(next.tokenBudget.estimatedSavingsPercent).toBe(
      calculateSavingsPercent(next.tokenBudget.estimatedRawTokens, accounted)
    );
    // Strictly less optimistic than computing against the budgeted part only.
    const optimistic = calculateSavingsPercent(
      base.tokenBudget.estimatedRawTokens,
      next.tokenBudget.compressedTokens
    );
    expect(next.tokenBudget.estimatedSavingsPercent).toBeLessThan(optimistic);
  });

  it("keeps estimatedRawTokens as a floor above the accounted payload", () => {
    const base = makeBasePreview(); // estimatedRawTokens = 1000
    const next = withPostPackageAccounting(base, [], 5000);
    expect(next.tokenBudget.estimatedRawTokens).toBe(next.accountedTokens);
    expect(next.tokenBudget.estimatedRawTokens).toBeGreaterThanOrEqual(next.tokenEstimate);
    // Savings clamps at 0 instead of going negative.
    expect(next.tokenBudget.estimatedSavingsPercent).toBe(0);
  });
});

describe("previewContext reports an accounted payload end-to-end", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-budget-accounting-"));
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

  it("accounts the recall line as budgeted, the hits as unbudgeted, and persists ROI on the true total", async () => {
    const client = createGraphClient(resolveConfig(configPath));
    await recordDialogueTurn(client, {
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

    const preview = await previewContext(
      "graphflow mcp transport 默认",
      configPath,
      root,
      undefined,
      { recordDialogue: false }
    );

    // The correction chain surfaces as one budgeted summary line; the hits ride along.
    expect(preview.dialogueHits).toBeDefined();
    expect(preview.dialogueHits!.length).toBeGreaterThan(0);
    expect(preview.summary.some((line) => line.startsWith("Dialogue recall:"))).toBe(true);

    // (b) Hits ride outside the layered package, measured with the same estimator.
    expect(preview.unbudgetedTokens).toBe(estimateUnbudgetedPayloadTokens(preview.dialogueHits!));
    expect(preview.unbudgetedTokens!).toBeGreaterThan(0);

    // True total is visible and internally consistent.
    expect(preview.accountedTokens).toBeDefined();
    expect(preview.accountedTokens).toBe(
      preview.tokenBudget.compressedTokens + preview.unbudgetedTokens!
    );
    expect(preview.tokenEstimate).toBe(preview.tokenBudget.compressedTokens);
    expect(preview.tokenBudget.estimatedRawTokens).toBeGreaterThanOrEqual(preview.tokenEstimate);
    expect(preview.tokenBudget.budgetUsedPercent).toBe(
      calculateBudgetUsedPercent(
        preview.tokenBudget.compressedTokens,
        preview.tokenBudget.maxContextTokens
      )
    );
    // (c) Savings percent uses the true accounted total.
    expect(preview.tokenBudget.estimatedSavingsPercent).toBe(
      calculateSavingsPercent(preview.tokenBudget.estimatedRawTokens, preview.accountedTokens!)
    );

    // Persisted ROI stats cover the accounted payload, not the pre-attach estimate.
    const stats = getTokenSavingsStats(configPath, root);
    const record = stats.recentRecords[0];
    expect(record?.query).toBe("graphflow mcp transport 默认");
    expect(record?.compressedTokens).toBe(preview.accountedTokens);
    expect(record!.compressedTokens).toBeGreaterThan(preview.tokenBudget.compressedTokens);
    expect(record?.savingsPercent).toBe(
      calculateSavingsPercent(record!.rawTokens, record!.compressedTokens)
    );
  });
});
