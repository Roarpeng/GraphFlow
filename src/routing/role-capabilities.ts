import type { AgentRole } from "../core/types";
import type { GraphFlowConfig, ProviderConfig } from "../config/schema";
import type { ModelSelection } from "./model-router";
import type { PromptContext } from "./provider-executor";
import type { ProviderChatMessage, ProviderTextRequest } from "./provider-adapters/types";

const JSON_SYSTEM_HINT =
  "Respond with valid json only. EXAMPLE JSON OUTPUT: {\"ok\":true,\"summary\":\"...\"}";

export function formatMessagesWithContext(
  role: AgentRole,
  prompt: string,
  context?: PromptContext,
  options?: { jsonMode?: boolean }
): ProviderChatMessage[] {
  const systemParts: string[] = [`You are GraphFlow's ${role} agent.`];
  if (options?.jsonMode) {
    systemParts.push(JSON_SYSTEM_HINT);
  }

  const skills = (context?.skillHints ?? []).filter((s) => s && s.trim().length > 0);
  if (skills.length > 0) {
    systemParts.push(`Skills to apply: ${skills.slice(0, 8).join(", ")}`);
  }

  const notes = (context?.extraInstructions ?? []).filter((n) => n && n.trim().length > 0);
  if (notes.length > 0) {
    systemParts.push(`Notes:\n${notes.map((n) => `- ${n}`).join("\n")}`);
  }

  const userParts: string[] = [];
  const summaries = (context?.summaryChannel ?? []).filter((line) => line && line.trim().length > 0);
  if (summaries.length > 0) {
    userParts.push("Knowledge graph context:");
    for (const item of summaries.slice(0, 20)) {
      userParts.push(`- ${item}`);
    }
    userParts.push("");
  }
  userParts.push("Task:");
  userParts.push(prompt);

  return [
    { role: "system", content: systemParts.join("\n") },
    { role: "user", content: userParts.join("\n") },
  ];
}

export function buildProviderRequestForRole(
  role: AgentRole,
  prompt: string,
  selection: ModelSelection,
  config: GraphFlowConfig,
  context?: PromptContext
): ProviderTextRequest {
  const providerCfg = (config.providers[selection.provider] ?? {}) as ProviderConfig;
  const isDeepseek = selection.provider === "deepseek";
  const smartRole = role === "planner" || role === "validator";
  const isProbe = /^\s*Reply with exactly:\s*ok\s*$/i.test(prompt.trim());
  const thinkingMode = providerCfg.thinking ?? "auto";
  const thinking: "enabled" | "disabled" =
    isProbe || thinkingMode === "disabled"
      ? "disabled"
      : thinkingMode === "enabled"
        ? "enabled"
        : smartRole && selection.tier === "smart"
          ? "enabled"
          : "disabled";

  const jsonModeSetting = providerCfg.jsonMode ?? "auto";
  const jsonMode =
    isProbe
      ? false
      : jsonModeSetting === true
        ? true
        : jsonModeSetting === false
          ? false
          : role === "planner" || role === "validator";

  const maxTokens =
    providerCfg.maxTokens ??
    (isProbe ? 32 : role === "planner" ? 2048 : role === "validator" ? 1024 : 512);

  const messages = formatMessagesWithContext(role, prompt, context, { jsonMode });
  const request: ProviderTextRequest = {
    prompt,
    model: selection.model,
    messages,
    maxTokens,
    ...(providerCfg.temperature !== undefined ? { temperature: providerCfg.temperature } : {}),
  };

  if (isDeepseek) {
    request.thinking = thinking;
    if (thinking === "enabled") {
      request.reasoningEffort = providerCfg.reasoningEffort ?? (role === "planner" ? "high" : "high");
    }
    if (jsonMode) {
      request.responseFormat = { type: "json_object" };
    }
  } else if (jsonMode && (selection.provider === "openai" || selection.provider === "bailian")) {
    request.responseFormat = { type: "json_object" };
  }

  return request;
}

export function shouldEnableProviderTools(
  selection: ModelSelection,
  config: GraphFlowConfig
): boolean {
  if (selection.provider !== "deepseek") {
    return false;
  }
  if (config.routingPolicy?.enableProviderTools === false) {
    return false;
  }
  const providerCfg = config.providers.deepseek as ProviderConfig | undefined;
  if (providerCfg?.enableTools === false) {
    return false;
  }
  return true;
}
