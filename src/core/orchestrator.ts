import { planTasks } from "../agents/planner";
import type { GraphClient } from "../graph/client-factory";
import {
  buildLayeredContextPackage,
  type LayeredContextPackage,
} from "../graph/context-slicer";
import { syncGraphAfterRun } from "../hooks/post-run-sync";
import { executeDag } from "./dag-engine";
import { runSimpleTask } from "./state-machine";
import { triageTask } from "./triage";
import type { OrchestrationInput, TaskRunResult } from "./types";

export interface OrchestrateOptions {
  graphClient?: GraphClient;
  enableAutoGraphSync?: boolean;
  enableNearLosslessMode?: boolean;
  nearLosslessQuery?: string;
  maxContextTokens?: number;
  layerQuota?: { l1: number; l2: number; l3: number };
  onContextPackage?: (pkg: LayeredContextPackage) => void;
}

export async function orchestrate(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<TaskRunResult> {
  const mode = triageTask(input.task);
  const retryOptions = input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {};
  const contextPackage = await maybeBuildNearLosslessContext(input, options);

  if (mode === "simple") {
    const run = await runSimpleTask({ task: input.task, ...retryOptions });
    const finalRun = appendContextFeedback(run, contextPackage);
    await maybeSyncGraph(input.task, finalRun, options);
    return finalRun;
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
    const finalRun = appendContextFeedback(run, contextPackage);
    await maybeSyncGraph(input.task, finalRun, options);
    return finalRun;
  }

  const run: TaskRunResult = {
    status: "COMPLETED",
    attempts: plan.length,
    feedback: `Completed tasks: ${result.completed.join(", ")}`,
  };
  const finalRun = appendContextFeedback(run, contextPackage);
  await maybeSyncGraph(input.task, finalRun, options);
  return finalRun;
}

async function maybeBuildNearLosslessContext(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<LayeredContextPackage | undefined> {
  if (!options?.enableNearLosslessMode || !options.graphClient) {
    return undefined;
  }

  const query = options.nearLosslessQuery ?? input.task;
  const maxTokens = options.maxContextTokens ?? 1200;
  const packageOptions = options.layerQuota ? { layerQuota: options.layerQuota } : undefined;

  const pkg = await buildLayeredContextPackage(options.graphClient, query, maxTokens, packageOptions);

  options.onContextPackage?.(pkg);
  return pkg;
}

function appendContextFeedback(
  run: TaskRunResult,
  contextPackage?: LayeredContextPackage
): TaskRunResult {
  if (!contextPackage) {
    return run;
  }

  return {
    ...run,
    feedback:
      `${run.feedback}; context(summary=${contextPackage.summaryChannel.length}, ` +
      `anchors=${contextPackage.anchorChannel.length}, tokens=${contextPackage.tokenEstimate})`,
  };
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
