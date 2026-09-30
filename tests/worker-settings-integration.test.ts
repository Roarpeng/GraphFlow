import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadConfigSafe } from "../src/config/loader";
import {
  DEFAULT_WORKER_BASE_URL,
  DEFAULT_WORKER_MODEL,
  DEFAULT_WORKER_TYPE,
  getDefaultConfig,
} from "../src/config/defaults";
import { getGraphFlowSettings, saveGraphFlowSettings } from "../src/surfaces/cli/runtime/settings";
import { buildSettingsHtml, type GraphFlowSettings } from "../vscode-extension/src/panels";

describe("Worker Settings Integration", () => {
  let tempDirs: string[] = [];

  function createTempConfig(initialContent?: Record<string, unknown>): { root: string; configPath: string } {
    const root = mkdtempSync(join(tmpdir(), "graphflow-worker-test-"));
    tempDirs.push(root);
    const configPath = join(root, "graphflow.config.json");
    if (initialContent) {
      writeFileSync(configPath, JSON.stringify(initialContent, null, 2), "utf8");
    }
    return { root, configPath };
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors in test
      }
    }
    tempDirs = [];
  });

  describe("Schema and Defaults", () => {
    it("getDefaultConfig includes default workerPolicy and efficiencyPolicy.worker", () => {
      const config = getDefaultConfig();
      expect(config.workerPolicy).toBeDefined();
      expect(config.workerPolicy?.workerType).toBe("local-command");
      expect(config.workerPolicy?.workerConfig?.baseUrl).toBe(DEFAULT_WORKER_BASE_URL);
      expect(config.workerPolicy?.workerConfig?.model).toBe(DEFAULT_WORKER_MODEL);
      expect(config.efficiencyPolicy?.worker).toBeDefined();
      expect(config.efficiencyPolicy?.worker?.workerType).toBe("local-command");
    });
  });

  describe("Backward Compatibility", () => {
    it("handles legacy config without workerPolicy or workerConfig without crashing", () => {
      const legacyConfig = {
        providers: {
          openai: { apiKey: "sk-legacy-key" },
        },
        tiers: {
          smart: { provider: "openai", model: "gpt-4.1" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          transport: "file",
          maxContextTokens: 1500,
        },
      };

      const { configPath } = createTempConfig(legacyConfig);

      // Verify loader handles it
      const loaded = loadConfig(configPath);
      expect(loaded).toBeDefined();
      expect(loaded.tiers.smart.provider).toBe("openai");

      const safeResult = loadConfigSafe(configPath);
      expect(safeResult.usedFallback).toBe(false);

      // Verify settings surface reads it gracefully with sensible defaults
      const settings = getGraphFlowSettings(configPath);
      expect(settings).toBeDefined();
      expect(settings.workerType).toBe(DEFAULT_WORKER_TYPE);
      expect(settings.workerBaseUrl).toBe(DEFAULT_WORKER_BASE_URL);
      expect(settings.workerModel).toBe(DEFAULT_WORKER_MODEL);
      expect(settings.workerApiKey).toBeUndefined();
    });
  });

  describe("Config Persistence and Round-trip", () => {
    it("persists typesafe-jev worker settings and environment variable placeholder for apiKey", () => {
      const { configPath } = createTempConfig();

      // Initial save with typesafe-jev
      const initialSettings = getGraphFlowSettings(configPath);
      const saved = saveGraphFlowSettings(
        {
          ...initialSettings,
          workerType: "typesafe-jev",
          workerBaseUrl: "http://localhost:8000/v1",
          workerModel: "typesafe-jev",
          workerApiKey: "TYPESAFE_API_KEY",
        },
        configPath
      );

      expect(saved.workerType).toBe("typesafe-jev");
      expect(saved.workerBaseUrl).toBe("http://localhost:8000/v1");
      expect(saved.workerModel).toBe("typesafe-jev");
      expect(saved.workerApiKey).toBe("TYPESAFE_API_KEY");

      // Verify persisted file content
      const rawJson = JSON.parse(readFileSync(configPath, "utf8"));
      expect(rawJson.workerPolicy).toBeDefined();
      expect(rawJson.workerPolicy.workerType).toBe("typesafe-jev");
      expect(rawJson.workerPolicy.workerConfig.baseUrl).toBe("http://localhost:8000/v1");
      expect(rawJson.workerPolicy.workerConfig.model).toBe("typesafe-jev");
      // TYPESAFE_API_KEY should be formatted as ${TYPESAFE_API_KEY} in the raw json
      expect(rawJson.workerPolicy.workerConfig.apiKey).toBe("${TYPESAFE_API_KEY}");

      // Verify reading back from file
      const reloaded = getGraphFlowSettings(configPath);
      expect(reloaded.workerType).toBe("typesafe-jev");
      expect(reloaded.workerBaseUrl).toBe("http://localhost:8000/v1");
      expect(reloaded.workerModel).toBe("typesafe-jev");
      expect(reloaded.workerApiKey).toBe("TYPESAFE_API_KEY");
    });

    it("persists local deployment baseUrl with empty apiKey for unauthenticated local models", () => {
      const { configPath } = createTempConfig();

      const initialSettings = getGraphFlowSettings(configPath);
      const saved = saveGraphFlowSettings(
        {
          ...initialSettings,
          workerType: "typesafe-jev",
          workerBaseUrl: "http://127.0.0.1:8000/v1",
          workerModel: "local-qwen-jev",
          workerApiKey: "",
        },
        configPath
      );

      expect(saved.workerType).toBe("typesafe-jev");
      expect(saved.workerBaseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(saved.workerModel).toBe("local-qwen-jev");
      expect(saved.workerApiKey).toBeUndefined();

      const rawJson = JSON.parse(readFileSync(configPath, "utf8"));
      expect(rawJson.workerPolicy.workerType).toBe("typesafe-jev");
      expect(rawJson.workerPolicy.workerConfig.baseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(rawJson.workerPolicy.workerConfig.model).toBe("local-qwen-jev");
      expect(rawJson.workerPolicy.workerConfig.apiKey).toBeUndefined();

      const reloaded = getGraphFlowSettings(configPath);
      expect(reloaded.workerType).toBe("typesafe-jev");
      expect(reloaded.workerBaseUrl).toBe("http://127.0.0.1:8000/v1");
      expect(reloaded.workerModel).toBe("local-qwen-jev");
      expect(reloaded.workerApiKey).toBeUndefined();
    });

    it("supports switching workerType back to local-command", () => {
      const { configPath } = createTempConfig();

      const initialSettings = getGraphFlowSettings(configPath);
      saveGraphFlowSettings(
        {
          ...initialSettings,
          workerType: "typesafe-jev",
          workerBaseUrl: "http://localhost:8000/v1",
          workerModel: "typesafe-jev",
        },
        configPath
      );

      const updated = saveGraphFlowSettings(
        {
          ...getGraphFlowSettings(configPath),
          workerType: "local-command",
        },
        configPath
      );

      expect(updated.workerType).toBe("local-command");

      const reloaded = getGraphFlowSettings(configPath);
      expect(reloaded.workerType).toBe("local-command");
    });
  });

  describe("VS Code Extension Panels Rendering", () => {
    it("renders Worker Agent card with required inputs and hints", () => {
      const mockSettings: GraphFlowSettings = {
        configPath: "/mock/graphflow.config.json",
        smartProvider: "openai",
        smartModel: "gpt-4.1",
        economyProvider: "openai",
        economyModel: "gpt-4.1-mini",
        provider: "openai",
        maxContextTokens: 1500,
        layerQuota: { l1: 6, l2: 4, l3: 3 },
        enableNearLosslessMode: true,
        autoIndexOnPreview: true,
        autoIndexOnRun: true,
        autoIndexOnSave: true,
        autoRunOnIndex: true,
        transport: "file",
        graphStorePath: "graphflow-out/graphflow-graph.json",
        workerType: "typesafe-jev",
        workerBaseUrl: "http://localhost:8000/v1",
        workerModel: "typesafe-jev",
        workerApiKey: "TYPESAFE_API_KEY",
      };

      const html = buildSettingsHtml(mockSettings, "media/settings.js");

      // Verify Worker Agent card header and container
      expect(html).toContain("Worker Agent 配置");
      expect(html).toContain('id="settings-worker-type"');
      expect(html).toContain('value="local-command"');
      expect(html).toContain('value="typesafe-jev"');
      expect(html).toContain('selected>TypeSafe-JEV 模型（typesafe-jev）');

      // Verify Base URL input and note
      expect(html).toContain('id="settings-worker-base-url"');
      expect(html).toContain('value="http://localhost:8000/v1"');
      expect(html).toContain("支持云端或本地部署模型端点，例如 http://localhost:8000/v1");

      // Verify Model input and note
      expect(html).toContain('id="settings-worker-model"');
      expect(html).toContain('value="typesafe-jev"');
      expect(html).toContain("默认 typesafe-jev 或本地模型名称");

      // Verify API Key input and note
      expect(html).toContain('id="settings-worker-api-key"');
      expect(html).toContain('value="TYPESAFE_API_KEY"');
      expect(html).toContain("支持 TYPESAFE_API_KEY，本地免密模型可留空");
    });
  });
});
