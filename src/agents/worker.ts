import { executeRolePrompt } from "../routing/provider-executor";
import type { ModelSelection } from "../routing/model-router";

export interface WorkerInput {
  task: string;
  outputHint?: string;
  selection?: ModelSelection;
}

export async function runWorker(input: WorkerInput): Promise<string> {
  if (input.outputHint !== undefined) {
    return input.outputHint;
  }

  if (input.selection) {
    return executeRolePrompt("worker", input.task, input.selection);
  }

  return `Simulated change for task: ${input.task}`;
}
