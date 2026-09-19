import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProviderError,
  __resetProviderCircuitsForTests,
  executeRolePrompt,
  formatPromptWithContext,
} from "../src/routing/provider-executor";
import { runDeepseekToolLoop } from "../src/routing/deepseek-tools";
import type { ModelSelection } from "../src/routing/model-router";

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function chat(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
}

const OPENAI: ModelSelection = {
  provider: "openai",
  model: "gpt-test",
  tier: "smart",
  fallbackApplied: false,
};

describe("M104 provider executor (stubbed fetch)", () => {
  const saved = new Map<string, string | undefined>();
  const ENV_KEYS = [
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GRAPHFLOW_OPENAI_STRICT",
    "GRAPHFLOW_PROVIDER_MAX_RETRIES",
    "GRAPHFLOW_PROVIDER_CIRCUIT_FAILURES",
    "GRAPHFLOW_PROVIDER_CIRCUIT_OPEN_MS",
    "GRAPHFLOW_PROVIDER_TIMEOUT_MS",
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.OPENAI_API_KEY = "sk-exec-test";
    process.env.DEEPSEEK_API_KEY = "sk-exec-ds";
    process.env.GRAPHFLOW_OPENAI_STRICT = "1";
    __resetProviderCircuitsForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    __resetProviderCircuitsForTests();
  });

  it("formatPromptWithContext keeps bare prompts untouched", () => {
    expect(formatPromptWithContext("planner", "Do the thing")).toBe("[role:planner] Do the thing");
  });

  it("formatPromptWithContext renders goal anchors first, then context, skills, notes", () => {
    const text = formatPromptWithContext("implementer", "Refactor it", {
      goalAnchors: ["core: fix the leak", "", "   "],
      summaryChannel: ["src/a.ts defines leaky()", "src/b.ts uses it"],
      skillHints: ["fail-open", "fail-open", "budget-first"],
      extraInstructions: ["write tests"],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("[role:implementer]");
    expect(lines[1]).toContain("Goal anchor");
    expect(lines[2]).toBe("- core: fix the leak");
    expect(lines).toContain("- src/a.ts defines leaky()");
    expect(text).toContain("Skills to apply: fail-open, budget-first");
    expect(lines).toContain("- write tests");
    expect(lines[lines.length - 2]).toBe("Task:");
    expect(lines[lines.length - 1]).toBe("Refactor it");
  });

  it("formatPromptWithContext caps channels at their configured limits", () => {
    const summaries = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const text = formatPromptWithContext("planner", "p", { summaryChannel: summaries });
    const summaryLines = text.split("\n").filter((l) => /^- s\d+$/.test(l));
    expect(summaryLines).toHaveLength(20);

    const skills = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
    const text2 = formatPromptWithContext("planner", "p", { skillHints: skills });
    expect(text2).toContain("skill-7");
    expect(text2).not.toContain("skill-8");

    const goals = ["g1", "g2", "g3"];
    const text3 = formatPromptWithContext("planner", "p", { goalAnchors: goals });
    expect(text3).toContain("- g2");
    expect(text3).not.toContain("- g3");
  });

  it("returns content on the happy path and resets circuit failures", async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(chat("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const value = await executeRolePrompt("worker", "hello", OPENAI);
    expect(value).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries retryable failures within the budget then succeeds", async () => {
    process.env.GRAPHFLOW_PROVIDER_MAX_RETRIES = "2";
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(jsonResponse({ error: "flaky" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "flaky" }, 503))
      .mockResolvedValueOnce(chat("recovered"));
    vi.stubGlobal("fetch", fetchMock);

    const value = await executeRolePrompt("worker", "hello", OPENAI);
    expect(value).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("wraps exhausted retries in a retryable ProviderError", async () => {
    process.env.GRAPHFLOW_PROVIDER_MAX_RETRIES = "0";
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>().mockResolvedValue(jsonResponse({ error: "down" }, 500))
    );

    const error = await executeRolePrompt("worker", "hello", OPENAI).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as ProviderError).message).toContain("openai http 500");
  });

  it("does not retry non-retryable failures (unauthorized)", async () => {
    process.env.GRAPHFLOW_PROVIDER_MAX_RETRIES = "3";
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValue(jsonResponse({ error: "invalid key" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const error = await executeRolePrompt("worker", "hello", OPENAI).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the circuit after repeated failures and short-circuits subsequent calls", async () => {
    process.env.GRAPHFLOW_PROVIDER_MAX_RETRIES = "0";
    process.env.GRAPHFLOW_PROVIDER_CIRCUIT_FAILURES = "2";
    process.env.GRAPHFLOW_PROVIDER_CIRCUIT_OPEN_MS = "60000";
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValue(jsonResponse({ error: "down" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeRolePrompt("worker", "hello", OPENAI)).rejects.toThrow(ProviderError);
    await expect(executeRolePrompt("worker", "hello", OPENAI)).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const error = await executeRolePrompt("worker", "hello", OPENAI).catch((e) => e);
    expect((error as ProviderError).message).toContain("circuit is open");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a non-retryable ProviderError when the caller aborts before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchMock);

    const error = await executeRolePrompt(
      "worker",
      "hello",
      OPENAI,
      undefined,
      controller.signal
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("aborted");
    expect((error as ProviderError).retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("M104 deepseek tool loop (stubbed fetch)", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.DEEPSEEK_API_KEY = "sk-ds-loop";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it("executes tool calls, feeds results back, and returns the final answer", async () => {
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "call-1", type: "function", function: { name: "graphflow_unknown_x", arguments: "{}" } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "final answer" } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDeepseekToolLoop({ prompt: "what is this repo", model: "ds" });
    expect(result.content).toBe("final answer");
    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 13 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      messages: Array<{ role: string; content?: string; tool_call_id?: string }>;
    };
    const toolMessage = secondBody.messages.find((m) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call-1");
    expect(toolMessage?.content).toContain("Unknown tool");
  });

  it("returns immediately when the first response has no tool calls", async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue(chat("plain answer"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDeepseekToolLoop({ prompt: "q", model: "ds" });
    expect(result.content).toBe("plain answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forces a tool-free final pass after exhausting the round budget", async () => {
    const toolCallResponse = () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "c", type: "function", function: { name: "graphflow_unknown_x", arguments: "{}" } },
              ],
            },
          },
        ],
      });
    const fetchMock = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(chat("forced final"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runDeepseekToolLoop({ prompt: "q", model: "ds" });
    expect(result.content).toBe("forced final");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const finalBody = JSON.parse(String(fetchMock.mock.calls[3][1]?.body)) as Record<
      string,
      unknown
    >;
    expect(finalBody.tools).toBeUndefined();
  });
});
