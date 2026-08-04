import { maybeAutoCaptureEpisode } from "../hooks/auto-capture.js";
import { syncGraphAfterRun } from "../hooks/post-run-sync.js";
import {
  findSimilarEpisodes,
  recordEpisode,
  type EpisodeRecord,
} from "../learning/episodic-memory.js";
import { applySkillLearning, cleanupNoiseSkills } from "../learning/skill-flywheel.js";
import { seedInitialSkills } from "../learning/seed-skills.js";
import { backfillTriageOutcome } from "../learning/triage-telemetry.js";
import { logger } from "../utils/logger.js";
import type { TaskRunResult, TaskStatus, TaskNode, OrchestrateOptions } from "./types.js";

/**
 * 预置种子技能：在技能飞轮启用且显式开启 enableSeedSkills 时，
 * 于 orchestrator 运行早期写入常见工程技能基线（原子 + 复合）。
 * 幂等：已存在的技能节点会被跳过。失败不阻断主流程。
 */
export async function maybeSeedInitialSkills(options?: OrchestrateOptions): Promise<void> {
  if (!options?.enableSeedSkills || !options?.enableSkillFlywheel || !options.graphClient) {
    return;
  }
  try {
    await seedInitialSkills(options.graphClient);
  } catch (error) {
    // 种子技能写入失败不应阻断编排主流程
    logger.warn({ error }, "Seed skills initialization failed");
  }
}

/**
 * P0-2 load-time cleanup: when the skill flywheel is active, prune legacy
 * pure-noise skill nodes (no symbol evidence) that older versions extracted
 * from generic episode text ("update", "readme", ...). Idempotent; never
 * touches curated seed skills. Failures never block orchestration.
 */
export async function maybeCleanupNoiseSkills(options?: OrchestrateOptions): Promise<void> {
  if (!options?.enableSkillFlywheel || !options.graphClient) {
    return;
  }
  try {
    await cleanupNoiseSkills(options.graphClient);
  } catch (error) {
    logger.warn({ error }, "Skill noise cleanup failed");
  }
}

export async function maybeFindSimilarEpisodes(
  task: string,
  options?: OrchestrateOptions
): Promise<EpisodeRecord[]> {
  if (!options?.enableEpisodicMemory || !options.graphClient) {
    return [];
  }
  // 透传 embedding provider 以启用语义检索（余弦相似度 + RRF 融合）；
  // 无 provider 时 findSimilarEpisodes 自动降级为纯 Jaccard。
  return findSimilarEpisodes(options.graphClient, task, 3, options.embeddingProvider);
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
  options?: OrchestrateOptions,
  triageId?: string
): Promise<TaskRunResult> {
  // 回填 triage 实际结果（与 episodic memory 独立）：只要图客户端可用且有 triageId 即执行。
  // 记录实际步数、是否触发 drift replan、最终状态，用于 triage 准确率数据收集。
  if (triageId && options?.graphClient) {
    try {
      await backfillTriageOutcome(options.graphClient, triageId, {
        // 根据实际计划步数推断复杂度：多于 1 步视为 complex
        actualMode: plan.length > 1 ? "complex" : "simple",
        actualSteps: plan.length > 0 ? plan.length : run.attempts,
        driftReplan: (run.replanRounds ?? 0) > 0,
        replanRounds: run.replanRounds ?? 0,
        finalStatus: run.status,
        resolvedAt: Date.now(),
      });
    } catch {
      // 回填失败不阻断主流程
    }
  }

  // P0-1/P0-2 学习飞轮自动闭环：结局未知（DELEGATED / HUMAN_REVIEW_REQUIRED）的 run
  // 自动生成 pending episode 并写入会话日志（.graphflow/session-journal.jsonl），由
  // Claude Code hooks（SessionEnd / Stop，见 integrations/claude-code-hooks.ts）在会话
  // 结束时自动调用 `graphflow outcome report <episodeId> <success>` 回填真实结局。
  // 默认开启（GRAPHFLOW_AUTO_CAPTURE=0 关闭）；失败不阻断主流程。
  const autoCapture = async (existingEpisodeId?: string): Promise<void> => {
    if (!options?.graphClient) return;
    try {
      await maybeAutoCaptureEpisode(
        options.graphClient,
        {
          task,
          plan: plan.map((node) => ({ id: node.id, description: node.description })),
          attempts: run.attempts,
          status: run.status,
          ...(existingEpisodeId ? { existingEpisodeId } : {}),
        },
        { workspaceRoot: process.cwd() }
      );
    } catch {
      // 自动捕获失败不阻断主流程
    }
  };

  if (!options?.enableEpisodicMemory || !options.graphClient) {
    await autoCapture();
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

  const episode = await recordEpisode(options.graphClient, recordInput, options.embeddingProvider);
  await autoCapture(episode.id);

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