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
 *   Phase 1 — history simulation (Arm A only): the task set is split
 *     deterministically (even index = training split, odd index = held-out).
 *     Only training-split history is fed through the REAL learning paths
 *     (applySkillLearning + recordEpisode); any training entry that mentions
 *     a held-out task's expected target is dropped, so no seeded experience
 *     is derived from the answers that are scored.
 *   Phase 2 — per HELD-OUT task, two configs on two identically-seeded graphs:
 *     Arm A (flywheel ON):  context preview package + suggestSkillHints +
 *                           findSimilarEpisodes (summarized for prompt)
 *     Arm B (flywheel OFF): context preview package only
 *
 * This is a SYNTHETIC MECHANISM TEST on a hand-built graph, not an LLM
 * task-success measurement; its numbers must not be quoted as success rates.
 *
 * Metrics per config:
 *   - target-surfaced proxy, IDENTICAL criterion for both arms: the golden
 *     node id is within the package Top-K (K=5) anchors, OR an expected
 *     target name appears in the arm's injected text (hints + episode
 *     summaries). Arm B injects nothing, so only its package can pass.
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

/** The single success criterion applied to BOTH arms. */
function targetSurfaced(
  topKIds: readonly string[],
  goldenId: string,
  injectionText: string,
  expectAny: string[]
): boolean {
  return topKIds.includes(goldenId) || targetFound(injectionText, expectAny);
}

interface HistoryEntry {
  task: string;
  lessons: string[];
}

/**
 * Deterministic train / held-out split. HISTORY_TASKS[i] is the history of
 * GOLDEN_TASKS[i]; only training-split history is seeded, and any training
 * entry naming a held-out target is dropped so no seeded experience comes
 * from the answers being scored.
 */
function splitTasksAndHistory(): {
  train: GoldenTaskFixture[];
  heldOut: GoldenTaskFixture[];
  history: HistoryEntry[];
  leakageDropped: number;
} {
  const decoy = HISTORY_TASKS[HISTORY_TASKS.length - 1]!;
  const aligned = HISTORY_TASKS.slice(0, -1);
  if (aligned.length !== GOLDEN_TASKS.length) {
    throw new Error(
      `skill-ab: HISTORY_TASKS (${aligned.length} + decoy) must align 1:1 with GOLDEN_TASKS (${GOLDEN_TASKS.length})`
    );
  }
  const train: GoldenTaskFixture[] = [];
  const heldOut: GoldenTaskFixture[] = [];
  const trainHistory: HistoryEntry[] = [];
  GOLDEN_TASKS.forEach((task, i) => {
    if (i % 2 === 0) {
      train.push(task);
      trainHistory.push(aligned[i]!);
    } else {
      heldOut.push(task);
    }
  });
  const heldOutNeedles = heldOut.flatMap((t) => [t.module, ...t.expectAny]);
  const history = trainHistory.filter(
    (h) => !targetFound(`${h.task} ${h.lessons.join(" ")}`, heldOutNeedles)
  );
  return {
    train,
    heldOut,
    history: [...history, decoy],
    leakageDropped: trainHistory.length - history.length,
  };
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
async function seedHistory(client: GraphClient, history: readonly HistoryEntry[]): Promise<void> {
  for (const item of history) {
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
  /** Arm B (flywheel OFF): target surfaced under the shared criterion (package only; no injection). */
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
  /** Synthetic mechanism test on a hand-built graph; not an LLM task-success rate. */
  kind: "synthetic-mechanism-test";
  evaluation: "held-out-split";
  k: number;
  /** Held-out tasks evaluated (successRate* denominators). */
  taskCount: number;
  trainTaskCount: number;
  historySeeded: number;
  leakageDropped: number;
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
  if (GOLDEN_TASKS.length < 20) {
    throw new Error(
      `skill-ab: expected >=20 golden tasks (mirroring the retrieval-golden suite), got ${GOLDEN_TASKS.length}`
    );
  }
  const split = splitTasksAndHistory();
  const tasks = split.heldOut;

  const startedAt = performance.now();

  // Two identically-seeded graphs (all tasks' nodes); Arm A additionally
  // accumulates the training-split learning history (skills + episodes).
  const clientB = new GraphifyClient() as GraphClient;
  const clientA = new GraphifyClient() as GraphClient;
  await seedBaseGraph(clientB, GOLDEN_TASKS);
  await seedBaseGraph(clientA, GOLDEN_TASKS);
  await seedHistory(clientA, split.history);

  const rows: SkillAbTaskResult[] = [];

  for (const task of tasks) {
    // Package hits use golden node id membership (precise, no substring false
    // positives from distractor/decoy nodes); injected text names modules, so
    // it uses the expectAny substring check. Both arms go through
    // targetSurfaced with their own channels.
    const goldenId = `file:src/golden/${task.module}.ts`;

    // Arm B: context preview package only.
    const pkgB = await buildContextPackage(clientB, task.query);
    const pkgTop5B = pkgB.topKIds.includes(goldenId);
    const successB = targetSurfaced(pkgB.topKIds, goldenId, "", task.expectAny);

    // Arm A: package + skill hints + episode summaries.
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
    const successA = targetSurfaced(pkgA.topKIds, goldenId, injectionText, task.expectAny);

    rows.push({
      task: task.query,
      module: task.module,
      direct: task.direct,
      successB,
      pkgTop5B,
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
    kind: "synthetic-mechanism-test",
    evaluation: "held-out-split",
    k: TOP_K,
    taskCount: n,
    trainTaskCount: split.train.length,
    historySeeded: split.history.length,
    leakageDropped: split.leakageDropped,
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
## Skill-Flywheel A/B — Synthetic Mechanism Test (P1-2)

> Appended by \`npm run benchmark:ab\` (\`benchmarks/run-skill-ab.ts\`).
> Last run: ${new Date().toISOString()}
> Structured JSON: \`benchmarks/.cache/skill-ab-results.json\`

> **Synthetic mechanism test, not a task-success rate.** The graph, the tasks and
> the historical experience are hand-built; no LLM executes anything. Both arms
> are scored with one identical criterion, and Arm A's seeded history comes only
> from a disjoint training split (entries naming a held-out target are dropped).
> Quote these numbers only as "does recall of prior experience transfer to unseen
> tasks in this toy setup", never as "the flywheel raises success to X%".

## Summary

${report.taskCount} HELD-OUT retrieval-golden tasks (odd indices; ${report.indirectCount} "indirect":
the golden module name is morphologically distinct from the query words, e.g.
"orchestrate" vs \`orchestrator\`), run on an in-memory graph seeded with every
task's golden target, distractors and a decoy. Arm A additionally learns
${report.historySeeded} historical tasks (from the ${report.trainTaskCount}-task training split, incl. 1 decoy;
${report.leakageDropped} training entries dropped because they named a held-out target).

| Metric | Arm A (flywheel ON) | Arm B (flywheel OFF) |
| --- | --- | --- |
| **Target surfaced** (same criterion both arms: golden id in package Top-${report.k}, or target named in injected text) | **${pct(report.successRateA)}** (${report.tasks.filter((t) => t.successA).length}/${report.taskCount}) | **${pct(report.successRateB)}** (${report.tasks.filter((t) => t.successB).length}/${report.taskCount}) |
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

| Task | Golden module | Direct | Surfaced (B) | Surfaced (A) | Pkg Top-${report.k} (A) | Injection hit (A) | Hints | Episodes | Overhead tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Methodology & honest caveats

- **Kind**: synthetic mechanism test on a hand-built in-memory graph. No LLM runs
  and nothing is executed, so this is not a task-success rate.
- **Task set** is duplicated from \`tests/retrieval-golden.test.ts\` GOLDEN_SET
  (that file is owned by another agent and is not modified). Each task's
  golden node id (\`file:src/golden/<module>.ts\`) contains an \`expectAny\`
  alternative verbatim.
- **Split**: even-index tasks form the training split whose history is seeded
  into Arm A; odd-index tasks are held out and are the only tasks scored.
  Training entries that mention any held-out \`expectAny\` / module name are
  dropped, so the seeded experience is not derived from the scored answers.
  Earlier versions seeded one history entry per scored task, written from the
  answer key — those "100% vs 61.5%" numbers are superseded.
- **One criterion for both arms**: a task passes when the golden node id is
  within the first ${TOP_K} package anchors, OR an \`expectAny\` target name appears
  in the arm's injected text (hints + episode summaries). Arm B injects nothing,
  so only its package can pass; the package-only rate is reported separately.
- For indirect tasks the golden node shares zero tokens with the query, so
  package retrieval alone cannot find it in either arm.
- Both arms run through the **real** retrieval and learning paths
  (\`buildEnhancedContextPackage\`, \`applySkillLearning\`, \`recordEpisode\`,
  \`suggestSkillHints\`, \`findSimilarEpisodes\`, \`summarizeEpisodeForPrompt\`)
  on isolated in-memory graphs — no mocks, no network, no API key.
- Token counts use \`gpt-tokenizer\` (gpt-4o encoding), identical to the token
  benchmark. Hashing is the project's DJB2a (FNV-class) — fully deterministic
  within a run; episode ids embed \`Date.now()\` so ids differ across runs, but
  ranking depends on tokens/scores, not ids.
- This measures a mechanical target-surfaced proxy, not LLM task completion or
  answer quality. It reports whether training-split experience transfers to
  unseen tasks in this toy setup, plus the exact token and wall-clock cost.
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
  process.stdout.write("GraphFlow skill-flywheel A/B — synthetic mechanism test (P1-2; not a task-success rate)\n");
  process.stdout.write(`Task set: ${GOLDEN_TASKS.length} retrieval-golden queries (duplicated from tests/retrieval-golden.test.ts)\n`);

  const report = await runSkillAbBenchmark();
  process.stdout.write(
    `Split: ${report.trainTaskCount} train / ${report.taskCount} held-out; history seeded (Arm A): ` +
      `${report.historySeeded} (incl. 1 decoy), ${report.leakageDropped} dropped for naming a held-out target\n\n`
  );

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
    `held-out target-surfaced A(on)=${pct(report.successRateA)}  B(off)=${pct(report.successRateB)}  ` +
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
