import { createTimeoutSignal, isAbortError } from "../core/cancellation";
import { logger } from "../utils/logger";
import { recordProviderError } from "./provider-errors";
import {
  asRecord,
  pickChatContent,
  pickUsage,
  type GenericProtocolOptions,
  type ProtocolType,
  type ProviderChatMessage,
  type ProviderTextRequest,
  type ProviderTextResult,
  type ProviderUsageStats,
} from "./provider-adapters/types";
import {
  isLocalhostEndpoint,
  detectApiKeyFromEndpoint,
} from "../config/provider-env";

export { isLocalhostEndpoint, detectApiKeyFromEndpoint };

/**
 * Build request body for OpenAI-compatible /chat/completions endpoint.
 */
export function buildOpenAiRequestBody(request: ProviderTextRequest): Record<string, unknown> {
  const messages =
    request.messages && request.messages.length > 0
      ? request.messages
      : [{ role: "user" as const, content: request.prompt }];

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    temperature: request.temperature ?? 0.1,
    max_tokens: request.maxTokens ?? 512,
  };

  if (request.responseFormat) {
    body.response_format = request.responseFormat;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  return body;
}

/**
 * Build request body for Anthropic-compatible /messages endpoint.
 */
export function buildAnthropicRequestBody(request: ProviderTextRequest): Record<string, unknown> {
  let systemPrompt: string | undefined;
  const messages: Array<{ role: string; content: string }> = [];

  if (request.messages && request.messages.length > 0) {
    for (const m of request.messages) {
      if (m.role === "system") {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${m.content}` : m.content;
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
  } else {
    messages.push({ role: "user", content: request.prompt });
  }

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 512,
    temperature: request.temperature ?? 0.1,
    messages,
  };

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  return body;
}

/**
 * Execute a request against a generic OpenAI-compatible endpoint (/chat/completions).
 * Automatically omits the Bearer authorization header for password-free localhost services.
 */
export async function executeOpenAiCompatible(
  request: ProviderTextRequest,
  options?: GenericProtocolOptions
): Promise<ProviderTextResult> {
  const strict = options?.strict ?? process.env.GRAPHFLOW_OPENAI_STRICT === "1";
  const rawBaseUrl = (options?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const isLocal = isLocalhostEndpoint(baseUrl);

  // Sniff or resolve apiKey
  let apiKey = options?.apiKey?.trim() || undefined;
  if (!apiKey && !isLocal) {
    apiKey = detectApiKeyFromEndpoint(baseUrl) || process.env.OPENAI_API_KEY?.trim() || undefined;
  }

  // If neither key nor local, fall back or throw based on strict mode
  if (!apiKey && !isLocal) {
    if (strict) {
      throw new Error(`API key is required for non-localhost OpenAI-compatible endpoint: ${baseUrl}`);
    }
    return {
      content: `[openai-compatible:${request.model}] ${request.prompt}`,
    };
  }

  const timeoutMsRaw = options?.timeoutMs ?? Number(process.env.GRAPHFLOW_OPENAI_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 15000;
  const { signal, dispose } = createTimeoutSignal(timeoutMs, request.signal);

  const endpointUrl = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options?.headers ?? {}),
  };

  // For localhost, omit Bearer header when no key is provided
  if (apiKey) {
    headers["authorization"] = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
  }

  try {
    const body = buildOpenAiRequestBody(request);
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`openai-compatible http ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = asRecord(await response.json());
    const picked = pickChatContent(payload);
    const usage = pickUsage(payload);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = choices.length > 0 ? asRecord(choices[0]) : {};
    const rawAssistantMessage = firstChoice.message
      ? (asRecord(firstChoice.message) as unknown as ProviderChatMessage)
      : undefined;

    if (!picked.content && !picked.reasoningContent && (!picked.toolCalls || picked.toolCalls.length === 0)) {
      throw new Error("openai-compatible response missing content");
    }

    return {
      content: picked.content ?? "",
      ...(picked.reasoningContent ? { reasoningContent: picked.reasoningContent } : {}),
      ...(picked.toolCalls ? { toolCalls: picked.toolCalls } : {}),
      ...(usage ? { usage } : {}),
      ...(rawAssistantMessage ? { rawAssistantMessage } : {}),
    };
  } catch (error: unknown) {
    if (isAbortError(error) || signal.aborted) {
      throw error instanceof Error ? error : new Error("openai-compatible request aborted");
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "OpenAI compatible driver caught error");
    recordProviderError("openai", message);
    if (strict) {
      throw error instanceof Error ? error : new Error(message);
    }
    return {
      content: `[openai-compatible:${request.model}] ${request.prompt}`,
    };
  } finally {
    dispose();
  }
}

/**
 * Execute a request against a generic Anthropic-compatible endpoint (/messages).
 * Automatically omits the x-api-key header for password-free localhost services.
 */
export async function executeAnthropicCompatible(
  request: ProviderTextRequest,
  options?: GenericProtocolOptions
): Promise<ProviderTextResult> {
  const strict = options?.strict ?? process.env.GRAPHFLOW_ANTHROPIC_STRICT === "1";
  const rawBaseUrl = (options?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").trim();
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const isLocal = isLocalhostEndpoint(baseUrl);

  // Sniff or resolve apiKey
  let apiKey = options?.apiKey?.trim() || undefined;
  if (!apiKey && !isLocal) {
    apiKey = detectApiKeyFromEndpoint(baseUrl) || process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  }

  // If neither key nor local, fall back or throw based on strict mode
  if (!apiKey && !isLocal) {
    if (strict) {
      throw new Error(`API key is required for non-localhost Anthropic-compatible endpoint: ${baseUrl}`);
    }
    return {
      content: `[anthropic-compatible:${request.model}] ${request.prompt}`,
    };
  }

  const timeoutMsRaw = options?.timeoutMs ?? Number(process.env.GRAPHFLOW_ANTHROPIC_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 15000;
  const { signal, dispose } = createTimeoutSignal(timeoutMs, request.signal);

  let endpointUrl: string;
  if (baseUrl.endsWith("/messages")) {
    endpointUrl = baseUrl;
  } else if (baseUrl.endsWith("/v1")) {
    endpointUrl = `${baseUrl}/messages`;
  } else {
    endpointUrl = `${baseUrl}/v1/messages`;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(options?.headers ?? {}),
  };

  // For localhost, omit x-api-key header when no key is provided
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  try {
    const body = buildAnthropicRequestBody(request);
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`anthropic-compatible http ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = asRecord(await response.json());
    const contentArray = Array.isArray(payload.content) ? payload.content : [];
    const textBlock = contentArray.find(
      (item): item is { type: string; text: string } =>
        Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text")
    );
    const content = typeof textBlock?.text === "string" ? textBlock.text.trim() : undefined;
    if (!content) {
      throw new Error("anthropic-compatible response missing text content");
    }

    const usagePayload = asRecord(payload.usage);
    const usage: ProviderUsageStats = {};
    if (typeof usagePayload.input_tokens === "number") {
      usage.promptTokens = usagePayload.input_tokens;
    }
    if (typeof usagePayload.output_tokens === "number") {
      usage.completionTokens = usagePayload.output_tokens;
    }

    return {
      content,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    };
  } catch (error: unknown) {
    if (isAbortError(error) || signal.aborted) {
      throw error instanceof Error ? error : new Error("anthropic-compatible request aborted");
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Anthropic compatible driver caught error");
    recordProviderError("anthropic", message);
    if (strict) {
      throw error instanceof Error ? error : new Error(message);
    }
    return {
      content: `[anthropic-compatible:${request.model}] ${request.prompt}`,
    };
  } finally {
    dispose();
  }
}

/**
 * Universal dispatcher for executing generic protocol requests.
 */
export async function executeGenericProtocol(
  protocol: ProtocolType,
  request: ProviderTextRequest,
  options?: GenericProtocolOptions
): Promise<ProviderTextResult> {
  if (protocol === "anthropic-compatible") {
    return executeAnthropicCompatible(request, options);
  }
  return executeOpenAiCompatible(request, options);
}
