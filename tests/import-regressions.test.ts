/**
 * Regression coverage for import-shape edge cases found during the 3.3.1
 * blast-radius rewrite: namespace imports (`import * as ns`) and C/C++ header
 * includes across directories. Both used to be either missed or counted as
 * declarations.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeBlastRadius, getWorkspaceAstIndex } from "../src/index.js";

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

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

check("TS namespace import: `import * as m; m.foo()` is a call site", () => {
  const root = makeRoot("gf-ns-import-");
  try {
    write(root, "ts/mod.ts", "export function foo(): number { return 1; }\n");
    write(
      root,
      "ts/use.ts",
      'import * as m from "./mod";\n\nexport function run(): number {\n  return m.foo();\n}\n'
    );
    const index = getWorkspaceAstIndex(root);
    const blast = computeBlastRadius(index, "ts/mod.ts", "foo");
    assert.equal(blast.totalCallSites, 1, "namespace member call must be counted");
    assert.equal(blast.callSites[0]?.file, "ts/use.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("C/C++ cross-directory header: member call found, declaration not counted", () => {
  const root = makeRoot("gf-cpp-header-");
  try {
    write(root, "include/engine.hpp", "class Engine {\npublic:\n  bool cancel(int id);\n};\n");
    write(
      root,
      "src/engine.cpp",
      '#include "../include/engine.hpp"\n\nbool Engine::cancel(int id) {\n  return id > 0;\n}\n'
    );
    write(
      root,
      "src/use.cpp",
      '#include "../include/engine.hpp"\n\nvoid f() {\n  Engine e;\n  e.cancel(1);\n}\n'
    );
    const index = getWorkspaceAstIndex(root);
    const blast = computeBlastRadius(index, "src/engine.cpp", "cancel");
    assert.equal(blast.totalCallSites, 1, "only the real call in use.cpp should count");
    assert.equal(blast.callSites[0]?.file, "src/use.cpp");
    assert.ok(
      !blast.callSites.some((site) => site.file === "include/engine.hpp"),
      "the header declaration must not be a call site"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
