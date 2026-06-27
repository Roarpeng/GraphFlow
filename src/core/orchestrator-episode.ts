import { syncGraphAfterRun } from "../hooks/post-run-sync.js";
import {
  findSimilarEpisodes,
  recordEpisode,
  type EpisodeRecord,
} from "../learning/episodic-memory.js";
import { applySkillLearning } from "../learning/skill-flywheel.js";
import type { TaskRunResult, TaskStatus, TaskNode, OrchestrateOptions } from "./types.js";

export async function maybeFindSimilarEpisodes(
  task: string,
  options?: OrchestrateOptions
): Promise<EpisodeRecord[]> {
  if (!options?.enableEpisodicMemory || !options.graphClient) {
    return [];
  }
  return findSimilarEpisodes(options.graphClient, task, 3);
}

export async function maybeSyncGraph(
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

  await syncGraphAfterRun(
    options.graphClient,
    [
      {
        filePath: "runtime:task",
        summary: `Task completed: ${task}`,
      },
    ],
    options.configPath
  );
}

export async function maybeSyncSkillGraph(
  task: string,
  run: TaskRunResult,
  options?: OrchestrateOptions
): Promise<void> {
  if (!options?.enableSkillFlywheel || !options.graphClient) {
    return;
  }
  // Bridge mode: task is delegated to an external agent whose outcome is unknown.
  // Skip skill score updates until the external agent reports back via
  // updateEpisodeOutcome + applySkillLearning. Otherwise every delegated task
  // would be counted as a failure, permanently sinking skill scores to -20.
  if (run.status === "DELEGATED") {
    return;
  }

  await applySkillLearning(options.graphClient, task, run);
}

function statusToOutcome(status: TaskStatus): "pass" | "fail" | "human_review" | "pending" {
  if (status === "COMPLETED") return "pass";
  if (status === "HUMAN_REVIEW_REQUIRED") return "human_review";
  if (status === "DELEGATED") return "pending";
  return "fail";
}

export async function finalizeEpisode(
  task: string,
  plan: TaskNode[],
  run: TaskRunResult,
  similar: EpisodeRecord[],
  skillHints: string[],
  options?: OrchestrateOptions
): Promise<TaskRunResult> {
  if (!options?.enableEpisodicMemory || !options.graphClient) {
    return run;
  }

  const decisions: string[] = [];
  for (const rd of run.routeDecisions ?? []) {
    decisions.push(`route ${rd.role}: ${rd.provider}/${rd.model}`);
  }
  for (const hint of skillHints.slice(0, 3)) {
    decisions.push(`skill: ${hint}`);
  }
  const dedupedDecisions = Array.from(new Set(decisions)).slice(0, 6);

  const planProjection = plan.map((node) => ({ id: node.id, description: node.description }));
  const recordInput: Parameters<typeof recordEpisode>[1] = {
    task,
    plan: planProjection,
    outcome: statusToOutcome(run.status),
    keyDecisions: dedupedDecisions,
    lessons: [],
    attempts: run.attempts,
    ...(run.executionRounds ? { executionRounds: run.executionRounds } : {}),
    ...(run.feedback !== undefined ? { runFeedback: run.feedback } : {}),
  };

  const episode = await recordEpisode(options.graphClient, recordInput);

  const similarSummaries = similar.map((ep) => ({
    id: ep.id,
    task: ep.task,
    score: ep.outcome === "pass" ? 1 : ep.outcome === "fail" ? -1 : 0,
  }));

  return {
    ...run,
    episodeId: episode.id,
    similarEpisodes: similarSummaries,
  };
}