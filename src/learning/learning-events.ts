import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { FeedbackEvent } from "./feedback-collector";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function appendFeedbackEvent(path: string, event: FeedbackEvent): void {
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const stats = statSync(path);
    if (stats.size >= MAX_FILE_SIZE) {
      const rotatedPath = path.replace(/\.jsonl$/, ".1.jsonl");
      if (rotatedPath === path) {
        // 如果后缀不是 .jsonl，加 .1
        renameSync(path, `${path}.1`);
      } else {
        renameSync(path, rotatedPath);
      }
    }
  }

  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function readFeedbackEvents(path: string): FeedbackEvent[] {
  if (!existsSync(path)) {
    return [];
  }

  // A crash mid-append can leave a truncated final line; fail-open by skipping
  // unparsable lines instead of breaking the whole nightly learning run.
  const events: FeedbackEvent[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as FeedbackEvent;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.query === "string" &&
        typeof parsed.passed === "boolean"
      ) {
        events.push(parsed);
      }
    } catch {
      // skip corrupted line
    }
  }
  return events;
}
