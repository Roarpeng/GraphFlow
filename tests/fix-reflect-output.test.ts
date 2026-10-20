/**
 * Regression tests for task reflection output fidelity (G1/D8/D10).
 *
 * G1: the compiled runner used to end with a single `PASS ...` line, which the
 *     output dehydrator collapsed to, losing the actual command result. The
 *     runner now prints `## step N: <cmd>` / output / `[exit=N]`, and `reflect`
 *     returns that payload verbatim for small outputs.
 * D8: instruction identity must not truncate words to stems (`tree` -> `tre`,
 *     `files` -> `fil`, `source` -> `sourc`); word order changes must still
 *     match at >= 0.85.
 * D10: `task --help` documents subcommands/options in <= 15 lines.
 *
 * Standalone: `node --import tsx tests/fix-reflect-output.test.ts`.
 * Fixtures live under `tmpdir()` and are removed afterwards.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  bestTaskSimilarity,
  findTask,
  normalizeInstructionKey,
  recordTaskUse,
  runTask,
} from "../src/task-reflector.js";

const REPO_ROOT = join(__dirname, "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

const INSTRUCTION = "check working tree status and count typescript files in source";
const REORDERED = "count typescript files in source and check git status";
const STEPS = [`node -e "console.log('?? .graphflow/')"`, `node -e "console.log(24)"`];

const createdRoots: string[] = [];
let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-fix-reflect-"));
  createdRoots.push(root);
  mkdirSync(join(root, "source"), { recursive: true });
  for (const name of ["a.ts", "b.ts", "c.ts"]) {
    writeFileSync(join(root, "source", name), `export const ${name[0]} = 1;\n`, "utf8");
  }
  return root;
}

function promote(root: string): string {
  recordTaskUse(root, INSTRUCTION, STEPS);
  const record = recordTaskUse(root, INSTRUCTION, STEPS);
  assert(record.scriptPath, "second use must compile a runner");
  return join(root, record.scriptPath);
}

/** Rough token estimate used by the project (4 chars ≈ 1 token). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
  });
}

function main(): void {
  try {
    testReflectKeepsStepOutput();
    testWordOrderSimilarity();
    testHelp();
  } finally {
    for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
  }
  const total = 3;
  console.log(`\n${total - failures}/${total} fix-reflect checks passed.`);
  if (failures > 0) process.exit(1);
}

function testReflectKeepsStepOutput(): void {
  check("reflect keeps per-step output and does not inflate small results", () => {
    const root = makeRoot();
    const scriptPath = promote(root);

    // Raw runner payload (before reflect): the baseline this feature must preserve.
    const runner = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      windowsHide: true,
    });
    assert(runner.status === 0, `runner failed: ${runner.stderr}`);
    const rawRunnerOutput = runner.stdout;

    const run = runTask(root, INSTRUCTION);
    assert(run.hit, `expected a hit: ${run.text}`);
    assert(run.exitCode === 0, `expected exit 0: ${run.text}`);
    assert(run.text.includes("24"), `step output must survive reflection:\n${run.text}`);
    assert(run.text.includes("?? .graphflow/"), `first step output must survive:\n${run.text}`);
    assert(run.text.includes("[exit=0]"), `per-step exit marker missing:\n${run.text}`);
    assert(run.text.includes("## step 2:"), `per-step header missing:\n${run.text}`);
    assert(run.text.includes("# Reflected Task"), `header missing:\n${run.text}`);

    const ratio = estimateTokens(run.text) / estimateTokens(rawRunnerOutput);
    assert(
      ratio <= 1.5,
      `reflected text inflated the runner output: ${ratio.toFixed(2)}x ` +
        `(${estimateTokens(run.text)} vs ${estimateTokens(rawRunnerOutput)} tokens)`
    );
  });
}

function testWordOrderSimilarity(): void {
  check("word-order permutations keep >= 0.85 similarity and hit", () => {
    const root = makeRoot();
    promote(root);

    const key = normalizeInstructionKey(INSTRUCTION);
    for (const word of ["tree", "file", "source", "typescript"]) {
      assert(key.split(" ").includes(word), `normalization must keep '${word}': ${key}`);
    }
    for (const broken of ["tre", "fil", "sourc"]) {
      assert(!key.split(" ").includes(broken), `normalization must not truncate to '${broken}': ${key}`);
    }

    // Same words, different order -> identical set (1.0).
    const sameWords = "count typescript files in source and check working tree status";
    assert(bestTaskSimilarity(root, sameWords) >= 0.86, "reordered identical words must keep >= 0.86");

    // One substituted word (`working tree` -> `git`) stays below the 0.86 gate:
    // a near miss must not replay a runner that would answer a different question.
    const score = bestTaskSimilarity(root, REORDERED);
    assert(
      score > 0 && score < 0.86,
      `substituted-word probe should stay under the gate, got ${score.toFixed(3)}`
    );
    assert(!findTask(root, REORDERED), `substituted instruction must stay a MISS (score=${score.toFixed(3)})`);
  });
}

function testHelp(): void {
  check("task --help documents commands/options in <= 15 lines", () => {
    const root = makeRoot();
    const help = runCli(root, ["task", "--help"]);
    assert(help.status === 0, `help exit=${help.status} stderr=${help.stderr}`);
    const output = (help.stdout ?? "").trimEnd();
    const lines = output.split("\n");
    assert(lines.length <= 15, `help must stay short, got ${lines.length} lines:\n${output}`);
    for (const expected of ["list", "show", "record", "run", "log", "harvest"]) {
      assert(output.includes(expected), `help missing subcommand '${expected}':\n${output}`);
    }
    for (const expected of ["--step", "--json", "--root", "--log", "repeatable"]) {
      assert(output.includes(expected), `help missing '${expected}':\n${output}`);
    }
    const short = runCli(root, ["task", "-h"]);
    assert(short.status === 0, `-h exit=${short.status}`);
    assert((short.stdout ?? "").includes("--step"), `-h must print the same help`);
  });
}

main();
