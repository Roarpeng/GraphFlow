/**
 * GraphFlow episodic-memory END-TO-END A/B benchmark (P3).
 *
 * Question: does EPISODIC MEMORY (past episode recall + injected summaries +
 * skill hints) improve an end-to-end SUCCESS proxy — "the expected golden
 * target is found" — and can we ATTRIBUTE each rescue to the specific memory
 * that carried it?
 *
 * This is the formal MEMORY ROI benchmark: it extends the P1-2 skill-flywheel
 * A/B harness (benchmarks/run-skill-ab.ts) with a HARD-domain task set and a
 * per-task attribution chain.
 *
 * Design (offline, deterministic, no API key, FNV/DJB2 hashing only):
 *   Phase 0 — fixture: the task set is the 26 retrieval-golden queries
 *     (DUPLICATED from tests/retrieval-golden.test.ts GOLDEN_SET — that file
 *     is owned by another agent and must not be modified; keep this list in
 *     sync manually, exactly like benchmarks/run-skill-ab.ts does) plus >= 34
 *     HARD-domain tasks (cross-module blast radius, name disambiguation,
 *     indirect/morphological queries such as "orchestrate" -> orchestrator or
 *     "where is routing decided"). For every task a small in-memory graph is
 *     seeded with the "golden" file node (the expected target), two
 *     token-overlapping distractor nodes, a module node, and one global decoy
 *     node.
 *     HARD tasks are deliberately built so the golden node shares ZERO query
 *     tokens (its node id carries the module name, but node ids are not part
 *     of searchable text — see graph-utils.nodeSearchableText), so pure
 *     retrieval cannot rank it: prior episodic experience is the only bridge.
 *   Phase 1 — history simulation (Arm A only): K historical tasks with
 *     lessons are fed through the REAL learning paths (applySkillLearning +
 *     recordEpisode), exactly like real runs. Golden-history entries mirror
 *     run-skill-ab.ts verbatim (no file-path evidence, so hints stay at the
 *     P1-2 baseline); HARD-history entries carry file-path evidence so skills
 *     form and the hint channel is exercised too.
 *   Phase 2 — per task, two configs on two identically-seeded graphs:
 *     Arm A (memory ON):  context preview package + suggestSkillHints +
 *                         findSimilarEpisodes (summarized for prompt)
 *     Arm B (memory OFF): context preview package only
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
 *   - ATTRIBUTION CHAIN (new): for every rescued task (B miss -> A hit)
 *     record which memory contributed: the top similar episode (id + task +
 *     similarity score, scored with the exact same Jaccard + outcome-bonus
 *     formula findSimilarEpisodes uses internally) and the actual hint /
 *     episode-summary text that was injected. Aggregate into a memory-
 *     contribution summary (distinct memories that rescued tasks, top-3
 *     contributing memories).
 *
 * Outputs:
 *   - benchmarks/.cache/memory-ab-results.json  (structured summary)
 *   - appends the results table to benchmarks/RESULTS.md
 *
 * Run with:  npm run benchmark:memory
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
  extractTaskTokens,
  findSimilarEpisodes,
  recordEpisode,
  summarizeEpisodeForPrompt,
  type EpisodeRecord,
} from "../src/learning/episodic-memory";
import { benchMeta } from "./bench-meta";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = __dirname;
const RESULTS_PATH = join(BENCH_DIR, "RESULTS.md");
const JSON_PATH = join(BENCH_DIR, ".cache", "memory-ab-results.json");

/** Success proxy window: expected target must appear within the top-K ranked items. */
const TOP_K = 5;
/** Context package token budget (same as the retrieval-golden suite). */
const CONTEXT_TOKEN_BUDGET = 800;
const MAX_HINTS = 3;
const MAX_EPISODES = 3;

// ── Task set ────────────────────────────────────────────────────────────────
//
// Part 1 — the 26 retrieval-golden queries.
//
// DUPLICATED from tests/retrieval-golden.test.ts (GOLDEN_SET). That file is the
// source of truth and is owned by another agent — do not modify it. Keep this
// list in sync manually (mirrors benchmarks/run-skill-ab.ts).
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

// ── Part 2 — HARD-domain tasks (>= 34) ──────────────────────────────────────
//
// Three families, all built so the golden node shares ZERO query tokens
// (the golden file id `file:src/golden/<module>.ts` carries the module name,
// but node ids are not searchable text — `nodeSearchableText` uses content +
// metadata only), so the OFF arm cannot rank the golden target and episodic
// memory is the only bridge:
//   - cross-module:    the query names a symptom in module A ("provider adapter
//                      crash kills routing") but the golden module is elsewhere
//                      ("model-router") — the memory of the past incident is
//                      what bridges the blast radius.
//   - disambiguation:  the query words are generic and match many things
//                      ("which agent gets this task"); memory disambiguates.
//   - indirect:        morphological paraphrase ("execute the chosen provider"
//                      -> provider-executor, "peek at the graph state" ->
//                      snapshot-view).
//
// Each task's history entry is phrased to (a) share >= 1 plain word with the
// query (so the Jaccard ranking inside findSimilarEpisodes recalls it — the
// same mechanism P1-2 uses) and (b) contain the golden module name verbatim
// (so the injected summary carries the target). The evidence path provides
// the project-symbol evidence the P0-2 extraction gate requires, so skills
// form and the hint channel is exercised for hard tasks.

export type HardTaskKind = "cross-module" | "disambiguation" | "indirect";

interface HardTaskFixture extends GoldenTaskFixture {
  kind: HardTaskKind;
  /** Historical episode text: shares query words + carries the module name. */
  history: string;
  lessons: string[];
  /** File path used as skill-extraction evidence (project-symbol gate). */
  evidence: string;
}

const HARD_TASKS: readonly HardTaskFixture[] = [
  // ── cross-module blast radius ──────────────────────────────────────────────
  { query: "provider adapter crash kills routing", expectAny: ["model-router", "modelrouter"], module: "model-router",
    content: "dispatch layer picks an upstream backend per request", direct: false, kind: "cross-module",
    history: "provider adapter crash killed model-router dispatch", lessons: ["pin provider adapter versions"],
    evidence: "src/routing/model-router.ts" },
  { query: "adding an embedding provider changed graph scores", expectAny: ["graph-compression", "pagerank"], module: "graph-compression",
    content: "centrality computation orders which nodes surface", direct: false, kind: "cross-module",
    history: "embedding provider changed graph-compression pagerank scores", lessons: ["recompute pagerank after provider swaps"],
    evidence: "src/graph/graph-compression.ts" },
  { query: "cli flags now ignored after settings refactor", expectAny: ["config/loader", "config-loader"], module: "config-loader",
    content: "merges defaults and overrides for every surface", direct: false, kind: "cross-module",
    history: "settings refactor broke cli flag loading in config-loader", lessons: ["keep flag precedence explicit"],
    evidence: "src/config/loader.ts" },
  { query: "indexer reindex wipes mcp session state", expectAny: ["mcp-server"], module: "mcp-server",
    content: "stdio transport carries requests over a persistent channel", direct: false, kind: "cross-module",
    history: "indexer reindex wiped mcp-server session state", lessons: ["persist session outside the graph store"],
    evidence: "src/surfaces/mcp/server.ts" },
  { query: "new language grammar breaks file watching", expectAny: ["file-watcher", "filewatcher"], module: "file-watcher",
    content: "tree changes trigger incremental graph refresh", direct: false, kind: "cross-module",
    history: "grammar update broke file-watcher watching loop", lessons: ["restart watcher on grammar rebuild"],
    evidence: "src/graph/file-indexer.ts" },
  { query: "sqlite migration loses episodic history", expectAny: ["episodic-memory", "episodicmemory"], module: "episodic-memory",
    content: "past runs become reusable lessons for later tasks", direct: false, kind: "cross-module",
    history: "sqlite migration lost episodic-memory episodes", lessons: ["backfill episodes after schema change"],
    evidence: "src/learning/episodic-memory.ts" },
  { query: "tool schema update confuses agent profiles", expectAny: ["tool-definitions", "mcp"], module: "tool-definitions",
    content: "declares every tool contract the server exposes", direct: false, kind: "cross-module",
    history: "tool-definitions schema update confused profiles", lessons: ["keep tool contracts backwards compatible"],
    evidence: "src/surfaces/mcp/tool-definitions.ts" },
  { query: "nightly training corrupts workspace config", expectAny: ["workspace-root"], module: "workspace-root",
    content: "locates the project boundary for every command", direct: false, kind: "cross-module",
    history: "nightly training corrupted workspace-root discovery", lessons: ["never write config during training"],
    evidence: "src/config/workspace-root.ts" },
  { query: "editor panel stuck after mcp restart", expectAny: ["vscode/extension", "vscode-extension"], module: "vscode-extension",
    content: "renders graph state for editors", direct: false, kind: "cross-module",
    history: "mcp restart stuck vscode-extension panel", lessons: ["reconnect panel on transport restart"],
    evidence: "src/surfaces/vscode/extension.ts" },
  { query: "query expansion returns chinese results", expectAny: ["query-expand"], module: "query-expand",
    content: "broadens hits with synonyms before ranking", direct: false, kind: "cross-module",
    history: "query-expand returned wrong language results", lessons: ["scope expansion to query language"],
    evidence: "src/graph/query-expand.ts" },
  { query: "feedback loop inflates skill scores", expectAny: ["skill-flywheel", "skillflywheel"], module: "skill-flywheel",
    content: "ranks hints so agents see the best guidance", direct: false, kind: "cross-module",
    history: "feedback loop inflated skill-flywheel scores", lessons: ["cap score growth per cycle"],
    evidence: "src/learning/skill-flywheel.ts" },
  { query: "atomic skill writes lock the whole store", expectAny: ["skill-store"], module: "skill-store",
    content: "persists learning state durably across runs", direct: false, kind: "cross-module",
    history: "skill-store write lock blocked other updates", lessons: ["use fine grained locks"],
    evidence: "src/learning/skill-store.ts" },

  // ── name disambiguation ────────────────────────────────────────────────────
  { query: "tree walker skips hidden directories", expectAny: ["file-indexer-walker"], module: "file-indexer-walker",
    content: "recursively collects files from the project root", direct: false, kind: "disambiguation",
    history: "tree walker skip bug fixed in file-indexer-walker", lessons: ["honor dotfile include rules"],
    evidence: "src/graph/file-indexer-walker.ts" },
  { query: "persistent storage for graph data", expectAny: ["sqlite-client", "sqlite"], module: "sqlite-client",
    content: "local engine that answers structured queries", direct: false, kind: "disambiguation",
    history: "graph data persisted through sqlite-client store", lessons: ["version the schema"],
    evidence: "src/graph/sqlite-client.ts" },
  { query: "cached context goes stale on file save", expectAny: ["context-cache"], module: "context-cache",
    content: "holds prepared slices for fast reuse", direct: false, kind: "disambiguation",
    history: "context-cache invalidation on save events", lessons: ["invalidate on mtime and hash"],
    evidence: "src/graph/context-cache.ts" },
  { query: "which agent gets this task", expectAny: ["agent-assignment"], module: "agent-assignment",
    content: "matches tasks to capable workers by profile", direct: false, kind: "disambiguation",
    history: "agent-assignment chose the wrong agent", lessons: ["score profiles before assigning"],
    evidence: "src/agents/agent-assignment.ts" },
  { query: "upstream probe fails then what", expectAny: ["provider-health", "providerhealth"], module: "provider-health",
    content: "detects dead endpoints and flags them for fallback", direct: false, kind: "disambiguation",
    history: "upstream probe failures tripped provider-health", lessons: ["mock provider health probes"],
    evidence: "src/routing/provider-health.ts" },
  { query: "simple versus complex task split", expectAny: ["triage"], module: "triage",
    content: "classifies incoming work before scheduling", direct: false, kind: "disambiguation",
    history: "simple tasks bypassed triage queue", lessons: ["keep simple tasks off the llm path"],
    evidence: "src/core/triage.ts" },
  { query: "learn from what went wrong", expectAny: ["reflector", "reflect"], module: "reflector",
    content: "distills run outcomes into reusable guidance", direct: false, kind: "disambiguation",
    history: "what went wrong captured by reflector", lessons: ["dedupe extracted lessons"],
    evidence: "src/learning/reflector.ts" },
  { query: "stop a hung run safely", expectAny: ["cancellation", "runtime-controller"], module: "cancellation",
    content: "aborts in flight work without corrupting state", direct: false, kind: "disambiguation",
    history: "hung run cancelled by cancellation controller", lessons: ["cancel timers on teardown"],
    evidence: "src/core/cancellation.ts" },
  { query: "numbers behind the token savings", expectAny: ["token-savings", "tokensavings"], module: "tokensavings",
    content: "reports how much context was spared", direct: false, kind: "disambiguation",
    history: "token savings numbers audited in tokensavings", lessons: ["report independent tokenizer counts"],
    evidence: "src/core/tokensavings.ts" },
  { query: "find similar past problems", expectAny: ["embeddings", "cosine"], module: "embeddings",
    content: "turns text into vectors for semantic search", direct: false, kind: "disambiguation",
    history: "similar past problems matched by embeddings", lessons: ["hash embeddings as fallback"],
    evidence: "src/learning/embeddings.ts" },
  { query: "fast nearest neighbor search", expectAny: ["hnsw"], module: "hnsw",
    content: "indexes vectors for approximate lookups", direct: false, kind: "disambiguation",
    history: "nearest neighbor search too slow in hnsw", lessons: ["rebuild index on store change"],
    evidence: "src/learning/hnsw.ts" },
  { query: "did the run stay on target", expectAny: ["goal-anchor"], module: "goal-anchor",
    content: "tracks deviation from the original intent", direct: false, kind: "disambiguation",
    history: "run drifted from goal-anchor target", lessons: ["log deviation reasons per drift"],
    evidence: "src/core/goal-anchor.ts" },

  // ── indirect / morphological ───────────────────────────────────────────────
  { query: "execute the chosen provider", expectAny: ["provider-executor"], module: "provider-executor",
    content: "runs the selected backend and marshals output", direct: false, kind: "indirect",
    history: "chosen provider call failed in provider-executor", lessons: ["retry idempotent calls"],
    evidence: "src/routing/provider-executor.ts" },
  { query: "what can each role do", expectAny: ["role-capabilities"], module: "role-capabilities",
    content: "maps agents to allowed operations", direct: false, kind: "indirect",
    history: "role gating too coarse for role-capabilities", lessons: ["gate by tier not by name"],
    evidence: "src/routing/role-capabilities.ts" },
  { query: "protocol messages over the wire", expectAny: ["atp-schema"], module: "atp-schema",
    content: "defines framing for agent exchange payloads", direct: false, kind: "indirect",
    history: "protocol message framing changed in atp-schema", lessons: ["version protocol fields"],
    evidence: "src/core/atp-schema.ts" },
  { query: "describe the work before planning", expectAny: ["task-profile"], module: "task-profile",
    content: "captures the shape of incoming requests", direct: false, kind: "indirect",
    history: "describe work shape with task-profile", lessons: ["require capability fields"],
    evidence: "src/core/task-profile.ts" },
  { query: "transition states in order", expectAny: ["state-machine"], module: "state-machine",
    content: "walks lifecycle steps in sequence", direct: false, kind: "indirect",
    history: "state-machine transition lifecycle", lessons: ["validate transition tables"],
    evidence: "src/core/state-machine.ts" },
  { query: "break the goal into steps", expectAny: ["planner"], module: "planner",
    content: "splits an objective into ordered subgoals", direct: false, kind: "indirect",
    history: "planner decompose plan steps", lessons: ["keep subgoals independent"],
    evidence: "src/agents/planner.ts" },
  { query: "pick between conflicting options", expectAny: ["decision-engine"], module: "decision-engine",
    content: "weighs tradeoffs for hard calls", direct: false, kind: "indirect",
    history: "conflicting options resolved by decision-engine", lessons: ["weight evidence over intuition"],
    evidence: "src/core/decision-engine.ts" },
  { query: "peek at the graph state", expectAny: ["snapshot-view"], module: "snapshot-view",
    content: "captures the store for inspection", direct: false, kind: "indirect",
    history: "snapshot-view graph state dump", lessons: ["snapshot before heavy mutations"],
    evidence: "src/graph/snapshot-view.ts" },
  { query: "stats about the knowledge graph", expectAny: ["graph-analysis"], module: "graph-analysis",
    content: "computes structure metrics on demand", direct: false, kind: "indirect",
    history: "stats about the knowledge graph fixed in graph-analysis", lessons: ["cache expensive metrics"],
    evidence: "src/graph/graph-analysis.ts" },
  { query: "bootstrap skills from scratch", expectAny: ["seed-skills"], module: "seed-skills",
    content: "installs curated starting guidance", direct: false, kind: "indirect",
    history: "seed-skills bootstrap curation", lessons: ["pin curated skill versions"],
    evidence: "src/learning/seed-skills.ts" },
  { query: "export the learning dataset", expectAny: ["exporter"], module: "exporter",
    content: "writes training samples to disk", direct: false, kind: "indirect",
    history: "exporter jsonl dataset writes", lessons: ["stream large datasets"],
    evidence: "src/learning/exporter.ts" },
  { query: "detect app routes automatically", expectAny: ["framework-routes"], module: "framework-routes",
    content: "finds endpoints declared by applications", direct: false, kind: "indirect",
    history: "app route detection fixed in framework-routes", lessons: ["respect framework config"],
    evidence: "src/graph/framework-routes.ts" },
];

interface BenchmarkTask extends GoldenTaskFixture {
  kind: "golden" | HardTaskKind;
  history: string;
  lessons: string[];
  evidence: string | null;
}

const ALL_TASKS: BenchmarkTask[] = [
  ...GOLDEN_TASKS.map((t) => ({
    ...t,
    kind: "golden" as const,
    history: "",
    lessons: [] as string[],
    evidence: null,
  })),
  ...HARD_TASKS.map((t) => ({ ...t, lessons: [...t.lessons] })),
];

// ── History (Arm A only) ────────────────────────────────────────────────────
// Golden-module history mirrors benchmarks/run-skill-ab.ts verbatim (one
// related historical task per golden module, phrased so the module name
// appears verbatim, plus one unrelated decoy task that must never be injected
// for any task). Hard-task history lives on each HardTaskFixture entry.

const GOLDEN_HISTORY: ReadonlyArray<{ task: string; lessons: string[] }> = [
  { task: "fixed orchestrator routing deadlock", lessons: ["verify orchestrator state before dispatch"] },
  { task: "dag-engine checkpoint recovery fix", lessons: ["include plan hash in checkpoint keys"] },
  { task: "triage classifier threshold tuning", lessons: ["keep simple tasks off the llm path"] },
  { task: "model-router provider fallback", lessons: ["fall back when provider probes fail"] },
  { task: "provider-health fallback chain probing", lessons: ["mock provider health probes"] },
  { task: "graph-compression pagerank tuning", lessons: ["use structural edges for centrality"] },
  { task: "context-slicer layered budget allocation", lessons: ["prefer structural compression"] },
  { task: "skill-flywheel scoring updates", lessons: ["bounded scores keep ranking stable"] },
  { task: "episodic-memory lesson extraction", lessons: ["cap lessons per episode"] },
  { task: "embeddings cosine similarity provider", lessons: ["hash embeddings as fallback"] },
  { task: "filewatcher incremental index invalidation", lessons: ["invalidate on mtime and hash"] },
  { task: "sqlite-client fts5 migration", lessons: ["version the schema"] },
  { task: "repomap overview generation", lessons: ["keep overviews compact"] },
  { task: "tokensavings statistics reporting", lessons: ["report independent tokenizer counts"] },
  { task: "tool-definitions schema updates", lessons: ["keep tool count small"] },
  { task: "formatcliresult json output handling", lessons: ["keep output stable across shells"] },
  { task: "workitem bridge delegation", lessons: ["keep work items small"] },
  { task: "brainstormer insight planning", lessons: ["use structured thinking artifacts"] },
  { task: "hnsw index rebuild strategy", lessons: ["rebuild index on store change"] },
  { task: "estimatecontextbudget token sizing", lessons: ["scale budget with task complexity"] },
  { task: "artifact-manager export compression", lessons: ["gzip large snapshots"] },
  { task: "nightly-trainer dataset runs", lessons: ["pin dataset versions"] },
  { task: "reflector episode lessons", lessons: ["dedupe extracted lessons"] },
  { task: "dag-checkpoint restore keys", lessons: ["checkpoint keys must include plan hash"] },
  { task: "cancellation timeout handling", lessons: ["cancel timers on teardown"] },
  { task: "language-indexers grammar updates", lessons: ["rebuild wasm grammars on change"] },
  // Decoy history — unrelated topic; must never surface for any task.
  { task: "style vscode panel theme colors", lessons: ["keep contrast high"] },
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

async function seedBaseGraph(client: GraphClient, tasks: readonly BenchmarkTask[]): Promise<void> {
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
// directly here — the same code path the existing benchmarks use.
async function seedHistory(client: GraphClient, tasks: readonly BenchmarkTask[]): Promise<void> {
  for (const item of GOLDEN_HISTORY) {
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
  for (const task of tasks) {
    if (!task.history) continue;
    const run = { status: "COMPLETED" as const, attempts: 1, feedback: "done" };
    // Hard-domain history carries file-path evidence so the P0-2 extraction
    // gate accepts the corpus and skills (the hint channel) actually form.
    await applySkillLearning(
      client,
      task.history,
      run,
      task.lessons,
      task.evidence ? { evidence: [task.evidence] } : undefined
    );
    await recordEpisode(client, {
      task: task.history,
      plan: [{ id: "task-1", description: task.history }],
      outcome: "pass",
      keyDecisions: [],
      lessons: task.lessons,
      attempts: 1,
    });
  }
}

// ── Episode similarity (attribution) ────────────────────────────────────────
//
// findSimilarEpisodes does not export its per-episode scores, so attribution
// replicates the EXACT formula its Jaccard branch uses (the fallback path,
// active here because no embedding provider is passed): Jaccard over
// extractTaskTokens sets, plus +0.1 for a "pass" outcome / -0.1 for "fail".
// This reproduces the ranking order and gives the per-task similarity score.

function episodeSimilarity(queryTokenSet: Set<string>, episode: EpisodeRecord): number {
  const recTokens = new Set(extractTaskTokens(episode.task));
  let inter = 0;
  for (const t of recTokens) {
    if (queryTokenSet.has(t)) inter += 1;
  }
  const union = new Set([...recTokens, ...queryTokenSet]).size;
  let score = union === 0 ? 0 : inter / union;
  if (episode.outcome === "pass") score += 0.1;
  else if (episode.outcome === "fail") score -= 0.1;
  return score;
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

export interface MemoryTaskAttribution {
  task: string;
  module: string;
  kind: string;
  direct: boolean;
  rescued: boolean;
  /** Which channel carried the success: package top-K, hint, episode, both, none. */
  carryingChannel: "package" | "hint" | "episode" | "both" | "none";
  /** Top similar episode per the real findSimilarEpisodes ranking. */
  topEpisodeId: string | null;
  topEpisodeTask: string | null;
  topSimilarity: number | null;
  /** The episode whose injected summary text actually matched expectAny. */
  carryingEpisodeId: string | null;
  carryingEpisodeTask: string | null;
  /** The actual text injected into the prompt (hints + episode summaries). */
  injectedHintText: string;
  injectedEpisodeText: string;
}

export interface MemoryTaskResult extends MemoryTaskAttribution {
  successB: boolean;
  pkgTop5B: boolean;
  pkgTokensB: number;
  pkgItemsB: number;
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

export interface MemoryContributor {
  episodeId: string;
  episodeTask: string;
  rescues: number;
  rescuedTasks: string[];
  meanSimilarity: number;
  sampleInjectedText: string;
}

export interface MemoryAbReport {
  k: number;
  taskCount: number;
  goldenCount: number;
  hardCount: number;
  hardKinds: Record<string, number>;
  successRateA: number;
  successRateB: number;
  pkgTop5RateA: number;
  pkgTop5RateB: number;
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
  /** How many distinct memories (episodes) rescued at least one task. */
  distinctMemoriesUsed: number;
  /** Top-3 contributing memories by rescue count. */
  topContributors: MemoryContributor[];
  tasks: MemoryTaskResult[];
}

export async function runMemoryAbBenchmark(): Promise<MemoryAbReport> {
  const tasks = [...ALL_TASKS];
  if (tasks.length < 60) {
    throw new Error(
      `memory-ab: expected >=60 tasks (26 golden + >=34 hard), got ${tasks.length}`
    );
  }
  if (HARD_TASKS.length < 34) {
    throw new Error(`memory-ab: expected >=34 hard-domain tasks, got ${HARD_TASKS.length}`);
  }

  const startedAt = performance.now();

  // Two identically-seeded graphs; Arm A additionally accumulates the real
  // learning history (skills + episodes) so hints/episodes exist to inject.
  const clientB = new GraphifyClient() as GraphClient;
  const clientA = new GraphifyClient() as GraphClient;
  await seedBaseGraph(clientB, tasks);
  await seedBaseGraph(clientA, tasks);
  await seedHistory(clientA, tasks);

  const rows: MemoryTaskResult[] = [];

  for (const task of tasks) {
    // The golden target is the seeded node; retrieval success means its anchor
    // id ranks within the Top-K package window (id membership — precise, no
    // substring false positives from distractor/decoy nodes).
    const goldenId = `file:src/golden/${task.module}.ts`;
    const queryTokenSet = new Set(extractTaskTokens(task.query));

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

    // ── Attribution chain ─────────────────────────────────────────────────
    const hintHit = targetFound(hintText, task.expectAny);
    const episodeHit = targetFound(episodeText, task.expectAny);
    const rescued = !successB && successA;
    const carryingChannel: MemoryTaskAttribution["carryingChannel"] = rescued
      ? pkgTop5A
        ? "package"
        : hintHit && episodeHit
          ? "both"
          : hintHit
            ? "hint"
            : episodeHit
              ? "episode"
              : "none"
      : "none";

    // Top similar episode: the recalled list is already in real ranking order
    // (Jaccard + outcome bonus, ties by updatedAt), so episodes[0] is the top;
    // its similarity score is recomputed with the identical formula.
    const top = episodes[0] ?? null;
    const topSimilarity = top ? episodeSimilarity(queryTokenSet, top) : null;

    // The episode whose summary text actually carried the target (first match
    // in ranking order).
    let carryingEpisode: EpisodeRecord | null = null;
    for (let i = 0; i < episodes.length; i += 1) {
      if (targetFound(episodeSummaries[i] ?? "", task.expectAny)) {
        carryingEpisode = episodes[i] ?? null;
        break;
      }
    }

    rows.push({
      task: task.query,
      module: task.module,
      kind: task.kind,
      direct: task.direct,
      rescued,
      carryingChannel,
      topEpisodeId: top?.id ?? null,
      topEpisodeTask: top?.task ?? null,
      topSimilarity,
      carryingEpisodeId: carryingEpisode?.id ?? null,
      carryingEpisodeTask: carryingEpisode?.task ?? null,
      injectedHintText: hintText,
      injectedEpisodeText: episodeText,
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
  const rescued = rows.filter((r) => r.rescued).length;
  const hurt = rows.filter((r) => r.successB && !r.successA).length;
  const withHints = rows.filter((r) => r.hintsInjected > 0).length;
  const withEpisodes = rows.filter((r) => r.episodesRecalled > 0).length;
  const decoyA = rows.filter((r) => r.decoyInTop5A).length;
  const decoyB = rows.filter((r) => r.decoyInTop5B).length;
  const decoyInjected = rows.filter((r) => r.decoyInjected).length;

  // ── Memory-contribution summary ─────────────────────────────────────────
  // For each rescued task, attribute the rescue to the memory whose text
  // actually carried the target (carrying episode); fall back to the top
  // similar episode when the carry channel was "hint" or "package".
  const contribution = new Map<string, { count: number; tasks: string[]; sims: number[] }>();
  for (const row of rows) {
    if (!row.rescued) continue;
    const attributedId = row.carryingEpisodeId ?? row.topEpisodeId;
    if (!attributedId) continue;
    const entry = contribution.get(attributedId) ?? { count: 0, tasks: [], sims: [] };
    entry.count += 1;
    entry.tasks.push(row.task);
    if (row.topEpisodeId === attributedId && row.topSimilarity !== null) {
      entry.sims.push(row.topSimilarity);
    }
    contribution.set(attributedId, entry);
  }

  const episodeTaskById = new Map<string, string>();
  for (const task of tasks) {
    if (task.history) episodeTaskById.set(task.history, task.history);
  }
  const contributors: MemoryContributor[] = Array.from(contribution.entries())
    .map(([id, entry]) => {
      const sample = rows.find(
        (r) => r.rescued && (r.carryingEpisodeId === id || r.topEpisodeId === id)
      );
      return {
        episodeId: id,
        episodeTask: sample?.carryingEpisodeTask ?? sample?.topEpisodeTask ?? id,
        rescues: entry.count,
        rescuedTasks: entry.tasks,
        meanSimilarity: entry.sims.length
          ? Math.round((entry.sims.reduce((a, b) => a + b, 0) / entry.sims.length) * 1000) / 1000
          : 0,
        sampleInjectedText:
          (sample?.carryingEpisodeId === id
            ? sample?.injectedEpisodeText
            : sample?.injectedHintText) ?? "",
      };
    })
    .sort((a, b) => b.rescues - a.rescues || b.meanSimilarity - a.meanSimilarity);

  const hardKinds: Record<string, number> = {};
  for (const t of tasks) {
    if (t.kind === "golden") continue;
    hardKinds[t.kind] = (hardKinds[t.kind] ?? 0) + 1;
  }

  return {
    k: TOP_K,
    taskCount: n,
    goldenCount: tasks.filter((t) => t.kind === "golden").length,
    hardCount: tasks.filter((t) => t.kind !== "golden").length,
    hardKinds,
    successRateA: Math.round((successA / n) * 1000) / 1000,
    successRateB: Math.round((successB / n) * 1000) / 1000,
    pkgTop5RateA: Math.round((pkgTop5A / n) * 1000) / 1000,
    pkgTop5RateB: Math.round((pkgTop5B / n) * 1000) / 1000,
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
    distinctMemoriesUsed: contribution.size,
    topContributors: contributors.slice(0, 3),
    tasks: rows,
  };
}

// ── Output ──────────────────────────────────────────────────────────────────

function renderMarkdown(report: MemoryAbReport): string {
  const rows = report.tasks
    .map(
      (t) =>
        `| \`${t.task}\` | \`${t.module}\` | ${t.kind} | ` +
        `${t.successB ? "hit" : "miss"} | ${t.successA ? "hit" : "miss"} | ${t.pkgTop5A ? "yes" : "no"} | ` +
        `${t.carryingChannel} | ${t.hintsInjected} | ${t.episodesRecalled} | ${t.overheadTokens} |`
    )
    .join("\n");

  const rescuedRows = report.tasks
    .filter((t) => t.rescued)
    .map(
      (t) =>
        `| \`${t.task}\` | \`${t.module}\` | ${t.carryingChannel} | ` +
        `\`${t.topEpisodeId ?? "-"}\` | \`${t.topEpisodeTask ?? "-"}\` | ` +
        `${t.topSimilarity === null ? "-" : t.topSimilarity.toFixed(3)} |`
    )
    .join("\n");

  const contributors = report.topContributors
    .map(
      (c) =>
        `| \`${c.episodeId}\` | \`${c.episodeTask}\` | ${c.rescues} | ` +
        `${c.rescuedTasks.map((t) => `\`${t}\``).join(", ")} | ${c.meanSimilarity.toFixed(3)} |`
    )
    .join("\n");

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const kindSummary = Object.entries(report.hardKinds)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");

  return `<!-- BEGIN P3 MEMORY-AB BENCHMARK -->
## Episodic-Memory End-to-End A/B Benchmark — Results (P3)

> Appended by \`npm run benchmark:memory\` (\`benchmarks/run-memory-ab.ts\`).
> Last run: ${new Date().toISOString()}
> Structured JSON: \`benchmarks/.cache/memory-ab-results.json\`

## Summary

${report.taskCount} tasks: ${report.goldenCount} retrieval-golden queries (duplicated
from \`tests/retrieval-golden.test.ts\`, same list as the P1-2 skill benchmark) plus
${report.hardCount} HARD-domain tasks (${kindSummary}), run end-to-end on an
in-memory graph seeded with the golden target, distractors and a decoy. Hard
tasks are constructed so the golden node shares zero query tokens (node ids are
not searchable text), so the OFF arm cannot rank them — episodic memory is the
only bridge. Arm A additionally simulates
${report.goldenCount + report.hardCount + 1} historical tasks through the real
learning paths (\`applySkillLearning\` + \`recordEpisode\`).

| Metric | Arm A (memory ON) | Arm B (memory OFF) |
| --- | --- | --- |
| **Success proxy** (golden target within Top-${report.k}) | **${pct(report.successRateA)}** (${report.tasks.filter((t) => t.successA).length}/${report.taskCount}) | **${pct(report.successRateB)}** (${report.tasks.filter((t) => t.successB).length}/${report.taskCount}) |
| Success via package Top-${report.k} only | ${pct(report.pkgTop5RateA)} | ${pct(report.pkgTop5RateB)} |
| Tasks rescued by memory (B miss → A hit) | ${report.rescued} | — |
| Tasks hurt by memory (B hit → A miss) | ${report.hurt} | — |
| Hint injection rate | ${pct(report.hintInjectionRate)} | 0% |
| Episode recall rate | ${pct(report.episodeRecallRate)} | 0% |
| Distinct memories that rescued tasks | ${report.distinctMemoriesUsed} | — |
| Mean prompt-token overhead / task | ${report.meanTokenOverheadPerTask} | 0 |
| Total prompt-token overhead | ${report.totalTokenOverhead} | 0 |
| Mean package tokens / task | ${report.meanPkgTokensA} | ${report.meanPkgTokensB} |
| Decoy contamination (Top-${report.k}) | ${pct(report.decoyContaminationA)} | ${pct(report.decoyContaminationB)} |
| Decoy contamination (injection) | ${pct(report.decoyInjectionRate)} | 0% |
| Mean wall-clock / task | ${report.meanWallMsA.toFixed(1)} ms | ${report.meanWallMsB.toFixed(1)} ms |
| Total wall-clock | ${(report.totalWallMs / 1000).toFixed(1)} s | — |

## Memory-contribution summary (top-3 contributing memories)

| Episode id | Episode task | Tasks rescued | Rescued queries | Mean similarity |
| --- | --- | --- | --- | --- |
${contributors || "| — | — | 0 | — | — |"}

## Attribution chain (rescued tasks: which memory carried the rescue)

| Task | Golden module | Carry channel | Top episode id | Top episode task | Similarity |
| --- | --- | --- | --- | --- | --- |
${rescuedRows || "| — | — | — | — | — | — |"}

## Per-task detail

| Task | Golden module | Kind | Top-${report.k} (B) | Success (A) | Pkg Top-${report.k} (A) | Carry (A) | Hints | Episodes | Overhead tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Methodology & honest caveats

- **Task set**: ${report.goldenCount} queries duplicated from
  \`tests/retrieval-golden.test.ts\` GOLDEN_SET (that file is owned by another
  agent and is not modified; this list mirrors \`benchmarks/run-skill-ab.ts\`).
  Each task's golden node id (\`file:src/golden/<module>.ts\`) contains an
  \`expectAny\` alternative verbatim. The ${report.hardCount} HARD tasks
  (cross-module blast radius / name disambiguation / indirect-morphological)
  are authored for this benchmark; their golden node **content** deliberately
  shares zero query tokens, so pure retrieval cannot rank the target.
- **Success proxy**: Top-K = the first ${TOP_K} ranked anchors of the compressed
  context package (the retrieval channel); success there means the **golden
  node id** is within those ${TOP_K} anchors (precise id membership — avoids
  substring false positives from distractor/decoy nodes). For Arm A, the
  injected hints + episode summaries form an additional channel an agent reads
  in full; hints/episodes reference modules by **name**, so injection success
  is the \`expectAny\` substring check. Arm A success = package Top-${TOP_K} hit
  **or** injection hit. The package-only hit rate is reported separately for a
  like-for-like retrieval comparison.
- **Package ranking differs slightly between arms**: Arm A's graph additionally
  holds the history nodes (skills + episodes), which can shift the package
  top-${TOP_K} for a few tasks; such differences are visible in the per-task
  detail (Pkg Top-${TOP_K} (A) vs Top-${TOP_K} (B)) and count as real flywheel
  side effects — the summary's rescued/hurt numbers include them.
- **Attribution**: for each rescued task, \`carryingChannel\` names the channel
  that actually carried the target; the top similar episode is the first entry
  of the real \`findSimilarEpisodes\` ranking, and \`similarity\` is recomputed
  with the exact formula that ranking uses internally (Jaccard over
  \`extractTaskTokens\` +0.1 for a \`pass\` outcome), since scores are not
  exported. The memory-contribution summary counts each distinct episode that
  rescued >= 1 task.
- **Arm B success is deliberately imperfect**: the ${report.taskCount - report.tasks.filter((t) => t.successB).length} tasks the OFF arm
  misses (${report.goldenCount - report.tasks.filter((t) => t.kind === "golden" && t.successB).length} golden + the hard tasks) share zero query tokens with
  their golden file (realistic: module names are morphologically different from
  task wording, and symptoms cross module boundaries) — prior episodic
  experience is the only bridge.
- Both arms run through the **real** retrieval and learning paths
  (\`buildEnhancedContextPackage\`, \`applySkillLearning\`, \`recordEpisode\`,
  \`suggestSkillHints\`, \`findSimilarEpisodes\`, \`summarizeEpisodeForPrompt\`)
  on isolated in-memory graphs — no mocks, no network, no API key.
- Token counts use \`gpt-tokenizer\` (gpt-4o encoding), identical to the token
  benchmark. Hashing is the project's DJB2a (FNV-class) — fully deterministic
  within a run; episode ids embed \`Date.now()\` so ids differ across runs, but
  ranking depends on tokens/scores, not ids.
- This measures a mechanical success proxy, not LLM task completion. It
  validates that episodic memory moves the needle on finding the expected
  target, quantifies the exact token and wall-clock cost, and exposes which
  memories earned their keep.
<!-- END P3 MEMORY-AB BENCHMARK -->`;
}

/** Replace the previous P3 section in RESULTS.md if present, else append. */
function writeResultsMarkdown(markdown: string): void {
  const full = readFileSync(RESULTS_PATH, "utf8");
  const startMarker = "<!-- BEGIN P3 MEMORY-AB BENCHMARK -->";
  const endMarker = "<!-- END P3 MEMORY-AB BENCHMARK -->";
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
  process.stdout.write("GraphFlow episodic-memory end-to-end A/B benchmark (P3)\n");
  process.stdout.write(
    `Task set: ${GOLDEN_TASKS.length} retrieval-golden queries + ${HARD_TASKS.length} hard-domain tasks\n`
  );
  process.stdout.write(`History (Arm A): ${GOLDEN_HISTORY.length} golden + ${HARD_TASKS.length} hard + 1 decoy\n\n`);

  const report = await runMemoryAbBenchmark();

  mkdirSync(dirname(JSON_PATH), { recursive: true });
  // Machine-readable artifact with reproducibility envelope (commit + date).
  writeFileSync(
    JSON_PATH,
    JSON.stringify({ ...benchMeta("memory-ab-p3"), ...report }, null, 2),
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
      `distinctMemoriesUsed=${report.distinctMemoriesUsed}\n`
  );
  process.stdout.write(
    `overhead=${report.meanTokenOverheadPerTask} tok/task (total ${report.totalTokenOverhead})  ` +
      `wall=${(report.totalWallMs / 1000).toFixed(1)}s total\n`
  );
  for (const c of report.topContributors) {
    process.stdout.write(
      `  top memory: ${c.episodeId} (${c.rescues} rescues) <- "${c.episodeTask}"\n`
    );
  }
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
