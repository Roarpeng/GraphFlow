import { logger } from "../../utils/logger";
import type { ProviderTextRequest } from "./openai";

export async function bailianGenerateText(request: ProviderTextRequest): Promise<string> {
  const strict = process.env.GRAPHFLOW_BAILIAN_STRICT === "1";
  const apiKey = process.env.BAILIAN_API_KEY;
  const baseUrl = (
    process.env.BAILIAN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
  ).replace(/\/+$/, "");
  const timeoutMsRaw = Number(process.env.GRAPHFLOW_BAILIAN_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 15000;

  if (!apiKey) {
    if (strict) {
      throw new Error("BAILIAN_API_KEY is required");
    }
    return `[bailian:${request.model}] ${request.prompt}`;
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
      throw new Error(`bailian http ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; text?: string }>;
    };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? payload.choices?.[0]?.text?.trim();
    if (!text) {
      throw new Error("bailian response missing content");
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
    return `[bailian:${request.model}] ${request.prompt}`;
  } finally {
    clearTimeout(timer);
  }
}
