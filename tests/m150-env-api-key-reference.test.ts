import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  describeApiKeyInput,
  extractEnvReferenceName,
  formatApiKeyForConfig,
  resolveConfigSecret,
} from "../src/config/secrets";
import { readEnvVar, resetRegistryEnvCache } from "../src/config/env-lookup";
import { loadConfig } from "../src/config/loader";
import { getDefaultConfig } from "../src/config/defaults";
import { providerHasCredentials } from "../src/config/llm-availability";
import { getGraphFlowSettings, saveGraphFlowSettings } from "../src/surfaces/cli/runtime";
import {
  normalizeTypesafeBaseUrl,
  resolveTypesafeCredentials,
  typesafeClientOptionsFromConfig,
} from "../src/routing/typesafe-systemone";
import type { GraphFlowConfig } from "../src/config/schema";

const baseSettings = {
  provider: "deepseek",
  smartProvider: "deepseek",
  smartModel: "deepseek-v4-pro",
  economyProvider: "deepseek",
  economyModel: "deepseek-v4-flash",
  maxContextTokens: 1200,
  layerQuota: { l1: 6, l2: 4, l3: 3 },
  enableNearLosslessMode: true,
  autoIndexOnPreview: true,
  autoIndexOnRun: true,
  autoIndexOnSave: true,
  transport: "file" as const,
  graphStorePath: "graphflow-out/graph.json",
};

function writeProjectConfig(dir: string): string {
  const defaults = getDefaultConfig();
  const configPath = join(dir, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...defaults,
      providers: { deepseek: { apiKey: "${GF_M150_KEY}" } },
      tiers: {
        smart: { provider: "deepseek", model: "deepseek-v4-pro" },
        economy: { provider: "deepseek", model: "deepseek-v4-flash" },
      },
      graphPolicy: { ...defaults.graphPolicy, transport: "file", mcpApiKey: "${GF_M150_TOKEN}" },
    })
  );
  return configPath;
}

describe("M150 env-var API key references (settings → runtime)", () => {
  let root: string;
  const savedConfigHome = process.env.GRAPHFLOW_CONFIG_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "graphflow-m150-"));
    process.env.GRAPHFLOW_CONFIG_HOME = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedConfigHome === undefined) delete process.env.GRAPHFLOW_CONFIG_HOME;
    else process.env.GRAPHFLOW_CONFIG_HOME = savedConfigHome;
    delete process.env.GF_M150_KEY;
    delete process.env.gf_m150_lower;
    delete process.env.GF_M150_TOKEN;
    delete process.env.TYPESAFE_API_KEY;
  });

  it("accepts every common env reference spelling and stores ${NAME}", () => {
    expect(formatApiKeyForConfig("GF_M150_KEY")).toBe("${GF_M150_KEY}");
    expect(formatApiKeyForConfig("${GF_M150_KEY}")).toBe("${GF_M150_KEY}");
    expect(formatApiKeyForConfig("%GF_M150_KEY%")).toBe("${GF_M150_KEY}");
    expect(formatApiKeyForConfig("$GF_M150_KEY")).toBe("${GF_M150_KEY}");
    expect(formatApiKeyForConfig("$env:GF_M150_KEY")).toBe("${GF_M150_KEY}");
  });

  it("treats a lowercase identifier as an env name only when that var exists", () => {
    expect(formatApiKeyForConfig("apikey_abc123_def456")).toBe("apikey_abc123_def456");
    process.env.gf_m150_lower = "value";
    expect(extractEnvReferenceName("gf_m150_lower")).toBe("gf_m150_lower");
    expect(formatApiKeyForConfig("gf_m150_lower")).toBe("${gf_m150_lower}");
  });

  it("keeps apiKey placeholders through load so a late-set var still resolves", () => {
    const configPath = writeProjectConfig(root);
    process.env.GF_M150_TOKEN = "team-token";
    const config = loadConfig(configPath);
    expect(config.providers.deepseek?.apiKey).toBe("${GF_M150_KEY}");
    expect(config.graphPolicy.mcpApiKey).toBe("team-token");
    expect(providerHasCredentials("deepseek", config)).toBe(false);
    process.env.GF_M150_KEY = "sk-late";
    expect(providerHasCredentials("deepseek", config)).toBe(true);
    expect(resolveConfigSecret(config.providers.deepseek?.apiKey)).toBe("sk-late");
  });

  it("settings save persists references (never expanded values) and reports resolution", () => {
    const configPath = writeProjectConfig(root);
    process.env.GF_M150_KEY = "sk-secret-value";
    process.env.GF_M150_TOKEN = "team-token-value";
    process.env.TYPESAFE_API_KEY = "ts-secret-value";

    const loaded = saveGraphFlowSettings(
      {
        ...baseSettings,
        workerType: "typesafe-jev",
        workerBaseUrl: "https://api.typesafe.ai/v1/systemone",
        workerApiKey: "%TYPESAFE_API_KEY%",
      },
      configPath
    );

    const text = readFileSync(configPath, "utf8");
    expect(text).not.toContain("sk-secret-value");
    expect(text).not.toContain("team-token-value");
    expect(text).not.toContain("ts-secret-value");
    const persisted = JSON.parse(text) as GraphFlowConfig;
    expect(persisted.providers.deepseek?.apiKey).toBe("${GF_M150_KEY}");
    expect(persisted.graphPolicy.mcpApiKey).toBe("${GF_M150_TOKEN}");
    expect(persisted.workerPolicy?.workerConfig?.apiKey).toBe("${TYPESAFE_API_KEY}");

    expect(loaded.workerApiKey).toBe("TYPESAFE_API_KEY");
    expect(loaded.apiKeyStatus?.worker).toEqual({ kind: "env", name: "TYPESAFE_API_KEY", resolved: true });
    expect(loaded.apiKeyStatus?.smart).toEqual({ kind: "env", name: "GF_M150_KEY", resolved: true });
    expect(JSON.stringify(loaded.apiKeyStatus)).not.toContain("secret-value");

    delete process.env.TYPESAFE_API_KEY;
    expect(getGraphFlowSettings(configPath).apiKeyStatus?.worker).toEqual({
      kind: "env",
      name: "TYPESAFE_API_KEY",
      resolved: false,
    });
  });

  it("the configured worker key reaches the TypeSafe client", () => {
    process.env.GF_M150_KEY = "ts-from-worker-ref";
    const config = {
      workerPolicy: {
        workerType: "typesafe-jev",
        workerConfig: { baseUrl: "https://api.typesafe.ai/v1/systemone/", apiKey: "${GF_M150_KEY}", model: "typesafe-jev" },
      },
    } as unknown as GraphFlowConfig;
    const options = typesafeClientOptionsFromConfig(config);
    expect(options.apiKey).toBe("ts-from-worker-ref");
    expect(options.model).toBeUndefined();
    const creds = resolveTypesafeCredentials(options);
    expect(creds.baseUrl).toBe("https://api.typesafe.ai");
    expect(creds.apiKey).toBe("ts-from-worker-ref");

    const local = typesafeClientOptionsFromConfig({
      workerPolicy: { workerType: "local-command", workerConfig: { baseUrl: "http://127.0.0.1:8000/v1", apiKey: "x" } },
    } as unknown as GraphFlowConfig);
    expect(local).toEqual({});
  });

  it("normalizes pasted System One endpoints", () => {
    expect(normalizeTypesafeBaseUrl("https://api.typesafe.ai/v1/systemone")).toBe("https://api.typesafe.ai");
    expect(normalizeTypesafeBaseUrl("https://api.typesafe.ai/v1/")).toBe("https://api.typesafe.ai");
    expect(normalizeTypesafeBaseUrl("https://api.typesafe.ai")).toBe("https://api.typesafe.ai");
  });

  it("describes key fields without leaking values", () => {
    expect(describeApiKeyInput("")).toEqual({ kind: "empty" });
    expect(describeApiKeyInput("sk-literal-1234")).toEqual({ kind: "literal" });
    expect(describeApiKeyInput("GF_M150_MISSING")).toEqual({ kind: "env", name: "GF_M150_MISSING", resolved: false });
  });

  it.runIf(process.platform === "win32")("falls back to the persisted Windows environment", () => {
    const savedOs = process.env.OS;
    const savedFlag = process.env.GRAPHFLOW_NO_REGISTRY_ENV;
    try {
      delete process.env.OS;
      process.env.GRAPHFLOW_NO_REGISTRY_ENV = "1";
      expect(readEnvVar("OS")).toBeUndefined();
      process.env.GRAPHFLOW_NO_REGISTRY_ENV = "0";
      resetRegistryEnvCache();
      expect(readEnvVar("OS")).toBe("Windows_NT");
      expect(process.env.OS).toBe("Windows_NT");
    } finally {
      if (savedOs === undefined) delete process.env.OS;
      else process.env.OS = savedOs;
      process.env.GRAPHFLOW_NO_REGISTRY_ENV = savedFlag ?? "1";
      resetRegistryEnvCache();
    }
  }, 30_000);
});
