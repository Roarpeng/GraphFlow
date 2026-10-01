/**
 * P3: CodeGraph-style independent multi-domain benchmark.
 *
 * Mirrors CodeGraph's 7-repo methodology by testing across 5 distinct
 * "domains" within the GraphFlow codebase:
 *   D1: core orchestration (orchestrator, dag, planner)
 *   D2: graph engine (indexer, retrieval, compression)
 *   D3: learning subsystem (flywheel, episodic, skill)
 *   D4: config & routing (loader, routing, providers)
 *   D5: integrations (mcp, bridge, vscode)
 *
 * Metrics per domain: rank-based Hit@1/3/5 and MRR over the ranked anchor
 * channel, token savings vs raw baseline. The weighted composite is a
 * self-graded internal check (author-written queries, self-chosen weights),
 * not a score comparable with other tools.
 *
 * Run: npx tsx benchmarks/run-independent-bench.ts
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/model/gpt-4o";
import { validateConfig } from "../src/config/loader.js";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory.js";
import { indexWorkspaceFiles } from "../src/graph/file-indexer.js";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SRC_DIR = join(REPO_ROOT, "src");

function countTokens(text: string): number {
  if (!text) return 0;
  try { return encode(text).length; } catch { return Math.ceil(text.length / 4); }
}

// ── Domain definitions ──────────────────────────────────────────────────────

interface DomainQuery { query: string; expectedKeywords: string[]; }

/**
 * 1-based rank of the first relevant anchor in ranked order, or null when no
 * anchor is relevant. An anchor is relevant when its id points into one of the
 * domain's files, or when its own id + content contain EVERY expected keyword.
 * Only the ranked anchor channel counts; the summary channel carries no rank.
 */
function firstRelevantRank(
  anchors: ReadonlyArray<{ id: string }>,
  domain: Pick<Domain, "filePatterns">,
  q: DomainQuery
): number | null {
  const patterns = domain.filePatterns.flatMap((p) => {
    const lower = p.toLowerCase();
    return [lower, lower.replace(/\//g, "-")];
  });
  const keywords = q.expectedKeywords.map((kw) => kw.toLowerCase());
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i]! as { id: string; content?: unknown };
    const id = anchor.id.toLowerCase().replace(/\\/g, "/");
    const text = `${id} ${typeof anchor.content === "string" ? anchor.content.toLowerCase() : ""}`;
    if (patterns.some((p) => id.includes(p)) || keywords.every((kw) => text.includes(kw))) {
      return i + 1;
    }
  }
  return null;
}

interface Domain {
  name: string;
  description: string;
  /** Files that belong to this domain (path substrings) */
  filePatterns: string[];
  queries: DomainQuery[];
}

const DOMAINS: Domain[] = [
  {
    name: "D1-core-orchestration",
    description: "Orchestrator, DAG engine, planner",
    filePatterns: ["orchestrator", "dag-engine", "planner", "triage"],
    queries: [
      { query: "task orchestration and DAG execution", expectedKeywords: ["orchestrator", "dag"] },
      { query: "bridge mode remote execution", expectedKeywords: ["bridge", "orchestrator"] },
      { query: "task planning and clause splitting", expectedKeywords: ["planner", "plan"] },
      { query: "task triage simple vs complex classification", expectedKeywords: ["triage"] },
      { query: "DAG dependency graph topological sort", expectedKeywords: ["dag", "executeDag"] },
    ],
  },
  {
    name: "D2-graph-engine",
    description: "File indexer, retrieval, context compression",
    filePatterns: ["file-indexer", "context-slicer", "graph-store", "client-factory"],
    queries: [
      { query: "workspace file indexing tree-sitter AST", expectedKeywords: ["file-indexer", "index"] },
      { query: "context package building with token budget", expectedKeywords: ["context-slicer", "buildEnhanced"] },
      { query: "graph node retrieval by keyword", expectedKeywords: ["queryByKeyword", "graph"] },
      { query: "anchor layer classification L1 L2 L3", expectedKeywords: ["anchor", "layer"] },
      { query: "graph client factory creation", expectedKeywords: ["client-factory", "createGraphClient"] },
      { query: "PageRank centrality scoring", expectedKeywords: ["pagerank", "centrality"] },
    ],
  },
  {
    name: "D3-learning-subsystem",
    description: "Skill flywheel, episodic memory, training",
    filePatterns: ["skill-flywheel", "episodic-memory", "nightly-trainer", "learning"],
    queries: [
      { query: "skill hints suggestion and learning", expectedKeywords: ["skill-flywheel", "suggestSkillHints"] },
      { query: "episodic memory recording and retrieval", expectedKeywords: ["episodic", "recordEpisode"] },
      { query: "finding similar past episodes", expectedKeywords: ["findSimilarEpisodes"] },
      { query: "skill learning application with evidence", expectedKeywords: ["applySkillLearning"] },
      { query: "nightly training pipeline", expectedKeywords: ["nightly", "trainer"] },
    ],
  },
  {
    name: "D4-config-routing",
    description: "Configuration loader, model routing, providers",
    filePatterns: ["config/loader", "config/defaults", "routing", "model-router"],
    queries: [
      { query: "configuration validation and loading", expectedKeywords: ["validateConfig", "loader"] },
      { query: "model routing tier selection smart economy", expectedKeywords: ["routing", "tier"] },
      { query: "budget policy token cap configuration", expectedKeywords: ["budgetPolicy", "runTokenCap"] },
      { query: "provider configuration openai anthropic", expectedKeywords: ["provider", "openai"] },
      { query: "graph policy transport memory file", expectedKeywords: ["graphPolicy", "transport"] },
    ],
  },
  {
    name: "D5-integrations",
    description: "MCP server, bridge mode, VS Code extension",
    filePatterns: ["mcp", "bridge", "surfaces", "integrations"],
    queries: [
      { query: "MCP server tool registration", expectedKeywords: ["mcp", "tool"] },
      { query: "bridge mode agent delegation", expectedKeywords: ["bridge"] },
      { query: "VS Code extension panel activation", expectedKeywords: ["vscode", "panel"] },
      { query: "graphflow context MCP tool handler", expectedKeywords: ["graphflow_context", "mcp"] },
      { query: "surface integration cursor claude", expectedKeywords: ["surface", "cursor"] },
    ],
  },
];

// ── Benchmark config ────────────────────────────────────────────────────────

const BENCH_CONFIG = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 3000,
  },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== P3: CodeGraph-style Independent Multi-Domain Benchmark ===\n");

  // Build graph once
  console.log("Building graph index...");
  const client: GraphClient = createGraphClient(BENCH_CONFIG);
  const t0 = Date.now();
  await indexWorkspaceFiles(client, SRC_DIR, {
    ...BENCH_CONFIG.graphPolicy,
    embeddingProvider: undefined,
  } as unknown as Record<string, unknown>);
  const indexMs = Date.now() - t0;

  const snapshot = await client.readSnapshot?.();
  const totalNodes = snapshot?.nodes.length ?? 0;
  const totalEdges = snapshot?.edges.length ?? 0;
  console.log(`  Indexed: ${totalNodes} nodes, ${totalEdges} edges in ${(indexMs / 1000).toFixed(1)}s\n`);

  // Read all source files for baseline token calculation
  const allSrcFiles: Map<string, string> = new Map();
  function readDir(dir: string) {
    try {
      const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { readDir(full); continue; }
        if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          try { allSrcFiles.set(full, readFileSync(full, "utf8")); } catch {}
        }
      }
    } catch {}
  }
  readDir(SRC_DIR);

  // Evaluate each domain
  interface DomainResult {
    name: string;
    description: string;
    hitAt1: number;
    hitAt3: number;
    hitAt5: number;
    mrr: number;
    avgGfTokens: number;
    avgBaselineTokens: number;
    savingsPct: number;
    queryCount: number;
  }

  const domainResults: DomainResult[] = [];

  for (const domain of DOMAINS) {
    let hit1 = 0, hit3 = 0, hit5 = 0, rrSum = 0;
    let totalGfTok = 0, totalBaseTok = 0;
    const n = domain.queries.length;

    for (const q of domain.queries) {
      // GraphFlow context
      const pkg = await buildEnhancedContextPackage(
        client, q.query, q.query, 800,
        { enableGraphCompression: true, maxAnchors: 15 }
      );
      const gfText = pkg.summaryChannel.join("\n") + "\n" +
        pkg.anchorChannel.map((a) => `${a.id} ${a.type} ${"content" in a ? (a as Record<string, unknown>).content || "" : ""}`).join("\n");
      const gfTok = countTokens(gfText);
      totalGfTok += gfTok;

      const rank = firstRelevantRank(pkg.anchorChannel, domain, q);
      if (rank !== null) {
        if (rank <= 1) hit1++;
        if (rank <= 3) hit3++;
        if (rank <= 5) hit5++;
        rrSum += 1 / rank;
      }

      // Baseline: all domain-relevant files concatenated
      let baselineText = "";
      for (const [path, content] of allSrcFiles) {
        if (domain.filePatterns.some(p => path.includes(p))) {
          baselineText += content + "\n";
        }
      }
      // If no domain files found, use all files as baseline
      if (!baselineText) baselineText = Array.from(allSrcFiles.values()).join("\n");
      totalBaseTok += countTokens(baselineText);
    }

    const savingsPct = totalBaseTok > 0 ? ((totalBaseTok - totalGfTok) / totalBaseTok) * 100 : 0;
    domainResults.push({
      name: domain.name,
      description: domain.description,
      hitAt1: Math.round((hit1 / n) * 1000) / 10,
      hitAt3: Math.round((hit3 / n) * 1000) / 10,
      hitAt5: Math.round((hit5 / n) * 1000) / 10,
      mrr: Math.round((rrSum / n) * 1000) / 1000,
      avgGfTokens: Math.round(totalGfTok / n),
      avgBaselineTokens: Math.round(totalBaseTok / n),
      savingsPct: Math.round(savingsPct * 10) / 10,
      queryCount: n,
    });

    console.log(`  ${domain.name}: Hit@1=${(hit1/n*100).toFixed(0)}% Hit@3=${(hit3/n*100).toFixed(0)}% Hit@5=${(hit5/n*100).toFixed(0)}% MRR=${(rrSum/n).toFixed(3)} savings=${savingsPct.toFixed(1)}%`);
  }

  // Aggregate
  const avgHit1 = domainResults.reduce((s, r) => s + r.hitAt1, 0) / domainResults.length;
  const avgHit3 = domainResults.reduce((s, r) => s + r.hitAt3, 0) / domainResults.length;
  const avgHit5 = domainResults.reduce((s, r) => s + r.hitAt5, 0) / domainResults.length;
  const avgMrr = domainResults.reduce((s, r) => s + r.mrr, 0) / domainResults.length;
  const avgSavings = domainResults.reduce((s, r) => s + r.savingsPct, 0) / domainResults.length;

  // Self-chosen weighting of self-graded sub-scores — an internal check, not a
  // comparable benchmark score.
  const overallScore = avgHit5 * 0.4 + avgSavings * 0.3 + avgHit3 * 0.2 + avgHit1 * 0.1;

  console.log(`\n── Aggregate ──`);
  console.log(`  Hit@1: ${avgHit1.toFixed(1)}%  Hit@3: ${avgHit3.toFixed(1)}%  Hit@5: ${avgHit5.toFixed(1)}%  MRR: ${avgMrr.toFixed(3)}`);
  console.log(`  Avg token savings: ${avgSavings.toFixed(1)}%`);
  console.log(`  Composite (self-graded internal check, self-chosen weights): ${overallScore.toFixed(1)}%`);

  // Write results
  const results = {
    generatedAt: new Date().toISOString(),
    methodology: "5-domain internal check on the GraphFlow codebase (author-written queries, self-chosen thresholds and weights)",
    scoreKind: "self-graded-internal-check",
    relevance: "first anchor whose id points into a domain file, or whose id+content contain every expected keyword; Hit@k = rank <= k; MRR = mean(1/rank), 0 when no relevant anchor",
    graphStats: { totalNodes, totalEdges, indexMs },
    domainResults,
    aggregate: { avgHit1, avgHit3, avgHit5, avgMrr, avgSavingsPct: avgSavings, overallScore },
  };

  const outDir = join(__dirname, ".cache");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "independent-bench-results.json"), JSON.stringify(results, null, 2));

  // Write markdown
  const lines: string[] = [];
  lines.push("# P3: Multi-Domain Internal Check (CodeGraph-style layout)");
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Methodology: 5 domains within the GraphFlow codebase itself (not independent repos)`);
  lines.push(`> Graph: ${totalNodes} nodes, ${totalEdges} edges, indexed in ${(indexMs/1000).toFixed(1)}s`);
  lines.push("");
  lines.push("> **Self-graded internal check, not an independent benchmark.** Queries, expected");
  lines.push("> keywords, domain file patterns, and the composite weights were all chosen by the");
  lines.push("> project author; there is no held-out query set. Do not quote the composite as a");
  lines.push("> product score or compare it with other tools' numbers.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Composite (self-chosen weights: 0.4·Hit@5 + 0.3·savings + 0.2·Hit@3 + 0.1·Hit@1) | ${overallScore.toFixed(1)}% |`);
  lines.push(`| Hit@1 | ${avgHit1.toFixed(1)}% |`);
  lines.push(`| Hit@3 | ${avgHit3.toFixed(1)}% |`);
  lines.push(`| Hit@5 | ${avgHit5.toFixed(1)}% |`);
  lines.push(`| MRR | ${avgMrr.toFixed(3)} |`);
  lines.push(`| Avg token savings (token ratio vs domain files in full; not an answer-quality measure) | ${avgSavings.toFixed(1)}% |`);
  lines.push(`| Domains tested | ${DOMAINS.length} |`);
  lines.push(`| Total queries | ${DOMAINS.reduce((s, d) => s + d.queries.length, 0)} |`);
  lines.push("");
  lines.push("## Per-Domain Results");
  lines.push("");
  lines.push("| Domain | Description | Hit@1 | Hit@3 | Hit@5 | MRR | GF tok | Base tok | Savings |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of domainResults) {
    lines.push(`| ${r.name} | ${r.description} | ${r.hitAt1}% | ${r.hitAt3}% | ${r.hitAt5}% | ${r.mrr.toFixed(3)} | ${r.avgGfTokens} | ${r.avgBaselineTokens} | ${r.savingsPct}% |`);
  }
  lines.push("");
  lines.push("## Methodology & caveats");
  lines.push("");
  lines.push("- **Relevance**: an anchor is relevant when its id points into one of the domain's files, or");
  lines.push("  when its own id + content contain every expected keyword. Only the ranked anchor channel");
  lines.push("  counts; the summary channel carries no rank.");
  lines.push("- **Hit@k** = the first relevant anchor has rank <= k. **MRR** = mean of 1/rank (0 when no");
  lines.push("  anchor is relevant). Earlier versions credited Hit@1 whenever the whole package matched,");
  lines.push("  ignoring rank; those numbers are superseded.");
  lines.push("- **Token savings** is a token-count ratio against concatenating every file of the domain;");
  lines.push("  it does not check that the package still contains what is needed to answer the query.");
  lines.push("- Corpus = GraphFlow's own `src/`; the queries were written by the author who also tunes the");
  lines.push("  ranker, so these numbers are optimistic and are not evidence of generalization.");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("npx tsx benchmarks/run-independent-bench.ts");
  lines.push("```");

  writeFileSync(join(__dirname, "INDEPENDENT-RESULTS.md"), lines.join("\n"));
  console.log("\nResults: benchmarks/INDEPENDENT-RESULTS.md");
  console.log("JSON: benchmarks/.cache/independent-bench-results.json");
}

main().catch((err) => {
  console.error("[independent-bench] Fatal:", err);
  process.exit(1);
});
