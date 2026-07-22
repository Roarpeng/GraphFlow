import { resolveConfig } from "../../../config/resolve";
import { createGraphClient } from "../../../graph/client-factory";
import { runNightlyLearning, type NightlyLearningSummary } from "../../../learning/nightly-trainer";
import {
  maybeDecaySkills,
  type SkillDecayResult,
  resetSkillScore,
  pruneLowSkills,
} from "../../../learning/skill-flywheel";
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
