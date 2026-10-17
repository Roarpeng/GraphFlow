/**
 * P2 parser-matrix smoke test.
 *
 * - `graphflow doctor parsers` (source via tsx) must report the parser backends.
 * - `node scripts/verify-parsers.mjs --json` must pass when dist is built; if dist
 *   is absent (e.g. `npm test` before `npm run build`), that part is skipped.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
    shell: false,
  });
}

check("doctor parsers reports core, all six grammars, and the default engine", () => {
  const result = run(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "parsers"]);
  assert.equal(result.status, 0, `doctor parsers failed: ${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  for (const grammar of [
    "tree-sitter-python",
    "tree-sitter-go",
    "tree-sitter-rust",
    "tree-sitter-c",
    "tree-sitter-cpp",
    "tree-sitter-c-sharp",
  ]) {
    assert.ok(output.includes(grammar), `doctor output must mention ${grammar}`);
  }
  assert.match(output, /tree-sitter core:/);
  assert.match(output, /default engine:/);
  assert.match(output, /TS\/JS: @babel\/parser/);
});

check("verify-parsers passes both true-AST and structural-fallback modes", () => {
  const dist = join(repoRoot, "dist", "index.js");
  if (!existsSync(dist)) {
    console.log("    (skipped: dist/index.js missing; run npm run build)");
    return;
  }
  const result = run(process.execPath, ["scripts/verify-parsers.mjs", "--json"]);
  assert.equal(result.status, 0, `verify-parsers failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout) as {
    ok: boolean;
    results: Array<{ language: string; engine: string; fallbackEngine: string; failed: string[] }>;
  };
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 6);
  for (const entry of report.results) {
    assert.equal(entry.failed.length, 0, `${entry.language}: ${entry.failed.join(", ")}`);
    assert.equal(entry.fallbackEngine, "structural", `${entry.language} fallback engine`);
    assert.ok(["tree-sitter", "structural"].includes(entry.engine), `${entry.language} engine`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
