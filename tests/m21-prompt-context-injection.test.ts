import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/routing/provider-executor", async () => {
  const actual = await vi.importActual<typeof import("../src/routing/provider-executor")>(
    "../src/routing/provider-executor"
  );
  return {
    ...actual,
    executeRolePrompt: vi.fn(),
  };
});

import {
  executeRolePrompt,
  formatAnchorSourcesBlock,
  formatPromptContextEntries,
  formatPromptWithContext,
  augmentPromptWithAnchorSources,
  type AnchorSourceItem,
  type PromptContext,
} from "../src/routing/provider-executor";
import { orchestrate } from "../src/core/orchestrator";
import { buildPromptContext, resolveAnchorSources } from "../src/core/orchestrator-context";
import type { GraphClient } from "../src/graph/client-factory";
import { GraphifyClient } from "../src/graph/graphify-client";
import type { GraphNode } from "../src/core/types";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";

const mockedExec = vi.mocked(executeRolePrompt);

const brainstormReply =
  "目标澄清: 明确目标\n实现路径: 拆分子任务\n风险提示: 注意回归";

function stripRolePrefix(prompt: string): string {
  return prompt.replace(/^\[role:[a-z]+\][\s\S]*?Task:\n/, "").replace(/^\[role:[a-z]+\]\s*/, "");
}

function plannerLikeImpl(plannerJson: string) {
  return async (role: string, prompt: string) => {
    if (role === "worker") {
      const task = stripRolePrefix(prompt);
      return `worker output covering ${task}`;
    }
    if (role === "planner") {
      if (prompt.includes("Brainstorm 3 short ideas")) {
        return brainstormReply;
      }
      if (prompt.includes("Decompose the task")) {
        return plannerJson;
      }
      return "planner draft text";
    }
    return "";
  };
}

function makeGraphClient(seed: Array<{ id: string; type: "File" | "Symbol"; content: string }>): GraphClient {
  const inner = new GraphifyClient();
  inner.upsertNodes(seed.map((n) => ({ id: n.id, type: n.type, content: n.content })));
  return {
    async upsertNodes(nodes) {
      inner.upsertNodes(nodes);
    },
    async upsertEdges(edges) {
      inner.upsertEdges(edges);
    },
    async queryByKeyword(query) {
      return inner.queryByKeyword(query);
    },
    async getNodesByIds(ids) {
      return inner.getNodesByIds(ids);
    },
  };
}

/** Fake graph client that also supports getNodesByIds (needed for anchor-source resolution). */
function makeGraphClientWithIds(seed: GraphNode[]): GraphClient {
  const inner = new GraphifyClient();
  inner.upsertNodes(seed);
  return {
    async upsertNodes(nodes) {
      inner.upsertNodes(nodes);
    },
    async upsertEdges(edges) {
      inner.upsertEdges(edges);
    },
    async queryByKeyword(query) {
      return inner.queryByKeyword(query);
    },
    async getNodesByIds(ids) {
      return inner.getNodesByIds(ids);
    },
  };
}

const DEMO_REL_PATH = "src/demo/anchor-widget.ts";
const DEMO_FILE_MARKER = "inline-me-7842";

function writeDemoWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "graphflow-anchor-src-"));
  mkdirSync(join(root, "src/demo"), { recursive: true });
  writeFileSync(
    join(root, DEMO_REL_PATH),
    [
      "export const ANCHOR_WIDGET_SECRET = \"" + DEMO_FILE_MARKER + "\";",
      "",
      "export function anchorWidgetCore(): string {",
      "  return ANCHOR_WIDGET_SECRET;",
      "}",
      "",
      "export function anchorWidgetTail(): string {",
      "  return \"tail-marker-9931\";",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  return root;
}

function seedDemoNodes(): GraphNode[] {
  return [
    {
      id: `file:${DEMO_REL_PATH}`,
      type: "File",
      content: `${DEMO_REL_PATH} # exports: anchorWidgetCore, anchorWidgetTail`,
      metadata: { path: DEMO_REL_PATH, language: "ts", symbolCount: 2, sizeBytes: 220 },
    },
    {
      id: `symbol:${DEMO_REL_PATH}:deadbeef`,
      type: "Symbol",
      content: `function anchorWidgetCore (exported) @${DEMO_REL_PATH}:3 # renders the anchor widget core`,
      metadata: {
        name: "anchorWidgetCore",
        kind: "function",
        exported: true,
        line: 3,
        file: DEMO_REL_PATH,
        signature: "export function anchorWidgetCore(): string",
      },
    },
  ];
}

describe("M21 prompt context injection", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("Test A: enableGraphContextInPrompt=false leaves prompts without context", async () => {
    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
    ]);
    mockedExec.mockImplementation(plannerLikeImpl(plannerJson));

    const run = await orchestrate(
      { task: "refactor module orchestrator and add tests", maxRetries: 1 },
      { enableLlmAgents: true }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.promptContextLines).toBeUndefined();
    for (const call of mockedExec.mock.calls) {
      const ctx = call[3];
      expect(
        ctx === undefined ||
          ((!ctx.summaryChannel || ctx.summaryChannel.length === 0) &&
            (!ctx.skillHints || ctx.skillHints.length === 0) &&
            (!ctx.extraInstructions || ctx.extraInstructions.length === 0))
      ).toBe(true);
    }
  });

  it("worker answer surfaces on the run result and the episode record", async () => {
    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
    ]);
    mockedExec.mockImplementation(plannerLikeImpl(plannerJson));

    const graphClient = makeGraphClient([
      {
        id: "file-1",
        type: "File",
        content: "src/orchestrator.ts: orchestrator entry",
        metadata: { path: "src/orchestrator.ts" },
      },
    ]);

    const run = await orchestrate(
      { task: "refactor module orchestrator and add tests", maxRetries: 1 },
      {
        enableLlmAgents: true,
        graphClient,
        enableEpisodicMemory: true,
      }
    );

    expect(run.status).toBe("COMPLETED");
    // The worker's final textual answer rides on the run result — a COMPLETED
    // run must not report only the validator's note while hiding what the
    // model actually produced.
    expect(run.result).toContain("worker output covering");
    expect(run.episodeId).toBeDefined();

    const episodeNode = (await graphClient.getNodesByIds([run.episodeId!]))[0];
    expect(episodeNode).toBeDefined();
    const raw = episodeNode!.metadata?.record;
    const record = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw ?? "{}"));
    expect(record.result).toContain("worker output covering");
  });

  it("Test B: enableGraphContextInPrompt=true injects summaryChannel into prompts", async () => {
    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
    ]);
    mockedExec.mockImplementation(plannerLikeImpl(plannerJson));

    const graphClient = makeGraphClient([
      { id: "file-1", type: "File", content: "src/orchestrator.ts: orchestrator entry" },
      { id: "sym-1", type: "Symbol", content: "function orchestrator(): runs the DAG" },
      { id: "sym-2", type: "Symbol", content: "class OrchestratorRunner orchestrator helper" },
    ]);

    const run = await orchestrate(
      { task: "refactor module orchestrator and add tests", maxRetries: 1 },
      {
        enableLlmAgents: true,
        graphClient,
        enableNearLosslessMode: true,
        enableGraphContextInPrompt: true,
        maxContextTokens: 1200,
      }
    );

    expect(run.status).toBe("COMPLETED");
    expect(run.promptContextLines).toBeGreaterThan(0);
    expect(run.feedback).toMatch(/promptCtx\(lines=\d+\)/);

    const withCtx = mockedExec.mock.calls.filter(
      (call) => (call[3] as PromptContext | undefined)?.summaryChannel?.length
    );
    expect(withCtx.length).toBeGreaterThan(0);
    expect(withCtx[0]?.[3]?.summaryChannel?.[0]).toMatch(/orchestrator/);
  });

  it("Test C: formatPromptWithContext caps summary lines at 20 and skill hints at 8", () => {
    const longSummary = Array.from({ length: 30 }, (_, i) => `summary-line-${i + 1}`);
    const manySkills = Array.from({ length: 12 }, (_, i) => `skill-${i + 1}`);
    const formatted = formatPromptWithContext("worker", "do the thing", {
      summaryChannel: longSummary,
      skillHints: manySkills,
      extraInstructions: ["take care"],
    });

    expect(formatted.startsWith("[role:worker]")).toBe(true);
    expect(formatted).toContain("Knowledge graph context:");
    expect(formatted).toContain("- summary-line-1");
    expect(formatted).toContain("- summary-line-20");
    expect(formatted).not.toContain("- summary-line-21");
    expect(formatted).toContain("Skills to apply: skill-1, skill-2, skill-3, skill-4, skill-5, skill-6, skill-7, skill-8");
    expect(formatted).not.toContain("skill-9");
    expect(formatted).toContain("Notes:");
    expect(formatted).toContain("- take care");
    expect(formatted.endsWith("Task:\ndo the thing")).toBe(true);
  });

  it("Test D: formatPromptWithContext returns single-line prompt when context empty", () => {
    expect(formatPromptWithContext("planner", "hello")).toBe("[role:planner] hello");
    expect(formatPromptWithContext("planner", "hello", {})).toBe("[role:planner] hello");
    expect(
      formatPromptWithContext("planner", "hello", { summaryChannel: [], skillHints: [] })
    ).toBe("[role:planner] hello");
    expect(
      formatPromptWithContext("planner", "hello", { anchorSources: [] })
    ).toBe("[role:planner] hello");
  });

  // ── Anchor source inlining (bridge workers have no filesystem access) ──
  it("Test E: anchor sources from the graph ride into worker prompts as inlined source", async () => {
    const plannerJson = JSON.stringify([
      { id: "task-1", description: "alpha", dependencies: [] },
    ]);
    const root = writeDemoWorkspace();
    const configPath = createNoLlmConfigPath({
      graphPolicy: {
        transport: "memory",
        autoIndexOnRun: false,
        autoIndexOnPreview: false,
        autoIndexOnSave: false,
        workspaceRoot: root,
      },
    });
    try {
      mockedExec.mockImplementation(async (role: string, prompt: string) => {
        if (role === "worker") {
          const task = stripRolePrefix(prompt);
          return `worker output covering ${task}`;
        }
        if (role === "planner") {
          if (prompt.includes("Brainstorm 3 short ideas")) {
            return brainstormReply;
          }
          if (prompt.includes("Decompose the task")) {
            return plannerJson;
          }
          return "planner draft text";
        }
        return "";
      });

      const run = await orchestrate(
        { task: "refactor anchorWidgetCore module and add tests", maxRetries: 1 },
        {
          enableLlmAgents: true,
          graphClient: makeGraphClientWithIds(seedDemoNodes()),
          enableNearLosslessMode: true,
          nearLosslessQuery: "anchorWidgetCore",
          maxContextTokens: 1200,
          configPath,
        }
      );

      expect(run.status).toBe("COMPLETED");

      const workerCalls = mockedExec.mock.calls.filter((call) => call[0] === "worker");
      expect(workerCalls.length).toBeGreaterThan(0);
      const workerCtx = workerCalls[0]?.[3] as PromptContext | undefined;
      expect(workerCtx?.anchorSources?.length).toBeGreaterThan(0);

      // The production transformation executeRolePrompt applies before the
      // request goes out: prompt + inlined source block.
      const sentPrompt = augmentPromptWithAnchorSources(
        workerCalls[0]?.[1] as string,
        workerCtx
      );
      expect(sentPrompt).toContain(DEMO_FILE_MARKER);
      expect(sentPrompt).toContain("以下源码已内联提供");
      expect(sentPrompt).toContain("不要请求或等待文件内容");
      expect(sentPrompt).toContain(DEMO_REL_PATH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Test F: resolveAnchorSources reads disk, windows symbols, and enforces budgets", async () => {
    const root = writeDemoWorkspace();
    const configPath = createNoLlmConfigPath({
      graphPolicy: {
        transport: "memory",
        autoIndexOnRun: false,
        autoIndexOnPreview: false,
        autoIndexOnSave: false,
        workspaceRoot: root,
      },
    });
    try {
      const client = makeGraphClientWithIds(seedDemoNodes());
      const anchorChannel = [
        { id: `file:${DEMO_REL_PATH}`, type: "File" as const, layer: "L1" as const },
        { id: `symbol:${DEMO_REL_PATH}:deadbeef`, type: "Symbol" as const, layer: "L1" as const },
      ];
      const sources = await resolveAnchorSources(
        { summaryChannel: [], anchorChannel, tokenEstimate: 10, truncated: false },
        { graphClient: client, configPath }
      );

      expect(sources.length).toBe(2);
      const [fileSource, symbolSource] = sources;
      // File anchor: whole (small) file inlined from disk.
      expect(fileSource?.path).toBe(DEMO_REL_PATH);
      expect(fileSource?.content).toContain(DEMO_FILE_MARKER);
      expect(fileSource?.truncated).toBeFalsy();
      // Symbol anchor: path:line display, window starts at the symbol.
      expect(symbolSource?.path).toBe(`${DEMO_REL_PATH}:3`);
      expect(symbolSource?.content).toContain("anchorWidgetCore");

      // No anchors / no getNodesByIds → no sources, no regression.
      expect(await resolveAnchorSources(undefined, { graphClient: client })).toEqual([]);
      expect(
        await resolveAnchorSources(
          { summaryChannel: [], anchorChannel: [], tokenEstimate: 0, truncated: false },
          { graphClient: client }
        )
      ).toEqual([]);

      // Metadata-only anchor channel (workbench/episode nodes) + a task text
      // that QUOTES the file path: the fallback inlines the quoted file so a
      // bridge descriptor never ships without the code the task names.
      const metadataOnly = [
        { id: "workbench:demo", type: "Decision" as const, layer: "L3" as const },
        { id: "episode:demo", type: "Decision" as const, layer: "L3" as const },
      ];
      const fallback = await resolveAnchorSources(
        { summaryChannel: [], anchorChannel: metadataOnly, tokenEstimate: 5, truncated: false },
        { graphClient: client, configPath },
        `列出 ${DEMO_REL_PATH} 的导出符号`
      );
      expect(fallback.length).toBe(1);
      expect(fallback[0]?.path).toBe(DEMO_REL_PATH);
      expect(fallback[0]?.content).toContain(DEMO_FILE_MARKER);
      expect(fallback[0]?.id).toBe(`file:${DEMO_REL_PATH}`);

      // Oversized file: head+tail truncation with a marker, capped at ~6KB.
      const bigRelPath = "src/demo/big-file.ts";
      writeFileSync(
        join(root, bigRelPath),
        Array.from({ length: 1000 }, (_, i) => `export const bigLine${i} = "${i}"; // padpadpad`).join("\n"),
        "utf8"
      );
      const bigClient = makeGraphClientWithIds([
        {
          id: `file:${bigRelPath}`,
          type: "File",
          content: `${bigRelPath} # exports: bigLine0`,
          metadata: { path: bigRelPath },
        },
      ]);
      const bigSources = await resolveAnchorSources(
        {
          summaryChannel: [],
          anchorChannel: [{ id: `file:${bigRelPath}`, type: "File", layer: "L1" }],
          tokenEstimate: 10,
          truncated: false,
        },
        { graphClient: bigClient, configPath }
      );
      expect(bigSources.length).toBe(1);
      expect(bigSources[0]?.truncated).toBe(true);
      expect(bigSources[0]?.content.length).toBeLessThanOrEqual(6 * 1024);
      expect(bigSources[0]?.content).toContain("bigLine0");
      expect(bigSources[0]?.content).toContain("bigLine999");
      expect(bigSources[0]?.content).toContain("truncated");

      // More than 8 file/symbol anchors → capped at 8.
      const manyIds = Array.from({ length: 12 }, (_, i) => `symbol:${DEMO_REL_PATH}:hash${i}`);
      const manyClient = makeGraphClientWithIds(
        manyIds.map((id) => ({
          id,
          type: "Symbol" as const,
          content: `function symMany (exported) @${DEMO_REL_PATH}:3`,
          metadata: { file: DEMO_REL_PATH, line: 3, signature: "export function symMany()" },
        }))
      );
      const manySources = await resolveAnchorSources(
        {
          summaryChannel: [],
          anchorChannel: manyIds.map((id) => ({ id, type: "Symbol" as const, layer: "L1" as const })),
          tokenEstimate: 10,
          truncated: false,
        },
        { graphClient: manyClient, configPath }
      );
      expect(manySources.length).toBeLessThanOrEqual(8);
      // …and the 24KB total budget holds.
      expect(manySources.reduce((sum, s) => sum + s.content.length, 0)).toBeLessThanOrEqual(24 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Test G: buildPromptContext carries anchorSources and renderers emit fenced blocks", () => {
    const anchorSources: AnchorSourceItem[] = [
      { id: `file:${DEMO_REL_PATH}`, path: DEMO_REL_PATH, content: "export const x = 1;" },
    ];

    const ctx = buildPromptContext(
      { summaryChannel: [], anchorChannel: [], tokenEstimate: 0, truncated: false },
      [],
      [],
      undefined,
      [],
      anchorSources
    );
    expect(ctx?.anchorSources).toEqual(anchorSources);

    // Empty anchors → unchanged behaviour (undefined context).
    expect(
      buildPromptContext(
        { summaryChannel: [], anchorChannel: [], tokenEstimate: 0, truncated: false },
        [],
        [],
        undefined,
        [],
        []
      )
    ).toBeUndefined();

    const formatted = formatPromptWithContext("worker", "do the thing", { anchorSources });
    expect(formatted).toContain("以下源码已内联提供");
    expect(formatted).toContain(`### ${DEMO_REL_PATH} [anchor file:${DEMO_REL_PATH}]`);
    expect(formatted).toContain("````ts");
    expect(formatted).toContain("export const x = 1;");
    expect(formatted.endsWith("Task:\ndo the thing")).toBe(true);

    // augment is a no-op without anchor sources.
    expect(augmentPromptWithAnchorSources("bare task")).toBe("bare task");
    expect(augmentPromptWithAnchorSources("bare task", { summaryChannel: ["s"] })).toBe("bare task");

    // Descriptor-style flattening: other fields stay `k: v`, sources become the block.
    const flat = formatPromptContextEntries({
      summaryChannel: ["mod exports x"],
      anchorSources,
    });
    expect(flat).toContain("summaryChannel: ");
    expect(flat).toContain("以下源码已内联提供");
    expect(flat).toContain("export const x = 1;");
    expect(flat).not.toContain("anchorSources: ");

    // Empty anchor list renders nothing.
    expect(formatAnchorSourcesBlock([])).toBe("");
  });
});
