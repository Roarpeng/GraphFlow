#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const corpus = JSON.parse(readFileSync(join(repo, "tests", "fixtures", "v4-tasks.json"), "utf8"));
const ids = new Set(corpus.tasks.map((task) => task.id));
if (ids.size !== corpus.tasks.length || corpus.tasks.length < 30 || corpus.tasks.length > 50)
  throw new Error("v4 corpus must contain 30-50 unique tasks");
for (const task of corpus.tasks) {
  if (!existsSync(join(repo, task.verify))) throw new Error(`Missing verifier for ${task.id}: ${task.verify}`);
}
if (process.argv.includes("--check-corpus")) {
  console.log(`PASS v4 corpus: ${corpus.tasks.length} tasks, baseline ${corpus.baselineSha}, all verifiers present`);
  process.exit(0);
}

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/v4-ab-report.mjs <results.jsonl> | --check-corpus");
  process.exit(2);
}
const rows = readFileSync(resolve(input), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
for (const row of rows) {
  if (!ids.has(row.taskId) || !["baseline", "v4"].includes(row.variant))
    throw new Error(`Unknown task or variant: ${row.taskId}/${row.variant}`);
  if (typeof row.success !== "boolean") throw new Error(`Missing verified success: ${row.taskId}`);
}

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const p95 = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const report = {};
for (const variant of ["baseline", "v4"]) {
  const group = rows.filter((row) => row.variant === variant);
  const successCount = group.filter((row) => row.success).length;
  const estimatedTokens = group.map((row) => Number.isFinite(row.estimatedOutputTokens)
    ? row.estimatedOutputTokens : Math.ceil((row.outputChars ?? 0) / 4));
  const costs = group.map((row) => row.observedModelUsage?.costUsd);
  const hasMeasuredCost = group.length > 0 && costs.every((cost) => typeof cost === "number" && Number.isFinite(cost));
  report[variant] = {
    attempts: group.length,
    verifiedSuccesses: successCount,
    successRate: group.length ? successCount / group.length : null,
    meanDurationMs: mean(group.map((row) => row.durationMs).filter(Number.isFinite)),
    meanEstimatedOutputTokens: mean(estimatedTokens),
    p95EstimatedOutputTokens: p95(estimatedTokens),
    meanTestRuns: mean(group.map((row) => row.testRuns).filter(Number.isFinite)),
    meanRetries: mean(group.map((row) => row.retries).filter(Number.isFinite)),
    observedTotalCostUsd: hasMeasuredCost ? costs.reduce((a, b) => a + b, 0) : "UNKNOWN",
    observedCostPerVerifiedSuccessUsd: hasMeasuredCost && successCount > 0
      ? costs.reduce((a, b) => a + b, 0) / successCount : "UNKNOWN",
  };
}
console.log(JSON.stringify({ baselineSha: corpus.baselineSha, tokenMeasure: "estimated tool output tokens (chars/4 unless supplied)", report }, null, 2));
