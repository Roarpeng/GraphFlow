#!/usr/bin/env node
// Release gate for the GraphFlow Efficiency Agent (spec §19 CI/CD gates, §27 #12).
// Runs named gates, prints PASS/FAIL/SKIP per gate with duration and a summary
// table, and exits 1 when any blocking gate fails. A gate whose test file does
// not exist FAILS: a missing gate cannot pass.
//
// Usage:
//   node packages/efficiency-agent/scripts/release-gate.mjs [--only a,b] [--skip a,b] [--json] [--strict] [--verbose]
//
//   --strict   treat SKIP (e.g. npm audit unreachable) as a failure of blocking gates
//   --verbose  stream full child output instead of printing the tail on failure
//
// Child CLIs are spawned through process.execPath + their JS entry: Windows
// refuses .cmd shims without a shell on Node >= 20.12 (CVE-2024-27980).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");
const PKG = "packages/efficiency-agent";
const VITEST = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const TSC = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const STEP_TIMEOUT_MS = Number(process.env.EFF_GATE_STEP_TIMEOUT_MS ?? 20 * 60_000);
const BIN_TSC_FLAGS = [
  "--noEmit", "--target", "es2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
  "--types", "node", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
  "--skipLibCheck", "--ignoreConfig",
];

// ---------------------------------------------------------------- CLI flags

function parseArgs(argv) {
  const opts = { only: null, skip: new Set(), json: false, strict: process.env.EFF_GATE_STRICT === "1", verbose: false };
  const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes("=") ? a.split(/=(.*)/s) : [a, undefined];
    if (flag === "--only") opts.only = new Set(list(inline ?? argv[++i]));
    else if (flag === "--skip") list(inline ?? argv[++i]).forEach((g) => opts.skip.add(g));
    else if (flag === "--json") opts.json = true;
    else if (flag === "--strict") opts.strict = true;
    else if (flag === "--verbose") opts.verbose = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------- step helpers

const pass = (detail = "") => ({ status: "PASS", detail });
const fail = (detail) => ({ status: "FAIL", detail });
const skip = (detail) => ({ status: "SKIP", detail });

let OPTS;
const log = (msg) => (OPTS.json ? process.stderr : process.stdout).write(`${msg}\n`);

function tail(text, lines = 40) {
  const all = (text ?? "").replace(/\r/g, "").split("\n");
  return all.slice(-lines).join("\n").trim();
}

function run(cmd, args, { cwd = repoRoot, shell = false, timeout = STEP_TIMEOUT_MS, env = {} } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    shell,
    timeout,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GRAPHFLOW_SKIP_EMBEDDING_WARMUP: "1", FORCE_COLOR: "0", ...env },
    stdio: OPTS.verbose && !OPTS.json ? "inherit" : "pipe",
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status, signal: res.signal, error: res.error, output, stdout: res.stdout ?? "" };
}

function childResult(label, res) {
  if (res.error) return fail(`${label}: ${res.error.message}`);
  if (res.signal) return fail(`${label}: killed by ${res.signal} (timeout ${STEP_TIMEOUT_MS} ms?)`);
  if (res.status !== 0) {
    if (!OPTS.verbose && !OPTS.json) log(indent(tail(res.output)));
    return fail(`${label}: exit ${res.status}`);
  }
  return pass(label);
}

const indent = (s) => s.split("\n").map((l) => `      | ${l}`).join("\n");

/** Vitest result: on failure, name the failing files and the pass/fail counts. */
function vitestResult(label, res) {
  const r = childResult(label, res);
  if (r.status !== "FAIL" || res.error || res.signal) return r;
  const text = res.output.replace(/\x1b\[[0-9;]*m/g, "");
  const counts = ["Test Files", "Tests"]
    .map((k) => new RegExp(`^\\s*${k}\\s+(.+?)\\s*$`, "m").exec(text)?.[1])
    .filter(Boolean)
    .map((c) => c.replace(/\s*\(\d+\)$/, ""));
  const failedFiles = [...new Set([...text.matchAll(/FAIL\s+(\S+\.test\.ts)/g)].map((m) => m[1].split("/").pop()))];
  if (counts.length) r.detail += ` [${counts.join("; ")}]`;
  if (failedFiles.length) r.detail += ` failing: ${failedFiles.slice(0, 8).join(", ")}${failedFiles.length > 8 ? ", ..." : ""}`;
  return r;
}

/** Vitest run of files relative to the package; missing files fail the step. */
function vitestStep(name, files, { optional = [] } = {}) {
  return {
    name,
    exec() {
      const present = [];
      const missing = [];
      for (const f of files) (existsSync(join(packageDir, f)) ? present : missing).push(f);
      const optionalPresent = optional.filter((f) => existsSync(join(packageDir, f)));
      if (missing.length) return fail(`missing ${missing.map((f) => `${PKG}/${f}`).join(", ")}`);
      const targets = [...present, ...optionalPresent].map((f) => `${PKG}/${f}`);
      if (!targets.length) {
        return files.length ? skip("no test files") : pass(`optional absent: ${optional.map((f) => `${PKG}/${f}`).join(", ")}`);
      }
      const res = run(process.execPath, [VITEST, "run", ...targets]);
      const r = vitestResult(`vitest ${targets.length} file(s)`, res);
      const absent = optional.filter((f) => !optionalPresent.includes(f));
      if (absent.length) r.detail += ` (optional absent: ${absent.join(", ")})`;
      return r;
    },
  };
}

/** Vitest run of every file matching a glob-like prefix/suffix under tests/. */
function vitestGlobStep(name, prefix, suffix = ".test.ts") {
  return {
    name,
    exec() {
      const dir = join(packageDir, "tests");
      const files = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(suffix)).sort()
        : [];
      if (!files.length) return fail(`missing ${PKG}/tests/${prefix}*${suffix}`);
      const targets = files.map((f) => `${PKG}/tests/${f}`);
      return vitestResult(`vitest ${files.length} file(s): ${files.join(", ")}`, run(process.execPath, [VITEST, "run", ...targets]));
    },
  };
}

function nodeScriptStep(name, script, args = []) {
  return {
    name,
    exec() {
      const abs = join(packageDir, "scripts", script);
      if (!existsSync(abs)) return fail(`missing ${PKG}/scripts/${script}`);
      const res = run(process.execPath, [abs, ...args]);
      const r = childResult(script, res);
      const last = tail(res.stdout, 1);
      if (last) r.detail = `${r.detail} -> ${last}`;
      return r;
    },
  };
}

const typecheckSrc = {
  name: "typecheck src",
  exec: () => childResult("tsc -p packages/efficiency-agent --noEmit", run(process.execPath, [TSC, "-p", PKG, "--noEmit"])),
};

const typecheckBin = {
  name: "typecheck bin",
  exec() {
    const entry = `${PKG}/bin/eff-agent.ts`;
    if (!existsSync(join(repoRoot, entry))) return fail(`missing ${entry}`);
    return childResult("tsc bin/eff-agent.ts --noEmit", run(process.execPath, [TSC, entry, ...BIN_TSC_FLAGS]));
  },
};

const vitestAll = {
  name: "vitest package",
  exec: () => vitestResult(`vitest run ${PKG}/tests`, run(process.execPath, [VITEST, "run", `${PKG}/tests/`])),
};

const npmAudit = {
  name: "npm audit (prod, high+)",
  exec() {
    // Mirrors frequently 404 the audit endpoint; ask the official registry.
    const res = run("npm", ["audit", "--omit=dev", "--audit-level=high", "--json", "--registry=https://registry.npmjs.org"], {
      shell: true,
      timeout: 180_000,
    });
    if (res.error) return skip(`npm audit could not start: ${res.error.message}`);
    if (res.signal) return skip(`npm audit timed out (${res.signal})`);
    let report;
    try {
      report = JSON.parse(res.stdout);
    } catch {
      return skip(`npm audit returned no JSON (exit ${res.status}): ${tail(res.output, 2) || "no output"}`);
    }
    const counts = report?.metadata?.vulnerabilities;
    if (!counts) {
      const reason = report?.error?.summary ?? report?.error?.code ?? report?.message ?? `exit ${res.status}`;
      return skip(`npm audit did not run: ${String(reason).split("\n")[0]}`);
    }
    const high = (counts.high ?? 0) + (counts.critical ?? 0);
    const summary = `${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low`;
    if (high > 0) {
      const names = Object.entries(report.vulnerabilities ?? {})
        .filter(([, v]) => v.severity === "high" || v.severity === "critical")
        .map(([n, v]) => `${n}@${v.severity}`);
      return fail(`${summary}: ${names.join(", ")}`);
    }
    return pass(summary);
  },
};

// ---------------------------------------------------------------- gates (§19)

const GATES = [
  {
    name: "code",
    blocking: true,
    description: "package typecheck (src + bin) and full package test suite",
    steps: [typecheckSrc, typecheckBin, vitestAll],
  },
  {
    name: "contract",
    blocking: true,
    description: "schema compatibility and measurement contract",
    steps: [vitestStep("schema contract", ["tests/schemas.test.ts", "tests/measurement-contract.test.ts"])],
  },
  {
    name: "security",
    blocking: true,
    description: "adversarial security tests, secret scan, production dependency audit",
    steps: [vitestGlobStep("security tests", "security-"), nodeScriptStep("secret scan", "secret-scan.mjs"), npmAudit],
  },
  {
    name: "cache",
    blocking: true,
    description: "reuse engine and cache invalidation",
    steps: [vitestStep("cache tests", ["tests/reuse-engine.test.ts", "tests/cache-invalidation.test.ts"])],
  },
  {
    name: "golden",
    blocking: true,
    description: "golden corpus structure, commit resolvability, judging status",
    steps: [
      nodeScriptStep("golden datasets check (core + extended + long-horizon)", "check-golden.mjs", ["--dataset", "all"]),
      nodeScriptStep("extended datasets reproducible", "gen-extended.mjs", ["--check"]),
      vitestStep("golden corpus tests", [], {
        optional: ["tests/golden-corpus.test.ts", "tests/datasets-extended.test.ts"],
      }),
    ],
  },
  { name: "chaos", blocking: true, description: "failure injection / degradation", steps: [vitestStep("chaos tests", ["tests/chaos.test.ts"])] },
  { name: "perf", blocking: true, description: "latency and token budgets", steps: [vitestStep("perf budget", ["tests/perf-budget.test.ts"])] },
  {
    name: "package",
    blocking: true,
    description: "build, npm pack, checksums, SBOM, provenance",
    steps: [nodeScriptStep("supply chain", "supply-chain.mjs")],
  },
];

// ---------------------------------------------------------------- runner

const RANK = { PASS: 0, SKIP: 1, FAIL: 2 };

function runGate(gate) {
  const started = Date.now();
  const steps = [];
  for (const step of gate.steps) {
    const t0 = Date.now();
    let r;
    try {
      r = step.exec();
    } catch (err) {
      r = fail(`${step.name}: ${err.message}`);
    }
    const s = { name: step.name, status: r.status, detail: r.detail, durationMs: Date.now() - t0 };
    steps.push(s);
    log(`    ${s.status.padEnd(4)} ${step.name} (${fmt(s.durationMs)})${s.detail ? ` - ${s.detail}` : ""}`);
  }
  const status = steps.reduce((acc, s) => (RANK[s.status] > RANK[acc] ? s.status : acc), "PASS");
  const reason = steps.filter((s) => s.status === status && status !== "PASS").map((s) => s.detail).join("; ");
  return { name: gate.name, blocking: gate.blocking, status, reason, durationMs: Date.now() - started, steps };
}

function fmt(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function main() {
  try {
    OPTS = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`release-gate: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const known = new Set(GATES.map((g) => g.name));
  if (OPTS.help) {
    process.stdout.write(`gates: ${[...known].join(", ")}\nflags: --only a,b --skip a,b --json --strict --verbose\n`);
    return;
  }
  const unknown = [...(OPTS.only ?? []), ...OPTS.skip].filter((g) => !known.has(g));
  if (unknown.length) {
    process.stderr.write(`release-gate: unknown gate(s): ${unknown.join(", ")} (known: ${[...known].join(", ")})\n`);
    process.exitCode = 2;
    return;
  }
  for (const entry of [VITEST, TSC]) {
    if (!existsSync(entry)) {
      process.stderr.write(`release-gate: ${entry} not found - run npm ci at the repo root first\n`);
      process.exitCode = 2;
      return;
    }
  }

  const started = Date.now();
  const results = [];
  for (const gate of GATES) {
    if ((OPTS.only && !OPTS.only.has(gate.name)) || OPTS.skip.has(gate.name)) {
      results.push({ name: gate.name, blocking: gate.blocking, status: "SKIP", reason: "deselected", durationMs: 0, steps: [] });
      continue;
    }
    log(`> gate ${gate.name}: ${gate.description}`);
    const r = runGate(gate);
    log(`  ${r.status} ${gate.name} (${fmt(r.durationMs)})`);
    results.push(r);
  }

  const blockingFailures = results.filter(
    (r) => r.blocking && (r.status === "FAIL" || (OPTS.strict && r.status === "SKIP" && r.reason !== "deselected")),
  );
  const ok = blockingFailures.length === 0;
  const report = {
    schema: "eff-agent-release-gate/v1",
    ok,
    strict: OPTS.strict,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    gates: results,
  };

  try {
    const outDir = join(packageDir, "artifacts");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "release-gate-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`release-gate: could not write report: ${err.message}\n`);
  }

  if (OPTS.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    log("");
    log("GATE      STATUS  BLOCKING  DURATION  DETAIL");
    log("--------  ------  --------  --------  ------");
    for (const r of results) {
      log(`${r.name.padEnd(8)}  ${r.status.padEnd(6)}  ${(r.blocking ? "yes" : "no").padEnd(8)}  ${fmt(r.durationMs).padEnd(8)}  ${r.reason ?? ""}`);
    }
    log("");
    log(
      ok
        ? `release-gate: OK (${fmt(report.durationMs)})`
        : `release-gate: BLOCKED by ${blockingFailures.map((r) => r.name).join(", ")} (${fmt(report.durationMs)})`,
    );
  }
  process.exitCode = ok ? 0 : 1;
}

main();
