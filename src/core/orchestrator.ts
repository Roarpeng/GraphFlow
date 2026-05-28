import { planTasks } from "../agents/planner";
import type { GraphClient } from "../graph/client-factory";
import { syncGraphAfterRun } from "../hooks/post-run-sync";
import { executeDag } from "./dag-engine";
import { runSimpleTask } from "./state-machine";
import { triageTask } from "./triage";
import type { OrchestrationInput, TaskRunResult } from "./types";

export interface OrchestrateOptions {
  graphClient?: GraphClient;
  enableAutoGraphSync?: boolean;
}

export async function orchestrate(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<TaskRunResult> {
  const mode = triageTask(input.task);
  const retryOptions = input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {};

  if (mode === "simple") {
    const run = await runSimpleTask({ task: input.task, ...retryOptions });
    await maybeSyncGraph(input.task, run, options);
    return run;
  }

  const plan = planTasks(input.task);
  const result = await executeDag(plan, async (node) => {
    const run = await runSimpleTask({ task: node.description, ...retryOptions });
    return run.status === "COMPLETED";
  });

  if (result.failed.length > 0) {
    const run: TaskRunResult = {
      status: "HUMAN_REVIEW_REQUIRED",
      attempts: plan.length,
      feedback: `Failed tasks: ${result.failed.join(", ")}`,
    };
    await maybeSyncGraph(input.task, run, options);
    return run;
  }

  const run: TaskRunResult = {
    status: "COMPLETED",
    attempts: plan.length,
    feedback: `Completed tasks: ${result.completed.join(", ")}`,
  };
  await maybeSyncGraph(input.task, run, options);
  return run;
}

async function maybeSyncGraph(
  task: string,
  run: TaskRunResult,
  options?: OrchestrateOptions
): Promise<void> {
  if (!options?.graphClient || !options.enableAutoGraphSync) {
    return;
  }

  if (run.status !== "COMPLETED") {
    return;
  }

  await syncGraphAfterRun(options.graphClient, [
    {
      filePath: "runtime:task",
      summary: `Task completed: ${task}`,
    },
  ]);
}
