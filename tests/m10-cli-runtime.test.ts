import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSkillInsights,
  indexGraph,
  inspectGraph,
  planAndBrainstorm,
  previewContext,
  runTask,
} from "../src/surfaces/cli/runtime";

describe("M10 CLI runtime", () => {
  it("runs task and returns standard output line", async () => {
    const output = await runTask("update readme");
    expect(output).toContain("status=");
    expect(output).toContain("feedback=");
  });

  it("returns context preview stats", async () => {
    const preview = await previewContext("orchestrate");
    expect(preview.summaryCount).toBeGreaterThanOrEqual(0);
    expect(preview.anchorCount).toBeGreaterThanOrEqual(0);
    expect(preview.tokenEstimate).toBeGreaterThanOrEqual(0);
    expect(preview.anchorsByLayer.l1).toBeGreaterThanOrEqual(0);
  });

  it("indexes graph from a workspace path", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-cli-index-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
      const result = await indexGraph(root);
      expect(result.indexedFiles).toBeGreaterThanOrEqual(1);
      expect(result.indexedSymbols).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns plan and brainstorm output for complex tasks", () => {
    const output = planAndBrainstorm("update readme and add tests and refactor architecture module");
    expect(output).toContain("mode=complex");
    expect(output).toContain("ideas=");
    expect(output).toContain("plan=");
    expect(output).toContain("task-1");
  });

  it("persists graph data when using file transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-persist-"));
    const configPath = join(root, "graphflow.config.json");
    const storePath = join(root, "graph-store.json");

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
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
              autoIndexOnRun: true,
              workspaceRoot: root,
              includeExtensions: [".ts"],
              transport: "file",
              graphStorePath: storePath,
              maxContextTokens: 200,
              layerQuota: { l1: 6, l2: 4, l3: 3 },
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: join(root, "learning.jsonl"),
            },
          },
          null,
          2
        ),
        "utf8"
      );

      await runTask("update readme", configPath);
      const preview = await previewContext("Task completed", configPath);

      expect(preview.summaryCount).toBeGreaterThan(0);
      expect(preview.anchorCount).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns graph snapshot for file transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-snapshot-"));
    const configPath = join(root, "graphflow.config.json");
    const storePath = join(root, "graph-store.json");

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export const demo = 1;", "utf8");
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
              autoIndexOnRun: true,
              workspaceRoot: root,
              includeExtensions: [".ts"],
              transport: "file",
              graphStorePath: storePath,
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: join(root, "learning.jsonl"),
            },
          },
          null,
          2
        ),
        "utf8"
      );

      await runTask("update readme", configPath);
      const snapshot = inspectGraph(configPath, { nodeLimit: 8, edgeLimit: 8 });

      expect(snapshot.transport).toBe("file");
      expect(snapshot.nodeCount).toBeGreaterThan(0);
      expect(snapshot.edgeCount).toBeGreaterThan(0);
      expect(snapshot.sampleNodes.length).toBeGreaterThan(0);
      expect(snapshot.topRelations.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns skill insights after task execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-skill-insights-"));
    const configPath = join(root, "graphflow.config.json");
    const storePath = join(root, "graph-store.json");

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
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
              autoIndexOnRun: true,
              workspaceRoot: root,
              includeExtensions: [".ts"],
              transport: "file",
              graphStorePath: storePath,
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: join(root, "learning.jsonl"),
            },
            skillPolicy: {
              enableSkillFlywheel: true,
              maxSkillHints: 4,
            },
          },
          null,
          2
        ),
        "utf8"
      );

      await runTask("refactor planner and add tests", configPath);
      const insights = getSkillInsights(configPath, 10);

      expect(insights.source).toBe("graph-store");
      expect(insights.transport).toBe("file");
      expect(insights.skills.length).toBeGreaterThan(0);
      expect(insights.skills[0]?.uses).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
