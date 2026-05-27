import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FeedbackEvent } from "./feedback-collector";
import type { RankingSample } from "./sample-builder";

export interface LearningMetrics {
  totalEvents: number;
  passRate: number;
  averageTokenCost: number;
}

export function computeLearningMetrics(events: FeedbackEvent[]): LearningMetrics {
  if (events.length === 0) {
    return { totalEvents: 0, passRate: 0, averageTokenCost: 0 };
  }

  const passed = events.filter((event) => event.passed).length;
  const totalTokenCost = events.reduce((sum, event) => sum + event.tokenCost, 0);

  return {
    totalEvents: events.length,
    passRate: passed / events.length,
    averageTokenCost: totalTokenCost / events.length,
  };
}

export function exportLearningDataset(
  path: string,
  samples: RankingSample[],
  metrics: LearningMetrics
): void {
  mkdirSync(dirname(path), { recursive: true });

  const lines = samples.map((sample) => JSON.stringify(sample));
  const payload = `${lines.join("\n")}\n#metrics ${JSON.stringify(metrics)}\n`;
  writeFileSync(path, payload, "utf8");
}
