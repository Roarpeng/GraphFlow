import type { AgentRole } from "../core/types";
import type { ModelSelection } from "./model-router";
import { anthropicGenerateText } from "./provider-adapters/anthropic";
import { bailianGenerateText } from "./provider-adapters/bailian";
import { doubaoGenerateText } from "./provider-adapters/doubao";
import { openaiGenerateText } from "./provider-adapters/openai";
import { openbmbGenerateText } from "./provider-adapters/openbmb";

export interface PromptContext {
  summaryChannel?: string[];
  skillHints?: string[];
  extraInstructions?: string[];
}

const MAX_SUMMARY_LINES = 20;
const MAX_SKILL_HINTS = 8;

function hasAnyContext(context?: PromptContext): boolean {
  if (!context) {
    return false;
  }
  const s = context.summaryChannel?.some((x) => x && x.trim().length > 0);
  const k = context.skillHints?.some((x) => x && x.trim().length > 0);
  const e = context.extraInstructions?.some((x) => x && x.trim().length > 0);
  return Boolean(s || k || e);
}

export function formatPromptWithContext(
  role: AgentRole,
  prompt: string,
  context?: PromptContext
): string {
  const rolePrefix = `[role:${role}]`;
  if (!hasAnyContext(context)) {
    return `${rolePrefix} ${prompt}`;
  }

  const lines: string[] = [rolePrefix];

  const summaries = (context?.summaryChannel ?? []).filter((line) => line && line.trim().length > 0);
  if (summaries.length > 0) {
    lines.push("Knowledge graph context:");
    for (const item of summaries.slice(0, MAX_SUMMARY_LINES)) {
      lines.push(`- ${item}`);
    }
  }

  const skills = (context?.skillHints ?? []).filter((s) => s && s.trim().length > 0);
  if (skills.length > 0) {
    lines.push(`Skills to apply: ${skills.slice(0, MAX_SKILL_HINTS).join(", ")}`);
  }

  const notes = (context?.extraInstructions ?? []).filter((n) => n && n.trim().length > 0);
  if (notes.length > 0) {
    lines.push("Notes:");
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("Task:");
  lines.push(prompt);
  return lines.join("\n");
}

export async function executeRolePrompt(
  role: AgentRole,
  prompt: string,
  selection: ModelSelection,
  context?: PromptContext
): Promise<string> {
  const finalPrompt = formatPromptWithContext(role, prompt, context);
  const request = {
    prompt: finalPrompt,
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

  if (selection.provider === "openbmb") {
    return openbmbGenerateText(request);
  }

  return openaiGenerateText(request);
}
