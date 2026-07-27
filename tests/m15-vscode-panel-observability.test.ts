import { describe, expect, it } from "vitest";
import {
  buildContextPreviewHtml,
  buildGraphSnapshotHtml,
  buildSettingsHtml,
  buildSkillInsightsHtml,
} from "../vscode-extension/src/panels";

describe("M15 VS Code observability panels", () => {
  it("renders graph snapshot controls for search, type filters, and node focus", () => {
    const html = buildGraphSnapshotHtml(
      {
      transport: "file",
      storePath: "graphflow-out/graphflow-graph.json",
      nodeCount: 5,
      edgeCount: 4,
      nodeTypeCount: {
        File: 1,
        Symbol: 1,
        Module: 1,
        TaskRun: 1,
        Decision: 1,
        Skill: 0,
      },
      topRelations: [
        { relation: "imports", count: 2 },
        { relation: "defines", count: 2 },
      ],
      sampleNodes: [
        {
          id: "file:src/index.ts",
          type: "File",
          contentPreview: "export {}",
          displayLabel: "index.ts",
          displayPath: "src/index.ts",
          folderGroup: "src",
          sourcePath: "src/index.ts",
          viewLayer: "code",
        },
        {
          id: "symbol:runTask",
          type: "Symbol",
          contentPreview: "function runTask",
          displayLabel: "runTask",
          displayPath: "src/index.ts",
          sourcePath: "src/index.ts",
          sourceLine: 3,
          folderGroup: "src",
          viewLayer: "code",
        },
      ],
      sampleEdges: [{ from: "file:src/index.ts", relation: "defines", to: "symbol:runTask" }],
      },
      "https://example.vscode-cdn.net/media/graph-snapshot.js"
    );

    expect(html).toContain('id="graph-search"');
    expect(html).toContain('src="https://example.vscode-cdn.net/media/graph-snapshot.js"');
    expect(html).toContain("<circle");
    expect(html).toContain('id="graph-type-filter"');
    expect(html).toContain('id="graph-node-list"');
    expect(html).toContain('id="graph-detail"');
    expect(html).toContain('data-role="graph-canvas"');
    expect(html).toContain('id="graph-layer-tabs"');
    expect(html).toContain("index.ts");
    expect(html).toContain('id="graph-open-source"');
  });

  it("renders skill insights controls for sorting and outcome filtering", () => {
    const html = buildSkillInsightsHtml(
      {
      source: "graph-store",
      transport: "file",
      storePath: "graphflow-out/graphflow-graph.json",
      skills: [
        {
          id: "skill:add-tests",
          name: "add tests",
          score: 4,
          uses: 6,
          lastOutcome: "pass",
          updatedAt: 1,
        },
        {
          id: "skill:refactor-planner",
          name: "refactor planner",
          score: -1,
          uses: 2,
          lastOutcome: "fail",
          updatedAt: 2,
        },
      ],
      },
      "https://example.vscode-cdn.net/media/skill-insights.js"
    );

    expect(html).toContain('id="skill-search"');
    expect(html).toContain('src="https://example.vscode-cdn.net/media/skill-insights.js"');
    expect(html).toContain('id="skill-outcome-filter"');
    expect(html).toContain('id="skill-sort"');
    expect(html).toContain('data-role="skill-table"');
    expect(html).toContain("add tests");
    expect(html).toContain("refactor planner");
  });

  it("renders context preview token budget and anchors", () => {
    const html = buildContextPreviewHtml(
      {
        query: "refactor planner",
        summaryCount: 2,
        anchorCount: 3,
        tokenEstimate: 120,
        truncated: false,
        anchorsByLayer: { l1: 1, l2: 1, l3: 1 },
        refillPreview: ["refill:item"],
        summary: ["Symbol: planner", "File: src/agents/planner.ts"],
        anchors: [
          { id: "symbol:planTasks", type: "Symbol", layer: "L1" },
          { id: "file:src/agents/planner.ts", type: "File", layer: "L2" },
        ],
        tokenBudget: {
          maxContextTokens: 400,
          estimatedRawTokens: 1200,
          compressedTokens: 120,
          estimatedSavingsPercent: 90,
          budgetUsedPercent: 30,
        },
      },
      "https://example.vscode-cdn.net/media/context-preview.js"
    );

    expect(html).toContain("Token Budget");
    expect(html).toContain("90%");
    expect(html).toContain("symbol:planTasks");
    expect(html).toContain('src="https://example.vscode-cdn.net/media/context-preview.js"');
  });

  it("renders settings form for models and token budget", () => {
    const html = buildSettingsHtml(
      {
        configPath: ".graphflow/config.json",
        provider: "openai",
        smartModel: "gpt-4.1",
        economyModel: "gpt-4.1-mini",
        apiKeyEnvVar: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
        maxContextTokens: 400,
        layerQuota: { l1: 6, l2: 4, l3: 3 },
        enableNearLosslessMode: true,
        autoIndexOnPreview: true,
        autoIndexOnRun: true,
        autoIndexOnSave: false,
        transport: "file",
        graphStorePath: "graphflow-out/graphflow-graph.json",
        enrichmentBackend: "inherit",
        enrichmentProvider: "",
        enrichmentModel: "",
        openbmbMode: "embedded",
        openbmbEngine: "command",
        openbmbModel: "",
        openbmbAutoDownload: false,
      },
      "https://example.vscode-cdn.net/media/settings.js",
      {
        extensionVersion: "0.6.6",
        graphNodeCount: 120,
        graphEdgeCount: 88,
        graphLastModified: "2026-06-11T00:00:00.000Z",
        diagnoseSummary: "dynamicRouting=on; planner=openai/gpt-4.1",
        overlayKeys: ["providers.openai.apiKey"],
        baseConfigPath: "graphflow.config.json",
      }
    );

    expect(html).toContain("GraphFlow Settings");
    expect(html).toContain("本版亮点");
    expect(html).toContain("unsafe workspace root from discovery");
    expect(html).toContain('id="settings-smart-provider"');
    expect(html).toContain('id="settings-smart-model"');
    expect(html).toContain('id="settings-max-context-tokens"');
    expect(html).toContain('id="settings-index-graph"');
    expect(html).toContain("建立图谱（无需 LLM）");
    expect(html).toContain('id="settings-test-routing"');
    expect(html).toContain("路由连通性测试（可选）");
    expect(html).toContain('id="settings-auto-index-save"');
    expect(html).toContain("120 节点 / 88 边");
    expect(html).toContain('src="https://example.vscode-cdn.net/media/settings.js"');
  });
});