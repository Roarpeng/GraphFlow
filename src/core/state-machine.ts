import { runWorker } from "../agents/worker";
import { validateTaskResult } from "../agents/validator";
import type { ModelSelection } from "../routing/model-router";
import type { PromptContext } from "../routing/provider-executor";
import type { TaskRunResult, TaskStatus } from "./types";

export interface RunInput {
  task: string;
  workerOutput?: string;
  maxRetries?: number;
  workerSelection?: ModelSelection;
  validatorSelection?: ModelSelection;
  workerContext?: PromptContext;
  validatorContext?: PromptContext;
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
        ? await runWorker({ task: input.task, outputHint: input.workerOutput })
        : input.workerSelection
          ? await runWorker({
              task: input.task,
              selection: input.workerSelection,
              ...(input.workerContext ? { context: input.workerContext } : {}),
            })
          : await runWorker({ task: input.task });

    status = "VALIDATING";
    const validation = validateTaskResult(input.task, output);
    feedback = validation.feedback;

    if (validation.passed) {
      status = "COMPLETED";
      return {
        status,
        attempts,
        feedback,
        validationSummary: {
          matched: validation.matchedCriteria.length,
          missing: validation.missingCriteria.length,
          riskTags: validation.riskTags,
        },
      };
    }
  }

  status = "HUMAN_REVIEW_REQUIRED";
  return {
    status,
    attempts,
    feedback: feedback || "Retry limit reached.",
    validationSummary: {
      matched: 0,
      missing: 1,
      riskTags: ["retry_limit"],
    },
  };
}
