import { logger } from "../../utils/logger";
export interface ProviderTextRequest {
  prompt: string;
  model: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function pickContent(payload: Record<string, unknown>): string | undefined {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const content = message.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }
  const text = first.text;
  if (typeof text === "string" && text.trim().length > 0) {
    return text.trim();
  }
  return undefined;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        temperature: 0.1,
        max_tokens: 512,
      }),
      signal: controller.signal,
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
  } catch (error: any) {
    logger.error({ error: error?.message || String(error) }, "Provider adapter caught error");
    if (strict) {
      throw error;
    }
    return `[openai:${request.model}] ${request.prompt}`;
  } finally {
    clearTimeout(timer);
  }
}
