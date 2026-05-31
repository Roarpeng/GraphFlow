import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";
import type { ModelSelection } from "../routing/model-router";

export interface WorkerInput {
  task: string;
  outputHint?: string;
  selection?: ModelSelection;
  context?: PromptContext;
}

export async function runWorker(input: WorkerInput): Promise<string> {
  if (input.outputHint !== undefined) {
    return input.outputHint;
  }

  if (input.selection) {
    return executeRolePrompt("worker", input.task, input.selection, input.context);
  }

  return `Simulated change for task: ${input.task}`;
}
