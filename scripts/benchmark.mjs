#!/usr/bin/env node
/**
 * GraphFlow benchmark harness — measures the claims the README makes:
 *   1. MCP tool-schema token tax (4 tools, target < 460 tokens)
 *   2. large-file symbol skeleton compression
 *   3. single-symbol slice vs full-file read
 *   4. passing test-suite output dehydration
 *   5. failure dehydration with auto-attached source context
 *   6. knowledge-graph build time / node / edge counts
 *   7. affected-test routing latency
 *
 * Run from the repo root after `npm run build`:
 *   node scripts/benchmark.mjs
 * It writes benchmarks/latest.md + benchmarks/latest.json (untracked cache dir).
 */
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const rootDir = resolve(process.cwd());
const gf = require(join(rootDir, "dist", "index.js"));
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

const tokens = (text) => Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
const pct = (before, after) => (before > 0 ? ((before - after) / before) * 100 : 0);
const fmt = (n) => n.toLocaleString("en-US");
const rows = [];
const json = { version: pkg.version, generatedAt: new Date().toISOString(), metrics: {} };

function record(id, label, before, after, extra = {}) {
  const saving = pct(before, after);
  rows.push({ id, label, before, after, saving, ...extra });
  json.metrics[id] = { label, before, after, savingPct: Number(saving.toFixed(1)), ...extra };
}

// 1. MCP tool schema tax -----------------------------------------------------
{
  const defs = gf.getToolDefinitions();
  const raw = JSON.stringify(defs);
  const toolTokens = tokens(raw);
  rows.push({
    id: "schema",
    label: `MCP schema tax (${defs.length} tools)`,
    before: null,
    after: toolTokens,
    saving: null,
    extra: { target: "< 460 tokens", pass: toolTokens < 460 },
  });
  json.metrics.schema = {
    tools: defs.length,
    tokens: toolTokens,
    target: "<460",
    pass: toolTokens < 460,
    bytes: Buffer.byteLength(raw, "utf8"),
  };
}

// 2. Large-file skeleton folding --------------------------------------------
{
  const rel = "src/ast-engine.ts";
  const content = readFileSync(join(rootDir, rel), "utf8");
  const ast = gf.analyzeSourceFile(rel, content);
  const skeleton = gf.foldFileSkeleton(content, ast);
  record("skeleton", `Skeleton fold ${rel} (${ast.totalLines}L)`, tokens(content), tokens(skeleton), {
    lines: ast.totalLines,
    symbols: ast.symbols.length,
  });
}

// 3. Single-symbol slice -----------------------------------------------------
{
  const rel = "src/ast-engine.ts";
  const content = readFileSync(join(rootDir, rel), "utf8");
  const slice = gf.executeSurgicalRead({
    rootDir,
    targets: [`${rel}#analyzeSourceFile`],
    includeCallers: true,
  });
  record("slice", "Symbol slice vs full-file read (ast-engine.ts#analyzeSourceFile)", tokens(content), slice.estimatedTokens, {
    resolvedKeys: slice.resolvedKeys.length,
  });
}

// 4. Passing test-suite dehydration -----------------------------------------
{
  const started = Date.now();
  const result = gf.execAndDehydrate({ rootDir, command: "npm test", timeoutMs: 300_000 });
  record("pass-dehydrate", `Passing test suite: raw vs dehydrated (${Date.now() - started}ms)`, result.rawEstimatedTokens, result.dehydratedTokens, {
    exitCode: result.exitCode,
    rawBytes: result.rawBytes,
    ok: result.ok,
  });
}

// 5. Failure dehydration with source context --------------------------------
{
  const failRoot = mkdtempSync(join(tmpdir(), "gf-bench-fail-"));
  try {
    writeFileSync(
      join(failRoot, "fail.js"),
      [
        'console.error("Error: expected 42 but received 7");',
        'console.error("    at run (fail.js:3:9)");',
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8"
    );
    const result = gf.execAndDehydrate({ rootDir: failRoot, command: "node fail.js" });
    record("fail-dehydrate", "Failure log: raw vs dehydrated + source context", result.rawEstimatedTokens, result.dehydratedTokens, {
      exitCode: result.exitCode,
      hasSourceContext: result.text.includes("# Auto-Attached Failure Source Context"),
    });
  } finally {
    rmSync(failRoot, { recursive: true, force: true });
  }
}

// 6. Knowledge graph ---------------------------------------------------------
{
  const index = gf.getWorkspaceAstIndex(rootDir);
  const started = Date.now();
  const graph = gf.buildKnowledgeGraphData(index);
  const elapsed = Date.now() - started;
  const kinds = {};
  for (const edge of graph.edges) kinds[edge.kind] = (kinds[edge.kind] ?? 0) + 1;
  rows.push({
    id: "graph",
    label: "Knowledge-graph build",
    before: null,
    after: elapsed,
    saving: null,
    extra: { nodes: graph.nodes.length, edges: graph.edges.length, kinds },
  });
  json.metrics.graph = { ms: elapsed, nodes: graph.nodes.length, edges: graph.edges.length, kinds };
}

// 7. Affected-test routing ---------------------------------------------------
{
  const started = Date.now();
  const result = gf.resolveAffectedTests(rootDir, ["src/dehydrator.ts"]);
  const elapsed = Date.now() - started;
  rows.push({
    id: "affected",
    label: "Affected-test routing (changed src/dehydrator.ts)",
    before: null,
    after: elapsed,
    saving: null,
    extra: { tests: result.affectedTests.length },
  });
  json.metrics.affected = { ms: elapsed, changedFiles: result.changedFiles.length, affectedTests: result.affectedTests };
}

// 8. Blast radius ------------------------------------------------------------
{
  const index = gf.getWorkspaceAstIndex(rootDir);
  const started = Date.now();
  const blast = gf.computeBlastRadius(index, "src/ast-engine.ts", "analyzeSourceFile");
  const elapsed = Date.now() - started;
  rows.push({
    id: "blast",
    label: "Blast radius (analyzeSourceFile)",
    before: null,
    after: elapsed,
    saving: null,
    extra: { callSites: blast.totalCallSites, importers: blast.importers.length },
  });
  json.metrics.blast = { ms: elapsed, callSites: blast.totalCallSites, importers: blast.importers.length };
}

// Report ---------------------------------------------------------------------
const md = [];
md.push(`# GraphFlow ${pkg.version} benchmark report`);
md.push("");
md.push(`Generated: ${json.generatedAt}`);
md.push("");
md.push("| Metric | Before | After | Saving | Notes |");
md.push("| :--- | ---: | ---: | ---: | :--- |");
for (const row of rows) {
  const before = row.before === null ? "—" : fmt(row.before);
  const after = typeof row.after === "number" && row.id === "graph" || row.id === "affected" || row.id === "blast"
    ? `${fmt(row.after)} ms`
    : fmt(row.after);
  const saving = row.saving === null ? "—" : `${row.saving.toFixed(1)}%`;
  const notes = Object.entries(row.extra ?? {})
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(", ");
  md.push(`| ${row.label} | ${before} | ${after} | ${saving} | ${notes} |`);
}
md.push("");
md.push("Raw JSON: `benchmarks/latest.json`");

const outDir = join(rootDir, "benchmarks");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "latest.md"), `${md.join("\n")}\n`, "utf8");
writeFileSync(join(outDir, "latest.json"), `${JSON.stringify(json, null, 2)}\n`, "utf8");
console.log(md.join("\n"));
