import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { resolveConfig } from "../src/config/resolve";
import { hasUsableLlmProvider, providerHasCredentials } from "../src/config/llm-availability";
import {
  runTask,
  runTaskResult,
  planAndBrainstormResult,
  planInsightResult,
  diagnoseRoutingResult,
} from "../src/surfaces/cli/runtime/routing";

const LLM_ENV_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "BAILIAN_API_KEY",
  "BAILIAN_BASE_URL",
  "DOUBAO_API_KEY",
  "DOUBAO_BASE_URL",
] as const;

describe("Bridge Fallback Guarantee & LLM Availability (工作 1)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const tempDirs: string[] = [];

  function clearAllLlmEnv(): void {
    for (const key of LLM_ENV_VARS) {
      if (!(key in savedEnv)) {
        savedEnv[key] = process.env[key];
      }
      delete process.env[key];
    }
  }

  function restoreLlmEnv(): void {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  const GRAPHFLOW_CONFIG_HOME_KEY = "GRAPHFLOW_CONFIG_HOME";

  function createTempConfigHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "gf-bridge-home-"));
    tempDirs.push(dir);
    return dir;
  }

  function createTempConfig(configObj: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "gf-bridge-test-"));
    tempDirs.push(dir);
    const configPath = join(dir, "graphflow.config.json");
    writeFileSync(configPath, JSON.stringify(configObj, null, 2), "utf8");
    return configPath;
  }

  beforeEach(() => {
    clearAllLlmEnv();
    // Isolate the GLOBAL config layer too: "彻底清空所有环境变量与配置" must
    // not read this machine's real ~/.graphflow.config.json (a machine with a
    // live key would legitimately answer "usable" and fail the guarantee).
    // GRAPHFLOW_CONFIG_HOME is the established isolation knob (see m49).
    if (!(GRAPHFLOW_CONFIG_HOME_KEY in savedEnv)) {
      savedEnv[GRAPHFLOW_CONFIG_HOME_KEY] = process.env[GRAPHFLOW_CONFIG_HOME_KEY];
    }
    process.env[GRAPHFLOW_CONFIG_HOME_KEY] = createTempConfigHome();
  });

  afterEach(() => {
    const savedHome = savedEnv[GRAPHFLOW_CONFIG_HOME_KEY];
    if (savedHome === undefined) {
      delete process.env[GRAPHFLOW_CONFIG_HOME_KEY];
    } else {
      process.env[GRAPHFLOW_CONFIG_HOME_KEY] = savedHome;
    }
    restoreLlmEnv();
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    }
    tempDirs.length = 0;
  });

  describe("1. 无任何 LLM 凭证时的绝对可用性与平滑降级保障", () => {
    it("彻底清空所有环境变量与配置时，hasUsableLlmProvider 严格返回 false", () => {
      clearAllLlmEnv();
      const defaultConfig = getDefaultConfig();
      expect(hasUsableLlmProvider(defaultConfig)).toBe(false);

      const resolved = resolveConfig();
      expect(hasUsableLlmProvider(resolved)).toBe(false);
    });

    it("全链路执行入口 runTaskResult 在无 LLM 时严格平滑走 bridge 模式，状态统一为 DELEGATED", async () => {
      clearAllLlmEnv();
      const task = "analyze repository structure and summarize modules";
      const summary = await runTaskResult(task);

      expect(summary.status).toBe("DELEGATED");
      expect(summary.attempts).toBe(0);
      expect(summary.feedback).toContain("[DELEGATED]");
      expect(summary.executionDescriptor).toBeDefined();
      expect(summary.executionDescriptor?.action).toBe("execute");
      expect(summary.executionDescriptor?.task).toBe(task);
      expect(summary.executionDescriptor?.context).toBeDefined();

      // 保留纯 Layer A Advisory
      expect(summary.advisory).toBeDefined();
      expect(summary.advisory?.mode).toBe("shadow");
      expect(summary.advisory?.decision.provenance).toBe("deterministic");
      expect(summary.advisory?.decision.llmCalls).toBe(0);
    });

    it("复杂任务在无 LLM 时同样平滑走 bridge 模式，保留 AST 上下文与 Layer A Advisory", async () => {
      clearAllLlmEnv();
      const task = "Refactor user authentication system across all modules and migrate database schema";
      const summary = await runTaskResult(task);

      expect(summary.status).toBe("DELEGATED");
      expect(summary.attempts).toBe(0);
      expect(summary.feedback).toContain("[DELEGATED]");
      expect(summary.executionDescriptor).toBeDefined();
      expect(summary.executionDescriptor?.action).toBe("execute");
      expect(summary.executionDescriptor?.context).toBeDefined();

      // 验证 Advisory 存在且为 Layer A 纯确定性
      expect(summary.advisory).toBeDefined();
      expect(summary.advisory?.mode).toBe("shadow");
      expect(summary.advisory?.decision.provenance).toBe("deterministic");
      expect(summary.advisory?.decision.llmCalls).toBe(0);
    });

    it("runTask 在无 LLM 时返回 status=DELEGATED，决不抛错", async () => {
      clearAllLlmEnv();
      const output = await runTask("inspect code health and report dependencies");
      expect(output).toContain("status=DELEGATED");
      expect(output).toContain("attempts=0");
    });

    it("planAndBrainstormResult 在无 LLM 时平滑返回 no-llm-bridge 委托计划", async () => {
      clearAllLlmEnv();
      const plan = await planAndBrainstormResult("implement caching layer for API responses");
      expect(plan.requiresAgentBridge).toBe(true);
      expect(plan.complete).toBe(false);
      expect(plan.planSource).toBe("no-llm-bridge");
      expect(plan.nodes.length).toBeGreaterThan(0);
    });

    it("planInsightResult 在无 LLM 时平滑返回 agent-delegated 六顶思考帽工单", async () => {
      clearAllLlmEnv();
      const insight = await planInsightResult("design high-concurrency message queue architecture");
      expect(insight.mode).toBe("agent-delegated");
      expect(insight.requiresAgentBridge).toBe(true);
      expect(insight.status).toBe("awaiting-agent");
      expect(insight.agentWorkItems).toBeDefined();
      expect(insight.agentWorkItems?.length).toBeGreaterThan(0);
    });

    it("diagnoseRoutingResult 在无 LLM 时诊断报告完整，无未捕获异常", () => {
      clearAllLlmEnv();
      const diagnosis = diagnoseRoutingResult();
      expect(diagnosis).toBeDefined();
      expect(diagnosis.health.openai).toBe(false);
      expect(diagnosis.health.deepseek).toBe(false);
    });
  });

  describe("2. 凭证嗅探与可用 LLM 正确识别", () => {
    it("环境中存在 DEEPSEEK_API_KEY 时，能够正确识别为可用 LLM，不再发生误判", () => {
      clearAllLlmEnv();
      process.env.DEEPSEEK_API_KEY = "sk-test-deepseek-credential";

      const resolved = resolveConfig();
      expect(hasUsableLlmProvider(resolved)).toBe(true);
      expect(providerHasCredentials("deepseek", resolved)).toBe(true);
      expect(resolved.providers.deepseek?.apiKey).toBeDefined();

      const configWithProvider = {
        ...getDefaultConfig(),
        providers: {
          deepseek: { model: "deepseek-chat" },
        },
      };
      expect(hasUsableLlmProvider(configWithProvider)).toBe(true);
      expect(providerHasCredentials("deepseek", configWithProvider)).toBe(true);
    });

    it("环境中存在 TYPESAFE_API_KEY 时，能够正确嗅探并作为 DeepSeek 兼容凭证识别为可用 LLM", () => {
      clearAllLlmEnv();
      process.env.TYPESAFE_API_KEY = "sk-test-typesafe-credential";
      process.env.TYPESAFE_BASE_URL = "https://api.typesafe-mock.com/v1";

      const resolved = resolveConfig();
      expect(hasUsableLlmProvider(resolved)).toBe(true);
      expect(providerHasCredentials("deepseek", resolved)).toBe(true);
      expect(process.env.DEEPSEEK_API_KEY).toBe("sk-test-typesafe-credential");
      expect(process.env.DEEPSEEK_BASE_URL).toBe("https://api.typesafe-mock.com/v1");

      const configWithProvider = {
        ...getDefaultConfig(),
        providers: {
          deepseek: { model: "deepseek-chat" },
        },
      };
      expect(hasUsableLlmProvider(configWithProvider)).toBe(true);
      expect(providerHasCredentials("deepseek", configWithProvider)).toBe(true);
    });

    it("环境中存在 OPENAI_API_KEY 时，能够正确识别为可用 LLM", () => {
      clearAllLlmEnv();
      process.env.OPENAI_API_KEY = "sk-test-openai-credential";

      const resolved = resolveConfig();
      expect(hasUsableLlmProvider(resolved)).toBe(true);
      expect(providerHasCredentials("openai", resolved)).toBe(true);

      const configWithProvider = {
        ...getDefaultConfig(),
        providers: {
          openai: { model: "gpt-4o" },
        },
      };
      expect(hasUsableLlmProvider(configWithProvider)).toBe(true);
      expect(providerHasCredentials("openai", configWithProvider)).toBe(true);
    });

    it("当用户配置文件缺少 apiKey 字段时，环境变量凭证能够被正确嗅探，不产生静默降级", () => {
      clearAllLlmEnv();
      process.env.DEEPSEEK_API_KEY = "sk-test-env-key";

      // 模拟用户配置中声明了 deepseek provider 但没有写 apiKey 字段
      const configPath = createTempConfig({
        ...getDefaultConfig(),
        providers: {
          deepseek: {
            model: "deepseek-v4-pro",
            temperature: 0.2,
          },
        },
        tiers: {
          smart: { provider: "deepseek" },
          economy: { provider: "deepseek" },
        },
      });

      const resolved = resolveConfig(configPath);
      expect(hasUsableLlmProvider(resolved)).toBe(true);
      expect(providerHasCredentials("deepseek", resolved)).toBe(true);
    });

    it("用户配置显式关闭时（如 apiKey 为空字符串或 disabled），严格遵守用户意图不自动使用环境变量", () => {
      clearAllLlmEnv();
      process.env.DEEPSEEK_API_KEY = "sk-test-env-key";

      // 显式配置 apiKey 为 ""
      const configPathEmpty = createTempConfig({
        ...getDefaultConfig(),
        routingPolicy: { enableDynamicRouting: false },
        tiers: {
          smart: { provider: "deepseek" },
          economy: { provider: "deepseek" },
        },
        providers: {
          deepseek: {
            apiKey: "",
          },
        },
      });
      const resolvedEmpty = resolveConfig(configPathEmpty);
      expect(providerHasCredentials("deepseek", resolvedEmpty)).toBe(false);
      expect(hasUsableLlmProvider(resolvedEmpty)).toBe(false);

      // 显式配置 apiKey 为 "disabled"
      const configPathDisabled = createTempConfig({
        ...getDefaultConfig(),
        routingPolicy: { enableDynamicRouting: false },
        tiers: {
          smart: { provider: "deepseek" },
          economy: { provider: "deepseek" },
        },
        providers: {
          deepseek: {
            apiKey: "disabled",
          },
        },
      });
      const resolvedDisabled = resolveConfig(configPathDisabled);
      expect(providerHasCredentials("deepseek", resolvedDisabled)).toBe(false);
      expect(hasUsableLlmProvider(resolvedDisabled)).toBe(false);

      // 显式配置 enabled: false
      const configPathEnabledFalse = createTempConfig({
        ...getDefaultConfig(),
        routingPolicy: { enableDynamicRouting: false },
        tiers: {
          smart: { provider: "deepseek" },
          economy: { provider: "deepseek" },
        },
        providers: {
          deepseek: {
            enabled: false,
          },
        },
      });
      const resolvedEnabledFalse = resolveConfig(configPathEnabledFalse);
      expect(providerHasCredentials("deepseek", resolvedEnabledFalse)).toBe(false);
      expect(hasUsableLlmProvider(resolvedEnabledFalse)).toBe(false);
    });
  });
});
