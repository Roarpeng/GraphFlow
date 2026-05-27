import type { FeedbackEvent } from "./feedback-collector";

export interface RankingSample {
  prompt: string;
  label: "positive" | "negative";
}

export function buildRankingSamples(events: FeedbackEvent[]): RankingSample[] {
  return events.map((event) => ({
    prompt: event.query,
    label: event.passed && event.retries <= 1 ? "positive" : "negative",
  }));
}
