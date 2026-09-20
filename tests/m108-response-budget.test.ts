import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import { seedWorkbenchFromPlan } from "../src/learning/workbench-topic";
import {
  estimateUnbudgetedPayloadTokens,
  inspectGraph,
  previewContext,
} from "../src/surfaces/cli/runtime/graph";
import {
  MAX_RESPONSE_BYTES,
  applyResponseBudget,
} from "../src/surfaces/cli/runtime/response-budget";
import { calculateSavingsPercent } from "../src/surfaces/cli/runtime/helpers";
import type { ContextPreviewResult } from "../src/surfaces/cli/runtime/types";

/**
 * 响应硬预算 + 有序降级 + diagnose outline 按需回显 / Hard response budget
 * with ordered degradation, and on-demand (workspace-filtered) diagnose outline.
 *
 * `graphflow_context` once produced responses the host truncated at its own
 * 50KB transport limit (trailing fields silently lost), and `graphflow_diagnose`
 * echoed every workspace's workbench outline. These tests pin the fixed
 * contract: over-budget responses degrade in ladder order until they fit,
 * token accounting is recomputed on the final payload, and diagnose omits the
 * outline by default (resume pointer only; full tree on includeOutline=true,
 * filtered to the current workspace).
 */

const TASK = "响应预算降级与 diagnose outline 按需回显";
const OTHER_TASK = "另一个工作区的任务容器（不应回显）";
const STEPS = [
  { id: "task-1", description: "实现响应预算模块", dependencies: [] },
  { id: "task-2", description: "接线 diagnose includeOutline", dependencies: ["task-1"] },
];

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

function baseResult(overrides: Partial<ContextPreviewResult> = {}): ContextPreviewResult {
  return {
    query: "响应预算降级",
    summaryCount: 2,
    anchorCount: 1,
    tokenEstimate: 40,
    truncated: false,
    anchorsByLayer: { l1: 1, l2: 0, l3: 0 },
    refillPreview: [],
    summary: ["File: src/surfaces/cli/runtime/response-budget.ts", "Dialogue recall: 修正线"],
    anchors: [{ id: "file:src/surfaces/cli/runtime/response-budget.ts", type: "File", layer: "L1" }],
    tokenBudget: {
      maxContextTokens: 1500,
      estimatedRawTokens: 20_000,
      compressedTokens: 40,
      estimatedSavingsPercent: 99,
      budgetUsedPercent: 3,
    },
    ...overrides,
  };
}

const OVERSIZED_WORKBENCH = {
  rootId: "workbench:budget",
  task: "响应预算降级任务",
  active: {
    id: "topic:budget:task-1",
    rootId: "workbench:budget",
    title: "实现响应预算模块",
    description: "降级阶梯实现",
    mainline: true,
    isolated: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [{ role: "user", content: "如何防止宿主截断？", at: 1_500 }],
  },
  ancestors: [],
  isolated: false,
  promptLines: ["Workbench: 响应预算降级任务", "Active: 主线 实现响应预算模块 (topic:budget:task-1)"],
  outline: {
    rootId: "workbench:budget",
    task: "响应预算降级任务",
    activeTopicId: "topic:budget:task-1",
    nodes: [
      {
        id: "topic:budget:task-1",
        title: "实现响应预算模块",
        kind: "mainline" as const,
        active: true,
        messageCount: 1,
        pendingReply: false,
        children: [],
      },
    ],
  },
};

function longHits(count: number, size: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `dialogue:s1:000${index + 1}`,
    seq: index + 1,
    sessionId: "dialogue-session:s1",
    title: `历史问题 ${index + 1}`,
    userQuery: "q".repeat(size),
    updatedAt: 1_000 + index,
    superseded: false,
  }));
}

describe("applyResponseBudget: ordered degradation with re-accounting (pure)", () => {
  it("degrades in ladder order, stops as soon as it fits, and re-accounts the final payload", () => {
    const fixture = baseResult({
      workbench: { ...OVERSIZED_WORKBENCH, active: { ...OVERSIZED_WORKBENCH.active } },
      dialogueHits: longHits(3, 12_000), // ~36KB of query text alone
      // Stale attach-time accounting — must be replaced by the re-estimate.
      unbudgetedTokens: 9_000,
      accountedTokens: 9_040,
    });
    expect(JSON.stringify(fixture).length).toBeGreaterThan(MAX_RESPONSE_BYTES);

    const out = applyResponseBudget(fixture);

    // Fits the hard cap; ladder stopped at step ② (③/④ untouched).
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(out.degraded).toEqual(["outline", "dialogueHits.userQuery"]);
    // Step ①: outline dropped from the echo view.
    expect("outline" in out.workbench!).toBe(false);
    // Step ②: hit bodies dropped, identity fields survive.
    expect(out.dialogueHits).toHaveLength(3);
    for (const hit of out.dialogueHits!) {
      expect("userQuery" in hit).toBe(false);
      expect(hit.seq).toBeGreaterThan(0);
    }
    // Not degraded: promptLines kept, dialogueHits kept.
    expect(out.workbench!.promptLines).toEqual(OVERSIZED_WORKBENCH.promptLines);
    expect(out.dialogueHits).toBeDefined();

    // Accounting recomputed on the FINAL payload (workbench echo minus its
    // already-budgeted promptLines, plus the hits exactly as sent).
    const { promptLines: _budgeted, ...echo } = out.workbench!;
    const expectedUnbudgeted = estimateUnbudgetedPayloadTokens([echo, ...out.dialogueHits!]);
    expect(out.unbudgetedTokens).toBe(expectedUnbudgeted);
    expect(expectedUnbudgeted).toBeLessThan(9_000); // stale figure was optimistic
    expect(out.accountedTokens).toBe(out.tokenBudget.compressedTokens + expectedUnbudgeted);
    expect(out.tokenBudget.estimatedRawTokens).toBeGreaterThanOrEqual(out.accountedTokens!);
    expect(out.tokenBudget.estimatedSavingsPercent).toBe(
      calculateSavingsPercent(out.tokenBudget.estimatedRawTokens, out.accountedTokens!)
    );

    // Pure: the input fixture is never mutated.
    expect(fixture.dialogueHits![0]!.userQuery).toHaveLength(12_000);
    expect(fixture.workbench!.outline).toBeDefined();
    expect(fixture.unbudgetedTokens).toBe(9_000);
  });

  it("walks the whole ladder under a tiny cap: promptLines emptied, dialogueHits removed", () => {
    const fixture = baseResult({
      workbench: { ...OVERSIZED_WORKBENCH, active: { ...OVERSIZED_WORKBENCH.active } },
      dialogueHits: longHits(3, 12_000),
    });

    const out = applyResponseBudget(fixture, { maxBytes: 500 });

    expect(out.degraded).toEqual(["outline", "dialogueHits.userQuery", "promptLines", "dialogueHits"]);
    expect("dialogueHits" in out).toBe(false);
    expect(out.workbench!.promptLines).toEqual([]);
    expect("outline" in out.workbench!).toBe(false);
    // compressedTokens unchanged: the prompt lines still ride inside `summary`.
    expect(out.tokenBudget.compressedTokens).toBe(fixture.tokenBudget.compressedTokens);
    expect(out.tokenEstimate).toBe(fixture.tokenEstimate);
    // Re-accounted over the only remaining unbudgeted payload (workbench echo).
    const { promptLines: _budgeted, ...echo } = out.workbench!;
    expect(out.unbudgetedTokens).toBe(estimateUnbudgetedPayloadTokens([echo]));
    expect(out.accountedTokens).toBe(out.tokenBudget.compressedTokens + out.unbudgetedTokens!);
  });

  it("returns the input unchanged (same reference, no degraded field) when within budget", () => {
    const fixture = baseResult({
      workbench: { ...OVERSIZED_WORKBENCH, active: { ...OVERSIZED_WORKBENCH.active } },
      dialogueHits: longHits(1, 200),
    });
    expect(JSON.stringify(fixture).length).toBeLessThan(MAX_RESPONSE_BYTES);

    const out = applyResponseBudget(fixture);

    expect(out).toBe(fixture);
    expect("degraded" in out).toBe(false);
    expect(out.workbench!.outline).toBeDefined();
    expect(out.dialogueHits![0]!.userQuery).toHaveLength(200);
  });
});

describe("inspectGraph outline: omitted by default, workspace-filtered on demand", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-m108-diagnose-"));
  const configPath = writeTempConfig(root);
  // Seeded below: current-workspace root (older) + foreign-workspace root (newer,
  // so an unfiltered or wrong filter would surface the FOREIGN pointer).
  let currentRootId = "";
  let currentActiveTopicId = "";
  let foreignRootId = "";

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("seeds current- and foreign-workspace roots into one shared store", async () => {
    const client = createGraphClient(resolveConfig(configPath));
    const current = await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: STEPS,
      workspaceRoot: root,
      now: 1_000,
    });
    const foreign = await seedWorkbenchFromPlan(client, {
      task: OTHER_TASK,
      steps: STEPS,
      workspaceRoot: "/tmp/graphflow-m108-other-workspace",
      now: 2_000,
    });
    currentRootId = current.root.id;
    currentActiveTopicId = current.root.activeTopicId;
    foreignRootId = foreign.root.id;
    expect(currentRootId).not.toBe(foreignRootId);
  });

  it("default: no workbenchOutline key on the wire, but the resume pointer survives", async () => {
    const snap = await inspectGraph(configPath, { autoIndex: false });
    const wire = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
    expect(wire.workbenchOutline).toBeUndefined();
    expect("workbenchOutline" in wire).toBe(false);
    expect(snap.workbenchResume).toBeDefined();
    expect(snap.workbenchResume!.rootId).toBe(currentRootId);
    expect(snap.workbenchResume!.activeTopicId).toBe(currentActiveTopicId);
  });

  it("includeOutline=true: full outline, but only the current workspace's", async () => {
    const snap = await inspectGraph(configPath, { autoIndex: false, includeOutline: true });
    expect(snap.workbenchOutline).toHaveLength(1);
    expect(snap.workbenchOutline![0]!.rootId).toBe(currentRootId);
    expect(snap.workbenchOutline!.every((outline) => outline.rootId !== foreignRootId)).toBe(true);
    expect(snap.workbenchResume!.activeTopicId).toBe(currentActiveTopicId);
  });
});

describe("previewContext wiring: the hard budget caps the assembled response", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-m108-preview-"));
  const configPath = writeTempConfig(root);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("degrades the echoed outline when the assembled workbench echo overflows", async () => {
    // A ~260-topic workbench DAG pushes the echoed outline (and thus the whole
    // response) past MAX_RESPONSE_BYTES on its own.
    const client = createGraphClient(resolveConfig(configPath));
    const bigSteps = Array.from({ length: 260 }, (_, index) => ({
      id: `step-${index + 1}`,
      description: `大纲节点 ${index + 1}：响应预算降级验证步骤`,
      dependencies: [],
    }));
    await seedWorkbenchFromPlan(client, {
      task: TASK,
      steps: bigSteps,
      workspaceRoot: root,
      now: 1_000,
    });

    const preview = await previewContext("响应预算降级 大纲节点 步骤", configPath, root);

    expect(preview.workbench).toBeDefined();
    expect(preview.degraded).toContain("outline");
    expect("outline" in preview.workbench!).toBe(false);
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    // Re-accounted on the final payload: echo view minus budgeted promptLines;
    // a thread spine injected into summary is measured without its lines too.
    const { promptLines: _budgeted, ...echo } = preview.workbench!;
    const payloads: unknown[] = [echo];
    if (preview.dialogueHits) payloads.push(...preview.dialogueHits);
    if (preview.dialogueThread) {
      const spineInjected = preview.summary.some((line) => line.startsWith("Thread:"));
      payloads.push(
        spineInjected ? { ...preview.dialogueThread, promptLines: [] } : preview.dialogueThread
      );
    }
    expect(preview.unbudgetedTokens).toBe(estimateUnbudgetedPayloadTokens(payloads));
    expect(preview.accountedTokens).toBe(
      preview.tokenBudget.compressedTokens + preview.unbudgetedTokens!
    );
  });
});
