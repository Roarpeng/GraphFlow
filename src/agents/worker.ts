import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";
import type { ModelSelection } from "../routing/model-router";

export interface WorkerInput {
  task: string;
  outputHint?: string;
  selection?: ModelSelection;
  context?: PromptContext;
  retryFeedback?: string;
  mode?: "llm" | "bridge";
}

export interface BridgeTaskDescriptor {
  action: "execute";
  task: string;
  context: string;
  retryHints: string[];
}

export async function runWorker(input: WorkerInput): Promise<string> {
  // Fast-path for deterministic testing
  if (input.outputHint !== undefined) {
    return input.outputHint;
  }

  // Bridge mode: emit structured JSON for external agents (Cursor / Claude Code)
  if (input.mode === "bridge") {
    const descriptor: BridgeTaskDescriptor = {
      action: "execute",
      task: input.task,
      context: input.context
        ? Object.entries(input.context)
            .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("; ")
        : "",
      retryHints: input.retryFeedback ? [input.retryFeedback] : [],
    };
    return JSON.stringify(descriptor);
  }

  // LLM mode with retryFeedback: append feedback to the prompt
  if (input.selection) {
    const taskWithFeedback = input.retryFeedback
      ? `${input.task}\n\n[Retry Feedback] ${input.retryFeedback}`
      : input.task;
    return executeRolePrompt("worker", taskWithFeedback, input.selection, input.context);
  }

  // Default simulate path (backward-compatible)
  return `Simulated change for task: ${input.task}`;
}
