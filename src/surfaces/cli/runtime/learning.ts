import { resolveConfig } from "../../../config/resolve";
import { createGraphClient } from "../../../graph/client-factory";
import { runNightlyLearning, type NightlyLearningSummary } from "../../../learning/nightly-trainer";
import {
  maybeDecaySkills,
  type SkillDecayResult,
  resetSkillScore,
  pruneLowSkills,
} from "../../../learning/skill-flywheel";
import {
  planSkillConsolidation,
  toConsolidateResult,
  type ConsolidateResult,
  type ConsolidateSkillInput,
} from "../../../learning/skill-consolidate";
import { parseSkillState } from "../../../learning/skill-store";
import { forgetEpisodes } from "../../../learning/episodic-memory";

export interface LearningNightlyResult extends NightlyLearningSummary {}
export type { SkillDecayResult };

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
 * Dry-run skill consolidation plan (QM-style UPDATE/DELETE/ADD) — does not mutate the graph.
 */
export async function runSkillConsolidatePlan(configPath?: string): Promise<ConsolidateResult> {
  const config = resolveConfig(configPath);
  const graphClient = createGraphClient(config);
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

  return toConsolidateResult(planSkillConsolidation(skills));
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
