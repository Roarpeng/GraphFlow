import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import type { GraphClient } from "../graph/client-factory";
import { computeLearningMetrics, exportLearningDataset } from "./exporter";
import { reflectOnEpisodes } from "./reflector";
import { applySkillLearning } from "./skill-flywheel";
import { buildRankingSamples } from "./sample-builder";

import { readFeedbackEvents } from "./learning-events";

export interface NightlyLearningSummary {
  totalEvents: number;
  passRate: number;
  averageTokenCost: number;
  exportedPath: string;
  lessonsSynthesized?: number;
}


export function runNightlyLearning(config: GraphFlowConfig): NightlyLearningSummary;
export function runNightlyLearning(
  config: GraphFlowConfig,
  graphClient: GraphClient
): Promise<NightlyLearningSummary>;
export function runNightlyLearning(
  config: GraphFlowConfig,
  graphClient?: GraphClient
): NightlyLearningSummary | Promise<NightlyLearningSummary> {
  const eventsPath = config.learningPolicy.eventsPath ?? "tmp/learning-events.jsonl";
  const events = readFeedbackEvents(eventsPath);
  const metrics = computeLearningMetrics(events);

  const samples = buildRankingSamples(events);
  exportLearningDataset(config.learningPolicy.exportPath, samples, metrics);

  const baseSummary: NightlyLearningSummary = {
    totalEvents: metrics.totalEvents,
    passRate: metrics.passRate,
    averageTokenCost: metrics.averageTokenCost,
    exportedPath: config.learningPolicy.exportPath,
  };

  const summaryPath = config.learningPolicy.summaryPath ?? "tmp/learning-summary.json";
  mkdirSync(dirname(summaryPath), { recursive: true });

  if (!graphClient) {
    writeFileSync(summaryPath, JSON.stringify(baseSummary, null, 2), "utf8");
    return baseSummary;
  }

  return (async () => {
    const lessons = await reflectOnEpisodes(graphClient);

    if (config.skillPolicy?.enableSkillFlywheel) {
      for (const event of events) {
        await applySkillLearning(graphClient, event.query, {
          status: event.passed ? "COMPLETED" : "FAILED",
          attempts: (event.retries ?? 0) + 1,
          feedback: "",
        });
      }
    }

    const summary: NightlyLearningSummary = {
      ...baseSummary,
      lessonsSynthesized: lessons.length,
    };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    return summary;
  })();
}

