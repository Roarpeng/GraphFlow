export interface ProviderChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
}

export interface ProviderToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ProviderToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderTextRequest {
  prompt: string;
  model: string;
  /** External cancel/timeout signal; merged with provider-local timeout. */
  signal?: AbortSignal;
  /** Optional multi-message layout (system + user). When set, preferred over prompt-only. */
  messages?: ProviderChatMessage[];
  maxTokens?: number;
  temperature?: number;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  responseFormat?: { type: "json_object" };
  tools?: ProviderToolDefinition[];
}

export interface ProviderUsageStats {
  promptTokens?: number;
  completionTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

export interface ProviderTextResult {
  content: string;
  reasoningContent?: string;
  toolCalls?: ProviderToolCall[];
  usage?: ProviderUsageStats;
  rawAssistantMessage?: ProviderChatMessage;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Prefer final content; fall back to reasoning_content when content is empty. */
export function pickChatContent(payload: Record<string, unknown>): {
  content?: string;
  reasoningContent?: string;
  toolCalls?: ProviderToolCall[];
} {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {};
  }
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const contentRaw = typeof message.content === "string" ? message.content.trim() : "";
  const reasoningRaw = message.reasoning_content ?? message.reasoning;
  const reasoningContent =
    typeof reasoningRaw === "string" && reasoningRaw.trim().length > 0
      ? reasoningRaw.trim()
      : undefined;
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as ProviderToolCall[])
    : undefined;
  const textFallback =
    typeof first.text === "string" && first.text.trim().length > 0 ? first.text.trim() : undefined;
  const content = contentRaw || textFallback || reasoningContent;
  return {
    ...(content ? { content } : {}),
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

export function pickUsage(payload: Record<string, unknown>): ProviderUsageStats | undefined {
  const usage = asRecord(payload.usage);
  if (Object.keys(usage).length === 0) {
    return undefined;
  }
  const stats: ProviderUsageStats = {};
  if (typeof usage.prompt_tokens === "number") {
    stats.promptTokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    stats.completionTokens = usage.completion_tokens;
  }
  if (typeof usage.prompt_cache_hit_tokens === "number") {
    stats.promptCacheHitTokens = usage.prompt_cache_hit_tokens;
  }
  if (typeof usage.prompt_cache_miss_tokens === "number") {
    stats.promptCacheMissTokens = usage.prompt_cache_miss_tokens;
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}
