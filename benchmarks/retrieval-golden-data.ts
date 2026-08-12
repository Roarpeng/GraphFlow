/**
 * retrieval-golden-data.ts — Retrieval golden set (source of truth for the
 * published open dataset under `benchmarks/datasets/`).
 *
 * Single source of truth for:
 *   - `npm run dataset:retrieval` → `benchmarks/datasets/retrieval-golden-v1.{json,jsonl}`
 *   - `npm run bench:retrieval` / comprehensive benches
 *
 * Keep in sync with `tests/retrieval-golden.test.ts` GOLDEN_SET / NEGATIVE_SAMPLES
 * (CI regression suite; that file may duplicate for vitest isolation).
 * After editing this file, run `npm run dataset:retrieval` so the JSON cannot drift.
 */

export interface GoldenEntry {
  query: string;
  expectAny: string[];
  domain: string;
  topK?: number;
  mustNotContain?: string[];
}

/** Negative samples: query must NOT surface decoy path substrings. */
export interface NegativeSample {
  query: string;
  mustNotContain: string[];
}

export const GOLDEN_SET: ReadonlyArray<GoldenEntry> = [
  // ── domain: orchestrator ──
  { query: "orchestrate task routing", expectAny: ["orchestrator"], domain: "orchestrator", topK: 4 },
  { query: "dag execution engine", expectAny: ["dag-engine", "executedag"], domain: "orchestrator", topK: 3 },
  { query: "triage task classification simple complex", expectAny: ["triage"], domain: "orchestrator", topK: 3 },
  { query: "agent delegation work items bridge", expectAny: ["agent-delegation", "workitem"], domain: "orchestrator", topK: 3 },
  { query: "dag checkpoint recovery taskrun", expectAny: ["dag-checkpoint", "checkpoint"], domain: "orchestrator", topK: 3 },
  { query: "cancellation timeout controller", expectAny: ["cancellation", "runtime-controller"], domain: "orchestrator", topK: 4 },
  { query: "six hats insight planning", expectAny: ["insight", "sixhats", "brainstormer"], domain: "orchestrator", topK: 3 },
  { query: "state machine transition lifecycle", expectAny: ["state-machine"], domain: "orchestrator", topK: 3 },
  { query: "goal anchor alignment deviation", expectAny: ["goal-anchor"], domain: "orchestrator", topK: 3 },
  { query: "planner decompose plan steps", expectAny: ["planner"], domain: "orchestrator", topK: 3 },
  { query: "worker executes tasks", expectAny: ["worker"], domain: "orchestrator", topK: 3 },
  { query: "validator checks task results", expectAny: ["validator"], domain: "orchestrator", topK: 3 },
  { query: "orchestrator route episode context", expectAny: ["orchestrator-route", "orchestrator-episode", "orchestrator-context"], domain: "orchestrator", topK: 5 },
  { query: "agent assignment skill match", expectAny: ["agent-assignment"], domain: "orchestrator", topK: 3 },
  { query: "error taxonomy recovery", expectAny: ["errors"], domain: "orchestrator", topK: 4 },
  { query: "task profile capabilities", expectAny: ["task-profile"], domain: "orchestrator", topK: 3 },
  { query: "task clauses split plan", expectAny: ["task-clauses"], domain: "orchestrator", topK: 3 },
  { query: "decision engine tradeoffs", expectAny: ["decision-engine"], domain: "orchestrator", topK: 4 },
  { query: "submit agent insight", expectAny: ["submit-agent-insight"], domain: "orchestrator", topK: 3 },
  { query: "merge agent insight conflicts", expectAny: ["merge-agent-insight"], domain: "orchestrator", topK: 3 },
  { query: "atp protocol schema", expectAny: ["atp-schema"], domain: "orchestrator", topK: 4 },
  { query: "brainstorm ideas alternatives agent", expectAny: ["brainstormer"], domain: "orchestrator", topK: 3 },
  // ── domain: context ──
  { query: "graph compression pagerank centrality", expectAny: ["graph-compression", "pagerank"], domain: "context", topK: 3 },
  { query: "context slicer layered package", expectAny: ["context-slicer"], domain: "context", topK: 3 },
  { query: "repo map module overview", expectAny: ["repo-map", "repomap"], domain: "context", topK: 3 },
  { query: "token savings statistics", expectAny: ["token-savings", "tokensavings"], domain: "context", topK: 3 },
  { query: "adaptive token budget estimation", expectAny: ["adaptive-budget", "estimatecontextbudget"], domain: "context", topK: 3 },
  { query: "context cache invalidation", expectAny: ["context-cache"], domain: "context", topK: 3 },
  { query: "hit diversification source files", expectAny: ["hit-diversify"], domain: "context", topK: 3 },
  { query: "query expansion synonyms rrf", expectAny: ["query-expand"], domain: "context", topK: 4 },
  { query: "query translation english", expectAny: ["query-translate"], domain: "context", topK: 3 },
  { query: "snapshot view graph state", expectAny: ["snapshot-view"], domain: "context", topK: 3 },
  { query: "graph analysis metrics", expectAny: ["graph-analysis"], domain: "context", topK: 4 },
  { query: "context slicer utils module derive", expectAny: ["context-slicer-utils"], domain: "context", topK: 3 },
  { query: "layered package types", expectAny: ["context-slicer-types"], domain: "context", topK: 3 },
  { query: "graphify client query", expectAny: ["graphify-client"], domain: "context", topK: 4 },
  // ── domain: indexers ──
  { query: "file watcher incremental index on save", expectAny: ["file-watcher", "filewatcher"], domain: "indexers", topK: 4 },
  { query: "sqlite graph storage fts5", expectAny: ["sqlite-client", "sqlite"], domain: "indexers", topK: 3 },
  { query: "language indexers tree sitter wasm", expectAny: ["language-indexers", "tree-sitter", "tree_sitter"], domain: "indexers", topK: 3 },
  { query: "plcopen xml pou variables", expectAny: ["plcopen"], domain: "indexers", topK: 3 },
  { query: "structured text case statement st", expectAny: ["st-analyzer"], domain: "indexers", topK: 3 },
  { query: "c cpp indexer symbols", expectAny: ["c-cpp"], domain: "indexers", topK: 4 },
  { query: "dart language indexer", expectAny: ["dart"], domain: "indexers", topK: 3 },
  { query: "go indexer functions", expectAny: ["go"], domain: "indexers", topK: 3 },
  { query: "java indexer classes", expectAny: ["java"], domain: "indexers", topK: 3 },
  { query: "kotlin swift indexer", expectAny: ["kotlin", "swift"], domain: "indexers", topK: 4 },
  { query: "markdown docs indexer", expectAny: ["markdown"], domain: "indexers", topK: 3 },
  { query: "python indexer defs", expectAny: ["python"], domain: "indexers", topK: 3 },
  { query: "ruby indexer methods", expectAny: ["ruby"], domain: "indexers", topK: 3 },
  { query: "rust indexer", expectAny: ["rust"], domain: "indexers", topK: 3 },
  { query: "typescript indexer exports", expectAny: ["typescript"], domain: "indexers", topK: 3 },
  { query: "incremental parse diff", expectAny: ["incremental-parse"], domain: "indexers", topK: 3 },
  { query: "tree sitter loader wasm", expectAny: ["tree-sitter-loader", "tree_sitter"], domain: "indexers", topK: 3 },
  { query: "file indexer walker", expectAny: ["file-indexer-walker"], domain: "indexers", topK: 4 },
  { query: "file indexer edges imports", expectAny: ["file-indexer-edges"], domain: "indexers", topK: 4 },
  { query: "file indexer nodes symbols", expectAny: ["file-indexer-nodes"], domain: "indexers", topK: 4 },
  { query: "file indexer cache", expectAny: ["file-indexer-cache"], domain: "indexers", topK: 3 },
  { query: "include extensions glob", expectAny: ["include-extensions"], domain: "indexers", topK: 3 },
  { query: "framework routes detection", expectAny: ["framework-routes"], domain: "indexers", topK: 3 },
  // ── domain: learning ──
  { query: "skill flywheel hints scoring", expectAny: ["skill-flywheel", "skillflywheel"], domain: "learning", topK: 3 },
  { query: "episodic memory similar episodes", expectAny: ["episodic-memory", "episodicmemory"], domain: "learning", topK: 3 },
  { query: "embedding cosine similarity vector", expectAny: ["embeddings", "cosine"], domain: "learning", topK: 3 },
  { query: "hnsw approximate nearest neighbor index", expectAny: ["hnsw"], domain: "learning", topK: 3 },
  { query: "nightly learning trainer", expectAny: ["nightly-trainer", "nightlytrainer"], domain: "learning", topK: 3 },
  { query: "reflect episodes extract lessons", expectAny: ["reflector", "reflect"], domain: "learning", topK: 3 },
  { query: "skill store persistence", expectAny: ["skill-store"], domain: "learning", topK: 3 },
  { query: "skill package export", expectAny: ["skill-package"], domain: "learning", topK: 4 },
  { query: "skill types interfaces", expectAny: ["skill-types"], domain: "learning", topK: 4 },
  { query: "seed skills bootstrap", expectAny: ["seed-skills"], domain: "learning", topK: 4 },
  { query: "feedback collector outcomes", expectAny: ["feedback-collector"], domain: "learning", topK: 4 },
  { query: "learning events stream", expectAny: ["learning-events"], domain: "learning", topK: 3 },
  { query: "sample builder dataset", expectAny: ["sample-builder"], domain: "learning", topK: 3 },
  { query: "exporter jsonl dataset", expectAny: ["exporter"], domain: "learning", topK: 4 },
  { query: "triage telemetry stats", expectAny: ["triage-telemetry"], domain: "learning", topK: 4 },
  { query: "embedding quality check", expectAny: ["embedding-quality"], domain: "learning", topK: 3 },
  { query: "skill health check", expectAny: ["skill-health"], domain: "learning", topK: 3 },
  // ── domain: routing ──
  { query: "model router provider selection", expectAny: ["model-router", "modelrouter"], domain: "routing", topK: 3 },
  { query: "provider health fallback chain", expectAny: ["provider-health", "providerhealth"], domain: "routing", topK: 3 },
  { query: "provider executor calls", expectAny: ["provider-executor"], domain: "routing", topK: 4 },
  { query: "role capabilities tier", expectAny: ["role-capabilities"], domain: "routing", topK: 4 },
  { query: "deepseek tools schema", expectAny: ["deepseek-tools"], domain: "routing", topK: 3 },
  { query: "anthropic provider adapter", expectAny: ["anthropic"], domain: "routing", topK: 4 },
  { query: "openai provider adapter", expectAny: ["openai"], domain: "routing", topK: 4 },
  { query: "bailian provider adapter", expectAny: ["bailian"], domain: "routing", topK: 4 },
  { query: "doubao provider adapter", expectAny: ["doubao"], domain: "routing", topK: 4 },
  { query: "deepseek provider adapter", expectAny: ["deepseek"], domain: "routing", topK: 4 },
  { query: "embedding factory provider", expectAny: ["embedding-factory"], domain: "routing", topK: 4 },
  { query: "llm availability check", expectAny: ["llm-availability"], domain: "routing", topK: 3 },
  // ── domain: cli ──
  { query: "cli output json formatting", expectAny: ["output", "formatcliresult"], domain: "cli", topK: 3 },
  { query: "cli init scaffold", expectAny: ["cli/init"], domain: "cli", topK: 3 },
  { query: "cli runtime facade", expectAny: ["runtime/facade", "runtime-facade"], domain: "cli", topK: 4 },
  { query: "cli runtime graph commands", expectAny: ["runtime/graph"], domain: "cli", topK: 4 },
  { query: "cli runtime learning commands", expectAny: ["runtime/learning"], domain: "cli", topK: 4 },
  { query: "cli runtime routing commands", expectAny: ["runtime/routing"], domain: "cli", topK: 5 },
  { query: "cli runtime settings", expectAny: ["runtime/settings"], domain: "cli", topK: 5 },
  { query: "cli runtime panel", expectAny: ["runtime/panel"], domain: "cli", topK: 4 },
  { query: "cli env vars", expectAny: ["runtime/env"], domain: "cli", topK: 3 },
  { query: "vscode extension panel", expectAny: ["vscode/extension"], domain: "cli", topK: 3 },
  { query: "cli help flags", expectAny: ["surfaces/cli"], domain: "cli", topK: 3 },
  // ── domain: mcp ──
  { query: "mcp server tool definitions", expectAny: ["tool-definitions", "mcp"], domain: "mcp", topK: 3 },
  { query: "mcp transport stdio session", expectAny: ["surfaces/mcp/server", "mcp/server"], domain: "mcp", topK: 3 },
  { query: "mcp tool handlers", expectAny: ["tool-handlers"], domain: "mcp", topK: 3 },
  { query: "mcp tool handler dispatch", expectAny: ["tool-handlers", "handlers"], domain: "mcp", topK: 3 },
  { query: "mcp version header", expectAny: ["surfaces/mcp/version"], domain: "mcp", topK: 3 },
  { query: "graphify mcp client", expectAny: ["graphify-mcp-client"], domain: "mcp", topK: 3 },
  { query: "mcp server initialize request", expectAny: ["surfaces/mcp/server"], domain: "mcp", topK: 4 },
  { query: "mcp tool schema json definitions", expectAny: ["tool-definitions"], domain: "mcp", topK: 3 },
  // ── domain: config ──
  { query: "config loader merge defaults", expectAny: ["config/loader"], domain: "config", topK: 4 },
  { query: "config schema validation", expectAny: ["config/schema"], domain: "config", topK: 5 },
  { query: "config merge deep", expectAny: ["config/merge"], domain: "config", topK: 3 },
  { query: "config resolve tiers", expectAny: ["config/resolve"], domain: "config", topK: 5 },
  { query: "config defaults", expectAny: ["config/defaults"], domain: "config", topK: 3 },
  { query: "config paths workspace", expectAny: ["config/paths"], domain: "config", topK: 3 },
  { query: "provider env api key", expectAny: ["provider-env"], domain: "config", topK: 5 },
  { query: "config secrets redact", expectAny: ["config/secrets"], domain: "config", topK: 3 },
  { query: "config scaffold generate", expectAny: ["config/scaffold"], domain: "config", topK: 3 },
  { query: "workspace packages detection", expectAny: ["workspace-packages"], domain: "config", topK: 3 },
  { query: "workspace root discovery", expectAny: ["workspace-root"], domain: "config", topK: 4 },
  { query: "discover workspace config", expectAny: ["discover-workspace"], domain: "config", topK: 4 },
  // ── domain: integrations ──
  { query: "agent mcp installer", expectAny: ["agent-mcp-installer"], domain: "integrations", topK: 4 },
  { query: "skill installer copy", expectAny: ["skill-installer"], domain: "integrations", topK: 3 },
  { query: "agent profile registry", expectAny: ["agent-profiles/registry"], domain: "integrations", topK: 3 },
  { query: "claude code agent profile", expectAny: ["profiles/claude-code"], domain: "integrations", topK: 3 },
  { query: "cursor agent profile", expectAny: ["profiles/cursor"], domain: "integrations", topK: 3 },
  { query: "codex agent profile", expectAny: ["profiles/codex"], domain: "integrations", topK: 4 },
  { query: "gemini agent profile", expectAny: ["profiles/gemini"], domain: "integrations", topK: 3 },
  { query: "windsurf agent profile", expectAny: ["profiles/windsurf"], domain: "integrations", topK: 3 },
  { query: "cline agent profile", expectAny: ["profiles/cline"], domain: "integrations", topK: 3 },
  { query: "roo code profile", expectAny: ["roo-code"], domain: "integrations", topK: 3 },
  { query: "trae agent profile", expectAny: ["profiles/trae"], domain: "integrations", topK: 3 },
  { query: "opencode profile skills", expectAny: ["opencode"], domain: "integrations", topK: 4 },
  { query: "antigravity profile", expectAny: ["antigravity"], domain: "integrations", topK: 3 },
];

/**
 * Negative-sample assertions: these queries must NOT surface the decoy file
 * (path substring) in the package output. Decoys are drawn from unrelated
 * domains; a hit here means retrieval over-bleeds across domains.
 */
export const NEGATIVE_SAMPLES: ReadonlyArray<NegativeSample> = [
  { query: "plcopen xml pou variables", mustNotContain: ["agent-profiles", "provider-adapters"] },
  { query: "cli init scaffold", mustNotContain: ["plcopen", "language-indexers"] },
  { query: "anthropic provider adapter", mustNotContain: ["language-indexers", "surfaces/mcp"] },
  { query: "skill store persistence", mustNotContain: ["model-router"] },
  { query: "config secrets redact", mustNotContain: ["dag-engine", "plcopen"] },
  { query: "mcp tool handlers", mustNotContain: ["agent-profiles"] },
  { query: "java indexer classes", mustNotContain: ["surfaces/mcp", "model-router"] },
  { query: "goal anchor alignment deviation", mustNotContain: ["plcopen", "surfaces/mcp"] },
  { query: "windsurf agent profile", mustNotContain: ["context-slicer", "sqlite"] },
  { query: "provider executor calls", mustNotContain: ["skill-flywheel", "language-indexers"] },
  { query: "config schema validation", mustNotContain: ["plcopen"] },
  { query: "atp protocol schema", mustNotContain: ["language-indexers"] },
];
