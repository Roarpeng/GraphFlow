/**
 * Real-corpus recall bench (iteration harness for `tests/zh-real-corpus.test.ts`).
 *
 *   npx tsx scripts/zh-recall-bench.ts --pairs 60 [--variant 0|1]
 *
 * Builds the workspace from `tests/fixtures/zh-real-corpus.json` once, scores the
 * same queries with L1/L2 off and on, and prints per-language P@1 plus the tokens
 * L1 added on every regression. Offline: the fixture is committed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tokenizeBilingualQuery } from "../src/tokenizer.js";
import { executeSurgicalRead } from "../src/slicer.js";
import { expandUncoveredChinese, getZhRecallBundle, resetZhRecallCache } from "../src/zh-recall.js";

interface Pair {
  repo: string;
  lang: string;
  path: string;
  symbol: string;
  comment: string;
  style: string;
  decl: string;
  variants: string[];
}

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const limit = Number(argOf("--pairs", "60"));
const variant = Number(argOf("--variant", "0"));
const fixturePath = join(import.meta.dirname, "..", "tests", "fixtures", "zh-real-corpus.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { pairs: Pair[] };
const pairs = fixture.pairs.slice(0, limit);

function render(pair: Pair): string[] {
  if (pair.style === "docstring") return [pair.decl, `    """${pair.comment}"""`, "    pass", ""];
  const out: string[] = [];
  if (pair.style === "block") {
    out.push("/**");
    for (const chunk of pair.comment.match(/.{1,70}/g) ?? []) out.push(` * ${chunk}`);
    out.push(" */");
  } else {
    for (const chunk of pair.comment.match(/.{1,70}/g) ?? []) out.push(`// ${chunk}`);
  }
  const tail = pair.decl.trimEnd();
  out.push(tail.endsWith("{") || tail.endsWith(":") ? tail : `${tail} {`);
  out.push("}");
  out.push("");
  return out;
}

function build(root: string): Array<{ relPath: string; content: string }> {
  const files = new Map<string, string[]>();
  for (const pair of pairs) {
    const rel = `${pair.repo.replace(/[^A-Za-z0-9.-]+/g, "_")}/${pair.path}`;
    const lines = files.get(rel) ?? [pair.lang === "py" ? "# extracted from the real repository\n" : "// extracted from the real repository\n"];
    lines.push(...render(pair));
    files.set(rel, lines);
  }
  const sources: Array<{ relPath: string; content: string }> = [];
  for (const [rel, lines] of files) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    const content = lines.join("\n");
    writeFileSync(full, content, "utf8");
    sources.push({ relPath: rel, content });
  }
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "corpus"], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gf",
      GIT_AUTHOR_EMAIL: "gf@example.com",
      GIT_COMMITTER_NAME: "gf",
      GIT_COMMITTER_EMAIL: "gf@example.com",
    },
  });
  return sources;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "gf-zh-bench-"));
const sources = build(root);

try {
  const rows: Array<{ pair: Pair; off: string[]; on: string[]; tokens: string[] }> = [];
  for (const pair of pairs) {
    const query = pair.variants[variant] ?? pair.comment;
    const off = withEnv({ GRAPHFLOW_ZH_L1: "0", GRAPHFLOW_ZH_L2: "0" }, () => {
      resetZhRecallCache();
      return executeSurgicalRead({ rootDir: root, query, topK: 5 }).matchedSymbols.map((s) => s.name);
    });
    const on = executeSurgicalRead({ rootDir: root, query, topK: 5 }).matchedSymbols.map((s) => s.name);
    resetZhRecallCache();
    const bundle = getZhRecallBundle(root, sources);
    const tokens = expandUncoveredChinese(tokenizeBilingualQuery(query), bundle);
    rows.push({ pair, off, on, tokens });
  }

  const byLang = new Map<string, { n: number; off: number; on: number }>();
  let offP1 = 0;
  let onP1 = 0;
  const regressions: string[] = [];
  const wins: string[] = [];
  for (const row of rows) {
    const offHit = row.off[0] === row.pair.symbol;
    const onHit = row.on[0] === row.pair.symbol;
    if (offHit) offP1 += 1;
    if (onHit) onP1 += 1;
    const bucket = byLang.get(row.pair.lang) ?? { n: 0, off: 0, on: 0 };
    bucket.n += 1;
    if (offHit) bucket.off += 1;
    if (onHit) bucket.on += 1;
    byLang.set(row.pair.lang, bucket);
    if (offHit && !onHit) {
      regressions.push(
        `${row.pair.comment.slice(0, 24)} | want ${row.pair.symbol} | got ${row.on.slice(0, 2).join(",")} | L1=[${row.tokens.join(",")}]`
      );
    }
    if (!offHit && onHit) wins.push(`${row.pair.comment.slice(0, 24)} | ${row.pair.symbol}`);
  }
  const n = rows.length || 1;
  console.log(`pairs=${rows.length} variant=${variant} P@1 off=${(offP1 / n).toFixed(3)} on=${(onP1 / n).toFixed(3)}`);
  for (const [lang, bucket] of byLang) {
    console.log(`  ${lang}: n=${bucket.n} off=${(bucket.off / bucket.n).toFixed(3)} on=${(bucket.on / bucket.n).toFixed(3)}`);
  }
  console.log(`regressions=${regressions.length} wins=${wins.length}`);
  for (const line of regressions.slice(0, 12)) console.log(`  REG ${line}`);
  for (const line of wins.slice(0, 6)) console.log(`  WIN ${line}`);
  resetZhRecallCache();
  const bundle = getZhRecallBundle(root, sources);
  console.log(`l1 keys=${bundle.l1.size} l2 keys=${bundle.l2.size} windows=${bundle.windows}`);
  for (const row of rows.filter((r) => r.off[0] !== r.pair.symbol).slice(0, 8)) {
    console.log(
      `  MISS ${row.pair.symbol} <- ${row.pair.comment.slice(0, 20)} | top5=${row.on.join(",")} | L1=[${row.tokens.join(",")}]`
    );
  }
} finally {
  resetZhRecallCache();
  if (!process.argv.includes("--keep")) rmSync(root, { recursive: true, force: true });
  else console.log(`workspace kept at ${root}`);
}
