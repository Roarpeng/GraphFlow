#!/usr/bin/env node
// Structural + repository check of the §18 benchmark datasets (spec §19 golden gate).
// Parses the JSONL files as plain JSON lines (no TS imports) and verifies, per dataset:
//   golden-core      benchmarks/golden-v1.jsonl            50 tasks, 20/15/10/5, commits resolve, judging status
//   golden-extended  benchmarks/golden-extended-v1.jsonl  200 tasks, 60/80/45/15, every category >= 3,
//                    paraphrase families, refs/absentRefs against git at baseCommit, oracle commands point
//                    at real files/scripts, file oracles are NOT already satisfied at baseCommit
//   long-horizon     benchmarks/long-horizon-v1.jsonl     20 sessions of 3-8 ordered steps, session numbering,
//                    dependsOn/equivalentTo point backwards, reuse expectations agree with stateChange,
//                    refs exist, step commands point at files/scripts that exist or an earlier step creates
//
// Usage: node packages/efficiency-agent/scripts/check-golden.mjs [file.jsonl] [--dataset core|extended|long-horizon|all] [--json]
//   no file and no --dataset: Golden-Core only (the PR release gate); --dataset all checks all three.
//   A file without --dataset is classified by its content.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");

const CATEGORIES = ["query", "single-file", "multi-file", "bugfix", "refactor", "test", "docs", "config", "cross-module", "deliberate-failure"];
const DATASETS = {
  core: { file: "golden-v1.jsonl", total: 50, cohorts: { repetition: 20, regular: 15, complex: 10, failure: 5 } },
  extended: { file: "golden-extended-v1.jsonl", total: 200, cohorts: { repetition: 60, regular: 80, complex: 45, failure: 15 }, minPerCategory: 3, maxUnjudged: 10 },
  "long-horizon": { file: "long-horizon-v1.jsonl", sessions: 20, steps: { min: 3, max: 8 } },
};
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|ya?ml|toml|txt|sh|ps1|html|css)$/i;

// ------------------------------------------------------------------ args

const args = process.argv.slice(2);
const json = args.includes("--json");
const dsIdx = args.indexOf("--dataset");
const datasetArg = dsIdx >= 0 ? args[dsIdx + 1] : undefined;
const fileArg = args.find((a, i) => !a.startsWith("--") && (dsIdx < 0 || i !== dsIdx + 1));
if (datasetArg && datasetArg !== "all" && !(datasetArg in DATASETS)) {
  process.stderr.write(`check-golden: unknown --dataset ${datasetArg} (core|extended|long-horizon|all)\n`);
  process.exit(2);
}

// ------------------------------------------------------------------ git access (cached)

// Object lookups go through one `git cat-file --batch-check` per batch: spawning git per
// commit/path costs ~0.1-0.5 s each on Windows, which made this gate take minutes.
const typeCache = new Map();
function batchCheck(specs) {
  const todo = [...new Set(specs)].filter((s) => !typeCache.has(s));
  if (todo.length === 0) return;
  const res = spawnSync("git", ["cat-file", "--batch-check"], { cwd: repoRoot, input: todo.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
  const lines = (res.stdout ?? "").split("\n");
  todo.forEach((spec, i) => {
    const line = lines[i] ?? "";
    typeCache.set(spec, / (missing|ambiguous)$/.test(line) || !line ? undefined : line.split(" ")[1]);
  });
}
const isRev = (rev) => typeof rev === "string" && /^[0-9a-f]{4,40}$/i.test(rev);
const commitsChecked = new Set();
function commitResolves(rev) {
  if (!isRev(rev)) return false;
  commitsChecked.add(rev);
  batchCheck([`${rev}^{commit}`]);
  return typeCache.get(`${rev}^{commit}`) === "commit";
}
function pathAt(rev, path) {
  batchCheck([`${rev}:${path.replace(/\/$/, "")}`]);
  return typeCache.get(`${rev}:${path.replace(/\/$/, "")}`) !== undefined;
}
/** Prefetch commit and `rev:path` lookups for a dataset in one call. */
function prefetch(revs, revPaths) {
  batchCheck([...revs.filter(isRev).map((r) => `${r}^{commit}`), ...revPaths.filter(([r]) => isRev(r)).map(([r, p]) => `${r}:${p.replace(/\/$/, "")}`)]);
}
const testPathsIn = (cmds) => (cmds ?? []).flatMap((c) => [...c.matchAll(/\btests\/[\w./-]+\.test\.ts\b/g)].map((m) => m[0]));

const treeCache = new Map();
function treeAt(rev) {
  if (!treeCache.has(rev)) {
    const res = spawnSync("git", ["ls-tree", "-r", "--name-only", rev], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28, windowsHide: true });
    treeCache.set(rev, res.status === 0 ? new Set(res.stdout.split("\n").filter(Boolean)) : new Set());
  }
  return treeCache.get(rev);
}

const blobCache = new Map();
/** Load `rev:path` blobs in one `git cat-file --batch` call. */
function loadBlobs(specs) {
  const todo = [...new Set(specs)].filter((s) => !blobCache.has(s));
  if (todo.length === 0) return;
  const res = spawnSync("git", ["cat-file", "--batch"], { cwd: repoRoot, input: todo.join("\n") + "\n", maxBuffer: 1 << 30, windowsHide: true });
  const buf = res.stdout;
  let pos = 0;
  for (const spec of todo) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) {
      blobCache.set(spec, undefined);
      continue;
    }
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (/ (missing|ambiguous)$/.test(header)) {
      blobCache.set(spec, undefined);
      continue;
    }
    const size = Number(header.split(" ")[2]);
    blobCache.set(spec, buf.subarray(pos, pos + size).toString("utf8").replace(/\r\n/g, "\n"));
    pos += size + 1;
  }
}
const blob = (rev, path) => {
  loadBlobs([`${rev}:${path}`]);
  return blobCache.get(`${rev}:${path}`);
};
function anyFileContains(rev, text) {
  const files = [...treeAt(rev)].filter((f) => TEXT_EXT.test(f));
  loadBlobs(files.map((f) => `${rev}:${f}`));
  return files.find((f) => (blobCache.get(`${rev}:${f}`) ?? "").includes(text));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const npmScripts = (rev) => {
  try {
    return JSON.parse(blob(rev, "package.json") ?? "{}").scripts ?? {};
  } catch {
    return {};
  }
};

// ------------------------------------------------------------------ shared helpers

function readJsonl(path, errors) {
  const rows = [];
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((line, idx) => {
      if (!line.trim()) return;
      try {
        rows.push({ lineNo: idx + 1, row: JSON.parse(line) });
      } catch (err) {
        errors.push(`line ${idx + 1}: invalid JSON (${err.message})`);
      }
    });
  return rows;
}

function checkRefs(where, rev, refs, errors) {
  for (const ref of refs ?? []) {
    if (!pathAt(rev, ref.path)) {
      errors.push(`${where}: ref ${ref.path} does not exist at ${rev.slice(0, 7)}`);
      continue;
    }
    if (ref.symbol) {
      const text = blob(rev, ref.path);
      if (text === undefined || !new RegExp(`(^|[^\\w$])${escapeRe(ref.symbol)}($|[^\\w$])`).test(text)) {
        errors.push(`${where}: symbol ${ref.symbol} not found in ${ref.path} at ${rev.slice(0, 7)}`);
      }
    }
  }
}

function checkAbsent(where, rev, absentRefs, errors) {
  for (const ref of absentRefs ?? []) {
    if (ref.path && !ref.text) {
      if (pathAt(rev, ref.path)) errors.push(`${where}: absentRef ${ref.path} exists at ${rev.slice(0, 7)} (the probe would not be false)`);
    } else if (ref.path && ref.text) {
      const text = blob(rev, ref.path);
      if (text === undefined) errors.push(`${where}: absentRef file ${ref.path} must exist at ${rev.slice(0, 7)}`);
      else if (text.includes(ref.text)) errors.push(`${where}: ${ref.path} already contains ${JSON.stringify(ref.text)} at ${rev.slice(0, 7)}`);
    } else if (ref.text) {
      const hit = anyFileContains(rev, ref.text);
      if (hit) errors.push(`${where}: ${JSON.stringify(ref.text)} is referenced in ${hit} at ${rev.slice(0, 7)}`);
    }
  }
}

/**
 * Oracle/guard commands must point at real things: every `tests/*.test.ts`
 * argument exists at `rev` (or is created by the task), every `npm run X`
 * names a script that exists (or is created by the task).
 */
function checkCommands(where, rev, commands, creates, errors) {
  for (const cmd of commands ?? []) {
    for (const m of cmd.matchAll(/\btests\/[\w./-]+\.test\.ts\b/g)) {
      if (!pathAt(rev, m[0]) && !creates.paths.has(m[0])) errors.push(`${where}: command references ${m[0]}, absent at ${rev.slice(0, 7)} and not created by the task`);
    }
    const npm = /^npm run ([\w:.-]+)/.exec(cmd);
    if (npm && !creates.scripts.has(npm[1]) && !(npm[1] in npmScripts(rev))) errors.push(`${where}: npm script ${npm[1]} does not exist at ${rev.slice(0, 7)} and is not created by the task`);
    const head = cmd.split(/\s+/)[0];
    if (!["npx", "npm", "node"].includes(head) && !head.includes("node")) errors.push(`${where}: unexpected command runner ${head}`);
  }
}

/** Paths / npm script names a task (or step) text says it creates. */
function createdBy(text) {
  return {
    paths: new Set([...text.matchAll(/\btests\/[\w./-]+\.test\.ts\b/g)].map((m) => m[0])),
    scripts: new Set([...text.matchAll(/npm script named "([\w:.-]+)"/g)].map((m) => m[1])),
  };
}

/** Output needles already in the task text would pass for an agent that merely echoes the prompt. */
function checkEcho(where, text, oracle, errors) {
  const lower = (text ?? "").toLowerCase();
  for (const n of [...(oracle?.outputAnyOf ?? []), ...(oracle?.outputAllOf ?? []), ...(oracle?.refusal?.signals ?? [])]) {
    if (lower.includes(n.toLowerCase())) errors.push(`${where}: output needle ${JSON.stringify(n)} appears in the task text`);
  }
}
const mergeCreates = (a, b) => ({ paths: new Set([...a.paths, ...b.paths]), scripts: new Set([...a.scripts, ...b.scripts]) });

// ------------------------------------------------------------------ golden-core (unchanged contract)

function checkCore(path) {
  const spec = DATASETS.core;
  const errors = [];
  const tasks = readJsonl(path, errors).map(({ lineNo, row }) => ({ lineNo, task: row }));
  prefetch(tasks.flatMap(({ task }) => [task.baseCommit, task.oracle?.overlayFrom?.commit]), []);
  if (tasks.length !== spec.total) errors.push(`expected ${spec.total} tasks, found ${tasks.length}`);
  const cohorts = {};
  const seen = new Set();
  let judged = 0;
  let unjudged = 0;
  let guarded = 0;
  for (const { lineNo, task } of tasks) {
    const where = `line ${lineNo} (${task.id ?? "no id"})`;
    if (typeof task.id !== "string" || !task.id) errors.push(`${where}: missing id`);
    else if (seen.has(task.id)) errors.push(`${where}: duplicate id`);
    else seen.add(task.id);
    cohorts[task.cohort] = (cohorts[task.cohort] ?? 0) + 1;
    if (!(task.cohort in spec.cohorts)) errors.push(`${where}: unknown cohort ${JSON.stringify(task.cohort)}`);
    if (!task.baseCommit) errors.push(`${where}: missing baseCommit`);
    else if (!commitResolves(task.baseCommit)) errors.push(`${where}: baseCommit ${task.baseCommit} does not resolve`);
    const overlay = task.oracle?.overlayFrom;
    if (overlay && !commitResolves(overlay.commit)) errors.push(`${where}: oracle.overlayFrom.commit ${overlay.commit} does not resolve`);
    const hasOracle = task.oracle !== undefined && task.oracle !== null;
    const markedUnjudged = typeof task.notes === "string" && /\bunjudged\b/i.test(task.notes);
    const complexWithGuards = task.cohort === "complex" && Array.isArray(task.guards) && task.guards.length > 0;
    if (hasOracle) judged++;
    else if (markedUnjudged) unjudged++;
    else if (complexWithGuards) guarded++;
    else errors.push(`${where}: no oracle, not marked unjudged, and not a guarded complex task`);
  }
  for (const [cohort, expected] of Object.entries(spec.cohorts)) {
    const actual = cohorts[cohort] ?? 0;
    if (actual !== expected) errors.push(`cohort ${cohort}: expected ${expected}, found ${actual}`);
  }
  return {
    summary: { total: tasks.length, cohorts, judged, unjudged, guardedOnly: guarded },
    line: `golden: ${tasks.length} tasks (${Object.entries(cohorts).map(([k, v]) => `${k}=${v}`).join(" ")}); judged=${judged} unjudged=${unjudged} guarded-only=${guarded}`,
    errors,
  };
}

// ------------------------------------------------------------------ golden-extended

function checkExtended(path) {
  const spec = DATASETS.extended;
  const errors = [];
  const rows = readJsonl(path, errors);
  if (rows.length !== spec.total) errors.push(`expected ${spec.total} tasks, found ${rows.length}`);
  const cohorts = {};
  const categories = {};
  const families = new Map();
  const seen = new Set();
  let judged = 0;
  let unjudged = 0;
  let baseFailChecked = 0;
  // Pre-load every referenced commit, path and blob in two batches.
  prefetch(
    rows.flatMap(({ row }) => [row.baseCommit, row.oracle?.overlayFrom?.commit]),
    rows.flatMap(({ row }) => [
      ...[...(row.refs ?? []), ...(row.absentRefs ?? []).filter((r) => r.path)].map((r) => [row.baseCommit, r.path]),
      ...testPathsIn([...(row.oracle?.commands ?? []), ...(row.guards ?? [])]).map((p) => [row.oracle?.overlayFrom?.commit ?? row.baseCommit, p]),
      ...(row.oracle?.overlayFrom?.paths ?? []).map((p) => [row.oracle.overlayFrom.commit, p]),
    ])
  );
  loadBlobs(rows.flatMap(({ row }) => [...(row.refs ?? []), ...(row.oracle?.files ?? [])].filter((r) => r.path).map((r) => `${row.baseCommit}:${r.path}`)));
  for (const { lineNo, row: t } of rows) {
    const where = `line ${lineNo} (${t.id ?? "no id"})`;
    if (typeof t.id !== "string" || !/^ext-(rep|reg|cx|fail)-\d{3}$/.test(t.id)) errors.push(`${where}: id must look like ext-<rep|reg|cx|fail>-NNN`);
    else if (seen.has(t.id)) errors.push(`${where}: duplicate id`);
    else seen.add(t.id);
    if (t.dataset !== "golden-extended-v1") errors.push(`${where}: dataset must be golden-extended-v1`);
    cohorts[t.cohort] = (cohorts[t.cohort] ?? 0) + 1;
    categories[t.category] = (categories[t.category] ?? 0) + 1;
    if (!(t.cohort in spec.cohorts)) errors.push(`${where}: unknown cohort ${JSON.stringify(t.cohort)}`);
    if (!CATEGORIES.includes(t.category)) errors.push(`${where}: unknown category ${JSON.stringify(t.category)}`);
    if (typeof t.text !== "string" || t.text.trim().length < 8) errors.push(`${where}: text too short`);
    if (!t.baseCommit || !commitResolves(t.baseCommit)) {
      errors.push(`${where}: baseCommit ${t.baseCommit} does not resolve`);
      continue;
    }
    const overlay = t.oracle?.overlayFrom;
    if (overlay) {
      if (!commitResolves(overlay.commit)) errors.push(`${where}: overlayFrom.commit ${overlay.commit} does not resolve`);
      else for (const p of overlay.paths ?? []) if (!pathAt(overlay.commit, p)) errors.push(`${where}: overlay path ${p} missing at ${overlay.commit}`);
    }
    checkRefs(where, t.baseCommit, t.refs, errors);
    checkAbsent(where, t.baseCommit, t.absentRefs, errors);
    checkEcho(where, t.text, t.oracle, errors);
    const creates = createdBy(t.text);
    checkCommands(where, t.baseCommit, [...(t.oracle?.commands ?? []).filter(() => !overlay), ...(t.guards ?? [])], creates, errors);
    if (overlay) checkCommands(where, overlay.commit, t.oracle.commands ?? [], creates, errors);
    for (const f of t.oracle?.files ?? []) {
      try {
        new RegExp(f.pattern);
      } catch {
        errors.push(`${where}: invalid regex ${f.pattern}`);
      }
    }
    // A change task whose file oracle already holds at baseCommit would pass on a no-op.
    if (t.oracle?.files && !overlay && t.cohort !== "failure") {
      baseFailChecked++;
      const satisfied = t.oracle.files.every((f) => {
        const text = blob(t.baseCommit, f.path);
        return text !== undefined && new RegExp(f.pattern).test(text);
      });
      if (satisfied) errors.push(`${where}: every file oracle already matches at baseCommit (a no-op would pass)`);
    }
    if (t.cohort === "repetition") {
      if (typeof t.family !== "string" || !t.family) errors.push(`${where}: repetition task without family`);
      else families.set(t.family, [...(families.get(t.family) ?? []), t]);
    } else if (t.family !== undefined) errors.push(`${where}: family on a non-repetition task`);
    if (t.cohort === "failure") {
      if (t.category !== "deliberate-failure" || !t.oracle?.refusal?.noChanges) errors.push(`${where}: failure needs deliberate-failure + refusal oracle with noChanges`);
      if (!t.absentRefs?.length) errors.push(`${where}: failure without absentRefs`);
    } else if (!t.refs?.length) errors.push(`${where}: no refs`);
    if (t.oracle) judged++;
    else {
      unjudged++;
      if (!(t.cohort === "complex" && t.guards?.length && /\bunjudged\b/i.test(t.notes ?? ""))) errors.push(`${where}: no oracle and not a guarded complex task marked unjudged`);
    }
  }
  for (const [cohort, expected] of Object.entries(spec.cohorts)) {
    if ((cohorts[cohort] ?? 0) !== expected) errors.push(`cohort ${cohort}: expected ${expected}, found ${cohorts[cohort] ?? 0}`);
  }
  for (const c of CATEGORIES) if ((categories[c] ?? 0) < spec.minPerCategory) errors.push(`category ${c}: ${categories[c] ?? 0} tasks, expected >= ${spec.minPerCategory}`);
  if (unjudged > spec.maxUnjudged) errors.push(`${unjudged} unjudged tasks, at most ${spec.maxUnjudged}`);
  for (const [family, members] of families) {
    if (members.length < 2) errors.push(`family ${family}: fewer than 2 members`);
    const oracle = JSON.stringify(members[0].oracle);
    for (const m of members) {
      if (m.category !== members[0].category || JSON.stringify(m.oracle) !== oracle) errors.push(`family ${family}: ${m.id} is not a paraphrase of ${members[0].id} (category/oracle differ)`);
    }
    if (new Set(members.map((m) => m.text)).size !== members.length) errors.push(`family ${family}: duplicate texts`);
  }
  return {
    summary: { total: rows.length, cohorts, categories, families: families.size, judged, unjudged, noOpOracleChecks: baseFailChecked },
    line:
      `golden-extended: ${rows.length} tasks (${Object.entries(cohorts).map(([k, v]) => `${k}=${v}`).join(" ")}); ` +
      `${families.size} families; judged=${judged} unjudged=${unjudged}; no-op checks=${baseFailChecked}`,
    errors,
  };
}

// ------------------------------------------------------------------ long-horizon

function checkLongHorizon(path) {
  const spec = DATASETS["long-horizon"];
  const errors = [];
  const rows = readJsonl(path, errors);
  prefetch(
    rows.map(({ row }) => row.baseCommit),
    rows.flatMap(({ row }) => [
      ...(row.refs ?? []).map((r) => [row.baseCommit, r.path]),
      ...(row.steps ?? []).flatMap((st) => testPathsIn([...(st.oracle?.commands ?? []), ...(st.guards ?? [])]).map((p) => [row.baseCommit, p])),
    ])
  );
  loadBlobs(rows.flatMap(({ row }) => [...(row.refs ?? []).filter((r) => r.symbol).map((r) => `${row.baseCommit}:${r.path}`), `${row.baseCommit}:package.json`]));
  if (rows.length !== spec.sessions) errors.push(`expected ${spec.sessions} sessions, found ${rows.length}`);
  const seen = new Set();
  const reuse = {};
  let steps = 0;
  let memorySteps = 0;
  for (const { lineNo, row: s } of rows) {
    const where = `line ${lineNo} (${s.id ?? "no id"})`;
    if (typeof s.id !== "string" || !/^lh-\d{3}$/.test(s.id)) errors.push(`${where}: id must look like lh-NNN`);
    else if (seen.has(s.id)) errors.push(`${where}: duplicate id`);
    else seen.add(s.id);
    if (s.dataset !== "long-horizon-v1") errors.push(`${where}: dataset must be long-horizon-v1`);
    if (!s.baseCommit || !commitResolves(s.baseCommit)) {
      errors.push(`${where}: baseCommit ${s.baseCommit} does not resolve`);
      continue;
    }
    checkRefs(where, s.baseCommit, s.refs, errors);
    const list = Array.isArray(s.steps) ? s.steps : [];
    if (list.length < spec.steps.min || list.length > spec.steps.max) errors.push(`${where}: ${list.length} steps, expected ${spec.steps.min}-${spec.steps.max}`);
    const byId = new Map();
    let created = { paths: new Set(), scripts: new Set() };
    let prevSession = 0;
    list.forEach((st, i) => {
      const at = `${s.id}-s${i + 1}`;
      steps++;
      if (st.step !== i + 1 || st.id !== at) errors.push(`${at}: step/id out of order (got step=${st.step} id=${st.id})`);
      if (!Number.isInteger(st.session) || st.session < prevSession || st.session > prevSession + 1 || (i === 0 && st.session !== 1)) errors.push(`${at}: bad session number ${st.session} after ${prevSession}`);
      prevSession = Math.max(prevSession, st.session ?? 0);
      if (!CATEGORIES.includes(st.category) || st.category === "deliberate-failure") errors.push(`${at}: bad category ${st.category}`);
      if (!st.oracle) errors.push(`${at}: step without oracle`);
      checkEcho(at, st.text, st.oracle, errors);
      for (const dep of st.dependsOn ?? []) if (!byId.has(dep)) errors.push(`${at}: dependsOn ${dep} is not an earlier step`);
      const e = st.expect ?? {};
      reuse[e.reuse] = (reuse[e.reuse] ?? 0) + 1;
      if (e.memory === "required") memorySteps++;
      if ((e.memory === "required") !== (st.dependsOn ?? []).length > 0) errors.push(`${at}: memory flag disagrees with dependsOn`);
      if (e.reuse === "fresh" && st.equivalentTo) errors.push(`${at}: fresh step with equivalentTo`);
      if (e.reuse === "reuse-allowed" || e.reuse === "must-refresh") {
        const eq = byId.get(st.equivalentTo);
        if (!eq) errors.push(`${at}: ${e.reuse} without an earlier equivalentTo`);
        else {
          const changed = list.slice(eq.step, i).some((p) => p.expect?.stateChange);
          if (e.reuse === "reuse-allowed" && changed) errors.push(`${at}: reuse-allowed although the workspace changed after ${eq.id}`);
          if (e.reuse === "must-refresh" && !changed) errors.push(`${at}: must-refresh although nothing changed after ${eq.id}`);
        }
      }
      if (!["fresh", "reuse-allowed", "must-refresh"].includes(e.reuse) || typeof e.stateChange !== "boolean") errors.push(`${at}: invalid expect block`);
      created = mergeCreates(created, createdBy(st.text ?? ""));
      checkCommands(at, s.baseCommit, [...(st.oracle?.commands ?? []), ...(st.guards ?? [])], created, errors);
      for (const f of st.oracle?.files ?? []) {
        try {
          new RegExp(f.pattern);
        } catch {
          errors.push(`${at}: invalid regex ${f.pattern}`);
        }
      }
      byId.set(st.id, st);
    });
    if (new Set(list.map((st) => st.session)).size < 2) errors.push(`${where}: spans fewer than two agent sessions`);
    if (!list.some((st) => st.expect?.memory === "required")) errors.push(`${where}: no memory-dependent step`);
  }
  for (const r of ["fresh", "reuse-allowed", "must-refresh"]) if (!reuse[r]) errors.push(`no step expects reuse "${r}"`);
  return {
    summary: { sessions: rows.length, steps, memorySteps, reuse },
    line: `long-horizon: ${rows.length} sessions, ${steps} steps (memory-dependent=${memorySteps}; ${Object.entries(reuse).map(([k, v]) => `${k}=${v}`).join(" ")})`,
    errors,
  };
}

// ------------------------------------------------------------------ main

function classify(path) {
  const first = readFileSync(path, "utf8").split(/\r?\n/).find((l) => l.trim());
  try {
    const row = JSON.parse(first ?? "{}");
    if (Array.isArray(row.steps) || row.dataset === "long-horizon-v1") return "long-horizon";
    if (row.dataset === "golden-extended-v1") return "extended";
  } catch {
    // golden-core reports the bad line
  }
  return "core";
}

const CHECKERS = { core: checkCore, extended: checkExtended, "long-horizon": checkLongHorizon };
let targets;
if (fileArg) targets = [{ name: datasetArg && datasetArg !== "all" ? datasetArg : classify(resolve(fileArg)), path: resolve(fileArg) }];
else {
  const names = !datasetArg ? ["core"] : datasetArg === "all" ? Object.keys(DATASETS) : [datasetArg];
  targets = names.map((name) => ({ name, path: resolve(packageDir, "benchmarks", DATASETS[name].file) }));
}

const results = targets.map(({ name, path }) => {
  if (!existsSync(path)) return { dataset: name, path, ok: false, errors: [`missing ${path}`], line: `${name}: missing ${path}` };
  const r = CHECKERS[name](path);
  return { dataset: name, path, ok: r.errors.length === 0, ...r.summary, errors: r.errors, line: r.line };
});
const errorCount = results.reduce((n, r) => n + r.errors.length, 0);

if (json) {
  const out = results.map(({ line, ...rest }) => rest);
  process.stdout.write(`${JSON.stringify({ ok: errorCount === 0, commitsChecked: commitsChecked.size, datasets: out }, null, 2)}\n`);
} else {
  for (const r of results) {
    for (const e of r.errors.slice(0, 50)) process.stdout.write(`  x [${r.dataset}] ${e}\n`);
    if (r.errors.length > 50) process.stdout.write(`  x [${r.dataset}] ... ${r.errors.length - 50} more\n`);
    process.stdout.write(`${r.line}; ${r.errors.length} error(s)\n`);
  }
  process.stdout.write(`datasets: ${results.map((r) => `${r.dataset}=${r.ok ? "ok" : "FAIL"}`).join(" ")}; ${commitsChecked.size} commits checked; ${errorCount} error(s)\n`);
}
process.exitCode = errorCount > 0 ? 1 : 0;
