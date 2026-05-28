import type { AgentRole } from "../core/types";
import type { ModelSelection } from "./model-router";
import { anthropicGenerateText } from "./provider-adapters/anthropic";
import { bailianGenerateText } from "./provider-adapters/bailian";
import { doubaoGenerateText } from "./provider-adapters/doubao";
import { openaiGenerateText } from "./provider-adapters/openai";

export async function executeRolePrompt(
  role: AgentRole,
  prompt: string,
  selection: ModelSelection
): Promise<string> {
  const rolePrefix = `[role:${role}]`;
  const request = {
    prompt: `${rolePrefix} ${prompt}`,
    model: selection.model,
  };

  if (selection.provider === "anthropic") {
    return anthropicGenerateText(request);
  }

  if (selection.provider === "bailian") {
    return bailianGenerateText(request);
  }

  if (selection.provider === "doubao") {
    return doubaoGenerateText(request);
  }

  return openaiGenerateText(request);
}
