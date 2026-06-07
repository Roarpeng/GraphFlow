import { logger } from "../../utils/logger";
import type { ProviderTextRequest } from "./openai";

export async function anthropicGenerateText(request: ProviderTextRequest): Promise<string> {
  const strict = process.env.GRAPHFLOW_ANTHROPIC_STRICT === "1";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const timeoutMsRaw = Number(process.env.GRAPHFLOW_ANTHROPIC_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 15000;

  if (!apiKey) {
    if (strict) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }
    return `[anthropic:${request.model}] ${request.prompt}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 512,
        temperature: 0.1,
        messages: [{ role: "user", content: request.prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`anthropic http ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = payload.content?.find((item) => item.type === "text")?.text?.trim();
    if (!text) {
      throw new Error("anthropic response missing text content");
    }
    return text;
  } catch (error: unknown) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Provider adapter caught error"
    );
    if (strict) {
      throw error;
    }
    return `[anthropic:${request.model}] ${request.prompt}`;
  } finally {
    clearTimeout(timer);
  }
}
