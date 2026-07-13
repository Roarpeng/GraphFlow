import { createTimeoutSignal, isAbortError } from "../../core/cancellation";
import { logger } from "../../utils/logger";
import {
  asRecord,
  pickChatContent,
  pickUsage,
  type ProviderChatMessage,
  type ProviderTextRequest,
  type ProviderTextResult,
} from "./types";

export type { ProviderTextRequest, ProviderTextResult } from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

function buildMessages(request: ProviderTextRequest): ProviderChatMessage[] {
  if (request.messages && request.messages.length > 0) {
    return request.messages;
  }
  return [{ role: "user", content: request.prompt }];
}

function buildBody(request: ProviderTextRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: buildMessages(request),
    max_tokens: request.maxTokens ?? 1024,
  };

  if (request.thinking) {
    body.thinking = { type: request.thinking };
  }
  if (request.reasoningEffort) {
    body.reasoning_effort = request.reasoningEffort;
  }
  // DeepSeek docs: temperature is ignored under thinking mode but accepted for compatibility.
  if (request.thinking !== "enabled" && request.temperature !== undefined) {
    body.temperature = request.temperature;
  } else if (request.thinking !== "enabled") {
    body.temperature = 0.1;
  }
  if (request.responseFormat) {
    body.response_format = request.responseFormat;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }
  return body;
}

export async function deepseekGenerateTextDetailed(
  request: ProviderTextRequest
): Promise<ProviderTextResult> {
  const strict = process.env.GRAPHFLOW_DEEPSEEK_STRICT === "1";
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMsRaw = Number(process.env.GRAPHFLOW_DEEPSEEK_TIMEOUT_MS ?? 60000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 60000;

  if (!apiKey) {
    if (strict) {
      throw new Error("DEEPSEEK_API_KEY is required");
    }
    return { content: `[deepseek:${request.model}] ${request.prompt}` };
  }

  const { signal, dispose } = createTimeoutSignal(timeoutMs, request.signal);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildBody(request)),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`deepseek http ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = asRecord(await response.json());
    const picked = pickChatContent(payload);
    const usage = pickUsage(payload);
    if (!picked.content && !(picked.toolCalls && picked.toolCalls.length > 0)) {
      throw new Error("deepseek response missing content");
    }

    const message = asRecord(asRecord((payload.choices as unknown[])?.[0]).message);
    const rawAssistantMessage: ProviderChatMessage = {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : picked.content ?? "",
      ...(picked.reasoningContent ? { reasoning_content: picked.reasoningContent } : {}),
      ...(picked.toolCalls ? { tool_calls: picked.toolCalls } : {}),
    };

    return {
      content: picked.content ?? "",
      ...(picked.reasoningContent ? { reasoningContent: picked.reasoningContent } : {}),
      ...(picked.toolCalls ? { toolCalls: picked.toolCalls } : {}),
      ...(usage ? { usage } : {}),
      rawAssistantMessage,
    };
  } catch (error: unknown) {
    if (isAbortError(error) || signal.aborted) {
      throw error instanceof Error ? error : new Error("deepseek request aborted");
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "DeepSeek provider adapter caught error");
    if (strict) {
      throw error;
    }
    return { content: `[deepseek:${request.model}] ${request.prompt}` };
  } finally {
    dispose();
  }
}

export async function deepseekGenerateText(request: ProviderTextRequest): Promise<string> {
  const result = await deepseekGenerateTextDetailed(request);
  return result.content;
}
