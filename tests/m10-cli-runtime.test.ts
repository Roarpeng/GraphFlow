import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getGraphFlowSettings,
  getSkillInsights,
  indexGraph,
  inspectGraph,
  planAndBrainstorm,
  previewContext,
  runTask,
  saveGraphFlowSettings,
} from "../src/surfaces/cli/runtime";

describe("M10 CLI runtime", () => {
  const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;

  beforeAll(() => {
    process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = "1000";
  });

  afterAll(() => {
    if (previousTimeout === undefined) {
      delete process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
    } else {
      process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = previousTimeout;
    }
  });

  it("runs task and returns standard output line", async () => {
    const output = await runTask("update readme");
    expect(output).toContain("status=");
    expect(output).toContain("feedback=");
  }, 60000);

  it("returns context preview stats", async () => {
    const preview = await previewContext("orchestrate");
    expect(preview.summaryCount).toBeGreaterThanOrEqual(0);
    expect(preview.anchorCount).toBeGreaterThanOrEqual(0);
    expect(preview.tokenEstimate).toBeGreaterThanOrEqual(0);
    expect(preview.anchorsByLayer.l1).toBeGreaterThanOrEqual(0);
    expect(preview.tokenBudget.compressedTokens).toBe(preview.tokenEstimate);
    expect(preview.tokenBudget.maxContextTokens).toBeGreaterThan(0);
    expect(preview.tokenBudget.estimatedRawTokens).toBeGreaterThanOrEqual(preview.tokenEstimate);
    expect(preview.tokenBudget.estimatedSavingsPercent).toBeGreaterThanOrEqual(0);
    expect(preview.summary).toEqual(expect.any(Array));
    expect(preview.anchors).toEqual(expect.any(Array));
  }, 60000);

  it("saves graphflow settings for model routing and token budget", () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-settings-"));
    const configPath = join(root, "graphflow.config.json");

    try {
      const settings = saveGraphFlowSettings(
        {
          provider: "anthropic",
          smartModel: "claude-4.6-sonnet-medium-thinking",
          economyModel: "claude-3-5-haiku-latest",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
          baseUrl: "https://example.invalid",
          maxContextTokens: 900,
          layerQuota: { l1: 5, l2: 3, l3: 1 },
          enableNearLosslessMode: true,
          autoIndexOnPreview: true,
          autoIndexOnRun: true,
          transport: "file",
          graphStorePath: "graphflow-out/custom-graph.json",
          enrichmentBackend: "network",
          enrichmentProvider: "",
          enrichmentModel: "",
          openbmbMode: "embedded",
          openbmbEngine: "command",
          openbmbModel: "",
          openbmbAutoDownload: false,
        },
        configPath
      );

      expect(settings.configPath).toBe(configPath);
      expect(settings.smartProvider).toBe("anthropic");
      expect(settings.economyProvider).toBe("anthropic");
      expect(settings.provider).toBe("anthropic");
      expect(settings.smartModel).toBe("claude-4.6-sonnet-medium-thinking");
      expect(settings.economyModel).toBe("claude-3-5-haiku-latest");
      expect(settings.maxContextTokens).toBe(900);
      expect(settings.layerQuota).toEqual({ l1: 5, l2: 3, l3: 1 });

      const persisted = JSON.parse(readFileSync(configPath, "utf8"));
      expect(persisted.providers.anthropic.apiKey).toBe("${ANTHROPIC_API_KEY}");
      expect(persisted.providers.anthropic.baseUrl).toBe("https://example.invalid");
      expect(persisted.tiers.smart).toEqual({
        provider: "anthropic",
        model: "claude-4.6-sonnet-medium-thinking",
      });
      expect(persisted.graphPolicy.maxContextTokens).toBe(900);

      const loaded = getGraphFlowSettings(configPath);
      expect(loaded.smartProvider).toBe("anthropic");
      expect(loaded.provider).toBe("anthropic");
      expect(loaded.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexes graph from a workspace path", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-cli-index-"));
    const configPath = join(root, "graphflow.config.json");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
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
            graphPolicy: {
              enableAutoBuild: true,
              enableNearLosslessMode: true,
              autoIndexOnPreview: false,
              autoIndexOnRun: false,
              workspaceRoot: root,
              includeExtensions: [".ts"],
              transport: "memory",
              maxContextTokens: 200,
              semanticEnrichment: {
                enabled: false,
                mode: "off",
                autoRunOnIndex: false,
              },
            },
            learningPolicy: {
              enableFlywheel: false,
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
      const result = await indexGraph(root, configPath);
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
  }, 60000);

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
      const snapshot = await inspectGraph(configPath, { nodeLimit: 8, edgeLimit: 8 });

      expect(snapshot.transport).toBe("file");
      expect(snapshot.nodeCount).toBeGreaterThan(0);
      expect(snapshot.edgeCount).toBeGreaterThan(0);
      expect(snapshot.sampleNodes.length).toBeGreaterThan(0);
      expect(snapshot.topRelations.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("auto-indexes workspace when graph snapshot store is empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-snapshot-autoidx-"));
    const configPath = join(root, "graphflow.config.json");
    const storePath = join(root, "graph-store.json");

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export const demo = 42;", "utf8");
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

      const snapshot = await inspectGraph(configPath, { nodeLimit: 8, edgeLimit: 8 });

      expect(snapshot.nodeCount).toBeGreaterThan(0);
      expect(snapshot.sampleNodes.length).toBeGreaterThan(0);
      expect(existsSync(storePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns skill insights after task execution", async () => {
    const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
    process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = "1000";

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
              semanticEnrichment: {
                enabled: false,
                mode: "off",
              },
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
            routingPolicy: {
              enableDynamicRouting: false,
              requireApiKeyForHealthy: true,
            },
          },
          null,
          2
        ),
        "utf8"
      );

      await runTask("update readme", configPath);
      const insights = await getSkillInsights(configPath, 10);

      expect(insights.source).toBe("graph-store");
      expect(insights.transport).toBe("file");
      expect(insights.skills.length).toBeGreaterThan(0);
      expect(insights.skills[0]?.uses).toBeGreaterThan(0);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = previousTimeout;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
