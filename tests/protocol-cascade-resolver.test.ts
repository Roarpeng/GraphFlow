import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isLocalhostEndpoint,
  detectApiKeyFromEndpoint,
  detectApiKeyEnvNameFromEndpoint,
  applyProviderEnvFromConfig,
} from "../src/config/provider-env";
import {
  providerHasCredentials,
  hasUsableLlmProvider,
} from "../src/config/llm-availability";
import {
  executeOpenAiCompatible,
  executeAnthropicCompatible,
  executeGenericProtocol,
  buildOpenAiRequestBody,
  buildAnthropicRequestBody,
} from "../src/routing/protocol-driver";
import type { GraphFlowConfig } from "../src/config/schema";

describe("Protocol cascade and localhost password-free sniffing", () => {
  const ENV_KEYS = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GRAPHFLOW_OPENAI_STRICT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "GRAPHFLOW_ANTHROPIC_STRICT",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "TYPESAFE_API_KEY",
    "BAILIAN_API_KEY",
    "DOUBAO_API_KEY",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "API_KEY",
  ] as const;

  const savedEnv = new Map<string, string | undefined>();

  function clearAllLlmEnv(): void {
    for (const key of ENV_KEYS) {
      if (!savedEnv.has(key)) {
        savedEnv.set(key, process.env[key]);
      }
      delete process.env[key];
    }
  }

  beforeEach(() => {
    clearAllLlmEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
  });

  function makeMockConfig(overrides?: Partial<GraphFlowConfig>): GraphFlowConfig {
    return {
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 100000 },
      graphPolicy: {
        enableAutoBuild: true,
        transport: "memory",
        maxContextTokens: 8000,
      },
      learningPolicy: {
        enableFlywheel: false,
        trainingCadence: "weekly",
        exportPath: ".graphflow/training",
      },
      ...overrides,
    };
  }

  describe("1. Localhost password-free endpoint recognition", () => {
    it("recognizes various localhost / loopback endpoints", () => {
      expect(isLocalhostEndpoint("http://localhost:11434")).toBe(true);
      expect(isLocalhostEndpoint("http://localhost:8000/v1")).toBe(true);
      expect(isLocalhostEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
      expect(isLocalhostEndpoint("http://0.0.0.0:8080/v1")).toBe(true);
      expect(isLocalhostEndpoint("http://[::1]:8080")).toBe(true);
      expect(isLocalhostEndpoint("http://test.localhost:3000")).toBe(true);
      expect(isLocalhostEndpoint("http://service.local:8080")).toBe(true);

      // Non-localhost endpoints
      expect(isLocalhostEndpoint("https://api.openai.com/v1")).toBe(false);
      expect(isLocalhostEndpoint("https://api.deepseek.com")).toBe(false);
      expect(isLocalhostEndpoint("https://my-remote-llm.corp.net")).toBe(false);
      expect(isLocalhostEndpoint("")).toBe(false);
      expect(isLocalhostEndpoint(undefined)).toBe(false);
    });

    it("marks provider as usable when configured with localhost endpoint without any apiKey", () => {
      const config = makeMockConfig({
        providers: {
          openai: { baseUrl: "http://127.0.0.1:11434/v1" },
        },
      });

      expect(providerHasCredentials("openai", config)).toBe(true);
      expect(hasUsableLlmProvider(config)).toBe(true);
    });

    it("executes OpenAI-compatible request on localhost without Bearer header when apiKey is omitted", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      let capturedUrl = "";

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedHeaders = init?.headers as Record<string, string>;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                {
                  message: { role: "assistant", content: "Hello from local model!" },
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 6 },
            }),
            text: async () => "{}",
          } as unknown as Response;
        })
      );

      const result = await executeOpenAiCompatible(
        { prompt: "Hi local LLM", model: "llama3" },
        { baseUrl: "http://127.0.0.1:11434/v1" }
      );

      expect(capturedUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders!["content-type"]).toBe("application/json");
      expect(capturedHeaders!["authorization"]).toBeUndefined();
      expect(result.content).toBe("Hello from local model!");
      expect(result.usage?.promptTokens).toBe(12);
      expect(result.usage?.completionTokens).toBe(6);
    });

    it("executes Anthropic-compatible request on localhost omitting x-api-key header when apiKey is omitted", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      let capturedUrl = "";

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedHeaders = init?.headers as Record<string, string>;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              content: [{ type: "text", text: "Hello from local anthropic compatible!" }],
              usage: { input_tokens: 8, output_tokens: 5 },
            }),
            text: async () => "{}",
          } as unknown as Response;
        })
      );

      const result = await executeAnthropicCompatible(
        { prompt: "Hi claude", model: "local-claude" },
        { baseUrl: "http://localhost:8000" }
      );

      expect(capturedUrl).toBe("http://localhost:8000/v1/messages");
      expect(capturedHeaders!["x-api-key"]).toBeUndefined();
      expect(capturedHeaders!["anthropic-version"]).toBe("2023-06-01");
      expect(result.content).toBe("Hello from local anthropic compatible!");
    });
  });

  describe("2. Domain characteristic environment variable auto-binding", () => {
    it("detects env key name from endpoint domain characteristics", () => {
      expect(detectApiKeyEnvNameFromEndpoint("https://api.deepseek.com/v1")).toBe("DEEPSEEK_API_KEY");
      expect(detectApiKeyEnvNameFromEndpoint("https://deepseek.com")).toBe("DEEPSEEK_API_KEY");
      expect(detectApiKeyEnvNameFromEndpoint("https://gateway.typesafe.com")).toBe("TYPESAFE_API_KEY");
      expect(detectApiKeyEnvNameFromEndpoint("https://api.jev.ai/v1")).toBe("TYPESAFE_API_KEY");
      expect(detectApiKeyEnvNameFromEndpoint("https://api.openai.com/v1")).toBe("OPENAI_API_KEY");
      expect(detectApiKeyEnvNameFromEndpoint("https://api.anthropic.com/v1")).toBe("ANTHROPIC_API_KEY");
      expect(detectApiKeyEnvNameFromEndpoint("https://custom-domain.com")).toBeUndefined();
    });

    it("sniffs matching API key from environment based on endpoint domain", () => {
      process.env.DEEPSEEK_API_KEY = "ds-secret-key";
      expect(detectApiKeyFromEndpoint("https://api.deepseek.com")).toBe("ds-secret-key");

      process.env.TYPESAFE_API_KEY = "ts-secret-key";
      expect(detectApiKeyFromEndpoint("https://gateway.typesafe.com")).toBe("ts-secret-key");
      expect(detectApiKeyFromEndpoint("https://jev-service.internal")).toBe("ts-secret-key");

      process.env.OPENAI_API_KEY = "openai-secret-key";
      expect(detectApiKeyFromEndpoint("https://api.openai.com/v1")).toBe("openai-secret-key");

      process.env.ANTHROPIC_API_KEY = "anthropic-secret-key";
      expect(detectApiKeyFromEndpoint("https://api.anthropic.com")).toBe("anthropic-secret-key");
    });

    it("falls back to LLM_API_KEY or API_KEY for custom domain endpoints", () => {
      process.env.LLM_API_KEY = "custom-llm-key";
      expect(detectApiKeyFromEndpoint("https://custom-ai.company.org/v1")).toBe("custom-llm-key");

      delete process.env.LLM_API_KEY;
      process.env.API_KEY = "general-api-key";
      expect(detectApiKeyFromEndpoint("https://another-ai.org/v1")).toBe("general-api-key");
    });

    it("automatically binds detected environment variables via applyProviderEnvFromConfig", () => {
      process.env.DEEPSEEK_API_KEY = "pre-set-ds-key";

      const config = makeMockConfig({
        providers: {
          custom_ds: {
            baseUrl: "https://api.deepseek.com",
          },
          custom_ai: {
            baseUrl: "https://my-llm-gateway.corp.net",
            apiKey: "corp-secret",
          },
        },
      });

      const applied = applyProviderEnvFromConfig(config);

      expect(process.env.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
      expect(process.env.LLM_BASE_URL).toBe("https://my-llm-gateway.corp.net");
      expect(process.env.LLM_API_KEY).toBe("corp-secret");
      expect(applied).toContain("DEEPSEEK_BASE_URL");
      expect(applied).toContain("LLM_BASE_URL");
      expect(applied).toContain("LLM_API_KEY");
    });
  });

  describe("3. Generic OpenAI-compatible request body construction", () => {
    it("builds correct request body with prompt converted to user message", () => {
      const body = buildOpenAiRequestBody({
        prompt: "Explain quantum computing",
        model: "gpt-4.1",
        temperature: 0.7,
        maxTokens: 1024,
      });

      expect(body.model).toBe("gpt-4.1");
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1024);
      expect(body.messages).toEqual([{ role: "user", content: "Explain quantum computing" }]);
    });

    it("preserves explicit multi-turn messages and response_format/tools", () => {
      const messages = [
        { role: "system" as const, content: "You are an assistant." },
        { role: "user" as const, content: "Give me JSON." },
      ];
      const tools = [
        {
          type: "function" as const,
          function: {
            name: "test_fn",
            description: "test",
            parameters: {},
          },
        },
      ];

      const body = buildOpenAiRequestBody({
        prompt: "fallback prompt",
        model: "gpt-4.1",
        messages,
        responseFormat: { type: "json_object" },
        tools,
      });

      expect(body.messages).toEqual(messages);
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.tools).toEqual(tools);
    });

    it("builds correct Anthropic request body splitting system message to top-level", () => {
      const messages = [
        { role: "system" as const, content: "System prompt instructions" },
        { role: "user" as const, content: "User prompt" },
      ];

      const body = buildAnthropicRequestBody({
        prompt: "fallback",
        model: "claude-3-7-sonnet",
        messages,
        maxTokens: 2048,
        temperature: 0.2,
      });

      expect(body.model).toBe("claude-3-7-sonnet");
      expect(body.system).toBe("System prompt instructions");
      expect(body.messages).toEqual([{ role: "user", content: "User prompt" }]);
      expect(body.max_tokens).toBe(2048);
    });

    it("handles reasoning_content and tool_calls in OpenAI-compatible response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Final answer",
                    reasoning_content: "Deep thinking steps...",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "search", arguments: '{"q":"test"}' },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 50,
                completion_tokens: 30,
              },
            }),
            text: async () => "{}",
          } as unknown as Response;
        })
      );

      const result = await executeOpenAiCompatible(
        { prompt: "Solve mystery", model: "deepseek-r1" },
        { baseUrl: "http://127.0.0.1:8000/v1" }
      );

      expect(result.content).toBe("Final answer");
      expect(result.reasoningContent).toBe("Deep thinking steps...");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].function.name).toBe("search");
      expect(result.usage?.promptTokens).toBe(50);
      expect(result.usage?.completionTokens).toBe(30);
    });
  });

  describe("4. Smooth bridge mode fallback when no key and no service", () => {
    it("providerHasCredentials returns false when remote endpoint has no key", () => {
      const config = makeMockConfig({
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1" },
        },
      });

      expect(providerHasCredentials("openai", config)).toBe(false);
      expect(hasUsableLlmProvider(config)).toBe(false);
    });

    it("executeOpenAiCompatible smoothly enters bridge fallback instead of crashing when non-strict", async () => {
      const result = await executeOpenAiCompatible(
        { prompt: "Write code", model: "remote-model" },
        { baseUrl: "https://api.openai.com/v1", strict: false }
      );

      expect(result.content).toBe("[openai-compatible:remote-model] Write code");
    });

    it("executeOpenAiCompatible throws clear error in strict mode when key is missing on remote endpoint", async () => {
      await expect(
        executeOpenAiCompatible(
          { prompt: "Write code", model: "remote-model" },
          { baseUrl: "https://api.openai.com/v1", strict: true }
        )
      ).rejects.toThrow("API key is required for non-localhost OpenAI-compatible endpoint");
    });

    it("executeAnthropicCompatible smoothly enters bridge fallback when non-strict", async () => {
      const result = await executeAnthropicCompatible(
        { prompt: "Write poem", model: "claude-haiku" },
        { baseUrl: "https://api.anthropic.com", strict: false }
      );

      expect(result.content).toBe("[anthropic-compatible:claude-haiku] Write poem");
    });

    it("executeAnthropicCompatible throws in strict mode when key is missing on remote endpoint", async () => {
      await expect(
        executeAnthropicCompatible(
          { prompt: "Write poem", model: "claude-haiku" },
          { baseUrl: "https://api.anthropic.com", strict: true }
        )
      ).rejects.toThrow("API key is required for non-localhost Anthropic-compatible endpoint");
    });

    it("executeGenericProtocol correctly dispatches to OpenAI or Anthropic protocol", async () => {
      const openAiRes = await executeGenericProtocol(
        "openai-compatible",
        { prompt: "Hello", model: "m1" },
        { baseUrl: "https://api.openai.com/v1", strict: false }
      );
      expect(openAiRes.content).toContain("[openai-compatible:m1]");

      const anthropicRes = await executeGenericProtocol(
        "anthropic-compatible",
        { prompt: "Hello", model: "m2" },
        { baseUrl: "https://api.anthropic.com", strict: false }
      );
      expect(anthropicRes.content).toContain("[anthropic-compatible:m2]");
    });
  });
});
