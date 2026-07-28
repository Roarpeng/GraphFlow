/**
 * GraphFlow skill-flywheel A/B benchmark.
 *
 * Question: does the learning flywheel (skill hints + episodic recall) actually
 * surface *relevant* prior experience for new tasks, and what does it cost in
 * prompt tokens?
 *
 * Design (offline, deterministic, no API key required):
 *   Phase 1 — simulate project history: K historical tasks with outcomes are
 *     fed through applySkillLearning + recordEpisode, exactly as real runs do.
 *   Phase 2 — evaluation suite: M new, related-but-distinct tasks.
 *     Arm A (flywheel ON):  suggestSkillHints + findSimilarEpisodes
 *     Arm B (flywheel OFF): nothing injected (zero overhead baseline)
 *
 * Metrics:
 *   - injection rate: fraction of eval tasks that receive ≥1 hint / ≥1 episode
 *   - relevance proxy: max Jaccard(hint tokens, task tokens) — deterministic;
 *     it verifies the flywheel surfaces *vocabulary-related* skills for related
 *     tasks. This is a MECHANICAL proxy, not task-success lift.
 *   - token overhead: gpt-tokenizer count of the injected text an agent would
 *     actually receive.
 *
 * HONEST SCOPE NOTE: end-to-end success-rate lift (does an agent complete tasks
 * better with hints?) requires LLM execution and is out of scope for this
 * offline harness. Run the same eval suite through your agent with the flywheel
 * toggled via skillPolicy.enableSkillFlywheel to measure that.
 *
 * Run with: npm run benchmark:skills
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/model/gpt-4o";

import { GraphifyClient } from "../src/graph/graphify-client.js";
import { applySkillLearning, suggestSkillHints } from "../src/learning/skill-flywheel.js";
import { recordEpisode, findSimilarEpisodes } from "../src/learning/episodic-memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "SKILL-AB-RESULTS.md");

// ── Fixtures ───────────────────────────────────────────────────────────────

const HISTORY: ReadonlyArray<{ task: string; pass: boolean; lessons: string[] }> = [
  { task: "refactor planner module and add tests", pass: true, lessons: ["keep planner steps small"] },
  { task: "fix graph index cache invalidation", pass: true, lessons: ["invalidate on mtime and hash"] },
  { task: "add sqlite backend migration for graph store", pass: true, lessons: ["version the schema"] },
  { task: "improve embedding provider fallback handling", pass: true, lessons: ["fall back to hash embeddings"] },
  { task: "update mcp server tool definitions", pass: true, lessons: ["keep tool count small"] },
  { task: "optimize context compression token budget", pass: true, lessons: ["prefer structural compression"] },
  { task: "refactor dag engine checkpoint recovery", pass: false, lessons: ["checkpoint keys must include plan hash"] },
  { task: "add tests for routing provider health", pass: true, lessons: ["mock provider health probes"] },
];

const EVAL_TASKS: readonly string[] = [
  "refactor validator module and add regression tests",
  "fix graph watcher invalidation bug",
  "add fts5 search migration for sqlite storage",
  "improve embedding timeout fallback path",
  "update cli tool output formatting",
  "optimize adaptive context budget allocation",
  "add tests for dag checkpoint restore",
  "refactor skill scoring and add tests",
];

// ── Measurement ────────────────────────────────────────────────────────────

function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.trim().length / 4));
  }
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_一-鿿]+/g)
      .filter((t) => t.length >= 3)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface SkillAbTaskResult {
  task: string;
  hintsInjected: number;
  hintTokens: number;
  hintRelevance: number;
  episodesRecalled: number;
  episodeTokens: number;
  episodeRelevance: number;
}

export interface SkillAbReport {
  tasks: SkillAbTaskResult[];
  historySize: number;
  skillNodes: number;
  hintInjectionRate: number;
  episodeRecallRate: number;
  meanHintRelevance: number;
  meanEpisodeRelevance: number;
  totalTokenOverhead: number;
  meanTokenOverheadPerTask: number;
}

export async function runSkillAbBenchmark(): Promise<SkillAbReport> {
  const client = new GraphifyClient();

  // Phase 1: simulate project history through the real learning paths.
  for (const item of HISTORY) {
    const run = {
      status: (item.pass ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
      attempts: 1,
      feedback: item.pass ? "done" : "failed",
    };
    await applySkillLearning(client, item.task, run, item.lessons);
    await recordEpisode(client, {
      task: item.task,
      plan: [{ id: "task-1", description: item.task }],
      outcome: item.pass ? "pass" : "fail",
      keyDecisions: [],
      lessons: item.lessons,
      attempts: 1,
    });
  }

  const skillNodes = client.snapshot().nodes.filter((n) => n.type === "Skill").length;

  // Phase 2: evaluate flywheel contribution on related new tasks.
  const tasks: SkillAbTaskResult[] = [];
  for (const task of EVAL_TASKS) {
    const hints = await suggestSkillHints(client, task, 3);
    const episodes = await findSimilarEpisodes(client, task, 3);

    const taskTokens = tokenSet(task);
    const hintText = hints.join("\n");
    const hintRelevance = hints.length
      ? Math.max(...hints.map((h) => jaccard(tokenSet(h), taskTokens)))
      : 0;
    const episodeText = episodes.map((e) => e.task).join("\n");
    const episodeRelevance = episodes.length
      ? Math.max(...episodes.map((e) => jaccard(tokenSet(e.task), taskTokens)))
      : 0;

    tasks.push({
      task,
      hintsInjected: hints.length,
      hintTokens: countTokens(hintText),
      hintRelevance: Math.round(hintRelevance * 1000) / 1000,
      episodesRecalled: episodes.length,
      episodeTokens: countTokens(episodeText),
      episodeRelevance: Math.round(episodeRelevance * 1000) / 1000,
    });
  }

  const withHints = tasks.filter((t) => t.hintsInjected > 0).length;
  const withEpisodes = tasks.filter((t) => t.episodesRecalled > 0).length;
  const totalOverhead = tasks.reduce((s, t) => s + t.hintTokens + t.episodeTokens, 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    tasks,
    historySize: HISTORY.length,
    skillNodes,
    hintInjectionRate: Math.round((withHints / tasks.length) * 1000) / 1000,
    episodeRecallRate: Math.round((withEpisodes / tasks.length) * 1000) / 1000,
    meanHintRelevance: Math.round(mean(tasks.map((t) => t.hintRelevance)) * 1000) / 1000,
    meanEpisodeRelevance: Math.round(mean(tasks.map((t) => t.episodeRelevance)) * 1000) / 1000,
    totalTokenOverhead: totalOverhead,
    meanTokenOverheadPerTask: Math.round(mean(tasks.map((t) => t.hintTokens + t.episodeTokens)) * 10) / 10,
  };
}

function renderMarkdown(report: SkillAbReport): string {
  const rows = report.tasks
    .map(
      (t) =>
        `| \`${t.task}\` | ${t.hintsInjected} | ${t.hintRelevance} | ${t.hintTokens} | ${t.episodesRecalled} | ${t.episodeRelevance} | ${t.episodeTokens} |`
    )
    .join("\n");

  return `# GraphFlow Skill-Flywheel A/B Benchmark — Results

> Auto-generated by \`npm run benchmark:skills\` (\`benchmarks/run-skill-ab-benchmark.ts\`).
> Last run: ${new Date().toISOString()}

## Summary

Simulated project history: **${report.historySize}** tasks (skills learned: **${report.skillNodes}** nodes).
Evaluation suite: **${report.tasks.length}** related-but-distinct new tasks.

| Metric | Arm A (flywheel ON) | Arm B (flywheel OFF) |
| --- | --- | --- |
| Hint injection rate | ${(report.hintInjectionRate * 100).toFixed(1)}% | 0% |
| Episode recall rate | ${(report.episodeRecallRate * 100).toFixed(1)}% | 0% |
| Mean hint relevance (Jaccard proxy) | ${report.meanHintRelevance} | — |
| Mean episode relevance (Jaccard proxy) | ${report.meanEpisodeRelevance} | — |
| Total prompt-token overhead | ${report.totalTokenOverhead} | 0 |
| Mean overhead per task | ${report.meanTokenOverheadPerTask} | 0 |

## Per-task detail

| Task | Hints | Hint relevance | Hint tokens | Episodes | Episode relevance | Episode tokens |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## Methodology & honest caveats

- Both phases run through the **real** learning paths (\`applySkillLearning\`,
  \`recordEpisode\`, \`suggestSkillHints\`, \`findSimilarEpisodes\`) on an
  isolated in-memory graph — no mocks.
- **Relevance is a mechanical Jaccard proxy** over token overlap. It proves the
  flywheel surfaces vocabulary-related experience for related tasks and
  quantifies the exact token cost. It does **not** prove task-success lift.
- To measure end-to-end success-rate lift, run an agent over the same eval
  suite with \`skillPolicy.enableSkillFlywheel\` toggled on/off and compare
  completion rates. That experiment needs a live LLM and is deliberately out
  of scope for this offline, reproducible harness.
`;
}

async function main(): Promise<void> {
  const report = await runSkillAbBenchmark();
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, renderMarkdown(report), "utf8");
  console.log(`Skill A/B benchmark complete. Results written to ${RESULTS_PATH}`);
  console.log(
    `hintInjection=${(report.hintInjectionRate * 100).toFixed(0)}% ` +
      `episodeRecall=${(report.episodeRecallRate * 100).toFixed(0)}% ` +
      `hintRelevance=${report.meanHintRelevance} ` +
      `overhead=${report.meanTokenOverheadPerTask} tok/task`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (isMain) {
  void main();
}
