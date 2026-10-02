#!/usr/bin/env node
// Reproducible generator for the Golden-Extended (200 tasks) and Long-Horizon
// (20 sessions) benchmark datasets (2.x plan §18). Every task is derived from
// the real tree at BASE (exports, imports, test files, package.json) or from
// real fix commits; nothing is invented except the deliberate-failure probes,
// whose absence is itself checked.
//
// Usage (repo root or package dir):
//   node packages/efficiency-agent/scripts/gen-extended.mjs              write both jsonl files
//   node packages/efficiency-agent/scripts/gen-extended.mjs --check      exit 1 if the committed files differ
//   node packages/efficiency-agent/scripts/gen-extended.mjs --candidates print calibration candidates
//   node packages/efficiency-agent/scripts/gen-extended.mjs --calibrate [--jobs N]
//        run the candidate validation commands in scratch worktrees (slow, tens of minutes) and
//        write benchmarks/calibration/extended-calibration-v1.json
//
// Output is a pure function of (git objects reachable from BASE, the committed
// calibration file): no clock, no randomness, stable ordering.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");
const BENCH_DIR = join(packageDir, "benchmarks");
const EXTENDED_FILE = join(BENCH_DIR, "golden-extended-v1.jsonl");
const LONG_HORIZON_FILE = join(BENCH_DIR, "long-horizon-v1.jsonl");
const CALIBRATION_FILE = join(BENCH_DIR, "calibration", "extended-calibration-v1.json");

export const BASE = "e5f05b17d47cf03fa5fcceef9dae6500684083a7";
const TSC = "npx tsc --noEmit -p tsconfig.json";
const GOLDEN_CORE_COMMITS = new Set([
  "17fa91c", "fd86770", "a130de3", "14b591c", "43c24b5", "bbff25f", "2b38bcb", "81f06d2",
  "cc2cf58", "3b21379", "42c5ba7", "49f9bfe", "532f359", "72a6c63", "b7451c4", "94e4523",
]);
const REFUSAL_SIGNALS = [
  "does not exist", "doesn't exist", "not exist", "no such", "not found", "there is no",
  "isn't defined", "not defined", "not referenced", "no reference", "no script", "missing script", "不存在",
];
// Never words the task texts use ("passes", "green"), so echoing the prompt cannot satisfy the check.
const PASS_SIGNALS = ["passed", "passing", "通过"];
const echoes = (text, needles) => needles.some((n) => text.toLowerCase().includes(n.toLowerCase()));

// ------------------------------------------------------------------ git access

function git(args, opts = {}) {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true, ...opts });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

/** Read many `rev:path` blobs in one `git cat-file --batch`; missing objects map to undefined. */
export function readBlobs(specs) {
  const out = new Map();
  if (specs.length === 0) return out;
  const res = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: specs.join("\n") + "\n",
    maxBuffer: 1 << 30,
    windowsHide: true,
  });
  const buf = res.stdout;
  let pos = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      out.set(spec, undefined);
      continue;
    }
    const size = Number(header.split(" ")[2]);
    out.set(spec, buf.subarray(pos, pos + size).toString("utf8").replace(/\r\n/g, "\n"));
    pos += size + 1;
  }
  return out;
}

// ------------------------------------------------------------------ helpers

const sha = (s) => createHash("sha256").update(s).digest("hex");
const stableSort = (items, key) => [...items].sort((a, b) => (sha(key(a)) < sha(key(b)) ? -1 : 1));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_$]+/g, "-").toLowerCase();
const stemOf = (p) => posix.basename(p).replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
const topDir = (p) => p.split("/")[1];
const pad = (n) => String(n).padStart(3, "0");

function resolveImport(fromFile, spec, files) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const cands = [base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`, base];
  return cands.find((c) => files.has(c));
}

// ------------------------------------------------------------------ repo model at BASE

function loadRepo() {
  const all = git(["ls-tree", "-r", "--name-only", BASE]).trim().split("\n");
  const files = new Set(all);
  const codeFiles = all.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f));
  const blobs = readBlobs([...codeFiles, "package.json"].map((f) => `${BASE}:${f}`));
  const content = new Map([...codeFiles, "package.json"].map((f) => [f, blobs.get(`${BASE}:${f}`) ?? ""]));
  const src = codeFiles.filter((f) => f.startsWith("src/") && f.endsWith(".ts")).sort();
  const tests = all.filter((f) => /^tests\/[^/]+\.test\.ts$/.test(f)).sort();

  const tokenFiles = new Map();
  for (const f of codeFiles) {
    for (const tok of new Set(content.get(f).match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      if (!tokenFiles.has(tok)) tokenFiles.set(tok, new Set());
      tokenFiles.get(tok).add(f);
    }
  }

  const defs = new Map();
  const exported = [];
  const local = [];
  const imports = new Map();
  for (const f of src) {
    const text = content.get(f);
    const lines = text.split("\n");
    for (const m of text.matchAll(/\b(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      defs.set(m[1], (defs.get(m[1]) ?? 0) + 1);
    }
    lines.forEach((line, i) => {
      const ex = /^export\s+(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/.exec(line);
      const lo = /^(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/.exec(line);
      const m = ex ?? lo;
      if (!m) return;
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === "") prev -= 1;
      const prevLine = prev >= 0 ? lines[prev].trim() : "";
      let end = i + 1;
      while (end < lines.length && !/^}/.test(lines[end])) end += 1;
      const fn = { file: f, name: m[2], line: i + 1, length: end - i + 1, documented: prevLine.endsWith("*/") || prevLine.startsWith("//") || prevLine.startsWith("@") };
      (ex ? exported : local).push(fn);
    });
    const specs = [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm)].map((m) => m[1]);
    imports.set(f, [...new Set(specs.map((s) => resolveImport(f, s, files)).filter(Boolean))]);
  }
  return { all, files, content, src, tests, tokenFiles, defs, exported, local, imports };
}

function importersOf(repo, target, symbol) {
  const out = [];
  for (const [f, deps] of repo.imports) {
    if (f !== target && deps.includes(target) && new RegExp(`\\b${escapeRe(symbol)}\\b`).test(repo.content.get(f))) out.push(f);
  }
  return out.sort();
}

const isPureModule = (text) => !/node:fs|["']fs["']|child_process|node:net|node:http|better-sqlite3|\bfetch\(|process\.env/.test(text);
const uniqueDef = (repo, name) => repo.defs.get(name) === 1;
const outsideSrcRefs = (repo, name) => [...(repo.tokenFiles.get(name) ?? [])].filter((f) => !f.startsWith("src/"));

// ------------------------------------------------------------------ git-history candidates

function fixCommitCandidates() {
  const log = git(["log", "--format=%H%x09%P%x09%s", BASE]).trim().split("\n");
  const out = [];
  for (const line of log) {
    const [hash, parents, subject] = line.split("\t");
    if (!/^fix/i.test(subject) || parents.split(" ").length !== 1) continue;
    const short = hash.slice(0, 7);
    if (GOLDEN_CORE_COMMITS.has(short)) continue;
    const changed = git(["diff-tree", "--no-commit-id", "--name-status", "-r", hash]).trim().split("\n").map((l) => l.split("\t"));
    const testsChanged = changed.filter(([st, f]) => /^[AM]$/.test(st) && /^tests\/[^/]+\.test\.ts$/.test(f)).map((x) => x[1]).sort();
    const srcChanged = changed.filter(([st, f]) => /^[AMD]/.test(st) && /^src\/.+\.ts$/.test(f)).map((x) => x[1]).sort();
    if (testsChanged.length === 0 || srcChanged.length === 0) continue;
    const dirs = [...new Set(srcChanged.map(topDir))].filter((d) => !d.endsWith(".ts"));
    const regular = dirs.length === 1 && srcChanged.length <= 3 && testsChanged.length <= 3 && changed.length <= 8;
    const complex = dirs.length >= 2 && srcChanged.length <= 10 && testsChanged.length <= 4 && changed.length <= 16;
    if (!regular && !complex) continue;
    out.push({ commit: hash, parent: parents, subject, tests: testsChanged, src: srcChanged, dirs, kind: regular ? "regular" : "complex" });
  }
  return out;
}

function baseTestCandidates(repo) {
  const small = repo.tests.filter((t) => {
    const text = repo.content.get(t);
    return text.length < 7000 && !/spawn|execFile|execSync|fetch\(|setTimeout\(|listen\(/.test(text);
  });
  return stableSort(small, (t) => `base-test:${t}`).slice(0, 30).sort();
}

// ------------------------------------------------------------------ calibration (slow, optional)

function makeWorktree(dir, rev) {
  if (existsSync(dir)) removeWorktree(dir);
  git(["worktree", "add", "--detach", dir, rev]);
  symlinkSync(join(git(["rev-parse", "--show-toplevel"]).trim(), "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

function removeWorktree(dir) {
  try {
    if (lstatSync(join(dir, "node_modules")).isSymbolicLink()) unlinkSync(join(dir, "node_modules"));
  } catch {
    // no link
  }
  try {
    git(["worktree", "remove", "--force", dir]);
  } catch {
    if (!existsSync(join(dir, "node_modules"))) rmSync(dir, { recursive: true, force: true });
    git(["worktree", "prune"]);
  }
}

function runIn(dir, command, timeoutMs = 5 * 60_000) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(command, { cwd: dir, shell: true, windowsHide: true, env: { ...process.env, GRAPHFLOW_SKIP_EMBEDDING_WARMUP: "1", FORCE_COLOR: "0" } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exitCode: code, ms: Date.now() - started, tail: out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => /Test Files|Tests |error TS|Error:/.test(l)).slice(-4).join(" | ") });
    });
  });
}

async function calibrate(jobs) {
  const repo = loadRepo();
  const commits = fixCommitCandidates();
  const baseTests = baseTestCandidates(repo);
  const work = [
    ...baseTests.map((t) => ({ kind: "base-test", id: t, steps: [{ rev: BASE, overlay: null, command: `npx vitest run ${t}`, expect: 0 }] })),
    ...commits.map((c) => ({
      kind: "fix-commit",
      id: c.commit,
      steps: [
        { rev: c.commit, overlay: null, command: `npx vitest run ${c.tests.join(" ")}`, expect: 0 },
        { rev: c.parent, overlay: { commit: c.commit, paths: c.tests }, command: `npx vitest run ${c.tests.join(" ")}`, expect: 1 },
      ],
    })),
  ];
  const parent = join(tmpdir(), "eff-calibration");
  mkdirSync(parent, { recursive: true });
  const results = new Map();
  let next = 0;
  async function worker(n) {
    const dir = join(parent, `wt-${n}`);
    makeWorktree(dir, BASE);
    try {
      while (next < work.length) {
        const item = work[next++];
        const steps = [];
        for (const step of item.steps) {
          git(["-C", dir, "checkout", "-f", "--detach", step.rev]);
          git(["-C", dir, "clean", "-fdq"]);
          if (step.overlay) git(["-C", dir, "checkout", step.overlay.commit, "--", ...step.overlay.paths]);
          const r = await runIn(dir, step.command);
          steps.push({ rev: step.rev, overlay: Boolean(step.overlay), command: step.command, exitCode: r.exitCode, ms: r.ms, tail: r.tail });
        }
        results.set(item.id, { kind: item.kind, steps });
        process.stderr.write(`[calibrate ${results.size}/${work.length}] ${item.kind} ${item.id} -> ${steps.map((s) => s.exitCode).join(",")}\n`);
      }
    } finally {
      removeWorktree(dir);
    }
  }
  await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i)));
  const baseTestResults = {};
  for (const t of baseTests) baseTestResults[t] = { passedAtBase: results.get(t)?.steps[0].exitCode === 0, ms: results.get(t)?.steps[0].ms };
  const fixResults = {};
  for (const c of commits) {
    const r = results.get(c.commit);
    fixResults[c.commit.slice(0, 7)] = {
      commit: c.commit,
      parent: c.parent,
      subject: c.subject,
      kind: c.kind,
      src: c.src,
      tests: c.tests,
      passAtFix: r?.steps[0].exitCode === 0,
      failAtBaseWithOverlay: r ? r.steps[1].exitCode !== 0 : false,
      fixTail: r?.steps[0].tail ?? "",
      baseTail: r?.steps[1].tail ?? "",
    };
  }
  const calibration = {
    schema: "eff-agent-extended-calibration/v1",
    base: BASE,
    calibratedAt: new Date().toISOString(),
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, note: "tests ran with the repository's current node_modules linked into each worktree, not the historical lockfile" },
    tscAtBase: (await (async () => {
      const dir = join(parent, "wt-tsc");
      makeWorktree(dir, BASE);
      try {
        const r = await runIn(dir, TSC);
        return { passed: r.exitCode === 0, ms: r.ms };
      } finally {
        removeWorktree(dir);
      }
    })()),
    baseTests: baseTestResults,
    fixCommits: fixResults,
  };
  mkdirSync(dirname(CALIBRATION_FILE), { recursive: true });
  writeFileSync(CALIBRATION_FILE, `${JSON.stringify(calibration, null, 2)}\n`);
  process.stderr.write(`calibration written: ${CALIBRATION_FILE}\n`);
}

// ------------------------------------------------------------------ dataset construction

function take(pool, n, used, key = (x) => `${x.file}#${x.name}`) {
  const out = [];
  for (const item of pool) {
    if (out.length === n) break;
    const k = key(item);
    if (used.has(k)) continue;
    used.add(k);
    out.push(item);
  }
  if (out.length < n) throw new Error(`pool exhausted: needed ${n}, got ${out.length}`);
  return out;
}

/** Round-robin over top-level src dirs so a pool is not dominated by one module. */
function spread(items, seed) {
  const byDir = new Map();
  for (const it of stableSort(items, (x) => `${seed}:${x.file}#${x.name ?? ""}`)) {
    const d = topDir(it.file);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(it);
  }
  const dirs = [...byDir.keys()].sort();
  const out = [];
  for (let i = 0; out.length < items.length; i += 1) {
    for (const d of dirs) if (byDir.get(d)[i]) out.push(byDir.get(d)[i]);
  }
  return out;
}

const jsdocPattern = (name) => `/\\*\\*(?:[^*]|\\*(?!/))*\\*/\\s*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(name)}\\b`;
const noJsdocPattern = (name) => `^(?![\\s\\S]*\\*/\\s*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(name)}\\b)[\\s\\S]*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(name)}\\b`;
const twoCasesPattern = "(?:\\b(?:it|test)\\s*\\([\\s\\S]*?){2}";

function build(repo, calibration) {
  const used = new Set();
  const extended = [];
  const add = (task) => extended.push({ dataset: "golden-extended-v1", baseCommit: BASE, ...task });
  const passingBaseTests = Object.entries(calibration.baseTests).filter(([, r]) => r.passedAtBase).map(([t]) => t).sort();
  if (!calibration.tscAtBase?.passed) throw new Error("calibration says tsc does not pass at BASE; tsc-judged tasks would be dishonest");

  const exportedUnique = repo.exported.filter((f) => !f.file.endsWith("/index.ts") && uniqueDef(repo, f.name) && f.name.length >= 10);
  const queryPool = spread(exportedUnique, "query");
  const docPool = spread(exportedUnique.filter((f) => !f.documented && f.length >= 4), "jsdoc");
  const testPool = spread(exportedUnique.filter((f) => isPureModule(repo.content.get(f.file)) && f.length >= 3), "unit-test");
  const localPool = spread(repo.local.filter((f) => f.name.length >= 8 && !f.file.endsWith("/index.ts") && uniqueDef(repo, f.name) && !new RegExp(`export\\s*\\{[^}]*\\b${escapeRe(f.name)}\\b`).test(repo.content.get(f.file))), "export-local");
  const renamable = (f) => {
    const imp = importersOf(repo, f.file, f.name);
    const refFiles = [...(repo.tokenFiles.get(f.name) ?? [])].filter((x) => x.startsWith("src/") && x !== f.file);
    return imp.length >= 1 && imp.length <= 3 && refFiles.length === imp.length && outsideSrcRefs(repo, f.name).length === 0 && !repo.tokenFiles.has(`${f.name}Impl`) ? imp : null;
  };
  const renamePool = spread(exportedUnique.filter((f) => renamable(f)), "rename");
  const movePool = spread(
    exportedUnique.filter((f) => f.length >= 15 && f.length <= 80 && repo.exported.filter((e) => e.file === f.file).length >= 3 && !repo.files.has(`${posix.dirname(f.file)}/${stemOf(f.file)}-${kebab(f.name)}.ts`)),
    "move"
  );

  // ---------------- repetition: 10 definition families + 5 test-run families (x4 paraphrases)
  let fam = 0;
  let rep = 0;
  const defTemplates = [
    (s) => `Where is the function \`${s}\` defined in this repository?`,
    (s) => `Which source file implements \`${s}\`?`,
    (s) => `Point me to the file that contains the definition of \`${s}\`.`,
    (s) => `In which module does the \`${s}\` function live? Give the file path.`,
  ];
  for (const fn of take(queryPool, 10, used)) {
    fam += 1;
    const family = `fam-def-${kebab(fn.name)}`;
    defTemplates.forEach((tpl, i) => {
      rep += 1;
      add({
        id: `ext-rep-${pad(rep)}`,
        cohort: "repetition",
        category: "query",
        source: `repo-structure:${fn.file}`,
        family,
        variant: i + 1,
        text: tpl(fn.name),
        oracle: { outputAnyOf: [fn.file, posix.basename(fn.file)] },
        refs: [{ path: fn.file, symbol: fn.name }],
      });
    });
  }
  const runTemplates = [
    (t) => `Run the vitest file ${t} and report whether it passes.`,
    (t) => `Do the tests in ${t} pass right now? Run them and tell me.`,
    (t) => `Execute ${t} with vitest and summarise the result (pass or fail).`,
    (t) => `Check whether ${t} is green by running it.`,
  ];
  const runFamilies = stableSort(passingBaseTests, (t) => `run-family:${t}`).slice(0, 5);
  for (const t of runFamilies) {
    used.add(`test:${t}`);
    fam += 1;
    const family = `fam-run-${stemOf(t).replace(/\.test$/, "")}`;
    runTemplates.forEach((tpl, i) => {
      rep += 1;
      add({
        id: `ext-rep-${pad(rep)}`,
        cohort: "repetition",
        category: "test",
        source: `calibration:base-test:${t}`,
        family,
        variant: i + 1,
        text: tpl(t),
        notes: "state-preserving: the command passes at baseCommit (calibrated); the output check judges the report",
        oracle: { commands: [`npx vitest run ${t}`], outputAnyOf: PASS_SIGNALS },
        refs: [{ path: t }],
      });
    });
  }

  // ---------------- regular (80)
  let reg = 0;
  const regular = (task) => add({ id: `ext-reg-${pad(++reg)}`, cohort: "regular", ...task });
  const fixes = Object.values(calibration.fixCommits).filter((c) => c.passAtFix && c.failAtBaseWithOverlay);
  const fixMeta = new Map(fixes.map((c) => [c.commit, c]));
  const cleanSubject = (s) => s.replace(/^fix(\([^)]*\))?!?:\s*/i, "").replace(/^v\d+\.\d+\.\d+\s*[—-]\s*/, "").replace(/\s*\(v?\d+\.\d+\.\d+\)\s*$/, "");
  const gitTask = (c, cohort) => {
    const meta = fixMeta.get(c.commit);
    const scope = /^fix\(([^)]*)\)/i.exec(meta.subject)?.[1];
    return {
      category: cohort === "complex" ? "cross-module" : meta.src.length === 1 ? "bugfix" : "multi-file",
      source: `git-history:${c.commit.slice(0, 7)}`,
      baseCommit: c.parent,
      text: `Fix this defect${scope ? ` in ${scope}` : ""}: ${cleanSubject(meta.subject)}`,
      notes: "hidden tests calibrated: pass at the fix commit, fail at baseCommit with the overlay",
      oracle: { overlayFrom: { commit: c.commit.slice(0, 7), paths: c.tests }, commands: [`npx vitest run ${c.tests.join(" ")}`] },
      refs: meta.src.map((p) => ({ path: p })),
      _kind: meta.kind,
      _commit: c.commit,
    };
  };
  const regularFixes = stableSort(fixes.map((c) => gitTask(c, "regular")).filter((t) => t._kind === "regular"), (t) => t._commit).slice(0, 20);
  const complexFixes = stableSort(fixes.map((c) => gitTask(c, "complex")).filter((t) => t._kind === "complex"), (t) => t._commit).slice(0, 15);
  const strip = ({ _kind, _commit, ...t }) => t;
  // refs for git tasks must exist at the parent commit (deleted/added files are dropped by the validator check below)
  const parentFiles = new Map();
  const existsAt = (rev, path) => {
    if (!parentFiles.has(rev)) parentFiles.set(rev, new Set(git(["ls-tree", "-r", "--name-only", rev]).trim().split("\n")));
    return parentFiles.get(rev).has(path);
  };
  for (const t of [...regularFixes, ...complexFixes]) t.refs = t.refs.filter((r) => existsAt(t.baseCommit, r.path));

  for (const t of regularFixes) regular(strip(t));

  for (const fn of take(docPool, 15 + (20 - regularFixes.length), used)) {
    regular({
      category: "docs",
      source: `repo-structure:${fn.file}`,
      text: `Add a JSDoc block comment directly above the exported function \`${fn.name}\` in ${fn.file} describing its parameters and return value. Do not change its behaviour.`,
      oracle: { files: [{ path: fn.file, pattern: jsdocPattern(fn.name) }] },
      guards: [TSC],
      refs: [{ path: fn.file, symbol: fn.name }],
    });
  }
  for (const fn of take(testPool, 15, used)) {
    const testPath = `tests/ext-${topDir(fn.file)}-${kebab(fn.name)}.test.ts`;
    regular({
      category: "test",
      source: `repo-structure:${fn.file}`,
      text: `Create ${testPath} with at least two vitest cases that exercise \`${fn.name}\` from ${fn.file}.`,
      oracle: {
        files: [
          { path: testPath, pattern: `\\b${escapeRe(fn.name)}\\b` },
          { path: testPath, pattern: twoCasesPattern },
        ],
        commands: [`npx vitest run ${testPath}`],
      },
      refs: [{ path: fn.file, symbol: fn.name }],
      absentRefs: [{ path: testPath }],
    });
  }
  for (const fn of take(renamePool, 10, used)) {
    const importers = renamable(fn);
    regular({
      category: "refactor",
      source: `repo-structure:${fn.file}`,
      text: `Rename the exported function \`${fn.name}\` in ${fn.file} to \`${fn.name}Impl\` and update every import and call site so the project still type-checks.`,
      oracle: {
        files: [
          { path: fn.file, pattern: `^(?![\\s\\S]*\\bfunction\\s*\\*?\\s*${escapeRe(fn.name)}\\s*[<(])[\\s\\S]*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(fn.name)}Impl\\b` },
          ...importers.map((p) => ({ path: p, pattern: `\\b${escapeRe(fn.name)}Impl\\b` })),
        ],
        commands: [TSC],
      },
      refs: [{ path: fn.file, symbol: fn.name }, ...importers.map((p) => ({ path: p, symbol: fn.name }))],
      absentRefs: [{ text: `${fn.name}Impl` }],
    });
  }
  const scriptGroups = [];
  const configTests = stableSort(passingBaseTests.filter((t) => !used.has(`test:${t}`)), (t) => `config:${t}`);
  for (let i = 0; i + 1 < configTests.length && scriptGroups.length < 13; i += 2) scriptGroups.push([configTests[i], configTests[i + 1]]);
  const configGroups = scriptGroups.slice(0, 8);
  configGroups.forEach((group, i) => {
    group.forEach((t) => used.add(`test:${t}`));
    const name = `test:ext-${i + 1}`;
    regular({
      category: "config",
      source: `calibration:base-test:${group.join(",")}`,
      text: `Add a root package.json npm script named "${name}" that runs vitest on ${group.join(" and ")} only.`,
      oracle: {
        files: [{ path: "package.json", pattern: `"${escapeRe(name)}"\\s*:\\s*"[^"]*vitest run[^"]*${escapeRe(group[0])}[^"]*${escapeRe(group[1])}[^"]*"` }],
        commands: [`npm run ${name}`],
      },
      refs: group.map((t) => ({ path: t })).concat([{ path: "package.json" }]),
      absentRefs: [{ path: "package.json", text: `"${name}"` }],
    });
  });
  for (const fn of take(localPool, 12, used)) {
    regular({
      category: "single-file",
      source: `repo-structure:${fn.file}`,
      text: `Export the module-private function \`${fn.name}\` from ${fn.file} (named export, no behaviour change) so other modules can reuse it.`,
      oracle: { files: [{ path: fn.file, pattern: `export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(fn.name)}\\b` }] },
      guards: [TSC],
      refs: [{ path: fn.file, symbol: fn.name }],
    });
  }

  // ---------------- complex (45)
  let cx = 0;
  const complex = (task) => add({ id: `ext-cx-${pad(++cx)}`, cohort: "complex", ...task });
  const forward = stableSort(
    repo.src.filter((f) => !f.endsWith("/index.ts")).map((f) => ({ file: f, deps: repo.imports.get(f).filter((d) => topDir(d) !== topDir(f) && !/\/(index|types)\.ts$/.test(d)) })).filter((x) => x.deps.length >= 2 && x.deps.length <= 4 && new Set(x.deps.map(topDir)).size >= 2),
    (x) => `forward:${x.file}`
  );
  const forwardText = (x) => `Which files outside src/${topDir(x.file)}/ does ${x.file} import directly? List each one and say what it is used for.`;
  let forwardCount = 0;
  for (const x of forward) {
    if (forwardCount === 8) break;
    if (used.has(`fwd:${x.file}`) || echoes(forwardText(x), x.deps.map((d) => posix.basename(d)))) continue;
    used.add(`fwd:${x.file}`);
    forwardCount += 1;
    complex({
      category: "cross-module",
      source: `import-graph:${x.file}`,
      text: forwardText(x),
      oracle: { outputAllOf: x.deps.map((d) => posix.basename(d)) },
      refs: [{ path: x.file }, ...x.deps.map((d) => ({ path: d }))],
    });
  }
  const reverseText = (f) => `Which files outside src/${topDir(f.file)}/ import \`${f.name}\` from ${f.file}? List every caller and how it uses the function.`;
  const reverse = stableSort(
    exportedUnique
      .map((f) => ({ ...f, users: importersOf(repo, f.file, f.name).filter((u) => topDir(u) !== topDir(f.file) && !u.endsWith("/index.ts")) }))
      .filter((f) => f.users.length >= 2 && f.users.length <= 4 && new Set(f.users.map(topDir)).size >= 2 && !echoes(reverseText(f), f.users.map((u) => posix.basename(u)))),
    (f) => `reverse:${f.file}#${f.name}`
  );
  for (const f of take(reverse, 7, used)) {
    complex({
      category: "cross-module",
      source: `import-graph:${f.file}#${f.name}`,
      text: reverseText(f),
      oracle: { outputAllOf: f.users.map((u) => posix.basename(u)) },
      refs: [{ path: f.file, symbol: f.name }, ...f.users.map((u) => ({ path: u, symbol: f.name }))],
    });
  }
  for (const t of complexFixes) complex(strip(t));
  for (const fn of take(movePool, 10 + (15 - complexFixes.length), used)) {
    const target = `${posix.dirname(fn.file)}/${stemOf(fn.file)}-${kebab(fn.name)}.ts`;
    const spec = `./${stemOf(target)}`;
    complex({
      category: "refactor",
      source: `repo-structure:${fn.file}`,
      text: `Move the exported function \`${fn.name}\` (and any private helpers only it uses) out of ${fn.file} into a new module ${target}, and re-export it from ${fn.file} so every existing import keeps working.`,
      oracle: {
        files: [
          { path: target, pattern: `export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(fn.name)}\\b` },
          { path: fn.file, pattern: `^(?![\\s\\S]*\\bfunction\\s*\\*?\\s*${escapeRe(fn.name)}\\s*[<(])[\\s\\S]*export\\s*\\{[^}]*\\b${escapeRe(fn.name)}\\b[^}]*\\}\\s*from\\s*["']${escapeRe(spec)}(?:\\.js)?["']` },
        ],
        commands: [TSC],
      },
      refs: [{ path: fn.file, symbol: fn.name }],
      absentRefs: [{ path: target }],
    });
  }
  const designGuardTests = stableSort(passingBaseTests, (t) => `design:${t}`).slice(0, 5);
  const designs = [
    { text: "Design and implement a single typed error hierarchy for graph-store transport failures (sqlite, json, auto) and use it from the store factory and the MCP diagnose surface", refs: ["src/graph", "src/surfaces/mcp"] },
    { text: "Design a pluggable provider-health cache shared by model routing and the CLI doctor command, with explicit TTL and invalidation on config change", refs: ["src/routing/model-router.ts", "src/surfaces/cli"] },
    { text: "Introduce a workspace-scoped audit trail that records every context preview and plan request, wired through config, core and the MCP surface, with a retention policy", refs: ["src/audit", "src/config", "src/surfaces/mcp"] },
    { text: "Unify the skill-learning and episode-reconciliation persistence behind one repository interface so learning and skills stop reading each other's files directly", refs: ["src/learning", "src/skills"] },
    { text: "Design cross-platform path normalisation for every place that compares workspace roots (config, integrations, hooks) and remove the ad-hoc per-module variants", refs: ["src/config", "src/integrations", "src/hooks"] },
  ];
  designs.forEach((d, i) => {
    complex({
      category: "cross-module",
      source: "authored",
      text: d.text,
      notes: "design task: success is not auto-judged (unjudged); guards measure regressions",
      guards: [TSC, `npx vitest run ${designGuardTests[i]}`],
      refs: [...d.refs.map((p) => ({ path: p })), { path: designGuardTests[i] }],
    });
  });

  // ---------------- deliberate failure (15)
  let fl = 0;
  const failure = (task) => add({ id: `ext-fail-${pad(++fl)}`, cohort: "failure", category: "deliberate-failure", source: "authored", oracle: { refusal: { signals: REFUSAL_SIGNALS, noChanges: true } }, ...task });
  for (const p of ["src/graph/hnsw-index.ts", "src/routing/load-balancer.ts", "src/core/scheduler/cron.ts", "src/learning/reinforcement-trainer.ts", "src/surfaces/grpc/server.ts"]) {
    failure({ text: `Fix the intermittent crash in ${p}; it throws on startup.`, notes: `${p} does not exist at baseCommit`, absentRefs: [{ path: p }] });
  }
  const realFiles = stableSort(repo.src.filter((f) => !f.endsWith("/index.ts") && repo.content.get(f).length > 2000), (f) => `fail-file:${f}`).slice(0, 4);
  ["computeQuantumAffinity", "rebalanceShardWeights", "flushTelemetryRingBuffer", "deriveOracleConsensus"].forEach((sym, i) => {
    failure({
      text: `What does the exported function \`${sym}\` in ${realFiles[i]} return, and who calls it?`,
      notes: `${realFiles[i]} exists but ${sym} is referenced nowhere in the repository`,
      refs: [{ path: realFiles[i] }],
      absentRefs: [{ text: sym }],
    });
  });
  for (const env of ["GRAPHFLOW_TURBO_MODE", "GRAPHFLOW_MAX_GPU_SHARDS", "GRAPHFLOW_LEGACY_VECTOR_DB"]) {
    failure({ text: `What is the default value of the ${env} environment variable, and where is it read?`, notes: `${env} is referenced nowhere in the repository`, absentRefs: [{ text: env }] });
  }
  for (const script of ["bench:gpu", "test:e2e-cloud", "release:canary"]) {
    failure({
      text: `The npm script "${script}" fails on CI — fix it.`,
      notes: `package.json has no "${script}" script at baseCommit`,
      refs: [{ path: "package.json" }],
      absentRefs: [{ path: "package.json", text: `"${script}"` }],
    });
  }

  // ---------------- long-horizon sessions (20)
  const sessions = [];
  const lhTests = stableSort(passingBaseTests.filter((t) => !runFamilies.includes(t)), (t) => `lh:${t}`);
  const docPairs = pairsInSameFile(docPool, used, 5);
  const testFns = take(testPool, 5, used);
  const renamePairs = pairsInSameFile(renamePool.filter((f) => !echoes(`${f.file} ${f.name}Impl`, renamable(f).map((p) => posix.basename(p)))), used, 5);
  let lh = 0;
  const session = (template, title, refs, steps) => {
    lh += 1;
    const id = `lh-${pad(lh)}`;
    sessions.push({
      id,
      dataset: "long-horizon-v1",
      template,
      title,
      baseCommit: BASE,
      refs,
      steps: steps.map((s, i) => ({
        id: `${id}-s${i + 1}`,
        step: i + 1,
        ...s,
        dependsOn: (s.dependsOn ?? []).map((n) => `${id}-s${n}`),
        ...(s.equivalentTo ? { equivalentTo: `${id}-s${s.equivalentTo}` } : {}),
      })),
    });
  };
  const exp = (reuse, stateChange, memory) => ({ reuse, memory: memory ? "required" : "none", stateChange });

  for (const [a, b] of docPairs) {
    const where = { outputAnyOf: [a.file, posix.basename(a.file)] };
    session("doc-pattern", `Document ${a.name}, propagate the pattern to ${b.name}, then revert the first change`, [{ path: a.file, symbol: a.name }, { path: b.file, symbol: b.name }], [
      { session: 1, category: "query", text: `Where is \`${a.name}\` defined, and what does it return?`, oracle: where, expect: exp("fresh", false, false) },
      { session: 2, category: "query", text: `Remind me which file defines \`${a.name}\`.`, equivalentTo: 1, oracle: where, expect: exp("reuse-allowed", false, false) },
      { session: 2, category: "docs", text: `Add a JSDoc block comment directly above \`${a.name}\` in ${a.file} describing its parameters and return value.`, oracle: { files: [{ path: a.file, pattern: jsdocPattern(a.name) }] }, guards: [TSC], expect: exp("fresh", true, false) },
      { session: 3, category: "docs", text: `Apply the same documentation pattern you used for \`${a.name}\` earlier to \`${b.name}\` in the same file.`, dependsOn: [3], oracle: { files: [{ path: b.file, pattern: jsdocPattern(b.name) }, { path: a.file, pattern: jsdocPattern(a.name) }] }, expect: exp("fresh", true, true) },
      { session: 3, category: "query", text: `Where is \`${a.name}\` defined, and what does it return?`, equivalentTo: 1, oracle: where, expect: exp("must-refresh", false, false), notes: "same text as step 1 but the file changed in steps 3-4: a cached answer keyed on the old project state must not be replayed" },
      { session: 4, category: "docs", text: `Revert the JSDoc comment you added to \`${a.name}\` in the earlier session, but keep the one on \`${b.name}\`.`, dependsOn: [3, 4], oracle: { files: [{ path: a.file, pattern: noJsdocPattern(a.name) }, { path: b.file, pattern: jsdocPattern(b.name) }] }, expect: exp("fresh", true, true) },
    ]);
  }
  for (const fn of testFns) {
    const testPath = `tests/lh-${topDir(fn.file)}-${kebab(fn.name)}.test.ts`;
    const run = { commands: [`npx vitest run ${testPath}`], outputAnyOf: PASS_SIGNALS };
    session("test-evolution", `Write, re-run and extend a unit test for ${fn.name}`, [{ path: fn.file, symbol: fn.name }], [
      { session: 1, category: "query", text: `Where is \`${fn.name}\` defined and what are its inputs and outputs?`, oracle: { outputAnyOf: [fn.file, posix.basename(fn.file)] }, expect: exp("fresh", false, false) },
      { session: 1, category: "test", text: `Create ${testPath} with one vitest case for \`${fn.name}\` from ${fn.file}.`, oracle: { files: [{ path: testPath, pattern: `\\b${escapeRe(fn.name)}\\b` }], commands: [`npx vitest run ${testPath}`] }, expect: exp("fresh", true, false) },
      { session: 2, category: "test", text: "Run the test file you created in the previous session and report whether it passes.", dependsOn: [2], oracle: run, expect: exp("fresh", false, true) },
      { session: 3, category: "test", text: "Is that test file still green? Run it again and tell me.", dependsOn: [2], equivalentTo: 3, oracle: run, expect: exp("reuse-allowed", false, true), notes: "nothing changed since step 3: replaying its validation result is correct" },
      { session: 3, category: "test", text: `Add an edge-case test to ${testPath} so it has at least two cases.`, dependsOn: [2], oracle: { files: [{ path: testPath, pattern: twoCasesPattern }], commands: [`npx vitest run ${testPath}`] }, expect: exp("fresh", true, true) },
      { session: 4, category: "test", text: "Run the test file again and report whether it passes.", dependsOn: [2, 5], equivalentTo: 3, oracle: run, expect: exp("must-refresh", false, true), notes: "the test file changed in step 5: the step-3/4 result is stale" },
      { session: 4, category: "query", text: `Which test file did we create for \`${fn.name}\` in the first session?`, dependsOn: [2], oracle: { outputAnyOf: [testPath, posix.basename(testPath)] }, expect: exp("fresh", false, true) },
    ]);
  }
  for (const [a, b] of renamePairs) {
    const impA = renamable(a);
    const impB = renamable(b);
    const who = { outputAllOf: impA.map((p) => posix.basename(p)) };
    session("rename-and-revert", `Rename ${a.name}, apply the convention to ${b.name}, then revert the first rename`, [{ path: a.file, symbol: a.name }, { path: b.file, symbol: b.name }], [
      { session: 1, category: "query", text: `Which files import \`${a.name}\` from ${a.file}?`, oracle: who, expect: exp("fresh", false, false) },
      { session: 2, category: "query", text: `List the modules that depend on \`${a.name}\` (defined in ${a.file}).`, equivalentTo: 1, oracle: who, expect: exp("reuse-allowed", false, false) },
      { session: 2, category: "refactor", text: `Rename \`${a.name}\` to \`${a.name}Impl\` and update every import and call site.`, oracle: { files: [{ path: a.file, pattern: `export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(a.name)}Impl\\b` }], commands: [TSC] }, expect: exp("fresh", true, false) },
      { session: 3, category: "refactor", text: `Rename \`${b.name}\` in the same file using the same naming convention you applied to \`${a.name}\`.`, dependsOn: [3], oracle: { files: [{ path: b.file, pattern: `export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(b.name)}Impl\\b` }, ...impB.map((p) => ({ path: p, pattern: `\\b${escapeRe(b.name)}Impl\\b` }))], commands: [TSC] }, expect: exp("fresh", true, true) },
      { session: 3, category: "query", text: `Which files import \`${a.name}Impl\` now?`, dependsOn: [3], equivalentTo: 1, oracle: who, expect: exp("must-refresh", false, true), notes: "same intent as step 1 after the rename: the answer set is unchanged but every cited import line changed" },
      { session: 4, category: "refactor", text: `Revert the first rename (\`${a.name}Impl\` back to \`${a.name}\`) but keep the rename of \`${b.name}\`.`, dependsOn: [3, 4], oracle: { files: [{ path: a.file, pattern: `^(?![\\s\\S]*\\b${escapeRe(a.name)}Impl\\b)[\\s\\S]*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRe(a.name)}\\b` }, { path: b.file, pattern: `\\b${escapeRe(b.name)}Impl\\b` }], commands: [TSC] }, expect: exp("fresh", true, true) },
    ]);
  }
  for (let i = 0; i < 5; i += 1) {
    const [t1, t2] = [lhTests[2 * i], lhTests[2 * i + 1]];
    if (!t1 || !t2) throw new Error("not enough calibrated base tests for long-horizon config sessions");
    const name = `test:lh-${i + 1}`;
    const run = { commands: [`npm run ${name}`], outputAnyOf: PASS_SIGNALS };
    session("config-lifecycle", `Add, extend and remove the npm script ${name}`, [{ path: "package.json" }, { path: t1 }, { path: t2 }], [
      { session: 1, category: "config", text: `Add a root package.json npm script named "${name}" that runs vitest on ${t1} only.`, oracle: { files: [{ path: "package.json", pattern: `"${escapeRe(name)}"\\s*:\\s*"[^"]*vitest run[^"]*${escapeRe(t1)}[^"]*"` }], commands: [`npm run ${name}`] }, expect: exp("fresh", true, false) },
      { session: 1, category: "test", text: `Run npm run ${name} and report whether it passes.`, dependsOn: [1], oracle: run, expect: exp("fresh", false, true) },
      { session: 2, category: "test", text: `Does the "${name}" script still pass? Run it and tell me.`, dependsOn: [1], equivalentTo: 2, oracle: run, expect: exp("reuse-allowed", false, true) },
      { session: 2, category: "config", text: `Extend the "${name}" script you added earlier so it also runs ${t2}.`, dependsOn: [1], oracle: { files: [{ path: "package.json", pattern: `"${escapeRe(name)}"\\s*:\\s*"[^"]*${escapeRe(t1)}[^"]*${escapeRe(t2)}[^"]*"|"${escapeRe(name)}"\\s*:\\s*"[^"]*${escapeRe(t2)}[^"]*${escapeRe(t1)}[^"]*"` }], commands: [`npm run ${name}`] }, expect: exp("fresh", true, true) },
      { session: 3, category: "test", text: `Run npm run ${name} again and report whether it passes.`, dependsOn: [4], equivalentTo: 2, oracle: run, expect: exp("must-refresh", false, true), notes: "the script now runs a second file: the earlier pass result does not cover it" },
      { session: 4, category: "config", text: `Remove the "${name}" npm script you added in the first session; leave every other script untouched.`, dependsOn: [1], oracle: { files: [{ path: "package.json", pattern: `^(?![\\s\\S]*"${escapeRe(name)}")[\\s\\S]*"test"\\s*:` }] }, expect: exp("fresh", true, true) },
    ]);
  }

  return { extended, sessions };
}

function pairsInSameFile(pool, used, n) {
  const byFile = new Map();
  for (const fn of pool) {
    if (used.has(`${fn.file}#${fn.name}`)) continue;
    if (!byFile.has(fn.file)) byFile.set(fn.file, []);
    byFile.get(fn.file).push(fn);
  }
  const out = [];
  const usedFiles = new Set();
  for (const fn of pool) {
    if (out.length === n) break;
    const group = byFile.get(fn.file);
    if (!group || group.length < 2 || usedFiles.has(fn.file)) continue;
    usedFiles.add(fn.file);
    const [a, b] = [...group].sort((x, y) => x.line - y.line);
    used.add(`${a.file}#${a.name}`);
    used.add(`${b.file}#${b.name}`);
    out.push([a, b]);
  }
  if (out.length < n) throw new Error(`pair pool exhausted: needed ${n}, got ${out.length}`);
  return out;
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function generate() {
  if (!existsSync(CALIBRATION_FILE)) throw new Error(`missing ${CALIBRATION_FILE}: run with --calibrate first`);
  const calibration = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8"));
  if (calibration.base !== BASE) throw new Error(`calibration base ${calibration.base} != ${BASE}`);
  const { extended, sessions } = build(loadRepo(), calibration);
  return { extended: toJsonl(extended), longHorizon: toJsonl(sessions) };
}

// ------------------------------------------------------------------ main

const args = process.argv.slice(2);
if (args.includes("--candidates")) {
  const repo = loadRepo();
  process.stdout.write(`${JSON.stringify({ baseTests: baseTestCandidates(repo), fixCommits: fixCommitCandidates().map((c) => ({ commit: c.commit.slice(0, 7), kind: c.kind, tests: c.tests, subject: c.subject })) }, null, 2)}\n`);
} else if (args.includes("--calibrate")) {
  const jobsIdx = args.indexOf("--jobs");
  await calibrate(jobsIdx >= 0 ? Math.max(1, Number(args[jobsIdx + 1])) : 3);
} else if (args.includes("--check")) {
  const out = generate();
  const same = existsSync(EXTENDED_FILE) && existsSync(LONG_HORIZON_FILE) && readFileSync(EXTENDED_FILE, "utf8") === out.extended && readFileSync(LONG_HORIZON_FILE, "utf8") === out.longHorizon;
  process.stdout.write(same ? "gen-extended: committed datasets are reproducible\n" : "gen-extended: committed datasets differ from the generator output\n");
  process.exitCode = same ? 0 : 1;
} else {
  const out = generate();
  writeFileSync(EXTENDED_FILE, out.extended);
  writeFileSync(LONG_HORIZON_FILE, out.longHorizon);
  process.stdout.write(`gen-extended: wrote ${out.extended.trim().split("\n").length} tasks and ${out.longHorizon.trim().split("\n").length} sessions\n`);
}
