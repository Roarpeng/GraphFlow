import type { ProviderTextRequest } from "./openai";

export async function doubaoGenerateText(request: ProviderTextRequest): Promise<string> {
  const strict = process.env.GRAPHFLOW_DOUBAO_STRICT === "1";
  const apiKey = process.env.DOUBAO_API_KEY;
  const baseUrl = (process.env.DOUBAO_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(
    /\/+$/,
    ""
  );
  const timeoutMsRaw = Number(process.env.GRAPHFLOW_DOUBAO_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 15000;

  if (!apiKey) {
    if (strict) {
      throw new Error("DOUBAO_API_KEY is required");
    }
    return `[doubao:${request.model}] ${request.prompt}`;
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
      throw new Error(`doubao http ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; text?: string }>;
    };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? payload.choices?.[0]?.text?.trim();
    if (!text) {
      throw new Error("doubao response missing content");
    }
    return text;
  } catch (error) {
    if (strict) {
      throw error;
    }
    return `[doubao:${request.model}] ${request.prompt}`;
  } finally {
    clearTimeout(timer);
  }
}
