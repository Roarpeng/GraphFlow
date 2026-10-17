/**
 * Focused tests for the diff-to-test impact router (`resolveAffectedTests`) and
 * the runner-aware affected-test command builder (`buildAffectedTestCommand`).
 *
 * Coverage: tsconfig/jsconfig path aliases (`@/*`, `~/*`), dynamic
 * `import(...)` / `require(...)`, `__tests__` + `spec/` conventions,
 * `.test.mts`/`.cts`, Python/Go/C# test conventions, package.json runner
 * selection, and the empty-diff case.
 *
 * Standalone: `npx tsx tests/affected-tests.test.ts`.
 * All fixtures live under `tmpdir()` and are removed afterwards.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAffectedTestCommand, resolveAffectedTests } from "../src/dehydrator.js";

const results: Array<{ name: string; ok: boolean }> = [];
const createdRoots: string[] = [];

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

function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gf-affected-"));
  createdRoots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = join(root, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return root;
}

function assertAffected(
  root: string,
  changed: string[],
  expectedTests: string[],
  label: string
): void {
  const resolved = resolveAffectedTests(root, changed);
  const expected = [...expectedTests].sort();
  assertEqual(
    JSON.stringify(resolved.affectedTests),
    JSON.stringify(expected),
    `${label}: affected tests mismatch`
  );
}

function testTsconfigPathAlias(): void {
  check("tsconfig path alias @/* routes a changed source to its 2-hop test", () => {
    const tsconfig = [
      "{",
      "  // path aliases (JSONC: comments + trailing commas must parse)",
      '  "compilerOptions": {',
      '    "baseUrl": ".",',
      '    "paths": {',
      '      "@/*": ["src/*"],',
      "    },",
      "  },",
      "}",
    ].join("\n");
    const root = makeWorkspace({
      "tsconfig.json": tsconfig,
      "src/model.ts": "export interface Model { id: number }\nexport const makeModel = (): Model => ({ id: 1 });\n",
      "src/app.ts": 'import { makeModel } from "@/model";\nexport const run = () => makeModel();\n',
      "tests/app.test.ts": 'import { run } from "../src/app";\nrun();\n',
    });
    assertAffected(root, ["src/model.ts"], ["tests/app.test.ts"], "tsconfig alias");
    // A test file changed directly is always returned.
    assertAffected(root, ["tests/app.test.ts"], ["tests/app.test.ts"], "changed test file");
  });

  check("jsconfig path alias ~/* routes through an intermediate module", () => {
    const root = makeWorkspace({
      "jsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "~/*": ["lib/*"] } },
      }),
      "lib/tool.js": "export const tool = () => 1;\n",
      "src/use.js": 'import { tool } from "~/tool";\nexport const use = () => tool();\n',
      "tests/use.spec.js": 'import { use } from "../src/use.js";\nuse();\n',
    });
    assertAffected(root, ["lib/tool.js"], ["tests/use.spec.js"], "jsconfig alias");
  });

  check("tsconfig non-root baseUrl and baseUrl-only resolution work", () => {
    const baseUrlPaths = makeWorkspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: "src", paths: { "~/model": ["model"] } },
      }),
      "src/model.ts": "export const model = 1;\n",
      "src/app.ts": 'import { model } from "~/model";\nexport const app = model;\n',
      "tests/app.test.ts": 'import { app } from "../src/app";\n',
    });
    assertAffected(baseUrlPaths, ["src/model.ts"], ["tests/app.test.ts"], "non-root baseUrl");

    const baseUrlOnly = makeWorkspace({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "src/data.ts": "export const data = 1;\n",
      "src/consumer.ts": 'import { data } from "src/data";\nexport const c = data;\n',
      "tests/consumer.test.ts": 'import { c } from "../src/consumer";\n',
    });
    assertAffected(baseUrlOnly, ["src/data.ts"], ["tests/consumer.test.ts"], "baseUrl-only");
  });
}

function testTsconfigInheritance(): void {
  check("extends chain inherits paths from a relative base config", () => {
    const root = makeWorkspace({
      "base.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
      "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
      "src/model.ts": "export const model = 1;\n",
      "src/app.ts": 'import { model } from "@/model";\nexport const app = model;\n',
      "tests/app.test.ts": 'import { app } from "../src/app";\n',
    });
    assertAffected(root, ["src/model.ts"], ["tests/app.test.ts"], "extends relative base");
  });

  check("child config paths override the extended base", () => {
    const root = makeWorkspace({
      "base.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["lib/*"] } } }),
      "tsconfig.json": JSON.stringify({
        extends: "./base.json",
        compilerOptions: { paths: { "@/*": ["src/*"] } },
      }),
      "lib/model.ts": "export const model = 'lib';\n",
      "src/model.ts": "export const model = 'src';\n",
      "src/app.ts": 'import { model } from "@/model";\nexport const app = model;\n',
      "tests/app.test.ts": 'import { app } from "../src/app";\n',
    });
    assertAffected(root, ["src/model.ts"], ["tests/app.test.ts"], "child paths override");
    // The overridden base target must no longer be linked through the alias.
    assertAffected(root, ["lib/model.ts"], [], "overridden base target");
  });

  check("extends resolves a node_modules package config (package.json tsconfig field)", () => {
    const root = makeWorkspace({
      "base.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
      "node_modules/@cfg/base/package.json": JSON.stringify({
        name: "@cfg/base",
        tsconfig: "./tsconfig.json",
      }),
      "node_modules/@cfg/base/tsconfig.json": JSON.stringify({ extends: "../../../base.json" }),
      "tsconfig.json": JSON.stringify({ extends: "@cfg/base" }),
      "src/model.ts": "export const model = 1;\n",
      "src/app.ts": 'import { model } from "@/model";\nexport const app = model;\n',
      "tests/app.test.ts": 'import { app } from "../src/app";\n',
    });
    assertAffected(root, ["src/model.ts"], ["tests/app.test.ts"], "node_modules extends");
  });

  check("nested package tsconfig wins over the workspace root config", () => {
    const root = makeWorkspace({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#/*": ["root-src/*"] } } }),
      "root-src/model.ts": "export const model = 'root';\n",
      "src/consumer.ts": 'import { model } from "#/model";\nexport const c = model;\n',
      "tests/consumer.test.ts": 'import { c } from "../src/consumer";\n',
      "packages/foo/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "#/*": ["./src/*"] } },
      }),
      "packages/foo/src/model.ts": "export const model = 'pkg';\n",
      "packages/foo/src/app.ts": 'import { model } from "#/model";\nexport const app = model;\n',
      "packages/foo/tests/app.test.ts": 'import { app } from "../src/app";\n',
    });
    assertAffected(
      root,
      ["packages/foo/src/model.ts"],
      ["packages/foo/tests/app.test.ts"],
      "nested package alias"
    );
    // Files outside the nested project keep using the workspace root config.
    assertAffected(root, ["root-src/model.ts"], ["tests/consumer.test.ts"], "root alias outside package");
  });

  check("project references config aliases are considered for root files", () => {
    const root = makeWorkspace({
      "tsconfig.json": JSON.stringify({ references: [{ path: "./packages/foo" }] }),
      "packages/foo/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@foo/*": ["./src/*"] } },
      }),
      "packages/foo/src/model.ts": "export const model = 1;\n",
      "src/consumer.ts": 'import { model } from "@foo/model";\nexport const c = model;\n',
      "tests/consumer.test.ts": 'import { c } from "../src/consumer";\n',
    });
    assertAffected(root, ["packages/foo/src/model.ts"], ["tests/consumer.test.ts"], "references");
  });

  check("extends cycles terminate and still apply the inherited alias", () => {
    const startedAt = Date.now();
    const root = makeWorkspace({
      "tsconfig.json": JSON.stringify({ extends: "./config/a.json" }),
      "config/a.json": JSON.stringify({ extends: "./b.json" }),
      "config/b.json": JSON.stringify({
        extends: "./a.json",
        compilerOptions: { paths: { "@/*": ["../src/*"] } },
      }),
      "src/model.ts": "export const model = 1;\n",
      "src/app.ts": 'import { model } from "@/model";\nexport const app = model;\n',
      "tests/app.test.ts": 'import { app } from "../src/app";\n',
    });
    assertAffected(root, ["src/model.ts"], ["tests/app.test.ts"], "extends cycle");
    assert(Date.now() - startedAt < 5000, "extends cycle must resolve quickly instead of hanging");
  });

  check("jsconfig extends chain inherits baseUrl/paths", () => {
    const root = makeWorkspace({
      "jsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "~/*": ["lib/*"] } },
      }),
      "jsconfig.json": JSON.stringify({ extends: "./jsconfig.base.json" }),
      "lib/tool.js": "export const tool = () => 1;\n",
      "src/use.js": 'import { tool } from "~/tool";\nexport const use = () => tool();\n',
      "tests/use.spec.js": 'import { use } from "../src/use.js";\n',
    });
    assertAffected(root, ["lib/tool.js"], ["tests/use.spec.js"], "jsconfig extends");
  });
}

function testDynamicImports(): void {
  check("dynamic import() and require() specifiers are routed", () => {
    const root = makeWorkspace({
      "src/foo.ts": "export const foo = 1;\n",
      "tests/unit/dynamic.test.ts":
        'test("foo", async () => {\n  const mod = await import("../../src/foo");\n  expect(mod.foo).toBe(1);\n});\n',
      "tests/unit/require.test.js": 'const { foo } = require("../../src/foo");\nmodule.exports = foo;\n',
    });
    assertAffected(
      root,
      ["src/foo.ts"],
      ["tests/unit/dynamic.test.ts", "tests/unit/require.test.js"],
      "dynamic import/require"
    );
  });
}

function testTestDirectories(): void {
  check("__tests__ directory convention routes and returns changed test files", () => {
    const root = makeWorkspace({
      "src/foo.ts": "export const foo = 1;\n",
      "__tests__/foo.test.ts": 'import { foo } from "../src/foo";\nexpect(foo).toBe(1);\n',
      "__tests__/setup.ts": "export const setup = true;\n",
    });
    assertAffected(root, ["src/foo.ts"], ["__tests__/foo.test.ts"], "__tests__ importer");
    assertAffected(root, ["__tests__/setup.ts"], ["__tests__/setup.ts"], "__tests__ changed file");
  });

  check("spec/ directory convention routes and returns changed test files", () => {
    const root = makeWorkspace({
      "src/baz.ts": "export const baz = 1;\n",
      "spec/baz.test.ts": 'import { baz } from "../src/baz";\nexpect(baz).toBe(1);\n',
      "spec/helpers.ts": "export const helpers = true;\n",
    });
    assertAffected(root, ["src/baz.ts"], ["spec/baz.test.ts"], "spec/ importer");
    assertAffected(root, ["spec/helpers.ts"], ["spec/helpers.ts"], "spec/ changed file");
  });

  check(".test.mts / .test.cts convention routes despite the shared index skipping them", () => {
    const root = makeWorkspace({
      "src/bar.ts": "export const bar = 1;\n",
      "tests/bar.test.mts": 'import { bar } from "../src/bar";\nbar();\n',
      "src/qux.cts": "export const qux = 1;\n",
      "tests/qux.test.cts": 'import { qux } from "../src/qux";\nqux();\n',
    });
    assertAffected(root, ["src/bar.ts"], ["tests/bar.test.mts"], ".test.mts");
    assertAffected(root, ["src/qux.cts"], ["tests/qux.test.cts"], ".test.cts");
  });
}

function testLanguageTestConventions(): void {
  check("Python foo.py routes test_foo.py and foo_test.py", () => {
    const root = makeWorkspace({
      "py/foo.py": "def foo():\n    return 1\n",
      "py/test_foo.py": "from .foo import foo\n\ndef test_foo():\n    assert foo() == 1\n",
      "py/foo_test.py": "import foo\n\ndef test_two():\n    assert foo.foo() == 1\n",
    });
    assertAffected(root, ["py/foo.py"], ["py/foo_test.py", "py/test_foo.py"], "python");
  });

  check("Go foo_test.go in the same package dir is routed", () => {
    const root = makeWorkspace({
      "go/service/foo.go": "package service\n\nfunc Foo() int { return 1 }\n",
      "go/service/foo_test.go":
        'package service\n\nimport "testing"\n\nfunc TestFoo(t *testing.T) { Foo() }\n',
    });
    assertAffected(root, ["go/service/foo.go"], ["go/service/foo_test.go"], "go");
  });

  check("C# FooTests.cs convention is routed", () => {
    const root = makeWorkspace({
      "cs/Foo.cs": "namespace App\n{\n    public class Foo\n    {\n        public int Run() => 1;\n    }\n}\n",
      "cs/FooTests.cs":
        "namespace App.Tests\n{\n    public class FooTests\n    {\n        public void Run() { }\n    }\n}\n",
    });
    assertAffected(root, ["cs/Foo.cs"], ["cs/FooTests.cs"], "csharp");
  });
}

function testRunnerAwareCommand(): void {
  check("package.json custom runner maps to npm test", () => {
    const root = makeWorkspace({
      "package.json": JSON.stringify({ scripts: { test: "tsx tests/run.ts" } }),
    });
    assertEqual(
      buildAffectedTestCommand(["tests/a.test.ts"], root),
      "npm test",
      "custom runner must fall back to npm test"
    );
  });

  check("package.json vitest runner maps to npx vitest run <files>", () => {
    const root = makeWorkspace({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    });
    assertEqual(
      buildAffectedTestCommand(["tests/a.test.ts"], root),
      "npx vitest run tests/a.test.ts",
      "vitest runner must target the affected test file"
    );
  });

  check("package.json test script already covering the file maps to npm test", () => {
    const root = makeWorkspace({
      "package.json": JSON.stringify({ scripts: { test: "vitest run tests/a.test.ts" } }),
    });
    assertEqual(
      buildAffectedTestCommand(["tests/a.test.ts"], root),
      "npm test",
      "covered test file must use npm test"
    );
  });

  check("no package.json falls back to the vitest heuristic", () => {
    const root = makeWorkspace({ "src/a.ts": "export const a = 1;\n" });
    assertEqual(
      buildAffectedTestCommand(["tests/a.test.ts"], root),
      "npx vitest run tests/a.test.ts",
      "missing package.json must use the vitest heuristic"
    );
  });
}

function testEmptyDiff(): void {
  check("no changed files yields an empty result", () => {
    const root = makeWorkspace({ "src/only.ts": "export const only = 1;\n" });
    const resolved = resolveAffectedTests(root, []);
    assertEqual(resolved.changedFiles.length, 0, "changedFiles must be empty");
    assertEqual(resolved.affectedTests.length, 0, "affectedTests must be empty");
  });

  check("changed files with no tests yields empty affectedTests", () => {
    const root = makeWorkspace({ "src/only.ts": "export const only = 1;\n" });
    const resolved = resolveAffectedTests(root, ["src/only.ts"]);
    assertEqual(JSON.stringify(resolved.changedFiles), JSON.stringify(["src/only.ts"]), "changedFiles");
    assertEqual(resolved.affectedTests.length, 0, "affectedTests must be empty");
  });
}

function main(): void {
  try {
    testTsconfigPathAlias();
    testTsconfigInheritance();
    testDynamicImports();
    testTestDirectories();
    testLanguageTestConventions();
    testRunnerAwareCommand();
    testEmptyDiff();
  } finally {
    for (const root of createdRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} affected-tests checks passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
