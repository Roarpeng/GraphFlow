/**
 * GraphFlow token-savings benchmark.
 *
 * Goal: produce a reproducible, independently verifiable measurement of how
 * many LLM *input* tokens GraphFlow's compressed context saves compared to the
 * traditional "grep then read whole files into the prompt" approach used by a
 * typical coding agent.
 *
 * Run with:  npm run benchmark
 *
 * Outputs:
 *   - benchmarks/RESULTS.md            (human-readable report)
 *   - benchmarks/.cache/token-bench-results.json (machine-readable results:
 *     per-query numbers, totals, inputs, environment, commit hash, run date)
 *
 * The runner is intentionally self-contained and offline:
 *  - it builds an isolated benchmark config that disables network embedding /
 *    semantic enrichment so results are deterministic and require no API key;
 *  - it tokenizes every value with the same tokenizer the project already ships
 *    (`gpt-tokenizer`, gpt-4o encoding), so numbers are comparable.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/model/gpt-4o";

import { getDefaultConfig } from "../src/config/defaults.js";
import { indexGraph, previewContext } from "../src/surfaces/cli/runtime/graph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BENCH_DIR = __dirname;
const CACHE_DIR = join(BENCH_DIR, ".cache");
const CONFIG_PATH = join(CACHE_DIR, "benchmark.config.json");
const RESULTS_PATH = join(BENCH_DIR, "RESULTS.md");
const JSON_PATH = join(CACHE_DIR, "token-bench-results.json");

/** Delimiters that make the token-benchmark section replaceable inside RESULTS.md. */
const TOKEN_BEGIN = "<!-- BEGIN TOKEN BENCHMARK -->";
const TOKEN_END = "<!-- END TOKEN BENCHMARK -->";
/** First section owned by another benchmark script (appended to RESULTS.md). */
const P12_BEGIN = "<!-- BEGIN P1-2 SKILL-AB BENCHMARK -->";

/**
 * Resolve the git revision this benchmark ran against so the results can be
 * attributed to an exact source state. Falls back to the CI-provided
 * GITHUB_SHA, then to "unknown" (e.g. when the checkout is not a git repo).
 */
function getCommitHash(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (sha) {
      return sha;
    }
  } catch {
    // git missing or not a git checkout — fall through to CI env / unknown.
  }
  return process.env.GITHUB_SHA ?? "unknown";
}

/**
 * Baseline scope: a traditional agent greps the source tree and reads the
 * matching files in full. We scan `src/` and cap the number of files read per
 * query so the baseline stays bounded and reproducible. Both the scope and the
 * cap are reported in RESULTS.md so the comparison is honest.
 */
const BASELINE_SCAN_DIR = join(REPO_ROOT, "src");
const BASELINE_MAX_FILES_PER_QUERY = 10;
const BASELINE_EXTENSIONS = [".ts", ".tsx"];
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  "graphflow-out",
  "graphify-out",
  ".cache",
  "tests",
  "__tests__",
]);

/** Representative queries that hit real symbols / concepts in this repository. */
const QUERIES: readonly string[] = [
  "orchestrator",
  "context compression",
  "model routing",
  "graph index",
  "token savings",
  "semantic enrichment",
  "preview context",
  "skill flywheel",
];

interface QueryResult {
  query: string;
  baselineTokens: number;
  baselineFiles: number;
  /** Independently tokenized GraphFlow context (summary + anchors) — the headline, conservative number. */
  graphflowTokens: number;
  /** GraphFlow's own internal `tokenEstimate` (self-reported, typically lower). */
  graphflowSelfEstimate: number;
  savingsPercent: number;
}

function countTokens(text: string): number {
  if (!text) {
    return 0;
  }
  try {
    return encode(text).length;
  } catch {
    // Mirror the project's own fallback heuristic if the tokenizer is missing.
    return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
  }
}

function collectSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) {
          continue;
        }
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (BASELINE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(rootDir);
  return files;
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((term) => term.length >= 3);
}

/**
 * Emulate a traditional agent: full-text grep over the source tree, then read
 * the most relevant matching files *in full* into the context window.
 */
function measureBaseline(
  query: string,
  sourceFiles: ReadonlyArray<{ path: string; content: string; lower: string }>
): { tokens: number; files: number } {
  const terms = queryTerms(query);
  const scored: Array<{ content: string; score: number }> = [];

  for (const file of sourceFiles) {
    let score = 0;
    for (const term of terms) {
      let from = 0;
      while (true) {
        const idx = file.lower.indexOf(term, from);
        if (idx === -1) {
          break;
        }
        score += 1;
        from = idx + term.length;
      }
    }
    if (score > 0) {
      scored.push({ content: file.content, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, BASELINE_MAX_FILES_PER_QUERY);
  const tokens = selected.reduce((sum, file) => sum + countTokens(file.content), 0);
  return { tokens, files: selected.length };
}

function writeBenchmarkConfig(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const base = getDefaultConfig();
  const config = {
    ...base,
    graphPolicy: {
      ...base.graphPolicy,
      workspaceRoot: REPO_ROOT,
      graphStorePath: join(CACHE_DIR, "benchmark-graph.json"),
      // Keep zero-cost graph-structure compression, drop network/LLM steps so
      // the benchmark is deterministic and runs without any API key.
      compression: {
        enableGraphCompression: true,
        enableAdaptiveBudget: true,
        enabled: false,
      },
      semanticEnrichment: {
        ...base.graphPolicy.semanticEnrichment,
        enabled: false,
        autoRunOnIndex: false,
      },
    },
    embeddingPolicy: {
      ...base.embeddingPolicy,
      enabled: false,
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function buildResultsMarkdown(
  results: QueryResult[],
  totals: { baseline: number; graphflow: number; savings: number; selfEstimate: number },
  meta: { nodeCount: number | null; indexedFiles: number | null; durationMs: number }
): string {
  const rows = results
    .map(
      (r) =>
        `| \`${r.query}\` | ${formatNumber(r.baselineTokens)} (${r.baselineFiles} files) | ${formatNumber(
          r.graphflowTokens
        )} | ${formatNumber(r.graphflowSelfEstimate)} | ${r.savingsPercent.toFixed(1)}% |`
    )
    .join("\n");

  const totalRow = `| **Total** | **${formatNumber(totals.baseline)}** | **${formatNumber(
    totals.graphflow
  )}** | **${formatNumber(totals.selfEstimate)}** | **${totals.savings.toFixed(1)}%** |`;

  const generatedAt = new Date().toISOString();

  return `${TOKEN_BEGIN}
# GraphFlow Token-Savings Benchmark — Results

> Auto-generated by \`npm run benchmark\` (\`benchmarks/run-token-benchmark.ts\`).
> Last run: ${generatedAt}

## 如何复现（How to reproduce）

\`\`\`bash
npm install && npm run benchmark   # Node ≥ 20，离线运行，无需 API key
\`\`\`

- 环境：Node ≥ 20（本表由 ${process.version} / ${process.platform} ${process.arch} 生成）；无网络、无 API key。
- 结果文件：本文件 \`benchmarks/RESULTS.md\`（人类可读）+ \`benchmarks/.cache/token-bench-results.json\`（机器可读，含 commit hash 与运行日期）。
- 输入数据、判定标准与第三方复现清单见 \`docs/benchmark-standards.md\`。

## Summary

GraphFlow compresses the context an LLM agent needs for a query into a small
summary + anchor package, instead of pushing whole source files into the prompt.
Across **${results.length}** representative queries against this repository:

- **Baseline total input tokens:** ${formatNumber(totals.baseline)}
- **GraphFlow total input tokens:** ${formatNumber(totals.graphflow)}
- **Overall token savings:** **${totals.savings.toFixed(1)}%**

The headline **GraphFlow tokens** column is independently re-tokenized with
\`gpt-tokenizer\` (summary + anchors), *not* GraphFlow's self-reported estimate.
GraphFlow's own internal estimate is shown separately for transparency and is
typically lower.

## Results table

| Query | Baseline tokens | GraphFlow tokens (independent) | GraphFlow self-estimate | Savings % |
| --- | --- | --- | --- | --- |
${rows}
${totalRow}

## Run environment

- Node: \`${process.version}\`
- Platform: \`${process.platform} ${process.arch}\`
- Tokenizer: \`gpt-tokenizer\` (gpt-4o encoding) — identical for both sides.
- Graph nodes in store: ${meta.nodeCount === null ? "n/a" : formatNumber(meta.nodeCount)}
- Files (re)indexed this run: ${
    meta.indexedFiles === null ? "n/a" : `${formatNumber(meta.indexedFiles)} (0 = incremental, graph already current)`
  }
- Benchmark wall-clock: ${(meta.durationMs / 1000).toFixed(1)}s

## Methodology & honest caveats

**Baseline (no graph)** — emulates a traditional coding agent with no context
layer. For each query we grep the \`src/\` tree (extensions: ${BASELINE_EXTENSIONS.join(
    ", "
  )}), rank files by the number of query-term matches, take the top
**${BASELINE_MAX_FILES_PER_QUERY}** files, and count the tokens of their **full
contents**. This represents the common "dump the relevant files into the prompt"
strategy.

- This is a *simulation*, not a capture of a specific real agent. The number of
  files an agent reads varies; we cap it at ${BASELINE_MAX_FILES_PER_QUERY} per query to keep the baseline
  bounded and reproducible. A higher cap would only increase the reported
  savings, so this cap is a **conservative** choice.
- We scan only \`src/\` (not tests, build output, or generated graph artifacts),
  which is the code an agent would realistically read for these queries.
- We count full-file contents because agents without precise navigation tend to
  read whole files rather than exact line ranges.

**GraphFlow (compressed)** — calls the exported \`previewContext\` function. The
headline number is obtained by **independently re-tokenizing** the exact text an
agent receives (the \`summary\` channel + anchor pointer lines) with
\`gpt-tokenizer\`. We deliberately do **not** trust GraphFlow's self-reported
\`tokenEstimate\` for the headline (that estimate is shown in its own column and
is typically *lower*, i.e. our reported savings are the conservative side).

- Anchors are lightweight pointers (id/type/layer). An agent expands only the
  anchors it needs via \`expand_anchor\`, so the *initial* context cost is what we
  measure here. Even if every anchor were later expanded, the upfront budget is
  what determines whether the task fits in a small context window.
- Semantic (LLM) compression and network embeddings are **disabled** for this
  run so it is offline and deterministic; only zero-cost graph-structure
  compression is active. Enabling semantic compression would typically improve
  savings further.

## Reproduce

\`\`\`bash
npm install
npm run benchmark
\`\`\`

No API key is required. The script builds its own isolated graph under
\`benchmarks/.cache/\` and replaces its own section in this file on every run
(sections appended by the other benchmark scripts are preserved). The
machine-readable numbers land in
\`benchmarks/.cache/token-bench-results.json\` (per-query results, totals,
inputs, environment, commit hash and run date).
${TOKEN_END}
`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  process.stdout.write("GraphFlow token-savings benchmark\n");
  process.stdout.write(`Repo root: ${REPO_ROOT}\n\n`);

  writeBenchmarkConfig();

  process.stdout.write("Indexing repository graph (offline, AST-only)...\n");
  let indexedFiles: number | null = null;
  let nodeCount: number | null = null;
  try {
    const indexResult = await indexGraph(REPO_ROOT, CONFIG_PATH);
    indexedFiles = indexResult.indexedFiles;
    process.stdout.write(
      `  indexed ${formatNumber(indexResult.indexedFiles)} files, ` +
        `${formatNumber(indexResult.indexedSymbols)} symbols\n\n`
    );
  } catch (error) {
    process.stdout.write(`  index step failed (will rely on auto-index): ${String(error)}\n\n`);
  }

  process.stdout.write("Scanning source tree for baseline...\n");
  const rawFiles = collectSourceFiles(BASELINE_SCAN_DIR);
  const sourceFiles = rawFiles.map((path) => {
    const content = readFileSync(path, "utf8");
    return { path, content, lower: content.toLowerCase() };
  });
  process.stdout.write(`  ${formatNumber(sourceFiles.length)} source files available\n\n`);

  const results: QueryResult[] = [];

  for (const query of QUERIES) {
    const baseline = measureBaseline(query, sourceFiles);
    const preview = await previewContext(query, CONFIG_PATH, REPO_ROOT);

    // Independent measurement: re-tokenize the exact text an agent receives
    // (summary strings + anchor pointer lines) with gpt-tokenizer. We use this
    // as the headline GraphFlow number rather than GraphFlow's self-reported
    // tokenEstimate, so the savings are independently verifiable and not
    // dependent on the engine's internal accounting.
    const contextText = [
      ...preview.summary,
      ...preview.anchors.map((a) => `${a.id} ${a.type} ${a.layer}`),
    ].join("\n");
    const graphflowTokens = countTokens(contextText);
    const graphflowSelfEstimate = preview.tokenEstimate;

    const savingsPercent =
      baseline.tokens > 0
        ? Math.max(0, ((baseline.tokens - graphflowTokens) / baseline.tokens) * 100)
        : 0;

    results.push({
      query,
      baselineTokens: baseline.tokens,
      baselineFiles: baseline.files,
      graphflowTokens,
      graphflowSelfEstimate,
      savingsPercent,
    });

    process.stdout.write(
      `  ${query.padEnd(22)} baseline=${formatNumber(baseline.tokens).padStart(9)} ` +
        `(${baseline.files} files)  graphflow=${formatNumber(graphflowTokens).padStart(6)} ` +
        `(self-est ${formatNumber(graphflowSelfEstimate)})  saved=${savingsPercent.toFixed(1)}%\n`
    );
  }

  const totalBaseline = results.reduce((sum, r) => sum + r.baselineTokens, 0);
  const totalGraphflow = results.reduce((sum, r) => sum + r.graphflowTokens, 0);
  const totalSavings =
    totalBaseline > 0 ? ((totalBaseline - totalGraphflow) / totalBaseline) * 100 : 0;

  // Read indexed node count from the benchmark graph store for the report.
  try {
    const storeRaw = readFileSync(join(CACHE_DIR, "benchmark-graph.json"), "utf8");
    const parsed = JSON.parse(storeRaw) as { nodes?: unknown[] };
    if (Array.isArray(parsed.nodes)) {
      nodeCount = parsed.nodes.length;
    }
  } catch {
    nodeCount = null;
  }

  process.stdout.write("\n");
  process.stdout.write("=".repeat(64) + "\n");
  process.stdout.write(
    `TOTAL  baseline=${formatNumber(totalBaseline)}  ` +
      `graphflow=${formatNumber(totalGraphflow)}  ` +
      `savings=${totalSavings.toFixed(1)}%\n`
  );
  process.stdout.write("=".repeat(64) + "\n");

  const durationMs = Date.now() - startedAt;
  const totalSelfEstimate = results.reduce((sum, r) => sum + r.graphflowSelfEstimate, 0);
  const markdown = buildResultsMarkdown(
    results,
    {
      baseline: totalBaseline,
      graphflow: totalGraphflow,
      savings: totalSavings,
      selfEstimate: totalSelfEstimate,
    },
    { nodeCount, indexedFiles, durationMs }
  );

  writeResultsMarkdown(markdown);
  process.stdout.write(`\nWrote ${relative(REPO_ROOT, RESULTS_PATH)}\n`);

  // Machine-readable artifact: pin the run to a commit + date so third parties
  // can reproduce (and attribute) the exact numbers. The inputs are recorded
  // verbatim (fixed query set + baseline parameters) for reproducibility.
  const jsonPayload = {
    schemaVersion: 1,
    benchmark: "token-savings",
    generatedAt: new Date().toISOString(),
    commit: getCommitHash(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      tokenizer: "gpt-tokenizer (gpt-4o encoding)",
    },
    inputs: {
      queries: [...QUERIES],
      baselineScanDir: relative(REPO_ROOT, BASELINE_SCAN_DIR),
      baselineMaxFilesPerQuery: BASELINE_MAX_FILES_PER_QUERY,
      baselineExtensions: [...BASELINE_EXTENSIONS],
    },
    totals: {
      baselineTokens: totalBaseline,
      graphflowTokens: totalGraphflow,
      graphflowSelfEstimate: totalSelfEstimate,
      savingsPercent: Math.round(totalSavings * 10) / 10,
    },
    meta: { nodeCount, indexedFiles, durationMs },
    results: results.map((r) => ({
      query: r.query,
      baselineTokens: r.baselineTokens,
      baselineFiles: r.baselineFiles,
      graphflowTokens: r.graphflowTokens,
      graphflowSelfEstimate: r.graphflowSelfEstimate,
      savingsPercent: Math.round(r.savingsPercent * 10) / 10,
    })),
  };
  writeFileSync(JSON_PATH, JSON.stringify(jsonPayload, null, 2), "utf8");
  process.stdout.write(`Wrote ${relative(REPO_ROOT, JSON_PATH)}\n`);
}

/**
 * Replace the previous token-benchmark section in RESULTS.md if present.
 * On the first run with section markers, keep whatever the other benchmark
 * scripts appended after the token section (P1-2 skill A/B, P3 memory A/B);
 * only when RESULTS.md has no appended sections at all is the whole file
 * (re)written by the token benchmark alone.
 */
function writeResultsMarkdown(markdown: string): void {
  let full = "";
  try {
    full = readFileSync(RESULTS_PATH, "utf8");
  } catch {
    full = "";
  }
  const startIdx = full.indexOf(TOKEN_BEGIN);
  const endIdx = full.indexOf(TOKEN_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const next = full.slice(endIdx + TOKEN_END.length);
    writeFileSync(RESULTS_PATH, `${full.slice(0, startIdx)}${markdown}${next}`, "utf8");
    return;
  }
  const p12Idx = full.indexOf(P12_BEGIN);
  if (p12Idx !== -1) {
    writeFileSync(RESULTS_PATH, `${markdown}${full.slice(p12Idx)}`, "utf8");
    return;
  }
  writeFileSync(RESULTS_PATH, markdown, "utf8");
}

main().catch((error) => {
  process.stderr.write(`Benchmark failed: ${String(error instanceof Error ? error.stack : error)}\n`);
  process.exitCode = 1;
});
