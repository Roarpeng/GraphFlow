import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "API_KEY",
] as const;

// Everything that can point config discovery at a real machine/repo layer.
const ISOLATION_ENV_VARS = [
  "GRAPHFLOW_CONFIG_HOME",
  "GRAPHFLOW_WORKSPACE_ROOT",
  "USERPROFILE",
  "HOME",
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

  const savedIsolationEnv: Record<string, string | undefined> = {};
  let savedCwd = process.cwd();

  function createTempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
    // "彻底清空所有环境变量与配置" must not read ANY real config layer: the
    // global ~/.graphflow.config.json (GRAPHFLOW_CONFIG_HOME / home) nor the
    // cwd project layers (resolveConfig() reads ./graphflow.config.json and
    // ./.graphflow/config.json — the repo's own files carry a live key, which
    // applyProviderEnvFromConfig would export and mark config-exported, so
    // later genuine test keys would be ignored).
    for (const key of ISOLATION_ENV_VARS) {
      savedIsolationEnv[key] = process.env[key];
    }
    const home = createTempDir("gf-bridge-home-");
    const project = createTempDir("gf-bridge-project-");
    writeFileSync(join(project, "package.json"), '{"name":"gf-bridge-fixture","private":true}\n', "utf8");
    process.env.GRAPHFLOW_CONFIG_HOME = home;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    process.env.GRAPHFLOW_WORKSPACE_ROOT = project;
    savedCwd = process.cwd();
    process.chdir(project);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const key of ISOLATION_ENV_VARS) {
      const value = savedIsolationEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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

    it("TYPESAFE_API_KEY 不再被别名为 DeepSeek 凭证（不同厂商，别名只会产生 401）", () => {
      clearAllLlmEnv();
      process.env.TYPESAFE_API_KEY = "sk-test-typesafe-credential";
      process.env.TYPESAFE_BASE_URL = "https://api.typesafe-mock.com/v1";

      const resolved = resolveConfig();
      expect(providerHasCredentials("deepseek", resolved)).toBe(false);
      expect(hasUsableLlmProvider(resolved)).toBe(false);
      // Boolean-only assertions: a failure must never print a credential.
      expect(Boolean(process.env.DEEPSEEK_API_KEY)).toBe(false);
      expect(Boolean(process.env.DEEPSEEK_BASE_URL)).toBe(false);

      const configWithProvider = {
        ...getDefaultConfig(),
        providers: {
          deepseek: { model: "deepseek-chat" },
        },
      };
      expect(providerHasCredentials("deepseek", configWithProvider)).toBe(false);
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
