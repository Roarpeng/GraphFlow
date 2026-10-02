import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyProviderEnvFromConfig,
  isConfigExportedEnvKey,
  literalApiKeyProblem,
  resolveProviderApiKey,
} from "../src/config/provider-env";
import { resolveConfig } from "../src/config/resolve";
import { validateConfig } from "../src/config/loader";
import { pickChatContent } from "../src/routing/provider-adapters/types";
import { buildProviderRequestForRole } from "../src/routing/role-capabilities";
import { ALL_PROVIDERS } from "../src/routing/provider-health";

describe("M64 DeepSeek provider + config env bridge", () => {
  const saved: Record<string, string | undefined> = {};

  function clearProviderEnv(): void {
    for (const key of [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  function restoreEnv(): void {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  afterEach(() => {
    restoreEnv();
  });

  it("includes deepseek in ALL_PROVIDERS and accepts deepseek in config", () => {
    expect(ALL_PROVIDERS).toContain("deepseek");
    const cfg = validateConfig({
      providers: {
        deepseek: {
          apiKey: "sk-test",
          baseUrl: "https://api.deepseek.com",
        },
      },
      tiers: {
        smart: { provider: "deepseek", model: "deepseek-v4-pro" },
        economy: { provider: "deepseek", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 1500,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/learning-dataset.jsonl",
      },
      routingPolicy: {
        providerPriority: ["deepseek", "openai"],
      },
    });
    expect(cfg.tiers.smart.provider).toBe("deepseek");
    expect(cfg.routingPolicy?.providerPriority).toContain("deepseek");
  });

  it("applyProviderEnvFromConfig fills DEEPSEEK_* when env empty", () => {
    clearProviderEnv();
    const cfg = validateConfig({
      providers: {
        deepseek: {
          apiKey: "sk-from-config",
          baseUrl: "https://api.deepseek.com",
        },
      },
      tiers: {
        smart: { provider: "deepseek", model: "deepseek-v4-pro" },
        economy: { provider: "deepseek", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 1500,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/x.jsonl",
      },
    });
    const applied = applyProviderEnvFromConfig(cfg);
    expect(applied).toEqual(expect.arrayContaining(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]));
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-from-config");
    expect(process.env.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
  });

  it("does not override existing env values", () => {
    clearProviderEnv();
    process.env.DEEPSEEK_API_KEY = "sk-env";
    process.env.DEEPSEEK_BASE_URL = "https://custom.example";
    const cfg = validateConfig({
      providers: {
        deepseek: {
          apiKey: "sk-config",
          baseUrl: "https://api.deepseek.com",
        },
      },
      tiers: {
        smart: { provider: "deepseek", model: "deepseek-v4-pro" },
        economy: { provider: "deepseek", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 1500,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/x.jsonl",
      },
    });
    applyProviderEnvFromConfig(cfg);
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-env");
    expect(process.env.DEEPSEEK_BASE_URL).toBe("https://custom.example");
  });

  it("resolveConfig applies provider env from a config file", () => {
    clearProviderEnv();
    const dir = mkdtempSync(join(tmpdir(), "gf-m64-"));
    const path = join(dir, "graphflow.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          deepseek: { apiKey: "sk-file", baseUrl: "https://api.deepseek.com" },
        },
        tiers: {
          smart: { provider: "deepseek", model: "deepseek-v4-flash" },
          economy: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          transport: "memory",
          maxContextTokens: 1500,
        },
        learningPolicy: {
          enableFlywheel: false,
          trainingCadence: "nightly",
          exportPath: "graphflow-out/x.jsonl",
        },
      }),
      "utf8"
    );
    resolveConfig(path);
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-file");
    expect(process.env.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
    rmSync(dir, { recursive: true, force: true });
  });

  it("pickChatContent falls back to reasoning_content", () => {
    const picked = pickChatContent({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            reasoning_content: "thinking then answer: OK",
          },
        },
      ],
    });
    expect(picked.content).toBe("thinking then answer: OK");
    expect(picked.reasoningContent).toBe("thinking then answer: OK");
  });

  it("buildProviderRequestForRole enables thinking+json for deepseek planner", () => {
    const cfg = validateConfig({
      providers: {
        deepseek: {
          apiKey: "sk-x",
          baseUrl: "https://api.deepseek.com",
          thinking: "auto",
        },
      },
      tiers: {
        smart: { provider: "deepseek", model: "deepseek-v4-pro" },
        economy: { provider: "deepseek", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 1500,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/x.jsonl",
      },
    });
    const req = buildProviderRequestForRole(
      "planner",
      "Plan a refactor",
      { provider: "deepseek", model: "deepseek-v4-pro", tier: "smart", fallbackApplied: false },
      cfg,
      { skillHints: ["graphflow"] }
    );
    expect(req.thinking).toBe("enabled");
    expect(req.reasoningEffort).toBe("high");
    expect(req.responseFormat).toEqual({ type: "json_object" });
    expect(req.messages?.[0]?.role).toBe("system");
    expect(req.messages?.[0]?.content).toContain("json");
    expect(req.messages?.[1]?.role).toBe("user");
  });

  it("probe prompts disable thinking and json for deepseek", () => {
    const cfg = validateConfig({
      providers: { deepseek: { apiKey: "sk-x" } },
      tiers: {
        smart: { provider: "deepseek", model: "deepseek-v4-pro" },
        economy: { provider: "deepseek", model: "deepseek-v4-flash" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 1500,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "nightly",
        exportPath: "graphflow-out/x.jsonl",
      },
    });
    const req = buildProviderRequestForRole(
      "planner",
      "Reply with exactly: ok",
      { provider: "deepseek", model: "deepseek-v4-pro", tier: "smart", fallbackApplied: false },
      cfg
    );
    expect(req.thinking).toBe("disabled");
    expect(req.responseFormat).toBeUndefined();
    expect(req.maxTokens).toBe(32);
  });

  describe("env-first key resolution", () => {
    const deepseekViaOpenAi = { apiKey: "sk-stale-literal-0000", baseUrl: "https://api.deepseek.com" };

    it("a genuine vendor env key shadows a stale literal on a cross-vendor entry", () => {
      clearProviderEnv();
      process.env.DEEPSEEK_API_KEY = "sk-genuine-env";
      const r = resolveProviderApiKey("openai", deepseekViaOpenAi);
      expect(r).toMatchObject({ key: "sk-genuine-env", source: "env", envVar: "DEEPSEEK_API_KEY", literalShadowed: true });

      const cfg = validateConfig({
        providers: { openai: deepseekViaOpenAi },
        tiers: {
          smart: { provider: "openai", model: "deepseek-v4-pro" },
          economy: { provider: "openai", model: "deepseek-v4-flash" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: { enableAutoBuild: true, transport: "memory", maxContextTokens: 1500 },
        learningPolicy: { enableFlywheel: false, trainingCadence: "nightly", exportPath: "graphflow-out/x.jsonl" },
      });
      applyProviderEnvFromConfig(cfg);
      expect(process.env.OPENAI_API_KEY).toBe("sk-genuine-env");
      expect(process.env.OPENAI_BASE_URL).toBe("https://api.deepseek.com");
    });

    it("falls back to the literal only when no env key exists", () => {
      clearProviderEnv();
      expect(resolveProviderApiKey("openai", deepseekViaOpenAi)).toMatchObject({
        key: "sk-stale-literal-0000",
        source: "config-literal",
      });
    });

    it("rejects placeholder literals and honours explicit env references", () => {
      clearProviderEnv();
      for (const bad of ["your-api-key", "sk-xxxxxxxx", "<DEEPSEEK_KEY>", "sk abc"]) {
        const r = resolveProviderApiKey("deepseek", { apiKey: bad });
        expect(r.key).toBeUndefined();
        expect(r.literalRejected).toBeTruthy();
        expect(literalApiKeyProblem(bad)).toBeTruthy();
      }
      expect(resolveProviderApiKey("deepseek", { apiKey: "disabled" })).toEqual({});
      process.env.GF_M64_REF = "sk-from-ref";
      try {
        expect(resolveProviderApiKey("deepseek", { apiKey: "${GF_M64_REF}" })).toMatchObject({
          key: "sk-from-ref",
          source: "config-env-ref",
        });
      } finally {
        delete process.env.GF_M64_REF;
      }
    });

    it("a value overwritten after export counts as genuine again", () => {
      clearProviderEnv();
      const cfg = validateConfig({
        providers: { deepseek: { apiKey: "sk-config-literal", baseUrl: "https://api.deepseek.com" } },
        tiers: {
          smart: { provider: "deepseek", model: "deepseek-v4-pro" },
          economy: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: { enableAutoBuild: true, transport: "memory", maxContextTokens: 1500 },
        learningPolicy: { enableFlywheel: false, trainingCadence: "nightly", exportPath: "graphflow-out/x.jsonl" },
      });
      applyProviderEnvFromConfig(cfg);
      expect(isConfigExportedEnvKey("DEEPSEEK_API_KEY")).toBe(true);
      process.env.DEEPSEEK_API_KEY = "sk-shell";
      expect(isConfigExportedEnvKey("DEEPSEEK_API_KEY")).toBe(false);
      applyProviderEnvFromConfig(cfg);
      expect(process.env.DEEPSEEK_API_KEY).toBe("sk-shell");
    });
  });
});
