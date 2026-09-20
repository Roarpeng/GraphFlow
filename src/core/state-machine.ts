import { runWorker } from "../agents/worker";
import { validateTaskResult, validateTaskResultLlm } from "../agents/validator";
import type { ModelSelection } from "../routing/model-router";
import { formatPromptContextEntries, type PromptContext } from "../routing/provider-executor";
import { buildFusedSteps, enrichExecutionDescriptor } from "./fused-descriptor";
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
  /** GF-4 / Action Fusion: attach fused edit+validate steps to the bridge descriptor. */
  enableActionFusion?: boolean;
}

export async function runSimpleTask(input: RunInput): Promise<TaskRunResult> {
  // Bridge mode: return structured task descriptor without executing
  // Skip bridge mode if workerOutput is provided (test shortcut)
  if (input.executionMode === "bridge" && input.workerOutput === undefined) {
    // Anchor sources render as a readable fenced block (not a JSON blob) so
    // the external bridge agent can actually read the inlined code.
    const contextStr = formatPromptContextEntries(input.workerContext);

    // GF-4 / Action Fusion: a simple bridge task carries no plan nodes, so
    // the fused steps derive from the TASK TEXT clauses ("修改 X 并验证" is
    // an edit+validate pair). Without this the plan-less bridge descriptor
    // never carried steps and Action Fusion was dark on this path.
    let descriptor: TaskRunResult["executionDescriptor"] = {
      action: "execute",
      task: input.task,
      context: contextStr,
      retryHints: [],
    };
    if (input.enableActionFusion) {
      const steps = buildFusedSteps({ task: input.task });
      if (steps.length > 0) {
        descriptor = enrichExecutionDescriptor(descriptor, steps);
      }
    }

    return {
      status: "DELEGATED",
      attempts: 0,
      feedback: "[DELEGATED] Task packaged for external agent execution. Use executionDescriptor to execute.",
      executionDescriptor: descriptor,
    };
  }

  const maxRetries = input.maxRetries ?? 3;
  let attempts = 0;
  let status: TaskStatus = "PENDING";
  let feedback = "";
  let lastValidation: ValidationResult | undefined;
  let lastOutput = "";

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
    lastOutput = output;

    if (validation.passed) {
      status = "COMPLETED";
      return {
        status,
        attempts,
        feedback,
        ...(output ? { result: output } : {}),
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
    // Even a rejected worker output is the caller's best evidence of what the
    // model actually produced — never drop it on the failure path either.
    ...(lastOutput ? { result: lastOutput } : {}),
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
