import { afterEach, describe, expect, it } from "vitest";
import {
  formatApiKeyForConfig,
  formatApiKeyForSettings,
  resolveConfigSecret,
} from "../src/config/secrets";
import { getGraphFlowSettings, saveGraphFlowSettings } from "../src/surfaces/cli/runtime";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("M39 config secrets", () => {
  afterEach(() => {
    delete process.env.GRAPHFLOW_TEST_API_KEY;
  });

  it("resolves env placeholders and keeps direct keys", () => {
    process.env.GRAPHFLOW_TEST_API_KEY = "resolved-secret";
    expect(resolveConfigSecret("${GRAPHFLOW_TEST_API_KEY}")).toBe("resolved-secret");
    expect(resolveConfigSecret("sk-direct-key")).toBe("sk-direct-key");
    expect(formatApiKeyForConfig("DEEPSEEK_API_KEY")).toBe("${DEEPSEEK_API_KEY}");
    expect(formatApiKeyForConfig("${DEEPSEEK_API_KEY}")).toBe("${DEEPSEEK_API_KEY}");
    expect(formatApiKeyForConfig("sk-live-key")).toBe("sk-live-key");
    expect(formatApiKeyForSettings("${DEEPSEEK_API_KEY}")).toBe("DEEPSEEK_API_KEY");
    expect(formatApiKeyForSettings("sk-live-key")).toBe("sk-live-key");
  });

  it("persists direct api keys and env var names via settings save", () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-secrets-"));
    const configPath = join(root, "graphflow.config.json");

    try {
      saveGraphFlowSettings(
        {
          provider: "openai",
          smartModel: "",
          economyModel: "",
          apiKeyEnvVar: "sk-direct-save-key",
          baseUrl: "https://api.deepseek.com",
          maxContextTokens: 1200,
          layerQuota: { l1: 6, l2: 4, l3: 3 },
          enableNearLosslessMode: true,
          autoIndexOnPreview: true,
          autoIndexOnRun: true,
          transport: "file",
          graphStorePath: "graphflow-out/graph.json",
          enrichmentBackend: "inherit",
          enrichmentProvider: "",
          enrichmentModel: "",
          openbmbMode: "embedded",
          openbmbEngine: "command",
          openbmbModel: "",
          openbmbAutoDownload: false,
        },
        configPath
      );

      const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
        providers?: { openai?: { apiKey?: string } };
      };
      expect(persisted.providers?.openai?.apiKey).toBe("sk-direct-save-key");

      saveGraphFlowSettings(
        {
          provider: "openai",
          smartModel: "deepseek-v4-pro",
          economyModel: "",
          apiKeyEnvVar: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com",
          maxContextTokens: 1200,
          layerQuota: { l1: 6, l2: 4, l3: 3 },
          enableNearLosslessMode: true,
          autoIndexOnPreview: true,
          autoIndexOnRun: true,
          transport: "file",
          graphStorePath: "graphflow-out/graph.json",
          enrichmentBackend: "network",
          enrichmentProvider: "",
          enrichmentModel: "deepseek-v4-flash",
          openbmbMode: "embedded",
          openbmbEngine: "command",
          openbmbModel: "",
          openbmbAutoDownload: false,
        },
        configPath
      );

      const envPersisted = JSON.parse(readFileSync(configPath, "utf8")) as {
        providers?: { openai?: { apiKey?: string } };
        tiers?: { smart?: { model?: string }; economy?: { model?: string } };
      };
      expect(envPersisted.providers?.openai?.apiKey).toBe("${DEEPSEEK_API_KEY}");
      expect(envPersisted.tiers?.smart?.model).toBe("deepseek-v4-pro");

      const loaded = getGraphFlowSettings(configPath);
      expect(loaded.apiKeyEnvVar).toBe("DEEPSEEK_API_KEY");
      expect(loaded.smartProvider).toBe("openai");
      expect(loaded.economyProvider).toBe("openai");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
