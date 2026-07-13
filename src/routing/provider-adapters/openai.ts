import { createTimeoutSignal, isAbortError } from "../../core/cancellation";
import { logger } from "../../utils/logger";
import {
  asRecord,
  pickChatContent,
  type ProviderTextRequest,
} from "./types";

export type { ProviderTextRequest } from "./types";

function pickContent(payload: Record<string, unknown>): string | undefined {
  return pickChatContent(payload).content;
}

export async function openaiGenerateText(request: ProviderTextRequest): Promise<string> {
  const strict = process.env.GRAPHFLOW_OPENAI_STRICT === "1";
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const timeoutMsRaw = Number(process.env.GRAPHFLOW_OPENAI_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 15000;

  if (!apiKey) {
    if (strict) {
      throw new Error("OPENAI_API_KEY is required");
    }
    return `[openai:${request.model}] ${request.prompt}`;
  }

  const { signal, dispose } = createTimeoutSignal(timeoutMs, request.signal);
  const messages =
    request.messages && request.messages.length > 0
      ? request.messages
      : [{ role: "user" as const, content: request.prompt }];

  try {
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      temperature: request.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? 512,
    };
    if (request.responseFormat) {
      body.response_format = request.responseFormat;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`openai http ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = asRecord(await response.json());
    const content = pickContent(payload);
    if (!content) {
      throw new Error("openai response missing content");
    }
    return content;
  } catch (error: unknown) {
    if (isAbortError(error) || signal.aborted) {
      throw error instanceof Error ? error : new Error("openai request aborted");
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Provider adapter caught error");
    if (strict) {
      throw error;
    }
    return `[openai:${request.model}] ${request.prompt}`;
  } finally {
    dispose();
  }
}
