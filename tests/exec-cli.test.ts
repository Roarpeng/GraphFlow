/**
 * Focused regression tests for:
 *  1. The dehydrated failure-source window (`Error:` + stack frame, lone
 *     locations, Python tracebacks, dedupe and the 3-location cap).
 *  2. CLI argv parsing: `graphflow exec` must not leak `--root <dir>` values
 *     into the wrapped command, and `uninstall`/`read` flags must parse cleanly.
 *
 * Standalone: `npx tsx tests/exec-cli.test.ts`.
 *
 * These tests only call pure parsers plus `dehydrateCommandOutput`; no
 * install/uninstall code path runs, so no real HOME or ~/.dsh is ever touched.
 * `src/cli.ts` auto-executes only when it is the Node entry point
 * (`require.main === module`), so importing it here is side-effect free.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseExecArgs,
  parseReadArgs,
  parseUninstallArgs,
} from "../src/cli.js";
import { dehydrateCommandOutput } from "../src/dehydrator.js";

const results: Array<{ name: string; ok: boolean }> = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`FAIL ${name}\n${detail}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SOURCE_CONTEXT_HEADER = "# Auto-Attached Failure Source Context:";

function makeFailureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-exec-cli-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "py"), { recursive: true });
  writeFileSync(
    join(root, "tests", "fail.js"),
    ["function run() {", "  const received = 7;", "  assert(received === 42);", "}", "run();", ""].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "py", "app.py"),
    ["def main():", "    raise ValueError('boom')", "", "main()", ""].join("\n"),
    "utf8"
  );
  // Extra files used to prove the 3-location cap.
  for (const name of ["f1.js", "f2.js", "f3.js", "f4.js"]) {
    writeFileSync(join(root, "tests", name), `// ${name}\nmodule.exports = 1;\n`, "utf8");
  }
  return root;
}

function run(root: string, stderr: string, exitCode = 1) {
  return dehydrateCommandOutput({
    rootDir: root,
    command: "node tests/run.js",
    exitCode,
    durationMs: 42,
    stdout: "",
    stderr,
  });
}

function testDehydrator(): void {
  const root = makeFailureWorkspace();
  try {
    check("Failure source: Error line followed by a stack frame attaches context", () => {
      const result = run(
        root,
        "Error: expected 42 but received 7\n    at run (tests/fail.js:3:9)\n"
      );
      assert(!result.ok, "failure output must be ok=false");
      assert(
        result.text.includes(SOURCE_CONTEXT_HEADER),
        `expected failure source header, got:\n${result.text}`
      );
      assert(
        result.text.includes("// tests/fail.js:3"),
        `expected location header for tests/fail.js:3, got:\n${result.text}`
      );
      assert(
        result.text.includes("assert(received === 42)"),
        `expected source window content, got:\n${result.text}`
      );
    });

    check("Failure source: lone location still attaches context", () => {
      const result = run(root, "    at run (tests/fail.js:2:5)\n");
      assert(result.text.includes(SOURCE_CONTEXT_HEADER), "lone location must attach context");
      assert(result.text.includes("// tests/fail.js:2"), "lone location must resolve file:line");
      assert(
        result.text.includes("const received = 7;"),
        `expected line 2 source content, got:\n${result.text}`
      );
    });

    check("Failure source: Python traceback File/line attaches context", () => {
      const result = run(
        root,
        [
          "Traceback (most recent call last):",
          '  File "py/app.py", line 2, in <module>',
          "    main()",
          "ValueError: boom",
          "",
        ].join("\n")
      );
      assert(result.text.includes(SOURCE_CONTEXT_HEADER), "Python traceback must attach context");
      assert(result.text.includes("// py/app.py:2"), `expected py/app.py:2, got:\n${result.text}`);
      assert(
        result.text.includes("raise ValueError('boom')"),
        `expected Python source line, got:\n${result.text}`
      );
    });

    check("Failure source: duplicate locations are deduped", () => {
      const result = run(
        root,
        [
          "Error: first",
          "    at run (tests/fail.js:3:9)",
          "Error: second",
          "    at run (tests/fail.js:3:9)",
          "",
        ].join("\n")
      );
      assertEqual(
        countOccurrences(result.text, "// tests/fail.js:3"),
        1,
        "the same file:line must only be attached once"
      );
    });

    check("Failure source: at most 3 locations are attached", () => {
      const result = run(
        root,
        [
          "Error: boom",
          "    at f1 (tests/f1.js:2:1)",
          "    at f2 (tests/f2.js:2:1)",
          "    at f3 (tests/f3.js:2:1)",
          "    at f4 (tests/f4.js:2:1)",
          "",
        ].join("\n")
      );
      const headers = ["f1.js", "f2.js", "f3.js", "f4.js"].filter((name) =>
        result.text.includes(`// tests/${name}`)
      );
      assertEqual(headers.length, 3, `at most 3 source windows, got ${headers.join(", ")}`);
    });

    check("Failure source: workspace frames are not dropped from the kept error lines", () => {
      const result = run(root, "Error: expected 42 but received 7\n    at run (tests/fail.js:3:9)\n");
      assert(
        result.text.includes("at run (tests/fail.js:3:9)"),
        "the consumed stack frame must remain in the visible error lines"
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testExecParsing(): void {
  check("exec: --root value is excluded from the wrapped command", () => {
    const parsed = parseExecArgs(["--root", "C:\\work\\repo", "npm", "test"]);
    assertEqual(parsed.cmd, "npm test", "cmd must not contain the --root value");
    assertEqual(parsed.rootDir, "C:\\work\\repo", "rootDir must capture the --root value");
    assertEqual(parsed.run, false, "run defaults to false");
  });

  check("exec: no command falls back to affected-tests", () => {
    assertEqual(parseExecArgs([]).cmd, "affected-tests", "default command");
    assertEqual(parseExecArgs(["--run"]).cmd, "affected-tests", "default command with --run");
    assertEqual(parseExecArgs(["--run"]).run, true, "--run must parse");
  });

  check("exec: flags are skipped and the remaining positionals are joined", () => {
    const parsed = parseExecArgs([
      "--run",
      "--no-color",
      "--root",
      "/tmp/ws",
      "npx",
      "vitest",
      "run",
      "tests/a.test.ts",
    ]);
    assertEqual(parsed.cmd, "npx vitest run tests/a.test.ts", "only positionals belong to cmd");
    assertEqual(parsed.run, true, "--run must parse");
    assertEqual(parsed.rootDir, "/tmp/ws", "--root value must parse");
  });

  check("exec: --root=<dir> form is supported", () => {
    const parsed = parseExecArgs(["--root=/tmp/ws", "node", "check.js"]);
    assertEqual(parsed.cmd, "node check.js", "cmd must stay clean");
    assertEqual(parsed.rootDir, "/tmp/ws", "inline --root value must parse");
  });

  check("exec: -- terminator forwards everything to the command", () => {
    const parsed = parseExecArgs(["--run", "--root", "/tmp/ws", "node", "check.js", "--", "-t", "smoke"]);
    assertEqual(parsed.cmd, "node check.js -t smoke", "tokens after -- are forwarded verbatim");
    assertEqual(parsed.rootDir, "/tmp/ws", "--root before -- still parses");
  });
}

function testUninstallParsing(): void {
  check("uninstall: no flags means detected agents only", () => {
    const parsed = parseUninstallArgs([]);
    assertEqual(parsed.all, false, "--all defaults to false");
    assertEqual(parsed.agentIds, undefined, "agentIds defaults to undefined");
    assertEqual(parsed.rootDir, undefined, "rootDir defaults to undefined");
  });

  check("uninstall: --all parses", () => {
    const parsed = parseUninstallArgs(["--all"]);
    assertEqual(parsed.all, true, "--all must parse");
    assertEqual(parsed.agentIds, undefined, "no agentIds with --all");
  });

  check("uninstall: --agents CSV plus --root parses", () => {
    const parsed = parseUninstallArgs([
      "--agents",
      "cursor, claude-code ,deepseek-harness",
      "--root",
      "C:\\work\\repo",
    ]);
    assertEqual(
      JSON.stringify(parsed.agentIds),
      JSON.stringify(["cursor", "claude-code", "deepseek-harness"]),
      "agent ids must be split and trimmed"
    );
    assertEqual(parsed.rootDir, "C:\\work\\repo", "--root value must parse");
    assertEqual(parsed.all, false, "agent-scoped uninstall is not --all");
  });

  check("uninstall: --agents=<ids> inline form parses", () => {
    const parsed = parseUninstallArgs(["--agents=deepseek-harness"]);
    assertEqual(
      JSON.stringify(parsed.agentIds),
      JSON.stringify(["deepseek-harness"]),
      "inline csv form must parse"
    );
  });

  check("uninstall: empty --agents is treated as unset", () => {
    const parsed = parseUninstallArgs(["--agents", " , "]);
    assertEqual(parsed.agentIds, undefined, "empty CSV must not scope uninstall");
  });
}

function testReadParsing(): void {
  check("read: -q value and --root value are excluded from targets", () => {
    const parsed = parseReadArgs(["-q", "token budget", "--root", "/tmp/ws", "src/a.ts", "src/b.ts"]);
    assertEqual(JSON.stringify(parsed.targets), JSON.stringify(["src/a.ts", "src/b.ts"]), "targets");
    assertEqual(parsed.q, "token budget", "-q value must parse");
    assertEqual(parsed.rootDir, "/tmp/ws", "--root value must parse");
    assertEqual(parsed.skeleton, false, "skeleton defaults to false");
  });

  check("read: boolean flags parse without leaking into targets", () => {
    const parsed = parseReadArgs(["src/a.ts#sym", "--skeleton", "--dedup"]);
    assertEqual(JSON.stringify(parsed.targets), JSON.stringify(["src/a.ts#sym"]), "targets");
    assertEqual(parsed.skeleton, true, "--skeleton must parse");
    assertEqual(parsed.dedup, true, "--dedup must parse");
  });
}

function main(): void {
  testDehydrator();
  testExecParsing();
  testUninstallParsing();
  testReadParsing();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} exec-cli checks passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
