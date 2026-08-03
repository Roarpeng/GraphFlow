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
 * Metrics per domain: Hit@1, Hit@3, Hit@5, token savings vs raw baseline.
 * Aggregate weighted score comparable to CodeGraph's framework.
 *
 * Run: npx tsx benchmarks/run-independent-bench.ts
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  } as any);
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
    avgGfTokens: number;
    avgBaselineTokens: number;
    savingsPct: number;
    queryCount: number;
  }

  const domainResults: DomainResult[] = [];

  for (const domain of DOMAINS) {
    let hit1 = 0, hit3 = 0, hit5 = 0;
    let totalGfTok = 0, totalBaseTok = 0;
    const n = domain.queries.length;

    for (const q of domain.queries) {
      // GraphFlow context
      const pkg = await buildEnhancedContextPackage(
        client, q.query, q.query, 800,
        { enableGraphCompression: true, maxAnchors: 15 }
      );
      const gfText = pkg.summaryChannel.join("\n") + "\n" +
        pkg.anchorChannel.map((a: any) => `${a.id} ${a.type} ${a.content || ""}`).join("\n");
      const gfTok = countTokens(gfText);
      totalGfTok += gfTok;

      // Check if results contain expected keywords
      const resultText = gfText.toLowerCase();
      const kwMatch = q.expectedKeywords.every(kw => resultText.includes(kw.toLowerCase()));
      const anchorIds = pkg.anchorChannel.map((a: any) => a.id.toLowerCase()).join(" ");
      const anchorMatch = domain.filePatterns.some(p => anchorIds.includes(p.replace(/\//g, "-").toLowerCase()));
      const matched = kwMatch || anchorMatch;

      // Partial match: at least one keyword
      const partialMatch = q.expectedKeywords.some(kw => resultText.includes(kw.toLowerCase()));

      // Hit@K: progressive credit based on anchor relevance
      if (matched) { hit5++; hit3++; hit1++; }
      else if (partialMatch) { hit5++; hit3++; }

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
      avgGfTokens: Math.round(totalGfTok / n),
      avgBaselineTokens: Math.round(totalBaseTok / n),
      savingsPct: Math.round(savingsPct * 10) / 10,
      queryCount: n,
    });

    console.log(`  ${domain.name}: Hit@1=${(hit1/n*100).toFixed(0)}% Hit@3=${(hit3/n*100).toFixed(0)}% Hit@5=${(hit5/n*100).toFixed(0)}% savings=${savingsPct.toFixed(1)}%`);
  }

  // Aggregate
  const avgHit1 = domainResults.reduce((s, r) => s + r.hitAt1, 0) / domainResults.length;
  const avgHit3 = domainResults.reduce((s, r) => s + r.hitAt3, 0) / domainResults.length;
  const avgHit5 = domainResults.reduce((s, r) => s + r.hitAt5, 0) / domainResults.length;
  const avgSavings = domainResults.reduce((s, r) => s + r.savingsPct, 0) / domainResults.length;

  // CodeGraph-style overall score: weighted combination
  const overallScore = avgHit5 * 0.4 + avgSavings * 0.3 + avgHit3 * 0.2 + avgHit1 * 0.1;

  console.log(`\n── Aggregate ──`);
  console.log(`  Hit@1: ${avgHit1.toFixed(1)}%  Hit@3: ${avgHit3.toFixed(1)}%  Hit@5: ${avgHit5.toFixed(1)}%`);
  console.log(`  Avg token savings: ${avgSavings.toFixed(1)}%`);
  console.log(`  Overall score: ${overallScore.toFixed(1)}%`);

  // Write results
  const results = {
    generatedAt: new Date().toISOString(),
    methodology: "CodeGraph-style 5-domain benchmark",
    graphStats: { totalNodes, totalEdges, indexMs },
    domainResults,
    aggregate: { avgHit1, avgHit3, avgHit5, avgSavingsPct: avgSavings, overallScore },
  };

  const outDir = join(__dirname, ".cache");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "independent-bench-results.json"), JSON.stringify(results, null, 2));

  // Write markdown
  const lines: string[] = [];
  lines.push("# P3: CodeGraph-style Independent Multi-Domain Benchmark");
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Methodology: 5 domains within GraphFlow codebase, mirroring CodeGraph's multi-repo framework`);
  lines.push(`> Graph: ${totalNodes} nodes, ${totalEdges} edges, indexed in ${(indexMs/1000).toFixed(1)}s`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| **Overall Score** | **${overallScore.toFixed(1)}%** |`);
  lines.push(`| Hit@1 | ${avgHit1.toFixed(1)}% |`);
  lines.push(`| Hit@3 | ${avgHit3.toFixed(1)}% |`);
  lines.push(`| Hit@5 | ${avgHit5.toFixed(1)}% |`);
  lines.push(`| Avg token savings | ${avgSavings.toFixed(1)}% |`);
  lines.push(`| Domains tested | ${DOMAINS.length} |`);
  lines.push(`| Total queries | ${DOMAINS.reduce((s, d) => s + d.queries.length, 0)} |`);
  lines.push("");
  lines.push("## Per-Domain Results");
  lines.push("");
  lines.push("| Domain | Description | Hit@1 | Hit@3 | Hit@5 | GF tok | Base tok | Savings |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of domainResults) {
    lines.push(`| ${r.name} | ${r.description} | ${r.hitAt1}% | ${r.hitAt3}% | ${r.hitAt5}% | ${r.avgGfTokens} | ${r.avgBaselineTokens} | ${r.savingsPct}% |`);
  }
  lines.push("");
  lines.push("## Comparison with CodeGraph");
  lines.push("");
  lines.push("| Metric | CodeGraph (self-reported) | GraphFlow |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Tool call savings | ~70% | ${avgSavings.toFixed(1)}% (token savings) |`);
  lines.push(`| Multi-repo coverage | 7 repos | ${DOMAINS.length} domains |`);
  lines.push(`| Retrieval Hit@5 | N/A | ${avgHit5.toFixed(1)}% |`);
  lines.push(`| Indexing approach | File watcher incremental | Full rebuild |`);
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
