import { afterEach, describe, expect, it, vi } from "vitest";

import { deepseekGenerateTextDetailed } from "../src/routing/provider-adapters/deepseek";
import { openaiGenerateText } from "../src/routing/provider-adapters/openai";
import { anthropicGenerateText } from "../src/routing/provider-adapters/anthropic";
import { bailianGenerateText } from "../src/routing/provider-adapters/bailian";
import { doubaoGenerateText } from "../src/routing/provider-adapters/doubao";

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("M103 provider adapters (stubbed fetch)", () => {
  const ENV_KEYS = [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "GRAPHFLOW_DEEPSEEK_STRICT",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GRAPHFLOW_OPENAI_STRICT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "GRAPHFLOW_ANTHROPIC_STRICT",
    "BAILIAN_API_KEY",
    "BAILIAN_BASE_URL",
    "GRAPHFLOW_BAILIAN_STRICT",
    "DOUBAO_API_KEY",
    "DOUBAO_BASE_URL",
    "GRAPHFLOW_DOUBAO_STRICT",
  ] as const;
  const saved = new Map<string, string | undefined>();

  function saveAndClearEnv(): void {
    for (const key of ENV_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("every adapter falls back to a deterministic placeholder when no key is configured", async () => {
    saveAndClearEnv();
    expect(await deepseekGenerateTextDetailed({ prompt: "hi", model: "ds-x" })).toEqual({
      content: "[deepseek:ds-x] hi",
    });
    expect(await openaiGenerateText({ prompt: "hi", model: "oai-x" })).toBe("[openai:oai-x] hi");
    expect(await anthropicGenerateText({ prompt: "hi", model: "ant-x" })).toBe("[anthropic:ant-x] hi");
    expect(await bailianGenerateText({ prompt: "hi", model: "bl-x" })).toBe("[bailian:bl-x] hi");
    expect(await doubaoGenerateText({ prompt: "hi", model: "db-x" })).toBe("[doubao:db-x] hi");
  });

  it("strict mode throws instead of falling back when the key is missing", async () => {
    saveAndClearEnv();
    process.env.GRAPHFLOW_DEEPSEEK_STRICT = "1";
    process.env.GRAPHFLOW_OPENAI_STRICT = "1";
    process.env.GRAPHFLOW_ANTHROPIC_STRICT = "1";
    process.env.GRAPHFLOW_BAILIAN_STRICT = "1";
    process.env.GRAPHFLOW_DOUBAO_STRICT = "1";
    await expect(
      deepseekGenerateTextDetailed({ prompt: "hi", model: "ds-x" })
    ).rejects.toThrow("DEEPSEEK_API_KEY is required");
    await expect(openaiGenerateText({ prompt: "hi", model: "oai-x" })).rejects.toThrow(
      "OPENAI_API_KEY is required"
    );
    await expect(anthropicGenerateText({ prompt: "hi", model: "ant-x" })).rejects.toThrow(
      "ANTHROPIC_API_KEY is required"
    );
    await expect(bailianGenerateText({ prompt: "hi", model: "bl-x" })).rejects.toThrow(
      "BAILIAN_API_KEY is required"
    );
    await expect(doubaoGenerateText({ prompt: "hi", model: "db-x" })).rejects.toThrow(
      "DOUBAO_API_KEY is required"
    );
  });

  it("deepseek adapter parses content, usage, and the raw assistant message", async () => {
    saveAndClearEnv();
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "  answer  " } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deepseekGenerateTextDetailed({
      prompt: "q",
      model: "deepseek-v4-pro",
      maxTokens: 256,
      temperature: 0.4,
    });
    expect(result.content).toBe("answer");
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
    // rawAssistantMessage preserves the untrimmed wire content by design.
    expect(result.rawAssistantMessage).toMatchObject({ role: "assistant", content: "  answer  " });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.4);
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-test" });
  });

  it("deepseek adapter omits temperature under thinking mode and forwards tools", async () => {
    saveAndClearEnv();
    process.env.DEEPSEEK_API_KEY = "sk-test";
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "t1", type: "function", function: { name: "f", arguments: "{}" } },
              ],
            },
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deepseekGenerateTextDetailed({
      prompt: "q",
      model: "deepseek-v4-pro",
      thinking: "enabled",
      reasoningEffort: "high",
      tools: [
        {
          type: "function",
          function: { name: "f", description: "d", parameters: { type: "object" } },
        },
      ],
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.reasoningContent).toBeUndefined();

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect("temperature" in body ? body.temperature : undefined).toBeUndefined();
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("deepseek adapter prefers explicit messages over prompt and honors custom base URL", async () => {
    saveAndClearEnv();
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.DEEPSEEK_BASE_URL = "https://mirror.example/v1/";
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    await deepseekGenerateTextDetailed({
      prompt: "unused",
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mirror.example/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as { messages: unknown[] };
    expect(body.messages).toHaveLength(2);
  });

  it("deepseek adapter maps tool-call-only responses without throwing", async () => {
    saveAndClearEnv();
    process.env.DEEPSEEK_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "t1", type: "function", function: { name: "f", arguments: "{}" } },
                ],
              },
            },
          ],
        })
      )
    );
    const result = await deepseekGenerateTextDetailed({ prompt: "q", model: "m" });
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("openai adapter parses content and sends OpenAI-style headers/body", async () => {
    saveAndClearEnv();
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.OPENAI_BASE_URL = "https://proxy.example/v1";
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { role: "assistant", content: "hi there" } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const content = await openaiGenerateText({ prompt: "q", model: "gpt-4.1", maxTokens: 64 });
    expect(content).toBe("hi there");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.example/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-openai" });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(64);
  });

  it("anthropic adapter sends x-api-key headers and extracts the first text block", async () => {
    saveAndClearEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({
        content: [
          { type: "tool_use", id: "x" },
          { type: "text", text: "  anthropic says hi  " },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const content = await anthropicGenerateText({ prompt: "q", model: "claude-x" });
    expect(content).toBe("anthropic says hi");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant" });
  });

  it("bailian adapter falls back to choices[0].text and honors custom base URL", async () => {
    saveAndClearEnv();
    process.env.BAILIAN_API_KEY = "sk-bailian";
    process.env.BAILIAN_BASE_URL = "https://bailian.example/compatible-mode/v1";
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "msg" } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ text: "legacy text" }] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await bailianGenerateText({ prompt: "q", model: "qwen-x" })).toBe("msg");
    expect(await bailianGenerateText({ prompt: "q", model: "qwen-x" })).toBe("legacy text");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://bailian.example/compatible-mode/v1/chat/completions");
  });

  it("doubao adapter parses message content from the ark endpoint", async () => {
    saveAndClearEnv();
    process.env.DOUBAO_API_KEY = "sk-doubao";
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "doubao ok" } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await doubaoGenerateText({ prompt: "q", model: "doubao-seed" })).toBe("doubao ok");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  });

  it("HTTP errors are rethrown in strict mode and swallowed into the placeholder otherwise", async () => {
    saveAndClearEnv();
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.GRAPHFLOW_DEEPSEEK_STRICT = "1";

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>().mockResolvedValue(jsonResponse({ error: "boom" }, 500))
    );
    await expect(deepseekGenerateTextDetailed({ prompt: "q", model: "m" })).rejects.toThrow(
      /deepseek http 500/
    );

    await expect(openaiGenerateText({ prompt: "q", model: "m" })).resolves.toBe("[openai:m] q");
  });

  it("empty responses throw a missing-content error which non-strict mode swallows", async () => {
    saveAndClearEnv();
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.GRAPHFLOW_OPENAI_STRICT = "1";

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "" } }] }))
    );
    await expect(openaiGenerateText({ prompt: "q", model: "m" })).rejects.toThrow(
      "openai response missing content"
    );
    await expect(anthropicGenerateText({ prompt: "q", model: "m" })).resolves.toBe(
      "[anthropic:m] q"
    );
  });

  it("an already-aborted request signal propagates instead of falling back", async () => {
    saveAndClearEnv();
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.GRAPHFLOW_OPENAI_STRICT = "1";
    const controller = new AbortController();
    controller.abort();

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>().mockRejectedValue(new DOMException("aborted", "AbortError"))
    );
    await expect(
      openaiGenerateText({ prompt: "q", model: "m", signal: controller.signal })
    ).rejects.toThrow();
  });
});
