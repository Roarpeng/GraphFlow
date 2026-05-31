import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import type { GraphClient } from "../graph/client-factory";
import { evaluateCanary } from "./canary-gate";
import { computeLearningMetrics, exportLearningDataset, type LearningMetrics } from "./exporter";
import type { FeedbackEvent } from "./feedback-collector";
import { reflectOnEpisodes } from "./reflector";
import { buildRankingSamples } from "./sample-builder";

export interface NightlyLearningSummary {
  totalEvents: number;
  passRate: number;
  averageTokenCost: number;
  canaryAllowed: boolean;
  canaryReason: string;
  exportedPath: string;
  lessonsSynthesized?: number;
}

export function appendFeedbackEvent(path: string, event: FeedbackEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
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
  const prevMetrics = readPreviousMetrics(config.learningPolicy.summaryPath ?? "tmp/learning-summary.json");

  const firstPassRateDelta = metrics.passRate - prevMetrics.passRate;
  const tokenDelta = metrics.averageTokenCost - prevMetrics.averageTokenCost;
  const canary = evaluateCanary(config.learningPolicy.canaryRatio, firstPassRateDelta, tokenDelta);

  const samples = buildRankingSamples(events);
  exportLearningDataset(config.learningPolicy.exportPath, samples, metrics);

  const baseSummary: NightlyLearningSummary = {
    totalEvents: metrics.totalEvents,
    passRate: metrics.passRate,
    averageTokenCost: metrics.averageTokenCost,
    canaryAllowed: canary.allowNewPolicy,
    canaryReason: canary.reason,
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
    const summary: NightlyLearningSummary = {
      ...baseSummary,
      lessonsSynthesized: lessons.length,
    };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    return summary;
  })();
}

function readFeedbackEvents(path: string): FeedbackEvent[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FeedbackEvent);
}

function readPreviousMetrics(path: string): LearningMetrics {
  if (!existsSync(path)) {
    return { totalEvents: 0, passRate: 0, averageTokenCost: 0 };
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LearningMetrics>;
  return {
    totalEvents: parsed.totalEvents ?? 0,
    passRate: parsed.passRate ?? 0,
    averageTokenCost: parsed.averageTokenCost ?? 0,
  };
}
