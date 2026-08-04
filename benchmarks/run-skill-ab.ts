/**
 * GraphFlow skill-flywheel END-TO-END A/B benchmark (P1-2).
 *
 * Question: does the learning flywheel (skill hints + episode summaries) improve
 * an end-to-end SUCCESS proxy — "the expected golden target is found" — not just
 * the hint-injection rates the existing `run-skill-ab-benchmark.ts` measures?
 *
 * Design (offline, deterministic, no API key, FNV/DJB2 hashing only):
 *   Phase 0 — fixture: the task set is DUPLICATED from the retrieval-golden
 *     regression suite (`tests/retrieval-golden.test.ts` GOLDEN_SET — that file
 *     is owned by another agent and must not be modified; keep this list in
 *     sync manually). For every task a small in-memory graph is seeded with the
 *     "golden" file node (the expected target), two token-overlapping
 *     distractor nodes, a module node, and one global decoy node.
 *   Phase 1 — history simulation (Arm A only): K historical tasks with lessons
 *     are fed through the REAL learning paths (applySkillLearning +
 *     recordEpisode), exactly like real runs.
 *   Phase 2 — per task, two configs on two identically-seeded graphs:
 *     Arm A (flywheel ON):  context preview package + suggestSkillHints +
 *                           findSimilarEpisodes (summarized for prompt)
 *     Arm B (flywheel OFF): context preview package only
 *
 * Metrics per config:
 *   - success proxy: expected golden target found within Top-K (K=5). The
 *     package anchors are the ranked retrieval channel (Top-K = first 5);
 *     for Arm A the injected hints + episode summaries are an additional
 *     channel an agent reads in full, so success counts either channel.
 *   - hint injection rate / episode recall rate (fraction of tasks with >=1)
 *   - token overhead per task (gpt-tokenizer, gpt-4o encoding)
 *   - wall-clock per task
 *   - decoy contamination (decoy node/history surfacing in top-5/injection)
 *
 * Outputs:
 *   - benchmarks/.cache/skill-ab-results.json  (structured summary)
 *   - appends the results table to benchmarks/RESULTS.md
 *
 * Run with:  npm run benchmark:ab
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/model/gpt-4o";

import type { GraphEdge, GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import { GraphifyClient } from "../src/graph/graphify-client";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import {
  applySkillLearning,
  suggestSkillHints,
} from "../src/learning/skill-flywheel";
import {
  findSimilarEpisodes,
  recordEpisode,
  summarizeEpisodeForPrompt,
} from "../src/learning/episodic-memory";
import { benchMeta } from "./bench-meta";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = __dirname;
const RESULTS_PATH = join(BENCH_DIR, "RESULTS.md");
const JSON_PATH = join(BENCH_DIR, ".cache", "skill-ab-results.json");

/** Success proxy window: expected target must appear within the top-K ranked items. */
const TOP_K = 5;
/** Context package token budget (same as the retrieval-golden suite). */
const CONTEXT_TOKEN_BUDGET = 800;
const MAX_HINTS = 3;
const MAX_EPISODES = 3;

// ── Task set ────────────────────────────────────────────────────────────────
//
// DUPLICATED from tests/retrieval-golden.test.ts (GOLDEN_SET). That file is the
// source of truth and is owned by another agent — do not modify it. Keep this
// list in sync manually when the golden set changes.
//
// `module` is the canonical slug used in the seeded golden node id and is
// always one of the `expectAny` alternatives listed by the golden suite.
// `direct` marks tasks whose golden node shares query tokens verbatim (pure
// retrieval can find it); `indirect` tasks paraphrase the query (module name is
// morphologically distinct, e.g. "orchestrate" vs "orchestrator") — exactly the
// case where episodic memory of prior work on the module should pay off.

interface GoldenTaskFixture {
  query: string;
  expectAny: string[];
  module: string;
  content: string;
  direct: boolean;
}

const GOLDEN_TASKS: readonly GoldenTaskFixture[] = [
  { query: "orchestrate task routing", expectAny: ["orchestrator"], module: "orchestrator",
    content: "orchestrator manages agent work dispatch across worker pools", direct: false },
  { query: "dag execution engine", expectAny: ["dag-engine", "executedag"], module: "dag-engine",
    content: "dag-engine: dag execution engine implementation with stage scheduling", direct: true },
  { query: "triage task classification simple complex", expectAny: ["triage"], module: "triage",
    content: "triage: triage task classification simple complex routing", direct: true },
  { query: "model router provider selection", expectAny: ["model-router", "modelrouter"], module: "model-router",
    content: "model-router: model router provider selection implementation", direct: true },
  { query: "provider health fallback chain", expectAny: ["provider-health", "providerhealth"], module: "provider-health",
    content: "provider-health: provider health fallback chain implementation", direct: true },
  { query: "graph compression pagerank centrality", expectAny: ["graph-compression", "pagerank"], module: "graph-compression",
    content: "graph-compression: graph compression pagerank centrality implementation", direct: true },
  { query: "context slicer layered package", expectAny: ["context-slicer"], module: "context-slicer",
    content: "context-slicer: context slicer layered package implementation", direct: true },
  { query: "skill flywheel hints scoring", expectAny: ["skill-flywheel", "skillflywheel"], module: "skill-flywheel",
    content: "skill-flywheel: skill flywheel hints scoring implementation", direct: true },
  { query: "episodic memory similar episodes", expectAny: ["episodic-memory", "episodicmemory"], module: "episodic-memory",
    content: "episodic-memory: episodic memory similar episodes implementation", direct: true },
  { query: "embedding cosine similarity vector", expectAny: ["embeddings", "cosine"], module: "embeddings",
    content: "embeddings provider computes numeric representations for semantic lookup", direct: false },
  { query: "file watcher incremental index on save", expectAny: ["file-watcher", "filewatcher"], module: "filewatcher",
    content: "filewatcher watches source trees and refreshes graph state", direct: false },
  { query: "sqlite graph storage fts5", expectAny: ["sqlite-client", "sqlite"], module: "sqlite-client",
    content: "sqlite-client: sqlite graph storage fts5 implementation", direct: true },
  { query: "repo map module overview", expectAny: ["repo-map", "repomap"], module: "repomap",
    content: "repomap renders a compact tree for repository navigation", direct: false },
  { query: "token savings statistics", expectAny: ["token-savings", "tokensavings"], module: "tokensavings",
    content: "tokensavings tracks compressed context budget reports", direct: false },
  { query: "mcp server tool definitions", expectAny: ["tool-definitions", "mcp"], module: "tool-definitions",
    content: "tool-definitions: mcp server tool definitions implementation", direct: true },
  { query: "cli output json formatting", expectAny: ["output", "formatcliresult"], module: "formatcliresult",
    content: "formatcliresult renders machine readable result payloads", direct: false },
  { query: "agent delegation work items bridge", expectAny: ["agent-delegation", "workitem"], module: "workitem",
    content: "workitem payloads carry delegated subgoal tasks", direct: false },
  { query: "six hats insight planning", expectAny: ["insight", "sixhats", "brainstormer"], module: "brainstormer",
    content: "brainstormer produces structured thinking artifacts", direct: false },
  { query: "hnsw approximate nearest neighbor index", expectAny: ["hnsw"], module: "hnsw",
    content: "hnsw: hnsw approximate nearest neighbor index implementation", direct: true },
  { query: "adaptive token budget estimation", expectAny: ["adaptive-budget", "estimatecontextbudget"], module: "estimatecontextbudget",
    content: "estimatecontextbudget sizes context windows by complexity", direct: false },
  { query: "artifact export import graph snapshot", expectAny: ["artifact-manager", "artifact"], module: "artifact-manager",
    content: "artifact-manager: artifact export import graph snapshot implementation", direct: true },
  { query: "nightly learning trainer", expectAny: ["nightly-trainer", "nightlytrainer"], module: "nightly-trainer",
    content: "nightly-trainer: nightly learning trainer implementation", direct: true },
  { query: "reflect episodes extract lessons", expectAny: ["reflector", "reflect"], module: "reflector",
    content: "reflector mines takeaways from finished runs", direct: false },
  { query: "dag checkpoint recovery taskrun", expectAny: ["dag-checkpoint", "checkpoint"], module: "dag-checkpoint",
    content: "dag-checkpoint: dag checkpoint recovery taskrun implementation", direct: true },
  { query: "cancellation timeout controller", expectAny: ["cancellation", "runtime-controller"], module: "cancellation",
    content: "cancellation: cancellation timeout controller implementation", direct: true },
  { query: "language indexers tree sitter wasm", expectAny: ["language-indexers", "tree-sitter", "tree_sitter"], module: "language-indexers",
    content: "language-indexers: language indexers tree sitter wasm implementation", direct: true },
];

// ── History (Arm A only) ────────────────────────────────────────────────────
// One related historical task per golden module, phrased so the module name
// appears verbatim (episode summaries / skill atoms carry it), plus one
// unrelated decoy task that must never be injected for any golden task.

// Task corpus carries project-symbol evidence (file names / camelCase) so the
// anti-noise extraction gate (hasProjectSymbolEvidence) admits skill atoms.
const HISTORY_TASKS: ReadonlyArray<{ task: string; lessons: string[] }> = [
  { task: "fixed orchestrator routing deadlock in orchestrator.ts", lessons: ["verify orchestrator state before dispatch"] },
  { task: "dag-engine checkpoint recovery fix in dag-engine.ts", lessons: ["include plan hash in checkpoint keys"] },
  { task: "triage classifier threshold tuning in triage.ts", lessons: ["keep simple tasks off the llm path"] },
  { task: "model-router provider fallback in routing/model-router.ts", lessons: ["fall back when provider probes fail"] },
  { task: "provider-health fallback chain probing in routing/provider-health.ts", lessons: ["mock provider health probes"] },
  { task: "graph-compression pagerank tuning in graph-compression.ts", lessons: ["use structural edges for centrality"] },
  { task: "context-slicer layered budget allocation in context-slicer.ts", lessons: ["prefer structural compression"] },
  { task: "skill-flywheel scoring updates in skill-flywheel.ts", lessons: ["bounded scores keep ranking stable"] },
  { task: "episodic-memory lesson extraction in episodic-memory.ts", lessons: ["cap lessons per episode"] },
  { task: "embeddings cosine similarity provider in embedding-factory.ts", lessons: ["hash embeddings as fallback"] },
  { task: "filewatcher incremental index invalidation in file-indexer.ts", lessons: ["invalidate on mtime and hash"] },
  { task: "sqlite-client fts5 migration in sqlite-client.ts", lessons: ["version the schema"] },
  { task: "repomap overview generation in repo-map.ts", lessons: ["keep overviews compact"] },
  { task: "tokenSavings statistics reporting in token-savings.ts", lessons: ["report independent tokenizer counts"] },
  { task: "tool-definitions schema updates in mcp/server.ts", lessons: ["keep tool count small"] },
  { task: "formatCliResult json output handling in cli/output.ts", lessons: ["keep output stable across shells"] },
  { task: "workitem bridge delegation in agent-delegation.ts", lessons: ["keep work items small"] },
  { task: "brainstormer insight planning in agents/brainstormer.ts", lessons: ["use structured thinking artifacts"] },
  { task: "hnsw index rebuild strategy in hnsw-store.ts", lessons: ["rebuild index on store change"] },
  { task: "estimateContextBudget token sizing in graph-compression.ts", lessons: ["scale budget with task complexity"] },
  { task: "artifact-manager export compression in artifact-manager.ts", lessons: ["gzip large snapshots"] },
  { task: "nightly-trainer dataset runs in nightly-trainer.ts", lessons: ["pin dataset versions"] },
  { task: "reflector episode lessons in reflector.ts", lessons: ["dedupe extracted lessons"] },
  { task: "dag-checkpoint restore keys in dag-engine.ts", lessons: ["checkpoint keys must include plan hash"] },
  { task: "cancellation timeout handling in orchestrator.ts", lessons: ["cancel timers on teardown"] },
  { task: "language-indexers grammar updates in graph/language-indexers", lessons: ["rebuild wasm grammars on change"] },
  // Decoy history — unrelated topic; must never surface for golden tasks.
  { task: "style vscode panel theme colors in panels.ts", lessons: ["keep contrast high"] },
];

// ── Decoy node ──────────────────────────────────────────────────────────────
// Present in both graphs; shares tokens with exactly one query ("cli output
// json formatting") so decoy contamination is measurable instead of vacuous.
const DECOY_NODE: GraphNode = {
  id: "file:src/legacy/cli-parser.ts",
  type: "File",
  content: "legacy cli parser for format flags and output tables",
};

// ── Token measurement (gpt-4o encoding, same as the token benchmark) ────────

function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
  }
}

function targetFound(text: string, expectAny: string[]): boolean {
  const lower = text.toLowerCase();
  return expectAny.some((needle) => lower.includes(needle.toLowerCase()));
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/g).filter((t) => t.length >= 3);
}

// ── Graph seeding ───────────────────────────────────────────────────────────

async function seedBaseGraph(client: GraphClient, tasks: readonly GoldenTaskFixture[]): Promise<void> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]!;
    const goldenId = `file:src/golden/${task.module}.ts`;
    const tokens = queryTokens(task.query);
    const t0 = tokens[0] ?? "shared";
    const t1 = tokens[1] ?? "common";

    nodes.push({ id: goldenId, type: "File", content: task.content });
    nodes.push({
      id: `file:src/utils/distractor-${i}-a.ts`,
      type: "File",
      content: `generic ${t0} utility helper`,
    });
    nodes.push({
      id: `file:src/utils/distractor-${i}-b.ts`,
      type: "File",
      content: `shared ${t1} helper`,
    });
    const moduleId = `module:src/golden/${task.module}`;
    nodes.push({ id: moduleId, type: "Module", content: `${task.module} module` });
    edges.push({ from: goldenId, to: moduleId, relation: "part_of" });
  }

  nodes.push(DECOY_NODE);
  await client.upsertNodes(nodes);
  await client.upsertEdges(edges);
}

// `GraphifyClient` (src/graph/graphify-client.ts) is the in-memory store that
// `InMemoryGraphClientAdapter` (client-factory.ts, not exported) wraps; it
// structurally implements the full `GraphClient` interface, so it is used
// directly here — the same code path the existing skill benchmark uses.
async function seedHistory(client: GraphClient): Promise<void> {
  for (const item of HISTORY_TASKS) {
    const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };
    await applySkillLearning(client, item.task, run, item.lessons);
    await recordEpisode(client, {
      task: item.task,
      plan: [{ id: "task-1", description: item.task }],
      outcome: "pass",
      keyDecisions: [],
      lessons: item.lessons,
      attempts: 1,
    });
  }
}

// ── Measurement ─────────────────────────────────────────────────────────────

interface PackageMetrics {
  items: string[];
  topKIds: string[];
  tokenEstimate: number;
  wallMs: number;
}

async function buildContextPackage(
  client: GraphClient,
  query: string
): Promise<PackageMetrics> {
  const started = performance.now();
  const pkg = await buildEnhancedContextPackage(
    client,
    query,
    query,
    CONTEXT_TOKEN_BUDGET,
    { enableGraphCompression: true }
  );
  return {
    items: pkg.summaryChannel.map(
      (summary, i) => `${summary} ${pkg.anchorChannel[i]?.id ?? ""}`
    ),
    topKIds: pkg.anchorChannel.slice(0, TOP_K).map((a) => a.id),
    tokenEstimate: pkg.tokenEstimate,
    wallMs: performance.now() - started,
  };
}

export interface SkillAbTaskResult {
  task: string;
  module: string;
  direct: boolean;
  /** Arm B (flywheel OFF): golden target within Top-K of the package anchors. */
  successB: boolean;
  pkgTop5B: boolean;
  pkgTokensB: number;
  pkgItemsB: number;
  /** Arm A (flywheel ON). */
  successA: boolean;
  pkgTop5A: boolean;
  pkgTokensA: number;
  pkgItemsA: number;
  hintsInjected: number;
  hintTokens: number;
  episodesRecalled: number;
  episodeTokens: number;
  injectionHit: boolean;
  decoyInTop5A: boolean;
  decoyInTop5B: boolean;
  decoyInjected: boolean;
  overheadTokens: number;
  wallMsB: number;
  wallMsA: number;
}

export interface SkillAbReport {
  k: number;
  taskCount: number;
  indirectCount: number;
  successRateA: number;
  successRateB: number;
  pkgTop5RateA: number;
  pkgTop5RateB: number;
  injectionCarryRate: number;
  rescued: number;
  hurt: number;
  hintInjectionRate: number;
  episodeRecallRate: number;
  meanTokenOverheadPerTask: number;
  totalTokenOverhead: number;
  meanPkgTokensA: number;
  meanPkgTokensB: number;
  decoyContaminationA: number;
  decoyContaminationB: number;
  decoyInjectionRate: number;
  meanWallMsA: number;
  meanWallMsB: number;
  totalWallMs: number;
  tasks: SkillAbTaskResult[];
}

export async function runSkillAbBenchmark(): Promise<SkillAbReport> {
  const tasks = [...GOLDEN_TASKS];
  if (tasks.length < 20) {
    throw new Error(
      `skill-ab: expected >=20 golden tasks (mirroring the retrieval-golden suite), got ${tasks.length}`
    );
  }

  const startedAt = performance.now();

  // Two identically-seeded graphs; Arm A additionally accumulates the real
  // learning history (skills + episodes) so hints/episodes exist to inject.
  const clientB = new GraphifyClient() as GraphClient;
  const clientA = new GraphifyClient() as GraphClient;
  await seedBaseGraph(clientB, tasks);
  await seedBaseGraph(clientA, tasks);
  await seedHistory(clientA);

  const rows: SkillAbTaskResult[] = [];

  for (const task of tasks) {
    // The golden target is the seeded node; retrieval success means its anchor
    // id ranks within the Top-K package window (id membership — precise, no
    // substring false positives from distractor/decoy nodes).
    const goldenId = `file:src/golden/${task.module}.ts`;

    // Arm B: context preview package only.
    const pkgB = await buildContextPackage(clientB, task.query);
    const pkgTop5B = pkgB.topKIds.includes(goldenId);
    const successB = pkgTop5B;

    // Arm A: package + skill hints + episode summaries. Injected hints and
    // episode summaries reference modules by NAME (not node id), so the
    // injection channel uses the expectAny substring check.
    const pkgA = await buildContextPackage(clientA, task.query);
    const hints = await suggestSkillHints(clientA, task.query, MAX_HINTS);
    const episodes = await findSimilarEpisodes(clientA, task.query, MAX_EPISODES);
    const episodeSummaries = await Promise.all(
      episodes.map((ep) => summarizeEpisodeForPrompt(ep))
    );

    const hintText = hints.join("\n");
    const episodeText = episodeSummaries.join("\n");
    const injectionText = [hintText, episodeText].filter(Boolean).join("\n");
    const injectionHit = targetFound(injectionText, task.expectAny);
    const pkgTop5A = pkgA.topKIds.includes(goldenId);
    const successA = pkgTop5A || injectionHit;

    rows.push({
      task: task.query,
      module: task.module,
      direct: task.direct,
      successB,
      pkgTop5B: successB,
      pkgTokensB: pkgB.tokenEstimate,
      pkgItemsB: pkgB.items.length,
      successA,
      pkgTop5A,
      pkgTokensA: pkgA.tokenEstimate,
      pkgItemsA: pkgA.items.length,
      hintsInjected: hints.length,
      hintTokens: countTokens(hintText),
      episodesRecalled: episodes.length,
      episodeTokens: countTokens(episodeText),
      injectionHit,
      decoyInTop5A: pkgA.topKIds.includes(DECOY_NODE.id),
      decoyInTop5B: pkgB.topKIds.includes(DECOY_NODE.id),
      decoyInjected: injectionText.toLowerCase().includes("vscode"),
      overheadTokens: countTokens(hintText) + countTokens(episodeText),
      wallMsB: pkgB.wallMs,
      wallMsA: pkgA.wallMs,
    });
  }

  const n = rows.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const successA = rows.filter((r) => r.successA).length;
  const successB = rows.filter((r) => r.successB).length;
  const pkgTop5A = rows.filter((r) => r.pkgTop5A).length;
  const pkgTop5B = rows.filter((r) => r.pkgTop5B).length;
  const injectionCarry = rows.filter((r) => r.injectionHit).length;
  const rescued = rows.filter((r) => !r.successB && r.successA).length;
  const hurt = rows.filter((r) => r.successB && !r.successA).length;
  const withHints = rows.filter((r) => r.hintsInjected > 0).length;
  const withEpisodes = rows.filter((r) => r.episodesRecalled > 0).length;
  const decoyA = rows.filter((r) => r.decoyInTop5A).length;
  const decoyB = rows.filter((r) => r.decoyInTop5B).length;
  const decoyInjected = rows.filter((r) => r.decoyInjected).length;

  return {
    k: TOP_K,
    taskCount: n,
    indirectCount: tasks.filter((t) => !t.direct).length,
    successRateA: Math.round((successA / n) * 1000) / 1000,
    successRateB: Math.round((successB / n) * 1000) / 1000,
    pkgTop5RateA: Math.round((pkgTop5A / n) * 1000) / 1000,
    pkgTop5RateB: Math.round((pkgTop5B / n) * 1000) / 1000,
    injectionCarryRate: Math.round((injectionCarry / n) * 1000) / 1000,
    rescued,
    hurt,
    hintInjectionRate: Math.round((withHints / n) * 1000) / 1000,
    episodeRecallRate: Math.round((withEpisodes / n) * 1000) / 1000,
    meanTokenOverheadPerTask: Math.round(mean(rows.map((r) => r.overheadTokens)) * 10) / 10,
    totalTokenOverhead: rows.reduce((s, r) => s + r.overheadTokens, 0),
    meanPkgTokensA: Math.round(mean(rows.map((r) => r.pkgTokensA)) * 10) / 10,
    meanPkgTokensB: Math.round(mean(rows.map((r) => r.pkgTokensB)) * 10) / 10,
    decoyContaminationA: Math.round((decoyA / n) * 1000) / 1000,
    decoyContaminationB: Math.round((decoyB / n) * 1000) / 1000,
    decoyInjectionRate: Math.round((decoyInjected / n) * 1000) / 1000,
    meanWallMsA: Math.round(mean(rows.map((r) => r.wallMsA)) * 10) / 10,
    meanWallMsB: Math.round(mean(rows.map((r) => r.wallMsB)) * 10) / 10,
    totalWallMs: Math.round(performance.now() - startedAt),
    tasks: rows,
  };
}

// ── Output ──────────────────────────────────────────────────────────────────

function renderMarkdown(report: SkillAbReport): string {
  const rows = report.tasks
    .map(
      (t) =>
        `| \`${t.task}\` | \`${t.module}\` | ${t.direct ? "yes" : "no"} | ` +
        `${t.successB ? "hit" : "miss"} | ${t.successA ? "hit" : "miss"} | ${t.pkgTop5A ? "yes" : "no"} | ` +
        `${t.injectionHit ? "yes" : "no"} | ${t.hintsInjected} | ${t.episodesRecalled} | ${t.overheadTokens} |`
    )
    .join("\n");

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  return `<!-- BEGIN P1-2 SKILL-AB BENCHMARK -->
## Skill-Flywheel End-to-End A/B Benchmark — Results (P1-2)

> Appended by \`npm run benchmark:ab\` (\`benchmarks/run-skill-ab.ts\`).
> Last run: ${new Date().toISOString()}
> Structured JSON: \`benchmarks/.cache/skill-ab-results.json\`

## Summary

${report.taskCount} retrieval-golden tasks (${report.indirectCount} "indirect": the
golden module name is morphologically distinct from the query words, e.g.
"orchestrate" vs \`orchestrator\`), run end-to-end on an in-memory graph seeded
with the golden target, distractors and a decoy. Arm A additionally simulates
${HISTORY_TASKS.length} historical tasks through the real learning paths.

| Metric | Arm A (flywheel ON) | Arm B (flywheel OFF) |
| --- | --- | --- |
| **Success proxy** (golden target within Top-${report.k}) | **${pct(report.successRateA)}** (${report.tasks.filter((t) => t.successA).length}/${report.taskCount}) | **${pct(report.successRateB)}** (${report.tasks.filter((t) => t.successB).length}/${report.taskCount}) |
| Success via package Top-${report.k} only | ${pct(report.pkgTop5RateA)} | ${pct(report.pkgTop5RateB)} |
| Tasks rescued by flywheel (B miss → A hit) | ${report.rescued} | — |
| Tasks hurt by flywheel (B hit → A miss) | ${report.hurt} | — |
| Hint injection rate | ${pct(report.hintInjectionRate)} | 0% |
| Episode recall rate | ${pct(report.episodeRecallRate)} | 0% |
| Mean prompt-token overhead / task | ${report.meanTokenOverheadPerTask} | 0 |
| Total prompt-token overhead | ${report.totalTokenOverhead} | 0 |
| Mean package tokens / task | ${report.meanPkgTokensA} | ${report.meanPkgTokensB} |
| Decoy contamination (Top-${report.k}) | ${pct(report.decoyContaminationA)} | ${pct(report.decoyContaminationB)} |
| Decoy contamination (injection) | ${pct(report.decoyInjectionRate)} | 0% |
| Mean wall-clock / task | ${report.meanWallMsA.toFixed(1)} ms | ${report.meanWallMsB.toFixed(1)} ms |
| Total wall-clock | ${(report.totalWallMs / 1000).toFixed(1)} s | — |

## Per-task detail

| Task | Golden module | Direct | Top-${report.k} (B) | Success (A) | Pkg Top-${report.k} (A) | Injection hit (A) | Hints | Episodes | Overhead tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Methodology & honest caveats

- **Task set** is duplicated from \`tests/retrieval-golden.test.ts\` GOLDEN_SET
  (that file is owned by another agent and is not modified). Each task's
  golden node id (\`file:src/golden/<module>.ts\`) contains an \`expectAny\`
  alternative verbatim.
- **Success proxy**: Top-K = the first ${TOP_K} ranked anchors of the compressed
  context package (the retrieval channel); success there means the **golden
  node id** is within those ${TOP_K} anchors (precise id membership — avoids
  substring false positives from distractor/decoy nodes). For Arm A, the
  injected hints + episode summaries form an additional channel an agent reads
  in full; hints/episodes reference modules by **name**, so injection success
  is the \`expectAny\` substring check. Arm A success = package Top-${TOP_K} hit
  **or** injection hit. The package-only hit rate is reported separately for a
  like-for-like retrieval comparison.
- **Arm B success is deliberately imperfect**: for the ${report.indirectCount}
  indirect tasks the golden file shares zero tokens with the query (realistic:
  module names are morphologically different from task wording), so pure
  retrieval cannot find it — prior episodic experience is the only bridge.
- Both arms run through the **real** retrieval and learning paths
  (\`buildEnhancedContextPackage\`, \`applySkillLearning\`, \`recordEpisode\`,
  \`suggestSkillHints\`, \`findSimilarEpisodes\`, \`summarizeEpisodeForPrompt\`)
  on isolated in-memory graphs — no mocks, no network, no API key.
- Token counts use \`gpt-tokenizer\` (gpt-4o encoding), identical to the token
  benchmark. Hashing is the project's DJB2a (FNV-class) — fully deterministic
  within a run; episode ids embed \`Date.now()\` so ids differ across runs, but
  ranking depends on tokens/scores, not ids.
- This measures a mechanical success proxy, not LLM task completion. It
  validates that the flywheel's injected context and graph nodes move the
  needle on finding the expected target, and quantifies the exact token and
  wall-clock cost.
<!-- END P1-2 SKILL-AB BENCHMARK -->`;
}

/** Replace the previous P1-2 section in RESULTS.md if present, else append. */
function writeResultsMarkdown(markdown: string): void {
  const full = readFileSync(RESULTS_PATH, "utf8");
  const startMarker = "<!-- BEGIN P1-2 SKILL-AB BENCHMARK -->";
  const endMarker = "<!-- END P1-2 SKILL-AB BENCHMARK -->";
  const startIdx = full.indexOf(startMarker);
  const endIdx = full.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const next = full.slice(endIdx + endMarker.length);
    writeFileSync(RESULTS_PATH, `${full.slice(0, startIdx)}${markdown}${next}`, "utf8");
  } else {
    writeFileSync(RESULTS_PATH, `${full.trimEnd()}\n\n${markdown}\n`, "utf8");
  }
}

async function main(): Promise<void> {
  process.stdout.write("GraphFlow skill-flywheel end-to-end A/B benchmark (P1-2)\n");
  process.stdout.write(`Task set: ${GOLDEN_TASKS.length} retrieval-golden queries (duplicated from tests/retrieval-golden.test.ts)\n`);
  process.stdout.write(`History (Arm A): ${HISTORY_TASKS.length} tasks (incl. 1 decoy)\n\n`);

  const report = await runSkillAbBenchmark();

  mkdirSync(dirname(JSON_PATH), { recursive: true });
  // Machine-readable artifact with reproducibility envelope (commit + date).
  writeFileSync(
    JSON_PATH,
    JSON.stringify({ ...benchMeta("skill-ab-p1-2"), ...report }, null, 2),
    "utf8"
  );
  writeResultsMarkdown(renderMarkdown(report));

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  process.stdout.write("=".repeat(64) + "\n");
  process.stdout.write(
    `success A(on)=${pct(report.successRateA)}  B(off)=${pct(report.successRateB)}  ` +
      `rescued=${report.rescued}  hurt=${report.hurt}\n`
  );
  process.stdout.write(
    `hintInjection=${pct(report.hintInjectionRate)}  episodeRecall=${pct(report.episodeRecallRate)}  ` +
      `injectionCarry=${pct(report.injectionCarryRate)}\n`
  );
  process.stdout.write(
    `overhead=${report.meanTokenOverheadPerTask} tok/task (total ${report.totalTokenOverhead})  ` +
      `wall=${(report.totalWallMs / 1000).toFixed(1)}s total\n`
  );
  process.stdout.write("=".repeat(64) + "\n");
  process.stdout.write(`JSON: ${JSON_PATH}\n`);
  process.stdout.write(`RESULTS.md updated: ${RESULTS_PATH}\n`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (isMain) {
  void main();
}
