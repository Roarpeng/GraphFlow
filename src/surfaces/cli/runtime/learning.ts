import { resolveConfig } from "../../../config/resolve";
import { createGraphClient, type GraphClient } from "../../../graph/client-factory";
import { runNightlyLearning, type NightlyLearningSummary } from "../../../learning/nightly-trainer";
import {
  maybeDecaySkills,
  type SkillDecayResult,
  resetSkillScore,
  pruneLowSkills,
} from "../../../learning/skill-flywheel";
import {
  applySkillConsolidation,
  planSkillConsolidation,
  toConsolidateResult,
  type ApplySkillConsolidationResult,
  type ConsolidateResult,
  type ConsolidateSkillInput,
} from "../../../learning/skill-consolidate";
import { parseSkillState } from "../../../learning/skill-store";
import { forgetEpisodes, loadAllEpisodes } from "../../../learning/episodic-memory";
import {
  extractNamedFiles,
  reconcileEpisodes,
  type ReconcileReport,
} from "../../../learning/outcome-reconciler";
import { reportOutcome } from "./routing.js";
import { createEmbeddingProviderFromConfig } from "../../../config/embedding-factory";
import { ensureEmbeddings } from "../../../learning/embedding-refresh";
import { logger } from "../../../utils/logger";

export interface LearningNightlyResult extends NightlyLearningSummary {}
export type { SkillDecayResult };

/** CLI / runtime result for `skill consolidate` (dry-run by default). */
export interface SkillConsolidateRuntimeResult extends ConsolidateResult {
  /** True when the graph was not mutated (default). */
  dryRun: boolean;
  /** Present only when `--apply` / `--execute` ran successfully against the plan. */
  applied?: ApplySkillConsolidationResult;
}

async function loadConsolidateSkillInputs(
  graphClient: GraphClient
): Promise<ConsolidateSkillInput[]> {
  const nodes = graphClient.readSnapshot
    ? graphClient.readSnapshot().nodes.filter((n) => n.type === "Skill")
    : (await graphClient.queryByKeyword("skill")).filter((n) => n.type === "Skill");

  const skills: ConsolidateSkillInput[] = [];
  for (const node of nodes) {
    const state = parseSkillState(node.content);
    if (!state || state.hidden === true) continue;
    skills.push({
      id: state.id,
      name: state.name,
      score: state.score,
      uses: state.uses,
      ...(state.outcomeKind ? { outcomeKind: state.outcomeKind } : {}),
      ...(state.guidance ? { guidance: state.guidance } : {}),
    });
  }
  return skills;
}

export function runLearningNightly(configPath?: string): string {
  const config = resolveConfig(configPath);
  const summary = runNightlyLearning(config);
  return formatNightlySummary(summary);
}

export async function runLearningNightlyResult(configPath?: string): Promise<LearningNightlyResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const summary = await runNightlyLearning(config, graphClient);
  // Index runs only spend ~2s on vectors (they sit on the agent's hot path);
  // this is the maintenance loop, so it can pay for real convergence.
  const embeddingProvider = createEmbeddingProviderFromConfig(config);
  if (embeddingProvider) {
    try {
      await ensureEmbeddings(graphClient, embeddingProvider, { limit: 1024, deadlineMs: 30_000 });
    } catch (error) {
      logger.warn({ error }, "Embedding backfill failed during nightly learning");
    }
  }
  return summary;
}

export async function runSkillDecay(configPath?: string): Promise<SkillDecayResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  return maybeDecaySkills(graphClient);
}

export async function runSkillReset(
  skillName: string,
  configPath?: string
): Promise<{ name: string; reset: boolean }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const result = await resetSkillScore(graphClient, skillName);
  return { name: skillName, reset: Boolean(result) };
}

export async function runSkillPrune(configPath?: string): Promise<{ pruned: number }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  return pruneLowSkills(graphClient);
}

/**
 * Plan (and optionally apply) QM-style skill consolidation (UPDATE/DELETE/ADD).
 * Default is dry-run — pass `{ apply: true }` only for opt-in mutation.
 */
export async function runSkillConsolidate(
  configPath?: string,
  options?: { apply?: boolean }
): Promise<SkillConsolidateRuntimeResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const skills = await loadConsolidateSkillInputs(graphClient);
  const plan = toConsolidateResult(planSkillConsolidation(skills));

  if (!options?.apply) {
    return { ...plan, dryRun: true };
  }

  const applied = await applySkillConsolidation(graphClient, plan.actions);
  return { ...plan, dryRun: false, applied };
}

/**
 * Dry-run skill consolidation plan (QM-style UPDATE/DELETE/ADD) — does not mutate the graph.
 */
export async function runSkillConsolidatePlan(configPath?: string): Promise<ConsolidateResult> {
  const result = await runSkillConsolidate(configPath);
  return { actions: result.actions, summary: result.summary };
}

export async function runLearnForget(configPath?: string): Promise<{ removed: number }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  return forgetEpisodes(graphClient);
}

/**
 * Close pending episodes from git history plus one verify-command run. Without
 * `reconcilePolicy.verifyCommand` this reports what it could not decide and
 * writes nothing — a commit alone is delivery, not correctness.
 */
export async function reconcileOutcomes(
  configPath?: string,
  options?: { verifyCommand?: string; lookbackDays?: number; limit?: number; dryRun?: boolean }
): Promise<ReconcileReport> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const verifyCommand = options?.verifyCommand ?? config.reconcilePolicy?.verifyCommand;
  const lookbackDays = options?.lookbackDays ?? config.reconcilePolicy?.lookbackDays;
  const limit = options?.limit ?? config.reconcilePolicy?.limit;
  return reconcileEpisodes(
    graphClient,
    {
      workspaceRoot: config.graphPolicy.workspaceRoot ?? process.cwd(),
      ...(verifyCommand ? { verifyCommand } : {}),
      ...(lookbackDays !== undefined ? { lookbackDays } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(options?.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    },
    async (episodeId, evidence) => {
      const result = await reportOutcome(episodeId, true, [], configPath, undefined, undefined, evidence);
      return result.ok === true;
    }
  );
}

/** What `reconcileOutcomes` would see, without touching git or running anything. */
export async function reconcilePreview(
  configPath?: string
): Promise<{ candidates: number; withNamedFiles: number; verifyCommand?: string }> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
  const workspaceRoot = config.graphPolicy.workspaceRoot ?? process.cwd();
  const cutoff = Date.now() - (config.reconcilePolicy?.lookbackDays ?? 30) * 86_400_000;
  const episodes = (await loadAllEpisodes(graphClient)).filter(
    (episode) =>
      (episode.outcome === "pending" || episode.outcome === "human_review") && episode.updatedAt >= cutoff
  );
  const withNamedFiles = episodes.filter(
    (episode) => extractNamedFiles([episode.task, ...episode.plan.map((step) => step.description ?? "")], workspaceRoot).length > 0
  ).length;
  const verifyCommand = config.reconcilePolicy?.verifyCommand;
  return { candidates: episodes.length, withNamedFiles, ...(verifyCommand ? { verifyCommand } : {}) };
}

function formatNightlySummary(summary: NightlyLearningSummary): string {
  return [
    `totalEvents=${summary.totalEvents}`,
    `passRate=${(summary.passRate * 100).toFixed(1)}%`,
    `averageTokenCost=${summary.averageTokenCost.toFixed(2)}`,
    `exportedPath=${summary.exportedPath}`,
    ...(summary.lessonsSynthesized !== undefined ? [`lessonsSynthesized=${summary.lessonsSynthesized}`] : []),
  ].join("; ");
}
