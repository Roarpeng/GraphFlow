import { planTasks } from "../agents/planner";
import { executeDag } from "./dag-engine";
import { runSimpleTask } from "./state-machine";
import { triageTask } from "./triage";
import type { OrchestrationInput, TaskRunResult } from "./types";

export async function orchestrate(input: OrchestrationInput): Promise<TaskRunResult> {
  const mode = triageTask(input.task);
  const retryOptions = input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {};

  if (mode === "simple") {
    return runSimpleTask({ task: input.task, ...retryOptions });
  }

  const plan = planTasks(input.task);
  const result = await executeDag(plan, async (node) => {
    const run = await runSimpleTask({ task: node.description, ...retryOptions });
    return run.status === "COMPLETED";
  });

  if (result.failed.length > 0) {
    return {
      status: "HUMAN_REVIEW_REQUIRED",
      attempts: plan.length,
      feedback: `Failed tasks: ${result.failed.join(", ")}`,
    };
  }

  return {
    status: "COMPLETED",
    attempts: plan.length,
    feedback: `Completed tasks: ${result.completed.join(", ")}`,
  };
}
