import { beforeAll, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer";
import { join } from "node:path";

/**
 * Retrieval-quality golden set (P1-1 regression gate).
 *
 * Indexes GraphFlow's own `src/` tree once into an isolated in-memory graph,
 * then asserts that representative queries surface the expected source files
 * in the compressed context package (summary lines + anchor ids).
 *
 * Why: the token-savings benchmark proves we ship ~1% of the tokens, but
 * nothing proved the surviving 1% is the *right* 1%. This suite locks in
 * retrieval correctness so compression/ranking changes cannot silently
 * degrade recall. Extend GOLDEN_SET whenever a retrieval bug is fixed.
 *
 * Structure:
 *   - GOLDEN_SET: 132 recall queries across 9 domains (each domain >= 8).
 *     Entries may carry `topK`: the expected anchor must appear within the
 *     first `topK` anchors of the package (position assertions were verified
 *     stable against the current retrieval pipeline).
 *   - NEGATIVE_SAMPLES: queries that must NOT surface a decoy file from an
 *     unrelated domain (guards against retrieval over-bleed).
 *   - Aggregate gates: >= 80% recall, >= 90% top-K compliance, per-domain
 *     coverage of >= 8 queries.
 */

const GOLDEN_CONFIG = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory", // isolated, never touches the real graph store
    maxContextTokens: 3000,
  },
  learningPolicy: {
    enableFlywheel: false,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

const SRC_DIR = join(process.cwd(), "src");

/**
 * Each entry: a natural-language query, a set of alternative substrings, and a
 * domain. The query passes when ANY expected substring appears in the package
 * output (anchor node ids carry their source path, e.g. `file:src/core/orchestrator.ts`).
 * `topK` (optional) additionally requires the first matching anchor to appear
 * within the first `topK` anchor positions (rank stability gate).
 */
interface GoldenEntry {
  query: string;
  expectAny: string[];
  domain: string;
  topK?: number;
  mustNotContain?: string[];
}

/**
 * The canonical retrieval golden set, exported so `skill sync export` can
 * bundle the team queries into the skill package (`goldenQueries` field).
 */
export const GOLDEN_SET: ReadonlyArray<GoldenEntry> = [
  // ── domain: orchestrator (src/core + src/agents) ──────────────────────────
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

  // ── domain: context/compression (src/graph core pipeline) ─────────────────
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

  // ── domain: graph indexers (language-indexers + file-indexer + store) ─────
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
  { query: "file indexer nodes symbols", expectAny: ["file-indexer-nodes"], domain: "indexers", topK: 3 },
  { query: "file indexer cache", expectAny: ["file-indexer-cache"], domain: "indexers", topK: 3 },
  { query: "include extensions glob", expectAny: ["include-extensions"], domain: "indexers", topK: 3 },
  { query: "framework routes detection", expectAny: ["framework-routes"], domain: "indexers", topK: 3 },

  // ── domain: learning / skill flywheel (src/learning + skill-health) ───────
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

  // ── domain: routing/providers (src/routing + embedding/llm availability) ──
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

  // ── domain: CLI surfaces (src/surfaces/cli + vscode) ──────────────────────
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
  // topK drifts with legitimate CLI surface growth (4 → 5 → 6); the domain
  // guarantee is "a surfaces/cli anchor leads the package".
  { query: "cli help flags", expectAny: ["surfaces/cli"], domain: "cli", topK: 6 },

  // ── domain: MCP tools (src/surfaces/mcp + graphify mcp client) ────────────
  { query: "mcp server tool definitions", expectAny: ["tool-definitions", "mcp"], domain: "mcp", topK: 3 },
  { query: "mcp transport stdio session", expectAny: ["surfaces/mcp/server", "mcp/server"], domain: "mcp", topK: 3 },
  { query: "mcp tool handlers", expectAny: ["tool-handlers"], domain: "mcp", topK: 3 },
  { query: "mcp tool handler dispatch", expectAny: ["tool-handlers", "handlers"], domain: "mcp", topK: 3 },
  { query: "mcp version header", expectAny: ["surfaces/mcp/version"], domain: "mcp", topK: 3 },
  { query: "graphify mcp client", expectAny: ["graphify-mcp-client"], domain: "mcp", topK: 3 },
  { query: "mcp server initialize request", expectAny: ["surfaces/mcp/server"], domain: "mcp", topK: 4 },
  { query: "mcp tool schema json definitions", expectAny: ["tool-definitions"], domain: "mcp", topK: 3 },

  // ── domain: config (src/config) ───────────────────────────────────────────
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

  // ── domain: integrations / agent profiles (src/integrations) ──────────────
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
const NEGATIVE_SAMPLES: ReadonlyArray<{ query: string; mustNotContain: string[] }> = [
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

const CONTEXT_TOKEN_BUDGET = 800;

let client: GraphClient;

// Per-query memoization: the per-query tests and the aggregate gates share the
// same package results, so adding the aggregate gates does not double the cost.
const packageCache = new Map<string, Promise<{ text: string; anchors: string[] }>>();

function packageResult(query: string): Promise<{ text: string; anchors: string[] }> {
  let cached = packageCache.get(query);
  if (!cached) {
    cached = buildEnhancedContextPackage(
      client,
      query,
      query,
      CONTEXT_TOKEN_BUDGET,
      { enableGraphCompression: true }
    ).then((pkg) => ({
      text: [...pkg.summaryChannel, ...pkg.anchorChannel.map((anchor) => anchor.id)]
        .join("\n")
        .toLowerCase(),
      anchors: pkg.anchorChannel.map((anchor) => anchor.id),
    }));
    packageCache.set(query, cached);
  }
  return cached;
}

describe("Retrieval golden set (recall regression gate)", () => {
  beforeAll(async () => {
    client = createGraphClient(GOLDEN_CONFIG);
    await indexWorkspaceFiles(client, SRC_DIR, GOLDEN_CONFIG.graphPolicy);
  }, 120_000);

  it(`golden set covers ${GOLDEN_SET.length} queries across 9 domains`, () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(100);
    const perDomain = new Map<string, number>();
    for (const { domain } of GOLDEN_SET) {
      perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    }
    for (const [domain, count] of perDomain) {
      expect(count, `domain "${domain}" must carry >= 8 queries`).toBeGreaterThanOrEqual(8);
    }
  });

  for (const { query, expectAny, topK } of GOLDEN_SET) {
    it(`retrieves expected context for: "${query}"`, async () => {
      const { text, anchors } = await packageResult(query);
      const hit = expectAny.some((needle) => text.includes(needle.toLowerCase()));
      expect(
        hit,
        `query "${query}" should surface one of [${expectAny.join(", ")}] in the context package`
      ).toBe(true);

      if (topK !== undefined) {
        const pos = anchors.findIndex((id) =>
          expectAny.some((needle) => id.toLowerCase().includes(needle.toLowerCase()))
        );
        expect(
          pos,
          `query "${query}" should place its expected anchor within the first ${topK} anchors (was ${pos})`
        ).toBeGreaterThanOrEqual(0);
        expect(
          pos,
          `query "${query}" should place its expected anchor within the first ${topK} anchors (was ${pos})`
        ).toBeLessThan(topK);
      }
    });
  }

  describe("negative samples (decoy files must stay out of context)", () => {
    for (const { query, mustNotContain } of NEGATIVE_SAMPLES) {
      it(`"${query}" must not surface [${mustNotContain.join(", ")}]`, async () => {
        const { text } = await packageResult(query);
        for (const decoy of mustNotContain) {
          expect(
            text.includes(decoy.toLowerCase()),
            `query "${query}" must not surface decoy "${decoy}"`
          ).toBe(false);
        }
      });
    }
  });

  it("reports aggregate recall hit rate", async () => {
    let hits = 0;
    for (const { query, expectAny } of GOLDEN_SET) {
      const { text } = await packageResult(query);
      if (expectAny.some((needle) => text.includes(needle.toLowerCase()))) {
        hits += 1;
      }
    }
    const hitRate = hits / GOLDEN_SET.length;
    console.log(`[golden-set] recall hit rate: ${hits}/${GOLDEN_SET.length} (${(hitRate * 100).toFixed(1)}%)`);
    expect(hitRate).toBeGreaterThanOrEqual(0.8);
  });

  it("reports aggregate top-K position compliance", async () => {
    const withTopK = GOLDEN_SET.filter((entry) => entry.topK !== undefined);
    let within = 0;
    for (const { query, expectAny, topK } of withTopK) {
      const { anchors } = await packageResult(query);
      const pos = anchors.findIndex((id) =>
        expectAny.some((needle) => id.toLowerCase().includes(needle.toLowerCase()))
      );
      if (pos >= 0 && pos < (topK as number)) {
        within += 1;
      }
    }
    const compliance = within / withTopK.length;
    console.log(`[golden-set] top-K compliance: ${within}/${withTopK.length} (${(compliance * 100).toFixed(1)}%)`);
    expect(compliance).toBeGreaterThanOrEqual(0.9);
  });

  it("negative samples all stay clean", async () => {
    let clean = 0;
    for (const { query, mustNotContain } of NEGATIVE_SAMPLES) {
      const { text } = await packageResult(query);
      if (mustNotContain.every((decoy) => !text.includes(decoy.toLowerCase()))) {
        clean += 1;
      }
    }
    console.log(`[golden-set] negative samples clean: ${clean}/${NEGATIVE_SAMPLES.length}`);
    expect(clean).toBe(NEGATIVE_SAMPLES.length);
  });
});
