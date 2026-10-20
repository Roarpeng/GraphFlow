/**
 * Regression tests for the real-repository evaluation fixes that live in the CLI layer:
 *
 *   A1  `test/` (singular) is a test directory, and a zero-match router result is NONE, not PASS
 *   T1  `graphflow exec --run` propagates the child exit code
 *   T2  Windows absolute stack paths attach the failure source window
 *   I2  an unknown MCP tool is a protocol-level error (`isError: true`)
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dehydrateCommandOutput, resolveAffectedTests } from "../src/dehydrator.js";
import { executeV3ToolCall } from "../src/mcp-tools.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

/** A repo whose tests live in `test/` (singular), imported through two intermediate modules. */
function makeRoutingRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-routing-fix-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export const util = (): number => 1;\n", "utf8");
  writeFileSync(
    join(root, "src", "core.ts"),
    'import { util } from "./util.js";\nexport const core = (): number => util() + 1;\n',
    "utf8"
  );
  writeFileSync(
    join(root, "src", "index.ts"),
    'import { core } from "./core.js";\nexport const entry = (): number => core() + 1;\n',
    "utf8"
  );
  writeFileSync(
    join(root, "test", "flow.ts"),
    'import { entry } from "../src/index.js";\nconsole.log(entry());\n',
    "utf8"
  );
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=gf", "-c", "user.email=gf@example.invalid", "commit", "-q", "-m", "seed"]);
  return root;
}

check("A1: singular test/ routes a three-hop source change to its test", () => {
  const root = makeRoutingRepo();
  try {
    writeFileSync(
      join(root, "src", "util.ts"),
      "export const util = (): number => 1;\nexport const extra = (): number => 2;\n",
      "utf8"
    );
    const result = resolveAffectedTests(root);
    assert.deepEqual(result.changedFiles, ["src/util.ts"]);
    assert.deepEqual(result.affectedTests, ["test/flow.ts"], "deep import chain must reach test/flow.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("A1: zero matches are reported as NONE, never as a green PASS", () => {
  // A workspace with no test files at all: zero is the correct answer and must say so.
  const root = mkdtempSync(join(tmpdir(), "gf-routing-none-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "solo.ts"), "export const solo = 1;\n", "utf8");
    git(root, ["init", "-q"]);
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=gf", "-c", "user.email=gf@example.invalid", "commit", "-q", "-m", "seed"]);

    const res = executeV3ToolCall(
      "gf_exec",
      { cmd: "affected-tests", changedFiles: ["src/solo.ts"], rootDir: root },
      root
    );
    const text = res.content[0]!.text;
    assert.ok(text.startsWith("NONE [affected-tests]"), `unexpected receipt:\n${text}`);
    assert.ok(!text.startsWith("PASS"), "a broken router must not look like a passing run");
    assert.match(text, /test\//, "NONE receipt should name the conventions it checked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("T1: gf_exec exposes the child exit code and the CLI propagates it", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-exec-exit-"));
  try {
    const res = executeV3ToolCall(
      "gf_exec",
      { cmd: 'node -e "process.exit(3)"', run: true, rootDir: root },
      root
    );
    assert.equal(res.structuredContent?.exitCode, 3, "gf_exec must carry the real exit code");

    const tsxLoader = pathToFileURL(
      join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")
    ).href;
    const cli = join(process.cwd(), "src", "cli.ts");
    const child = spawnSync(
      process.execPath,
      ["--import", tsxLoader, cli, "exec", 'node -e "process.exit(3)"', "--run"],
      { cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true }
    );
    assert.equal(child.status, 3, `CLI must exit 3, got ${child.status}\n${child.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("T2: a Windows absolute stack frame attaches the failure source window", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-win-stack-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const file = join(root, "src", "boom.ts");
    writeFileSync(
      file,
      ["export function boom(): void {", "  const x = 1;", "  throw new Error('boom');", "}", ""].join("\n"),
      "utf8"
    );
    const stackPath = file.replace(/\\/g, "\\");
    const result = dehydrateCommandOutput({
      rootDir: root,
      command: "node run.js",
      exitCode: 1,
      durationMs: 12,
      stdout: "",
      stderr: `Error: boom\n    at boom (${stackPath}:3:9)\n    at node:internal/main/run_main_module:28:49\n`,
    });
    assert.ok(
      result.text.includes("Auto-Attached Failure Source Context"),
      `source window missing:\n${result.text}`
    );
    assert.match(result.text, /\b3: +throw new Error\('boom'\)/, "the failing line must be shown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("I2: an unknown MCP tool is a protocol-level error", () => {
  const res = executeV3ToolCall("gf_does_not_exist", {}, process.cwd());
  assert.equal(res.isError, true, "unknown tool must set isError");
  assert.equal(res.structuredContent?.ok, false);
  assert.match(res.content[0]!.text, /unknown-v3-tool/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
