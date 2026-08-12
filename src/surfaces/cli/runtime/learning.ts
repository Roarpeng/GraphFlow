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
import { forgetEpisodes } from "../../../learning/episodic-memory";

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

function formatNightlySummary(summary: NightlyLearningSummary): string {
  return [
    `totalEvents=${summary.totalEvents}`,
    `passRate=${(summary.passRate * 100).toFixed(1)}%`,
    `averageTokenCost=${summary.averageTokenCost.toFixed(2)}`,
    `exportedPath=${summary.exportedPath}`,
    ...(summary.lessonsSynthesized !== undefined ? [`lessonsSynthesized=${summary.lessonsSynthesized}`] : []),
  ].join("; ");
}
