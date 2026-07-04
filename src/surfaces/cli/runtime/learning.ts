import { resolveConfig } from "../../../config/resolve";
import { createGraphClient } from "../../../graph/client-factory";
import { runNightlyLearning, type NightlyLearningSummary } from "../../../learning/nightly-trainer";

export interface LearningNightlyResult extends NightlyLearningSummary {}

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

function formatNightlySummary(summary: NightlyLearningSummary): string {
  return [
    `totalEvents=${summary.totalEvents}`,
    `passRate=${(summary.passRate * 100).toFixed(1)}%`,
    `averageTokenCost=${summary.averageTokenCost.toFixed(2)}`,
    `exportedPath=${summary.exportedPath}`,
    ...(summary.lessonsSynthesized !== undefined ? [`lessonsSynthesized=${summary.lessonsSynthesized}`] : []),
  ].join("; ");
}
