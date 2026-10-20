/**
 * GraphFlow — blast-radius alias / constructor regressions (`tests/fix-slicer-blast.test.ts`)
 *
 * Covers:
 *   R3  `pkg.url_for` / `alias.fn()` counts when the alias resolves to the module that
 *       re-exports the target, including `import x as alias`;
 *   E6  `this.method()` inside a constructor resolves to the enclosing class.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeBlastRadius, getWorkspaceAstIndex } from "../src/index.js";

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
  const root = mkdtempSync(join(tmpdir(), "gf-fix-blast-"));
  roots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

run("R3 python module alias counts attribute calls after re-export resolution", () => {
  const root = workspace({
    "src/pkg/__init__.py": "from .helpers import target_fn as target_fn\n",
    "src/pkg/helpers.py": "def target_fn(value):\n    return value\n",
    "tests/test_use.py": [
      "import pkg",
      "import pkg as aliased",
      "",
      "def run():",
      "    pkg.target_fn(1)",
      "    aliased.target_fn(2)",
      "    other.target_fn(3)",
      "",
    ].join("\n"),
  });
  const index = getWorkspaceAstIndex(root);
  const blast = computeBlastRadius(index, "src/pkg/helpers.py", "target_fn");
  assert(blast.totalCallSites === 2, `expected 2 resolved alias calls, got ${blast.totalCallSites}`);
  assert(
    blast.callSites.every((site) => site.file === "tests/test_use.py"),
    "both call sites should come from the test file"
  );
});

run("E6 this.method() inside a constructor counts for the enclosing class", () => {
  const root = workspace({
    "src/options.ts": [
      "export class Options {",
      "  constructor() {",
      "    this.merge({});",
      "  }",
      "",
      "  merge(options: unknown): void {",
      "    void options;",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  const index = getWorkspaceAstIndex(root);
  const blast = computeBlastRadius(index, "src/options.ts", "merge");
  assert(blast.totalCallSites === 1, `expected the constructor call, got ${blast.totalCallSites}`);
  assert(blast.callSites[0]?.caller === "constructor", `unexpected caller ${blast.callSites[0]?.caller}`);
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
