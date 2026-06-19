import { runWorker } from "../agents/worker";
import { validateTaskResult, validateTaskResultLlm } from "../agents/validator";
import type { ModelSelection } from "../routing/model-router";
import type { PromptContext } from "../routing/provider-executor";
import type { TaskRunResult, TaskStatus, ValidationResult } from "./types";

export interface RunInput {
  task: string;
  workerOutput?: string;
  maxRetries?: number;
  workerSelection?: ModelSelection;
  validatorSelection?: ModelSelection;
  workerContext?: PromptContext;
  validatorContext?: PromptContext;
  executionMode?: "bridge" | "llm";
}

export async function runSimpleTask(input: RunInput): Promise<TaskRunResult> {
  // Bridge mode: return structured task descriptor without executing
  // Skip bridge mode if workerOutput is provided (test shortcut)
  if (input.executionMode === "bridge" && input.workerOutput === undefined) {
    const contextStr = input.workerContext
      ? Object.entries(input.workerContext)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("; ")
      : "";

    return {
      status: "HUMAN_REVIEW_REQUIRED",
      attempts: 0,
      feedback: "[DELEGATED] Task packaged for external agent execution. Use executionDescriptor to execute.",
      executionDescriptor: {
        action: "execute",
        task: input.task,
        context: contextStr,
        retryHints: [],
      },
    };
  }

  const maxRetries = input.maxRetries ?? 3;
  let attempts = 0;
  let status: TaskStatus = "PENDING";
  let feedback = "";
  let lastValidation: ValidationResult | undefined;

  while (attempts < maxRetries) {
    status = "RUNNING";
    attempts += 1;

    // 构建当前轮次的 task 描述，注入上次 validation 反馈
    let effectiveTask = input.task;
    if (lastValidation && !lastValidation.passed) {
      const retryHint = [
        `\n[Retry feedback]: ${lastValidation.feedback}`,
        `Missing criteria: ${lastValidation.missingCriteria.join(", ")}`,
        lastValidation.riskTags.length > 0
          ? `Risk tags: ${lastValidation.riskTags.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      effectiveTask = `${input.task}${retryHint}`;
    }

    const output =
      input.workerOutput !== undefined
        ? await runWorker({ task: effectiveTask, outputHint: input.workerOutput })
        : input.workerSelection
          ? await runWorker({
              task: effectiveTask,
              selection: input.workerSelection,
              ...(input.workerContext ? { context: input.workerContext } : {}),
            })
          : await runWorker({ task: effectiveTask });

    status = "VALIDATING";

    // 根据 validatorSelection 决定走 LLM 验证还是规则验证
    const validation = input.validatorSelection
      ? await validateTaskResultLlm(
          input.task,
          output,
          input.validatorSelection,
          input.validatorContext,
        )
      : validateTaskResult(input.task, output);

    feedback = validation.feedback;
    lastValidation = validation;

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
    validationSummary: lastValidation
      ? {
          matched: lastValidation.matchedCriteria.length,
          missing: lastValidation.missingCriteria.length,
          riskTags: lastValidation.riskTags,
        }
      : {
          matched: 0,
          missing: 1,
          riskTags: ["retry_limit"],
        },
  };
}
