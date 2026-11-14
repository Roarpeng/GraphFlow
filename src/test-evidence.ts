import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentSha256 } from "./edit-transaction.js";

export function changedContentHash(rootDir: string, files: string[]): string {
  return contentSha256(files.sort().map((file) => {
    const path = join(rootDir, file);
    return `${file}:${existsSync(path) ? contentSha256(readFileSync(path, "utf8")) : "missing"}`;
  }).join("|"));
}

export function failureFingerprint(rootDir: string, command: string, output: string, changedFiles: string[]): string {
  const code = output.match(/\b(?:TS\d{4}|E[A-Z_]{2,}|AssertionError|Error)\b/)?.[0] ?? "unknown";
  const location = output.match(/\b[\w./\\-]+\.(?:ts|tsx|js|py|go|rs|cs|cpp|c):\d+(?::\d+)?/)?.[0] ?? "unknown";
  const test = output.match(/^(?!FAIL \[exit=)(?:FAIL|FAILED|✗)\s+([^\r\n]{1,100})/m)?.[1] ?? "unknown";
  const stack = output.match(/\bat\s+([^\r\n]{1,100})/)?.[1] ?? "unknown";
  return `sha256:${contentSha256(JSON.stringify([command, code, location, test, stack, changedContentHash(rootDir, changedFiles)]))}`;
}
