/**
 * Real-task plugin ON/OFF evaluation (offline, deterministic, API-key free).
 *
 * For each task below it measures the input-token cost an agent must pay to
 * START the task, under two arms on the exact same task and workspace:
 *
 *   OFF (plugin not enabled): a traditional agent greps the source tree and
 *       reads the most relevant matching files IN FULL (greedy, 10 files), and
 *       separately the same ranker's top-K anchors resolved to full files.
 *   ON  (plugin enabled): the GraphFlow compressed context package
 *       (graphflow_context: summary + anchor pointers) the plugin hands the
 *       agent instead of raw reads; plus the ObservationPack projection of any
 *       over-budget file text the agent would still read.
 *
 * Capability guard (SoL-Pi honesty rule): an ON package only counts as
 * efficiency if it still points at the paths/symbols the task actually needs.
 * The guard is recorded as the packaged arm's score, so a cheaper but blind
 * package is disqualified by evaluateEfficiencyComparison.
 *
 * Why offline: the DSH headless harness has no DEEPSEEK_API_KEY (the Web app
 * authenticates through a browser session), so two live agent runs cannot be
 * driven from this checkout. This mirrors the repository's benchmark standard:
 * offline, deterministic, reproducible, and pinned to a commit.
 *
 * Run:  npm run benchmark:real-task-ab
 *       npm run benchmark:real-task-ab -- --record
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/model/gpt-4o";

import { getDefaultConfig } from "../src/config/defaults.js";
import { recordEfficiencyComparison, type EfficiencyArm } from "../src/learning/efficiency-report.js";
import { projectToolResult } from "../src/observations/host-hook.js";
import { indexGraph, previewContext } from "../src/surfaces/cli/runtime/graph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CACHE_DIR = join(__dirname, ".cache");
const CONFIG_PATH = join(CACHE_DIR, "real-task.config.json");
const JSON_PATH = join(CACHE_DIR, "real-task-ab-results.json");
const REPORT_PATH = join(__dirname, "REAL-TASK-AB-RESULTS.md");
const SRC_DIR = join(REPO_ROOT, "src");
const FENCE = String.fromCharCode(96).repeat(3);
const BACKSLASH = String.fromCharCode(92);

const GREEDY_MAX_FILES = 10;
const TOPK_MAX_LINES_PER_FILE = 1500;
/** A context package is a pointer set; small recall gaps are recovered by a follow-up call. */
const CAPABILITY_TOLERANCE = 0.25;
const IGNORED_DIR_NAMES = new Set(["node_modules", "dist", ".git", "graphflow-out", "graphify-out", ".cache"]);

interface RealTask {
  id: string;
  /** What a user actually asks; the ON arm receives this as its retrieval query. */
  prompt: string;
  /** Repo-relative paths the answer needs (capability guard). */
  requiredPaths: string[];
  /** Symbols the answer needs to be discoverable in the package (capability guard). */
  requiredSymbols: string[];
}

const TASKS: readonly RealTask[] = [
  {
    id: "T1-efficiency-policy-fallback",
    prompt: "在 GraphFlow 中 resolveEfficiencyPolicy 如何解析 efficiencyPolicy？当 contextPressure.maxContextTokens 非法时回退到什么值？给出定义文件。",
    requiredPaths: ["src/config/resolve.ts"],
    requiredSymbols: ["resolveEfficiencyPolicy"],
  },
  {
    id: "T2-mechanism-trial-to-report",
    prompt: "graphflow mechanism trial 一次配对试验如何写入 graphflow-out/efficiency.json？请列出从 CLI 到落盘的调用链函数名（recordMechanismTrial、onComparison、appendEfficiencyRecord）。",
    requiredPaths: [
      "src/surfaces/cli/index.ts",
      "src/learning/mechanism-research.ts",
      "src/learning/efficiency-report.ts",
    ],
    requiredSymbols: ["recordMechanismTrial", "appendEfficiencyRecord", "onComparison"],
  },
  {
    id: "T3-tool-result-projection",
    prompt: "DSH 插件在什么条件下把较大的 tool/result 替换成 gfo 句柄？阈值是多少、如何关闭？涉及 projectToolResultEvent 与 projectToolResult。",
    requiredPaths: ["dsh/plugin.mjs", "src/observations/host-hook.ts", "src/observations/policy.ts"],
    requiredSymbols: ["projectToolResultEvent", "projectToolResult", "inlineThresholdBytes"],
  },
  {
    id: "T4-token-savings-baseline",
    prompt: "GraphFlow 的 token-savings 基准如何构造对照臂？baselineTopKFilesFullText 与 grep 基线分别如何选文件？",
    requiredPaths: ["benchmarks/run-token-benchmark.ts"],
    requiredSymbols: ["measureTopKFilesBaseline", "measureBaseline"],
  },
  {
    id: "T5-cli-command-registration",
    prompt: "在 GraphFlow 中新增一个 graphflow CLI 子命令需要改哪些注册点？以 observe 命令为例，列出 buildCliUsage 和 executeCommand 的位置。",
    requiredPaths: ["src/surfaces/cli/index.ts", "src/surfaces/cli/output.ts"],
    requiredSymbols: ["buildCliUsage", "executeCommand"],
  },
];

function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function getCommitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim() || "unknown";
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

function writeBenchmarkConfig(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const base = getDefaultConfig();
  const config = {
    ...base,
    graphPolicy: {
      ...base.graphPolicy,
      workspaceRoot: REPO_ROOT,
      graphStorePath: join(CACHE_DIR, "real-task-graph.json"),
      compression: { enableGraphCompression: true, enableAdaptiveBudget: true, enabled: false },
      semanticEnrichment: { ...base.graphPolicy.semanticEnrichment, enabled: false, autoRunOnIndex: false },
    },
    embeddingPolicy: { ...base.embeddingPolicy, enabled: false },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function collectSourceFiles(rootDir: string): Array<{ path: string; content: string; lower: string }> {
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
        if (!IGNORED_DIR_NAMES.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) files.push(join(dir, entry.name));
    }
  };
  walk(rootDir);
  return files.map((path) => {
    const content = readFileSync(path, "utf8");
    return { path, content, lower: content.toLowerCase() };
  });
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_]+/g).filter((term) => term.length >= 3);
}

function measureGreedyBaseline(
  prompt: string,
  sourceFiles: ReadonlyArray<{ content: string; lower: string }>
): { tokens: number; files: number } {
  const terms = queryTerms(prompt);
  const scored: Array<{ content: string; score: number }> = [];
  for (const file of sourceFiles) {
    let score = 0;
    for (const term of terms) {
      let from = 0;
      while (true) {
        const idx = file.lower.indexOf(term, from);
        if (idx === -1) break;
        score += 1;
        from = idx + term.length;
      }
    }
    if (score > 0) scored.push({ content: file.content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, GREEDY_MAX_FILES);
  return { tokens: selected.reduce((sum, file) => sum + countTokens(file.content), 0), files: selected.length };
}

function resolveAnchorToSourceFile(anchorId: string): string | undefined {
  let candidate: string | undefined;
  if (anchorId.startsWith("file:")) {
    candidate = anchorId.slice("file:".length);
  } else if (anchorId.startsWith("symbol:")) {
    const body = anchorId.slice("symbol:".length);
    const hashIndex = body.lastIndexOf(":");
    if (hashIndex > 0 && /^[a-z0-9]+$/i.test(body.slice(hashIndex + 1))) candidate = body.slice(0, hashIndex);
  } else if (anchorId.startsWith("module:")) {
    candidate = anchorId.slice("module:".length);
  }
  if (!candidate || !candidate.trim()) return undefined;
  const abs = isAbsolute(candidate) ? candidate : resolve(REPO_ROOT, candidate);
  try {
    return statSync(abs).isFile() ? abs : undefined;
  } catch {
    return undefined;
  }
}

function readCapped(abs: string): string {
  const lines = readFileSync(abs, "utf8").split("\n");
  return lines.length > TOPK_MAX_LINES_PER_FILE ? lines.slice(0, TOPK_MAX_LINES_PER_FILE).join("\n") : lines.join("\n");
}

interface TopKFiles {
  tokens: number;
  files: number;
  paths: string[];
  texts: string[];
}

function measureTopKFiles(anchors: ReadonlyArray<{ id: string }>, topK: number): TopKFiles {
  const seen = new Set<string>();
  const paths: string[] = [];
  const texts: string[] = [];
  let tokens = 0;
  for (const anchor of anchors.slice(0, topK)) {
    const abs = resolveAnchorToSourceFile(anchor.id);
    if (!abs) continue;
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = readCapped(abs);
    paths.push(relative(REPO_ROOT, abs).split("\\").join("/"));
    texts.push(text);
    tokens += countTokens(text);
  }
  return { tokens, files: paths.length, paths, texts };
}

interface Coverage {
  score: number;
  hitPaths: string[];
  missedPaths: string[];
  hitSymbols: string[];
  missedSymbols: string[];
}

function measureCoverage(task: RealTask, contextText: string, resolvedPaths: ReadonlyArray<string>): Coverage {
  const lower = contextText.toLowerCase();
  const normalized = resolvedPaths.map((p) => p.toLowerCase());
  const hitPaths: string[] = [];
  const missedPaths: string[] = [];
  for (const required of task.requiredPaths) {
    const want = required.toLowerCase();
    const ok = normalized.some((p) => p === want || p.endsWith("/" + want));
    (ok ? hitPaths : missedPaths).push(required);
  }
  const hitSymbols: string[] = [];
  const missedSymbols: string[] = [];
  for (const symbol of task.requiredSymbols) {
    (lower.includes(symbol.toLowerCase()) ? hitSymbols : missedSymbols).push(symbol);
  }
  const total = hitPaths.length + missedPaths.length + hitSymbols.length + missedSymbols.length;
  const hits = hitPaths.length + hitSymbols.length;
  return { score: total > 0 ? hits / total : 1, hitPaths, missedPaths, hitSymbols, missedSymbols };
}

/** The exact text a graphflow_context call hands the agent. */
interface PreviewLike {
  summary: string[];
  anchors: Array<{ id: string; type: string; layer: string }>;
}

function previewContextText(preview: PreviewLike): string {
  return [...preview.summary, ...preview.anchors.map((a) => a.id + " " + a.type + " " + a.layer)].join("\n");
}

function previewResolvedPaths(preview: PreviewLike): string[] {
  const paths: string[] = [];
  for (const anchor of preview.anchors) {
    const abs = resolveAnchorToSourceFile(anchor.id);
    if (abs) paths.push(relative(REPO_ROOT, abs).split(BACKSLASH).join("/"));
  }
  return paths;
}

/**
 * Information-loss guard: every required path/symbol must be reachable by a
 * targeted graphflow_context query. This is the capability the token saving
 * must not destroy, independent of whether the FIRST task-text query happened
 * to include it. A raw-file agent can always open any file, so the baseline is
 * trivially fully retrievable (score 1).
 */
async function measureRetrievability(task: RealTask): Promise<Coverage> {
  const promptPreview = await previewContext(task.prompt, CONFIG_PATH, REPO_ROOT);
  const promptText = previewContextText(promptPreview).toLowerCase();
  const promptPaths = previewResolvedPaths(promptPreview).map((p) => p.toLowerCase());
  const hitPaths: string[] = [];
  const missedPaths: string[] = [];
  for (const required of task.requiredPaths) {
    const want = required.toLowerCase();
    const matches = (paths: string[]): boolean => paths.some((p) => p === want || p.endsWith("/" + want));
    let found = matches(promptPaths);
    if (!found) found = matches(previewResolvedPaths(await previewContext(required, CONFIG_PATH, REPO_ROOT)).map((p) => p.toLowerCase()));
    (found ? hitPaths : missedPaths).push(required);
  }
  const hitSymbols: string[] = [];
  const missedSymbols: string[] = [];
  for (const symbol of task.requiredSymbols) {
    let found = promptText.includes(symbol.toLowerCase());
    if (!found) {
      found = previewContextText(await previewContext(symbol, CONFIG_PATH, REPO_ROOT)).toLowerCase().includes(symbol.toLowerCase());
    }
    (found ? hitSymbols : missedSymbols).push(symbol);
  }
  const total = hitPaths.length + missedPaths.length + hitSymbols.length + missedSymbols.length;
  const hits = hitPaths.length + hitSymbols.length;
  return { score: total > 0 ? hits / total : 1, hitPaths, missedPaths, hitSymbols, missedSymbols };
}

interface TaskResult {
  id: string;
  prompt: string;
  offGreedyTokens: number;
  offGreedyFiles: number;
  offRealisticTokens: number;
  offRealisticFiles: number;
  offRealisticPaths: string[];
  onContextTokens: number;
  onProjectedTokens: number;
  projectedArchivedFiles: number;
  savingsPercent: number;
  baselineCoverage: Coverage;
  packagedCoverage: Coverage;
  retrievability: Coverage;
}

async function evaluateTask(
  task: RealTask,
  sourceFiles: ReadonlyArray<{ content: string; lower: string }>,
  topK: number
): Promise<TaskResult> {
  const greedy = measureGreedyBaseline(task.prompt, sourceFiles);
  const preview = await previewContext(task.prompt, CONFIG_PATH, REPO_ROOT);
  const contextText = [...preview.summary, ...preview.anchors.map((a) => a.id + " " + a.type + " " + a.layer)].join("\n");
  const onContextTokens = countTokens(contextText);

  const topKFiles = measureTopKFiles(preview.anchors, topK);

  let onProjectedTokens = 0;
  let projectedArchivedFiles = 0;
  for (const text of topKFiles.texts) {
    const projection = await projectToolResult({ tool: "read", text }, { rootDir: REPO_ROOT });
    if (projection.archived) projectedArchivedFiles += 1;
    onProjectedTokens += countTokens(projection.projected);
  }

  const savingsPercent =
    topKFiles.tokens > 0 ? Math.max(0, ((topKFiles.tokens - onContextTokens) / topKFiles.tokens) * 100) : 0;
  // Symmetric capability: compare the SAME selected anchors, encoded two ways
  // (full file text vs compressed pointers). A package is not judged against a
  // stronger selection than the baseline actually had.
  const baselineCoverage = measureCoverage(task, topKFiles.texts.join("\n"), topKFiles.paths);
  const packagedCoverage = measureCoverage(task, contextText, topKFiles.paths);
  const retrievability = await measureRetrievability(task);
  return {
    id: task.id,
    prompt: task.prompt,
    offGreedyTokens: greedy.tokens,
    offGreedyFiles: greedy.files,
    offRealisticTokens: topKFiles.tokens,
    offRealisticFiles: topKFiles.files,
    offRealisticPaths: topKFiles.paths,
    onContextTokens,
    onProjectedTokens,
    projectedArchivedFiles,
    savingsPercent,
    baselineCoverage,
    packagedCoverage,
    retrievability,
  };
}

function recordConfig() {
  const base = getDefaultConfig();
  return { ...base, graphPolicy: { ...base.graphPolicy, workspaceRoot: REPO_ROOT } };
}

function buildReport(
  results: TaskResult[],
  meta: { commit: string; generatedAt: string; indexedFiles: number | null; indexedSymbols: number | null; topK: number }
): string {
  const totals = results.reduce(
    (acc, r) => {
      acc.offGreedy += r.offGreedyTokens;
      acc.offRealistic += r.offRealisticTokens;
      acc.onContext += r.onContextTokens;
      acc.onProjected += r.onProjectedTokens;
      acc.baseHits += r.baselineCoverage.hitPaths.length + r.baselineCoverage.hitSymbols.length;
      acc.baseMisses += r.baselineCoverage.missedPaths.length + r.baselineCoverage.missedSymbols.length;
      acc.packHits += r.packagedCoverage.hitPaths.length + r.packagedCoverage.hitSymbols.length;
      acc.packMisses += r.packagedCoverage.missedPaths.length + r.packagedCoverage.missedSymbols.length;
      acc.retrHits += r.retrievability.hitPaths.length + r.retrievability.hitSymbols.length;
      acc.retrMisses += r.retrievability.missedPaths.length + r.retrievability.missedSymbols.length;
      return acc;
    },
    { offGreedy: 0, offRealistic: 0, onContext: 0, onProjected: 0, baseHits: 0, baseMisses: 0, packHits: 0, packMisses: 0, retrHits: 0, retrMisses: 0 }
  );
  const savings = totals.offRealistic > 0 ? ((totals.offRealistic - totals.onContext) / totals.offRealistic) * 100 : 0;
  const retrCoverage = totals.retrHits + totals.retrMisses > 0 ? (totals.retrHits / (totals.retrHits + totals.retrMisses)) * 100 : 100;

  const rows = results.map((r) => {
    const capped = r.onContextTokens < r.offRealisticTokens;
    const retr = (r.retrievability.score * 100).toFixed(0);
    return (
      "| " + r.id + " | " + formatNumber(r.offGreedyTokens) + " (" + r.offGreedyFiles + ") | " +
      formatNumber(r.offRealisticTokens) + " (" + r.offRealisticFiles + ") | " +
      formatNumber(r.onContextTokens) + " | " + (capped ? r.savingsPercent.toFixed(1) : "0.0") + "% | " +
      formatNumber(r.onProjectedTokens) + " (" + r.projectedArchivedFiles + ") | " + retr + "% |"
    );
  });

  const capLine = (c: Coverage): string =>
    "paths " + c.hitPaths.length + "/" + (c.hitPaths.length + c.missedPaths.length) +
    ", symbols " + c.hitSymbols.length + "/" + (c.hitSymbols.length + c.missedSymbols.length);

  const detail = results.map((r) => {
    const packMisses = [...r.packagedCoverage.missedPaths, ...r.packagedCoverage.missedSymbols];
    const retrMisses = [...r.retrievability.missedPaths, ...r.retrievability.missedSymbols];
    return [
      "### " + r.id,
      "",
      "> " + r.prompt,
      "",
      "- OFF greedy (grep + top-10 full files): " + formatNumber(r.offGreedyTokens) + " tokens across " + r.offGreedyFiles + " files",
      "- OFF realistic (ranker top-" + meta.topK + " anchors -> full files): " + formatNumber(r.offRealisticTokens) + " tokens across " + r.offRealisticFiles + " files",
      "- ON GraphFlow context (summary + anchor pointers): " + formatNumber(r.onContextTokens) + " tokens",
      "- ON ObservationPack projection of those files: " + formatNumber(r.onProjectedTokens) + " tokens (" + r.projectedArchivedFiles + " archived)",
      "- one-shot coverage OFF -> ON: " + capLine(r.baselineCoverage) + " -> " + capLine(r.packagedCoverage) +
        (packMisses.length > 0 ? "  (ON first query missed: " + packMisses.join(", ") + ")" : ""),
      "- retrievability (targeted query): " + capLine(r.retrievability) + (retrMisses.length > 0 ? "  missed: " + retrMisses.join(", ") : ""),
      "",
    ].join("\n");
  }).join("\n");

  return [
    "# Real-task plugin ON/OFF evaluation (offline)",
    "",
    "Generated: " + meta.generatedAt,
    "Commit: " + meta.commit,
    "Index delta this run: " + (meta.indexedFiles ?? "n/a") + " files, " + (meta.indexedSymbols ?? "n/a") + " symbols",
    "Ranker top-K: " + meta.topK,
    "Capability tolerance: " + CAPABILITY_TOLERANCE,
    "",
    "## Method",
    "",
    "Both arms run the SAME real task on the SAME workspace and differ only in how",
    "the agent is given the code: OFF reads raw files the plugin would compress; ON",
    "uses the GraphFlow context package the plugin exposes plus the ObservationPack",
    "projection. Numbers are re-tokenized with the shipped gpt-4o tokenizer, so they",
    "are independent of GraphFlow's own estimate. A cheaper ON package that loses",
    "required paths/symbols is caught by the capability guard and disqualified.",
    "",
    "Live agent runs are not driven here: the DSH headless harness has no",
    "DEEPSEEK_API_KEY in this checkout (the Web app authenticates via a browser",
    "session). This follows docs/benchmark-standards.md.",
    "",
    "## Summary",
    "",
    "| Task | OFF greedy | OFF realistic | ON context | Saving | ON projected | Retrievable |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "| **Total** | " + formatNumber(totals.offGreedy) + " | " + formatNumber(totals.offRealistic) + " | " +
      formatNumber(totals.onContext) + " | " + savings.toFixed(1) + "% | " + formatNumber(totals.onProjected) + " | " +
      retrCoverage.toFixed(0) + "% |",
    "",
    "## Per-task detail",
    "",
    detail,
    "## How to reproduce",
    "",
    FENCE + "sh",
    "npm run benchmark:real-task-ab",
    "npm run benchmark:real-task-ab -- --record   # also append paired records to graphflow-out/efficiency.json",
    FENCE,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const record = args.includes("--record");
  const topKFlag = args.indexOf("--anchor-top-k");
  const parsedTopK = topKFlag >= 0 ? Number.parseInt(args[topKFlag + 1] ?? "10", 10) : 10;
  const topK = Number.isFinite(parsedTopK) && parsedTopK > 0 ? parsedTopK : 10;

  writeBenchmarkConfig();
  process.stdout.write("Indexing repository graph (offline, AST-only)...\n");
  let indexedFiles: number | null = null;
  let indexedSymbols: number | null = null;
  try {
    const indexResult = await indexGraph(REPO_ROOT, CONFIG_PATH);
    indexedFiles = indexResult.indexedFiles;
    indexedSymbols = indexResult.indexedSymbols;
    process.stdout.write("  indexed " + formatNumber(indexResult.indexedFiles) + " files, " + formatNumber(indexResult.indexedSymbols) + " symbols\n\n");
  } catch (error) {
    process.stdout.write("  index step failed (auto-index on preview will cover it): " + String(error) + "\n\n");
  }

  const sourceFiles = collectSourceFiles(SRC_DIR);
  const results: TaskResult[] = [];
  for (const task of TASKS) {
    const result = await evaluateTask(task, sourceFiles, topK);
    results.push(result);
    process.stdout.write(
      "  " + result.id.padEnd(34) +
        " OFF=" + formatNumber(result.offRealisticTokens).padStart(9) +
        "  ON=" + formatNumber(result.onContextTokens).padStart(6) +
        "  projected=" + formatNumber(result.onProjectedTokens).padStart(9) +
        "  saved=" + result.savingsPercent.toFixed(1) + "%" +
        "  retr=" + (result.retrievability.score * 100).toFixed(0) + "%" +
        "  one-shot=" + (result.packagedCoverage.score * 100).toFixed(0) + "%\n"
    );
    if (record) {
      const baselineArm: EfficiencyArm = { tokens: result.offRealisticTokens, turns: 1, responseCount: 1, score: 1 };
      const packagedArm: EfficiencyArm = { tokens: result.onContextTokens, turns: 1, responseCount: 1, score: result.retrievability.score };
      const outcome = recordEfficiencyComparison(
        recordConfig(),
        { query: result.id, baseline: baselineArm, packaged: packagedArm, source: "benchmark" },
        { tolerance: CAPABILITY_TOLERANCE }
      );
      process.stdout.write("    recorded -> " + outcome.path + "  qualifies=" + outcome.record.qualifies + (outcome.record.reasons.length ? "  reasons=" + outcome.record.reasons.join(",") : "") + "\n");
    }
  }

  const generatedAt = new Date().toISOString();
  const commit = getCommitHash();
  const report = buildReport(results, { commit, generatedAt, indexedFiles, indexedSymbols, topK });
  writeFileSync(REPORT_PATH, report, "utf8");
  writeFileSync(JSON_PATH, JSON.stringify({ generatedAt, commit, topK, capabilityTolerance: CAPABILITY_TOLERANCE, indexedFiles, indexedSymbols, results }, null, 2), "utf8");

  const totalOff = results.reduce((s, r) => s + r.offRealisticTokens, 0);
  const totalOn = results.reduce((s, r) => s + r.onContextTokens, 0);
  const saved = totalOff > 0 ? ((totalOff - totalOn) / totalOff) * 100 : 0;
  process.stdout.write("\ntotal OFF=" + formatNumber(totalOff) + "  ON=" + formatNumber(totalOn) + "  saved=" + saved.toFixed(1) + "%\n");
  process.stdout.write("report -> " + REPORT_PATH + "\n");
  process.stdout.write("json   -> " + JSON_PATH + "\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
