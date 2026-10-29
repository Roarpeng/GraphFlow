/**
 * GraphFlow — data-file structure-aware folding (`tests/slicer-data-fold.test.ts`)
 *
 * Standalone: `npx tsx tests/slicer-data-fold.test.ts`
 *
 * Covers:
 *   D1  whole-file .json read folds to a key-path skeleton (arrays as [N items],
 *       >30 sibling keys collapse, depth cap 4, 40-char scalar truncation) and
 *       the [Data Skeleton] header reports a real token reduction;
 *   D2  whole-file .csv read (> 40 rows) folds to header + 3 data rows + row-count
 *       marker with 40-char cells;
 *   D3  whole-file .log read (> 250 lines) folds to head 20 + tail 20 with real
 *       1-based line numbers and a one-line omission marker;
 *   D4  explicit line-range and symbol targets never fold;
 *   D5  invalid JSON falls back to the raw whole-file view;
 *   D6  below-threshold data files and source files keep the raw/skeleton view.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executeSurgicalRead } from "../src/index.js";

let passed = 0;
let failed = 0;
const roots: string[] = [];

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function run(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gf-data-fold-"));
  roots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

const DATA_SKELETON_HEADER = /raw ~(\d+) tok → folded ~(\d+) tok \(−(\d+)%\)/;

function manyKeys(count: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i++) out[`field_${i}`] = i;
  return out;
}

const configJson = JSON.stringify(
  {
    name: "graphflow-datasink",
    server: { host: "localhost", port: 5432, tags: ["alpha", "beta", "gamma"] },
    deep: { l1: { l2: { l3: { l4: { l5: "bottom" } } } } },
    description: "d".repeat(200),
    longArray: Array.from({ length: 25 }, (_, i) => ({ id: i, label: `row-${i}` })),
    flat: manyKeys(36),
  },
  null,
  2
);

const bigCsv = [
  "id,name,score,note",
  ...Array.from({ length: 45 }, (_, i) => `${i + 1},user-${i + 1},${((i + 1) * 7) % 100},${"n".repeat(60)}`),
].join("\n");

const bigLog = Array.from({ length: 300 }, (_, i) => `2026-10-29T10:00:00Z INFO line-${i + 1} event payload`).join(
  "\n"
);

run("D1 json whole-file read folds to a key-path skeleton with token header", () => {
  const root = workspace({ "data/config.json": configJson });
  const result = executeSurgicalRead({
    rootDir: root,
    targets: ["data/config.json"],
    includeCallers: false,
  });

  assert(result.text.includes("// [Data Skeleton]"), "[Data Skeleton] marker missing");
  assert(result.text.includes("(Data Skeleton, JSON)"), "JSON section header missing");
  assert(result.text.includes('server.host: "localhost"'), "nested key path server.host missing");
  assert(result.text.includes("server.port: 5432"), "numeric leaf missing");
  assert(result.text.includes("tags: [3 items]"), "array item-count marker missing");
  assert(result.text.includes("longArray: [25 items]"), "long array marker missing");
  assert(result.text.includes("longArray[0].label: \"row-0\""), "first-element shape sample missing");
  assert(result.text.includes("…(+6 more keys)"), "36 sibling keys must fold to +6 more");
  assert(
    result.text.includes("deep.l1.l2.l3: {…} [1 keys, depth cap 4]"),
    "depth-4 object must stop expanding"
  );
  assert(result.text.includes('description: "'), "long string leaf missing");
  assert(!result.text.includes("d".repeat(60)), "leaf longer than 40 chars must be truncated");

  const header = DATA_SKELETON_HEADER.exec(result.text);
  assert(header !== null, "token header line missing");
  const rawTok = Number(header![1]);
  const foldedTok = Number(header![2]);
  const reduction = Number(header![3]);
  assert(foldedTok < rawTok, `folded (${foldedTok}) must be below raw (${rawTok}) tokens`);
  assert(reduction > 0, "reduction percent must be positive");
  assert(
    result.estimatedTokens < result.rawFileTokens,
    `estimatedTokens (${result.estimatedTokens}) must be below rawFileTokens (${result.rawFileTokens})`
  );
});

run("D2 csv whole-file read (> 40 rows) folds to header + 3 rows + marker", () => {
  const root = workspace({ "data/rows.csv": bigCsv });
  const result = executeSurgicalRead({
    rootDir: root,
    targets: ["data/rows.csv"],
    includeCallers: false,
  });

  assert(result.text.includes("// [Data Skeleton]"), "[Data Skeleton] marker missing");
  assert(result.text.includes("(Data Skeleton, CSV)"), "CSV section header missing");
  assert(result.text.includes("   1: id,name,score,note"), "header row missing");
  assert(result.text.includes("   2: 1,user-1,7,"), "first data row missing");
  assert(result.text.includes("   4: 3,user-3,21,"), "third data row missing");
  assert(result.text.includes("(+42 more rows)"), "row omission marker must say +42 more rows");
  assert(!result.text.includes("user-5,"), "fifth data row must be omitted");
  assert(result.text.includes("n".repeat(40)), "cell must keep up to 40 chars");
  assert(!result.text.includes("n".repeat(41)), "cells must truncate at 40 chars");

  const header = DATA_SKELETON_HEADER.exec(result.text);
  assert(header !== null, "token header line missing");
  assert(Number(header![2]) < Number(header![1]), "folded tokens must be below raw tokens");
});

run("D3 log whole-file read (> 250 lines) folds to head/tail with real line numbers", () => {
  const root = workspace({ "logs/app.log": bigLog });
  const result = executeSurgicalRead({
    rootDir: root,
    targets: ["logs/app.log"],
    includeCallers: false,
  });

  assert(result.text.includes("// [Data Skeleton]"), "[Data Skeleton] marker missing");
  assert(result.text.includes("(Data Skeleton, LOG)"), "LOG section header missing");
  assert(result.text.includes("   1: 2026-10-29T10:00:00Z INFO line-1 "), "head line 1 missing");
  assert(result.text.includes("  20: 2026-10-29T10:00:00Z INFO line-20 "), "head line 20 missing");
  assert(result.text.includes("… (+260 lines omitted)"), "omission marker must say +260 lines");
  assert(result.text.includes(" 281: 2026-10-29T10:00:00Z INFO line-281 "), "tail start line 281 missing");
  assert(result.text.includes(" 300: 2026-10-29T10:00:00Z INFO line-300 "), "tail line 300 missing");
  assert(!result.text.includes("line-150"), "middle line 150 must be omitted");

  const header = DATA_SKELETON_HEADER.exec(result.text);
  assert(header !== null, "token header line missing");
  assert(Number(header![2]) < Number(header![1]), "folded tokens must be below raw tokens");
});

run("D4 explicit line-range and symbol targets never fold", () => {
  const root = workspace({ "data/config.json": configJson, "logs/app.log": bigLog });

  const rangeRead = executeSurgicalRead({
    rootDir: root,
    targets: ["logs/app.log:10-12"],
    includeCallers: false,
  });
  assert(!rangeRead.text.includes("[Data Skeleton]"), "line-range read must not fold");
  assert(rangeRead.text.includes("  10: 2026-10-29T10:00:00Z INFO line-10 "), "range read must show raw lines");

  const symbolRead = executeSurgicalRead({
    rootDir: root,
    targets: ["data/config.json#name"],
    includeCallers: false,
  });
  assert(!symbolRead.text.includes("[Data Skeleton]"), "symbol target must not fold");
  assert(symbolRead.text.includes("[SYMBOL NOT FOUND]"), "json symbol target has no symbols to slice");
});

run("D5 invalid JSON falls back to the raw whole-file view", () => {
  const broken = '{\n  "alpha": 1,\n  "beta": :broken\n';
  const root = workspace({ "data/broken.json": broken });
  const result = executeSurgicalRead({
    rootDir: root,
    targets: ["data/broken.json"],
    includeCallers: false,
  });

  assert(!result.text.includes("[Data Skeleton]"), "invalid JSON must not produce a data skeleton");
  assert(result.text.includes("AST Skeleton View"), "fallback must use the raw whole-file view");
  assert(result.text.includes('"alpha": 1'), "fallback must show the raw content");
});

run("D6 below-threshold data files and source files keep the raw/skeleton view", () => {
  const smallCsv = ["id,name", "1,ann", "2,bob"].join("\n");
  const shortLog = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n");
  const source = ['export function keep(value: string): string {', "  return value;", "}", ""].join("\n");
  const root = workspace({
    "data/small.csv": smallCsv,
    "logs/short.log": shortLog,
    "src/keep.ts": source,
  });
  const result = executeSurgicalRead({
    rootDir: root,
    targets: ["data/small.csv", "logs/short.log", "src/keep.ts"],
    includeCallers: false,
  });

  assert(!result.text.includes("[Data Skeleton]"), "below-threshold data files must not fold");
  assert(result.text.includes("data/small.csv"), "small csv must still be read");
  assert(result.text.includes("logs/short.log"), "short log must still be read");
  assert(result.text.includes("AST Skeleton View"), "source file must keep the AST skeleton view");
  assert(result.text.includes("export function keep("), "source file content missing");
});

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
