#!/usr/bin/env node
/**
 * Parser backend verification (P2).
 *
 * Runs six small fixtures through the real analyzer in two modes:
 *   - default: tree-sitter true AST when the optional native grammars are installed
 *   - GRAPHFLOW_TREE_SITTER=0: the built-in structural fallback
 *
 * Usage:
 *   node scripts/verify-parsers.mjs [--json] [--strict] [--check-install]
 *
 *   --strict         fail when tree-sitter (core + all grammars) is unavailable
 *   --check-install  only print installed grammar/core versions and exit
 *   --json           emit a machine-readable report
 *
 * Requires `npm run build` first (it loads dist/index.js).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(repoRoot, "dist", "index.js");

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const strict = args.has("--strict");
const checkInstall = args.has("--check-install");

const GRAMMARS = {
  python: "tree-sitter-python",
  go: "tree-sitter-go",
  rust: "tree-sitter-rust",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  csharp: "tree-sitter-c-sharp",
};

function packageVersion(name) {
  try {
    const pkgPath = require.resolve(`${name}/package.json`);
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
  } catch {
    try {
      let dir = dirname(require.resolve(name));
      for (let i = 0; i < 6; i++) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
          const pkg = JSON.parse(readFileSync(candidate, "utf8"));
          if (pkg.name === name) return pkg.version ?? "unknown";
        }
        dir = dirname(dir);
      }
    } catch {
      // ignore
    }
    return undefined;
  }
}

function installStatus() {
  const core = packageVersion("tree-sitter");
  const grammars = Object.fromEntries(
    Object.entries(GRAMMARS).map(([family, pkg]) => [family, packageVersion(pkg)])
  );
  return { core, grammars };
}

if (checkInstall) {
  const status = installStatus();
  if (jsonOutput) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`tree-sitter core: ${status.core ?? "NOT INSTALLED"}`);
    for (const [family, version] of Object.entries(status.grammars)) {
      console.log(`  ${GRAMMARS[family]}: ${version ?? "NOT INSTALLED"}`);
    }
  }
  process.exit(0);
}

if (!existsSync(distEntry)) {
  console.error(`[verify-parsers] ${distEntry} is missing. Run "npm run build" first.`);
  process.exit(2);
}

const gf = require(distEntry);
const fixtures = [
  {
    language: "python",
    file: "a.py",
    source: [
      "import os",
      "",
      "class Svc:",
      "    def cancel(self) -> bool:",
      "        return True",
      "",
      "    def run(self) -> bool:",
      "        return self.cancel()",
      "",
    ].join("\n"),
    symbol: "cancel",
    importModule: "os",
    callCallee: "cancel",
  },
  {
    language: "go",
    file: "a.go",
    source: [
      "package p",
      "",
      'import "fmt"',
      "",
      "type S struct { A int }",
      "",
      "func (s *S) Cancel(id string) error {",
      "\tfmt.Println(id)",
      "\treturn nil",
      "}",
      "",
    ].join("\n"),
    symbol: "Cancel",
    importModule: "fmt",
    callCallee: "Println",
  },
  {
    language: "rust",
    file: "a.rs",
    source: [
      "use std::fmt;",
      "",
      "struct S { a: i32 }",
      "",
      "impl S {",
      "    fn cancel(&self) -> bool { true }",
      "}",
      "",
      "fn run() -> bool {",
      "    let s = S { a: 1 };",
      "    s.cancel()",
      "}",
      "",
    ].join("\n"),
    symbol: "cancel",
    importModule: "std",
    callCallee: "cancel",
  },
  {
    language: "c",
    file: "a.c",
    source: [
      "#include <stdio.h>",
      "",
      "struct S { int a; };",
      "",
      "int cancel(int id) { return id; }",
      "",
      "int run(void) {",
      "    return cancel(1);",
      "}",
      "",
    ].join("\n"),
    symbol: "cancel",
    importModule: "stdio.h",
    callCallee: "cancel",
  },
  {
    language: "cpp",
    file: "a.cpp",
    source: [
      "#include <string>",
      "",
      "class S {",
      "public:",
      "    bool cancel(int id);",
      "};",
      "",
      "bool S::cancel(int id) {",
      "    return id > 0;",
      "}",
      "",
    ].join("\n"),
    symbol: "cancel",
    importModule: "string",
    callCallee: "cancel",
  },
  {
    language: "csharp",
    file: "a.cs",
    source: [
      "using System;",
      "",
      "namespace N {",
      "    class S {",
      "        public bool Cancel(int id) { return id > 0; }",
      "        public bool Run() { return Cancel(1); }",
      "    }",
      "}",
      "",
    ].join("\n"),
    symbol: "Cancel",
    importModule: "System",
    callCallee: "Cancel",
  },
];

const available = (() => {
  try {
    return gf.isTreeSitterAvailable();
  } catch {
    return false;
  }
})();

const results = [];
let failures = 0;

function analyzeWithEnv(file, source, envValue) {
  const previous = process.env.GRAPHFLOW_TREE_SITTER;
  if (envValue === undefined) delete process.env.GRAPHFLOW_TREE_SITTER;
  else process.env.GRAPHFLOW_TREE_SITTER = envValue;
  const started = process.hrtime.bigint();
  try {
    return { ast: gf.analyzeSourceFile(file, source), ms: Number(process.hrtime.bigint() - started) / 1e6 };
  } finally {
    if (previous === undefined) delete process.env.GRAPHFLOW_TREE_SITTER;
    else process.env.GRAPHFLOW_TREE_SITTER = previous;
  }
}

for (const fixture of fixtures) {
  const expectedTreeSitter = available;
  const native = analyzeWithEnv(fixture.file, fixture.source, undefined);
  const structural = analyzeWithEnv(fixture.file, fixture.source, "0");

  const symbols = (native.ast.symbols ?? []).map((s) => s.name);
  const imports = (native.ast.imports ?? []).map((i) => i.module);
  const calls = (native.ast.calls ?? []).map((c) => c.callee);
  const checks = [];

  if (expectedTreeSitter) {
    checks.push(["engine", native.ast.engine === "tree-sitter", native.ast.engine]);
    checks.push(["symbol", symbols.includes(fixture.symbol), fixture.symbol]);
    checks.push(["import", imports.some((m) => m.includes(fixture.importModule)), fixture.importModule]);
    checks.push(["call", calls.includes(fixture.callCallee), fixture.callCallee]);
    checks.push(["noSyntaxErrors", native.ast.syntaxErrors.length === 0, `${native.ast.syntaxErrors.length}`]);
  }
  checks.push(["fallbackEngine", structural.ast.engine === "structural", structural.ast.engine]);
  checks.push(["fallbackSymbols", structural.ast.symbols.length > 0, `${structural.ast.symbols.length}`]);

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) failures += 1;
  results.push({
    language: fixture.language,
    engine: native.ast.engine,
    fallbackEngine: structural.ast.engine,
    symbols: symbols.length,
    imports: imports.length,
    calls: calls.length,
    syntaxErrors: native.ast.syntaxErrors.length,
    ms: Number(native.ms.toFixed(2)),
    fallbackMs: Number(structural.ms.toFixed(2)),
    checks: Object.fromEntries(checks.map(([name, ok, detail]) => [name, { ok, detail }])),
    failed: failed.map(([name]) => name),
  });
}

if (strict && !available) {
  failures += 1;
}

if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        ok: failures === 0,
        available,
        strict,
        install: installStatus(),
        results,
      },
      null,
      2
    )
  );
} else {
  console.log(`[verify-parsers] tree-sitter available: ${available ? "yes" : "no"}`);
  const install = installStatus();
  console.log(`  core: ${install.core ?? "missing"}`);
  for (const [family, version] of Object.entries(install.grammars)) {
    console.log(`  ${GRAMMARS[family]}: ${version ?? "missing"}`);
  }
  for (const result of results) {
    const status = result.failed.length === 0 ? "PASS" : `FAIL (${result.failed.join(", ")})`;
    console.log(
      `  ${result.language.padEnd(7)} engine=${result.engine.padEnd(11)} ` +
        `fallback=${result.fallbackEngine.padEnd(10)} symbols=${result.symbols} ` +
        `imports=${result.imports} calls=${result.calls} ` +
        `errors=${result.syntaxErrors} ${result.ms.toFixed(2)}ms/${result.fallbackMs.toFixed(2)}ms ${status}`
    );
  }
  if (!available) {
    console.log(
      "  note: optional tree-sitter grammars are missing; structural fallback was verified. " +
        "Install the optional dependencies for true AST, or use --strict to make this an error."
    );
  }
}

process.exit(failures === 0 ? 0 : 1);
