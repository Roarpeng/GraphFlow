/**
 * P5 — Chinese→English recall on REAL code, not synthetic phrasing.
 *
 * The fixture (`tests/fixtures/zh-real-corpus.json`) holds 160 (comment,
 * declaration) pairs lifted verbatim from five MIT-licensed repositories whose
 * code carries Chinese comments/docstrings next to English identifiers:
 *
 *   - akfamily/akshare            (Python docstrings)
 *   - mouday/domain-admin         (Python docstrings)
 *   - go-admin-team/go-admin      (Go line comments)
 *   - HalseySpicy/Geeker-Admin    (TS block comments)
 *   - vbenjs/vue-vben-admin       (TS block comments)
 *
 * Comments that name the symbol (or any camel token of it) are excluded at
 * extraction time, so the query never leaks the answer.
 *
 * The test rebuilds a workspace from those pairs (one file per original path, so
 * comment/identifier windows stay per-file) and asks: given the Chinese comment
 * a maintainer actually wrote, does GraphFlow rank the annotated symbol first?
 *
 * Known limit: only annotated declarations are materialised, so the candidate
 * pool is the 160 annotated symbols rather than a whole repository. This measures
 * the comment→identifier bridge, not ranking against thousands of siblings.
 *
 * What it caught (2026-10, all fixed in `src/`):
 *   - mined pairs were built from an 8-line forward window, so a comment "meant"
 *     the identifiers of the next declaration; now ±2/+3 lines with URLs masked;
 *   - corpus-wide filler ("pass", a package name, "数据", "中心") was mined as a
 *     translation; now dropped by document frequency;
 *   - ranking only read comments *above* a declaration, so every Python
 *     docstring-scored function had to win on body text alone;
 *   - mined tokens outvoted glossary hits. They are now weaker evidence and are
 *     only consulted when the glossary cannot read the query at all.
 * Before those fixes L1 lost 5 points of P@1 here (0.825 -> 0.775).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeSurgicalRead } from "../src/index.js";
import { resetZhRecallCache } from "../src/zh-recall.js";

interface Pair {
  repo: string;
  commit: string;
  license: string;
  lang: "go" | "py" | "ts";
  path: string;
  symbol: string;
  comment: string;
  style: "line" | "block" | "docstring";
  decl: string;
  variants: string[];
}

interface Fixture {
  repos: Array<{ name: string; commit: string; license: string; url: string }>;
  stats: { candidates: number; unique: number; sampled: number };
  pairs: Pair[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "zh-real-corpus.json"), "utf8")) as Fixture;

/** Rebuild the declaration with its real comment in the real position. */
function render(pair: Pair): string[] {
  const out: string[] = [];
  if (pair.style === "docstring") {
    out.push(pair.decl);
    out.push(`    """${pair.comment}"""`);
    out.push("    pass");
    out.push("");
    return out;
  }
  if (pair.style === "block") {
    out.push("/**");
    for (const chunk of pair.comment.match(/.{1,70}/g) ?? []) out.push(` * ${chunk}`);
    out.push(" */");
  } else {
    for (const chunk of pair.comment.match(/.{1,70}/g) ?? []) out.push(`// ${chunk}`);
  }
  const tail = pair.decl.trimEnd();
  if (tail.endsWith("{") || tail.endsWith(":") || tail.endsWith("else")) {
    out.push(tail);
  } else if (pair.lang === "ts") {
    out.push(`${tail} {`);
  } else {
    out.push(`${tail} {`);
  }
  out.push("}");
  out.push("");
  return out;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
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
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function buildWorkspace(root: string): void {
  const files = new Map<string, string[]>();
  for (const pair of fixture.pairs) {
    const rel = `${slug(pair.repo)}/${pair.path}`;
    const lines = files.get(rel) ?? [
      pair.lang === "py" ? "# extracted from the real repository\n" : "// extracted from the real repository\n",
    ];
    lines.push(...render(pair));
    files.set(rel, lines);
  }
  for (const [rel, lines] of files) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, lines.join("\n"), "utf8");
  }
  git(root, ["init"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "real zh corpus"]);
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

interface Score {
  n: number;
  p1: number;
  r3: number;
  mrr: number;
  misses: string[];
  byLang: Map<string, { n: number; p1: number }>;
}

function score(root: string, pick: (pair: Pair) => string | undefined, limitMisses = 6): Score {
  const rows: Array<{ pair: Pair; names: string[] }> = [];
  for (const pair of fixture.pairs) {
    const query = pick(pair);
    if (!query) continue;
    const names = executeSurgicalRead({ rootDir: root, query, topK: 5 }).matchedSymbols.map((s) => s.name);
    rows.push({ pair, names });
  }
  const n = rows.length || 1;
  let p1 = 0;
  let r3 = 0;
  let mrr = 0;
  const misses: string[] = [];
  const byLang = new Map<string, { n: number; p1: number }>();
  for (const row of rows) {
    const idx = row.names.indexOf(row.pair.symbol);
    const bucket = byLang.get(row.pair.lang) ?? { n: 0, p1: 0 };
    bucket.n += 1;
    if (idx === 0) {
      p1 += 1;
      bucket.p1 += 1;
    }
    if (idx >= 0 && idx < 3) r3 += 1;
    if (idx >= 0) mrr += 1 / (idx + 1);
    byLang.set(row.pair.lang, bucket);
    if (idx < 0 && misses.length < limitMisses) {
      misses.push(`${row.pair.lang} ${row.pair.comment.slice(0, 28)} -> ${row.names.slice(0, 3).join(",") || "(none)"} want ${row.pair.symbol}`);
    }
  }
  return { n: rows.length, p1: p1 / n, r3: r3 / n, mrr: mrr / n, misses, byLang };
}

function fmt(label: string, s: Score): string {
  return `${label} n=${s.n} P@1=${s.p1.toFixed(3)} R@3=${s.r3.toFixed(3)} MRR=${s.mrr.toFixed(3)}`;
}

const root = mkdtempSync(join(tmpdir(), "gf-zh-real-"));
try {
  assert.equal(fixture.pairs.length, 160, "fixture should hold 160 real pairs");
  const repos = new Set(fixture.pairs.map((p) => p.repo));
  assert.ok(repos.size >= 3, `expected >=3 real repos, got ${repos.size}`);
  for (const repo of fixture.repos) assert.equal(repo.license, "MIT", `${repo.name} must be MIT`);
  for (const pair of fixture.pairs) {
    assert.ok(/[\u4e00-\u9fff]/.test(pair.comment), `${pair.symbol} comment has no Chinese`);
    assert.ok(pair.commit.length === 40, `${pair.symbol} missing commit pin`);
    assert.equal(pair.comment.toLowerCase().includes(pair.symbol.toLowerCase()), false, `${pair.symbol} leaks into its own query`);
  }

  buildWorkspace(root);

  const verbatimOff = withEnv({ GRAPHFLOW_ZH_L1: "0", GRAPHFLOW_ZH_L2: "0" }, () => {
    resetZhRecallCache();
    return score(root, (p) => p.variants[0]);
  });
  const verbatimOn = withEnv({ GRAPHFLOW_ZH_L1: undefined, GRAPHFLOW_ZH_L2: undefined }, () => {
    resetZhRecallCache();
    return score(root, (p) => p.variants[0]);
  });
  const clauseOn = withEnv({ GRAPHFLOW_ZH_L1: undefined, GRAPHFLOW_ZH_L2: undefined }, () => {
    resetZhRecallCache();
    return score(root, (p) => p.variants[1]);
  });
  const clauseOff = withEnv({ GRAPHFLOW_ZH_L1: "0", GRAPHFLOW_ZH_L2: "0" }, () => {
    resetZhRecallCache();
    return score(root, (p) => p.variants[1]);
  });

  console.log(`[zh-real] ${fmt("verbatim  L1 off", verbatimOff)}`);
  console.log(`[zh-real] ${fmt("verbatim  L1 on ", verbatimOn)}`);
  console.log(`[zh-real] ${fmt("first-clause L1 off", clauseOff)}`);
  console.log(`[zh-real] ${fmt("first-clause L1 on ", clauseOn)}`);
  for (const [lang, bucket] of verbatimOn.byLang) {
    console.log(`[zh-real] lang=${lang} n=${bucket.n} P@1=${(bucket.p1 / bucket.n).toFixed(3)}`);
  }
  for (const line of verbatimOn.misses) console.log(`[zh-real] miss ${line}`);

  assert.ok(verbatimOn.p1 >= 0.75, `real-corpus verbatim P@1 too low: ${verbatimOn.p1}`);
  assert.ok(verbatimOn.r3 >= 0.85, `real-corpus verbatim R@3 too low: ${verbatimOn.r3}`);
  // The mined layer must be additive or neutral here. It used to *lose* 5 points on
  // this corpus by mining a comment's neighbouring identifiers as its translation.
  assert.ok(
    verbatimOn.p1 >= verbatimOff.p1 - 0.02,
    `L1 regressed real comments: ${verbatimOff.p1} -> ${verbatimOn.p1}`
  );
  assert.ok(
    clauseOn.p1 >= clauseOff.p1 - 0.02,
    `L1 regressed shortened queries: ${clauseOff.p1} -> ${clauseOn.p1}`
  );
  assert.ok(clauseOn.p1 >= 0.7, `first-clause P@1 too low: ${clauseOn.p1}`);

  console.log("PASS [zh-real] real-repository Chinese recall");
} finally {
  resetZhRecallCache();
  rmSync(root, { recursive: true, force: true });
}
