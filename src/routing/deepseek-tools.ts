import { logger } from "../utils/logger";
import { deepseekGenerateTextDetailed } from "./provider-adapters/deepseek";
import type {
  ProviderChatMessage,
  ProviderTextRequest,
  ProviderTextResult,
  ProviderToolDefinition,
  ProviderUsageStats,
} from "./provider-adapters/types";

const MAX_TOOL_ROUNDS = 3;

const READONLY_GRAPH_TOOLS: ProviderToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "graphflow_context",
      description:
        "Preview compressed GraphFlow context for a code question. Use before guessing about the codebase.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you need to understand in the codebase." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "graphflow_skill_insights",
      description: "Return top learned GraphFlow skill insights.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max skills to return (default 5)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "graphflow_inspect",
      description: "Return lightweight graph stats (node/edge counts).",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

async function invokeReadonlyTool(
  name: string,
  argsJson: string
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }

  try {
    if (name === "graphflow_context") {
      const { previewContext } = await import("../surfaces/cli/runtime.js");
      const query = typeof args.query === "string" ? args.query : "";
      const result = await previewContext(query);
      return JSON.stringify({
        summary: result.summary?.slice(0, 12) ?? [],
        anchorCount: result.anchors?.length ?? 0,
        tokenEstimate: result.tokenEstimate,
      });
    }
    if (name === "graphflow_skill_insights") {
      const { getSkillInsights } = await import("../surfaces/cli/runtime.js");
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const result = await getSkillInsights(undefined, limit);
      return JSON.stringify(result);
    }
    if (name === "graphflow_inspect") {
      const { inspectGraph } = await import("../surfaces/cli/runtime.js");
      const result = await inspectGraph(undefined, { nodeLimit: 5, edgeLimit: 5 });
      return JSON.stringify({
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
      });
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ tool: name, message }, "DeepSeek readonly tool failed");
    return JSON.stringify({ error: message });
  }
}

function mergeUsage(
  a?: ProviderUsageStats,
  b?: ProviderUsageStats
): ProviderUsageStats | undefined {
  if (!a && !b) {
    return undefined;
  }
  const stats: ProviderUsageStats = {};
  const promptTokens = (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0);
  const completionTokens = (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0);
  const promptCacheHitTokens = (a?.promptCacheHitTokens ?? 0) + (b?.promptCacheHitTokens ?? 0);
  const promptCacheMissTokens = (a?.promptCacheMissTokens ?? 0) + (b?.promptCacheMissTokens ?? 0);
  if (promptTokens > 0) stats.promptTokens = promptTokens;
  if (completionTokens > 0) stats.completionTokens = completionTokens;
  if (promptCacheHitTokens > 0) stats.promptCacheHitTokens = promptCacheHitTokens;
  if (promptCacheMissTokens > 0) stats.promptCacheMissTokens = promptCacheMissTokens;
  return Object.keys(stats).length > 0 ? stats : undefined;
}

/**
 * DeepSeek thinking + tool_calls loop (max 3 rounds).
 * Must echo reasoning_content when tool_calls occur (API requirement).
 */
export async function runDeepseekToolLoop(
  request: ProviderTextRequest
): Promise<ProviderTextResult> {
  const messages: ProviderChatMessage[] = [...(request.messages ?? [{ role: "user", content: request.prompt }])];
  let usage: ProviderUsageStats | undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await deepseekGenerateTextDetailed({
      ...request,
      messages,
      tools: READONLY_GRAPH_TOOLS,
    });
    usage = mergeUsage(usage, result.usage);

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return { ...result, ...(usage ? { usage } : {}) };
    }

    if (result.rawAssistantMessage) {
      messages.push(result.rawAssistantMessage);
    } else {
      messages.push({
        role: "assistant",
        content: result.content,
        ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
        tool_calls: result.toolCalls,
      });
    }

    for (const call of result.toolCalls) {
      const toolResult = await invokeReadonlyTool(call.function.name, call.function.arguments);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolResult,
      });
    }
  }

  // Final pass without tools to force an answer.
  const { tools: _ignored, ...withoutTools } = request;
  void _ignored;
  const finalResult = await deepseekGenerateTextDetailed({
    ...withoutTools,
    messages,
  });
  usage = mergeUsage(usage, finalResult.usage);
  return { ...finalResult, ...(usage ? { usage } : {}) };
}
