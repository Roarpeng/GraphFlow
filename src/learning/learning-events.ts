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

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FeedbackEvent);
}
