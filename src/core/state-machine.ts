import { runWorker } from "../agents/worker";
import { validateTaskResult } from "../agents/validator";
import type { TaskRunResult, TaskStatus } from "./types";

export interface RunInput {
  task: string;
  workerOutput?: string;
  maxRetries?: number;
}

export async function runSimpleTask(input: RunInput): Promise<TaskRunResult> {
  const maxRetries = input.maxRetries ?? 3;
  let attempts = 0;
  let status: TaskStatus = "PENDING";
  let feedback = "";

  while (attempts < maxRetries) {
    status = "RUNNING";
    attempts += 1;

    const output =
      input.workerOutput !== undefined
        ? runWorker({ task: input.task, outputHint: input.workerOutput })
        : runWorker({ task: input.task });

    status = "VALIDATING";
    const validation = validateTaskResult(input.task, output);
    feedback = validation.feedback;

    if (validation.passed) {
      status = "COMPLETED";
      return { status, attempts, feedback };
    }
  }

  status = "HUMAN_REVIEW_REQUIRED";
  return {
    status,
    attempts,
    feedback: feedback || "Retry limit reached.",
  };
}
