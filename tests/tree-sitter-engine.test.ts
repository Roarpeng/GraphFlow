/**
 * GraphFlow — Optional tree-sitter TRUE-AST backend tests (`tests/tree-sitter-engine.test.ts`)
 *
 * Standalone: `npx tsx tests/tree-sitter-engine.test.ts` (exit code 1 on failure).
 * If the tree-sitter core/grammars are not installed the whole suite is skipped with a
 * clear message (exit 0) instead of failing environments that opt out.
 *
 * Env gating is exercised explicitly: `GRAPHFLOW_TREE_SITTER` is saved/restored around the
 * suite; when bindings are present the backend is the default, and `=0` forces structural.
 */

import { analyzeSourceFile } from "../src/index.js";
import {
  analyzeWithTreeSitter,
  isTreeSitterAvailable,
  treeSitterFamilyForPath,
} from "../src/tree-sitter-engine.js";

let passed = 0;
let failed = 0;

function fail(message: string): never {
  throw new Error(message);
}

function assertTrue(condition: unknown, message: string): void {
  if (!condition) fail(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    fail(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertIncludes(haystack: readonly string[], needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    fail(`${message} (missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)})`);
  }
}

function runTest(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL ${name}\n       ${message.replace(/\n/g, "\n       ")}`);
  }
}

// ── Fixtures (strings only; no workspace mutation) ─────────────────────────

const PY_SOURCE = [
  "from dataclasses import dataclass",
  "import os",
  "",
  "@dataclass",
  "class OrderService(Base):",
  "    max_tokens: int",
  "    strict: bool = True",
  "",
  "    def cancel_order(self, order_id: str, reason=None) -> bool:",
  "        return bool(order_id)",
  "",
  "def run(service: OrderService) -> bool:",
  "    return service.cancel_order('x', reason='r')",
  "",
].join("\n");

const GO_SOURCE = [
  "package svc",
  "",
  'import "fmt"',
  "",
  "type Service struct {",
  "\tMaxTokens int",
  "\tStrict    bool",
  "}",
  "",
  "func (s *Service) Cancel(id int) bool {",
  "\tfmt.Println(id)",
  "\treturn id > 0",
  "}",
  "",
  "func Run(s Service) bool {",
  "\treturn s.Cancel(1)",
  "}",
  "",
].join("\n");

const RS_SOURCE = [
  "use crate::types::Quota;",
  "use std::collections::HashMap;",
  "",
  "pub struct Service {",
  "    pub limit: usize,",
  "    pub hard: bool,",
  "}",
  "",
  "impl Service {",
  "    pub fn new(limit: usize) -> Self { todo!() }",
  "    pub fn cancel(&self, id: u32) -> bool {",
  "        id > 0",
  "    }",
  "}",
  "",
  "pub fn run(svc: &Service) -> bool {",
  "    svc.cancel(3)",
  "}",
  "",
].join("\n");

const C_SOURCE = [
  '#include "engine.h"',
  "#include <stdio.h>",
  "",
  "struct Engine {",
  "  int max_bytes;",
  "  void (*on_cancel)(int);",
  "};",
  "",
  "int calc_frame(const struct Engine* e, int bonus) {",
  '  printf("%d", bonus);',
  "  return e->max_bytes + bonus;",
  "}",
  "",
  "int run(void);",
  "",
].join("\n");

const CPP_SOURCE = [
  '#include "engine.hpp"',
  "",
  "class OrderService {",
  "public:",
  "  void cancelOrder(int id);",
  "  int pending;",
  "};",
  "",
  "void OrderService::cancelOrder(int id) {",
  "  Engine::cancel(id);",
  "}",
  "",
  "int run(OrderService svc, int id) {",
  "  svc.cancelOrder(id);",
  "  return 0;",
  "}",
  "",
].join("\n");

const CS_SOURCE = [
  "using System;",
  "using App.Models;",
  "",
  "namespace App;",
  "",
  "public class OrderService : IService",
  "{",
  "    private readonly ILogger _logger;",
  "    public int Pending { get; set; }",
  "",
  "    public bool CancelOrder(string id)",
  "    {",
  "        _logger.Info(id);",
  "        return true;",
  "    }",
  "}",
  "",
].join("\n");

const BAD_SOURCES: Array<[string, string]> = [
  ["bad.py", "def broken(:\n    return 1\n"],
  ["bad.go", "package x\nfunc Broken( {\n"],
  ["bad.rs", "fn broken( {\n"],
  ["bad.c", "int broken( {\n"],
  ["bad.cpp", "void ( { }\n"],
  ["bad.cs", "class Broken { void F( { } }\n"],
];

function findSymbol(
  ast: NonNullable<ReturnType<typeof analyzeWithTreeSitter>>,
  name: string,
  parentClass?: string
) {
  return ast.symbols.find(
    (symbol) => symbol.name === name && (parentClass === undefined || symbol.parentClass === parentClass)
  );
}

function main(): void {
  console.log("=== GraphFlow tree-sitter backend suite ===");

  const savedEnv = process.env.GRAPHFLOW_TREE_SITTER;
  try {
    if (!isTreeSitterAvailable()) {
      console.log(
        "SKIP: tree-sitter core/grammar packages are not installed in this environment " +
          "(optional dependency); skipping all tree-sitter backend checks."
      );
      return;
    }

    // 1. Extension -> language family + availability surface.
    runTest("1) extension mapping and availability", () => {
      assertEqual(treeSitterFamilyForPath("a.py"), "python", "python ext");
      assertEqual(treeSitterFamilyForPath("a.pyi"), "python", "pyi ext");
      assertEqual(treeSitterFamilyForPath("a.go"), "go", "go ext");
      assertEqual(treeSitterFamilyForPath("a.rs"), "rust", "rust ext");
      assertEqual(treeSitterFamilyForPath("a.c"), "c", "c ext");
      assertEqual(treeSitterFamilyForPath("a.hpp"), "cpp", "cpp header ext");
      assertEqual(treeSitterFamilyForPath("a.cs"), "csharp", "csharp ext");
      assertEqual(treeSitterFamilyForPath("a.ts"), undefined, "TS/JS stays on babel");
      assertEqual(treeSitterFamilyForPath("a.rb"), undefined, "unsupported ext");
      assertEqual(analyzeWithTreeSitter("a.rb", "puts 1"), undefined, "unsupported ext analysis");
    });

    // 2. Env gating: true-AST by default when bindings exist; GRAPHFLOW_TREE_SITTER=0 forces structural.
    runTest("2) default uses tree-sitter when available; env=0 forces structural", () => {
      delete process.env.GRAPHFLOW_TREE_SITTER;
      assertEqual(analyzeSourceFile("a.py", PY_SOURCE).engine, "tree-sitter", "Python default tree-sitter");
      assertEqual(analyzeSourceFile("a.go", GO_SOURCE).engine, "tree-sitter", "Go default tree-sitter");
      assertEqual(analyzeSourceFile("a.rs", RS_SOURCE).engine, "tree-sitter", "Rust default tree-sitter");
      assertEqual(analyzeSourceFile("a.c", C_SOURCE).engine, "tree-sitter", "C default tree-sitter");
      assertEqual(analyzeSourceFile("a.cpp", CPP_SOURCE).engine, "tree-sitter", "C++ default tree-sitter");
      assertEqual(analyzeSourceFile("a.cs", CS_SOURCE).engine, "tree-sitter", "C# default tree-sitter");
      assertEqual(analyzeSourceFile("a.ts", "export function f(): void {}\n").engine, "babel", "TS babel");

      process.env.GRAPHFLOW_TREE_SITTER = "0";
      assertEqual(analyzeSourceFile("a.py", PY_SOURCE).engine, "structural", "Python forced structural");
      assertEqual(analyzeSourceFile("a.go", GO_SOURCE).engine, "structural", "Go forced structural");
      assertEqual(analyzeSourceFile("a.rs", RS_SOURCE).engine, "structural", "Rust forced structural");
      assertEqual(analyzeSourceFile("a.c", C_SOURCE).engine, "structural", "C forced structural");
      assertEqual(analyzeSourceFile("a.cpp", CPP_SOURCE).engine, "structural", "C++ forced structural");
      assertEqual(analyzeSourceFile("a.cs", CS_SOURCE).engine, "structural", "C# forced structural");

      process.env.GRAPHFLOW_TREE_SITTER = "1";
      assertEqual(analyzeSourceFile("a.py", PY_SOURCE).engine, "tree-sitter", "Python opt-in tree-sitter");
      assertEqual(analyzeSourceFile("a.go", GO_SOURCE).engine, "tree-sitter", "Go opt-in tree-sitter");
      assertEqual(analyzeSourceFile("a.rs", RS_SOURCE).engine, "tree-sitter", "Rust opt-in tree-sitter");
      assertEqual(analyzeSourceFile("a.c", C_SOURCE).engine, "tree-sitter", "C opt-in tree-sitter");
      assertEqual(analyzeSourceFile("a.cpp", CPP_SOURCE).engine, "tree-sitter", "C++ opt-in tree-sitter");
      assertEqual(analyzeSourceFile("a.cs", CS_SOURCE).engine, "tree-sitter", "C# opt-in tree-sitter");
      assertEqual(analyzeSourceFile("a.ts", "export function f(): void {}\n").engine, "babel", "TS still babel");
    });

    // 3. Python: imports, decorated class, fields, method parentClass, params, member call.
    runTest("3) Python extraction: decorator, class/fields, method, import, member call", () => {
      const ast = analyzeWithTreeSitter("service.py", PY_SOURCE);
      assertTrue(ast, "Python analysis must be defined");
      assertEqual(ast!.backend, "python-ast", "Python backend");
      assertEqual(ast!.engine, "tree-sitter", "Python engine");
      assertEqual(ast!.syntaxErrors.length, 0, "Python fixture parses cleanly");

      const cls = findSymbol(ast!, "OrderService");
      assertTrue(cls, "Python class symbol");
      assertEqual(cls!.kind, "class", "class kind");
      assertEqual(cls!.line, 4, "decorated class starts at the decorator line");
      assertEqual(cls!.endLine, 10, "class end line");
      assertIncludes(cls!.fields ?? [], "max_tokens", "class annotation field");
      assertIncludes(cls!.fields ?? [], "strict", "class annotation field");

      const method = findSymbol(ast!, "cancel_order", "OrderService");
      assertTrue(method, "Python method symbol");
      assertEqual(method!.kind, "method", "method kind");
      assertEqual(method!.parentClass, "OrderService", "method parentClass");
      assertEqual(method!.paramsCount, 2, "self excluded from paramsCount");
      assertEqual(method!.line, 9, "method line");
      assertEqual(method!.endLine, 10, "method end line");

      const runFn = findSymbol(ast!, "run");
      assertTrue(runFn, "Python function symbol");
      assertEqual(runFn!.paramsCount, 1, "run params");
      assertIncludes(runFn!.referencedTypes, "OrderService", "referencedTypes includes annotation");

      assertTrue(ast!.imports.some((imp) => imp.module === "dataclasses" && imp.importedNames.includes("dataclass")), "from-import");
      assertTrue(ast!.imports.some((imp) => imp.module === "os" && imp.importedNames.includes("*")), "plain import wildcard marker");

      const call = ast!.calls.find((site) => site.callee === "cancel_order");
      assertTrue(call, "member call recorded");
      assertEqual(call!.receiver, "service", "call receiver");
      assertEqual(call!.member, true, "member call flag");
      assertEqual(call!.argsCount, 2, "call args");
      assertEqual(call!.line, 13, "call line");
      assertEqual(call!.caller, "run", "enclosing caller");
    });

    // 4. Go: import, struct/fields, method receiver, calls.
    runTest("4) Go extraction: import, struct fields, method receiver, calls", () => {
      const ast = analyzeWithTreeSitter("service.go", GO_SOURCE);
      assertTrue(ast, "Go analysis must be defined");
      assertEqual(ast!.engine, "tree-sitter", "Go engine");
      assertEqual(ast!.backend, "go-ast", "Go backend");
      assertEqual(ast!.syntaxErrors.length, 0, "Go fixture parses cleanly");

      const structSym = findSymbol(ast!, "Service");
      assertTrue(structSym, "Go struct symbol");
      assertEqual(structSym!.kind, "struct", "Go struct kind");
      assertIncludes(structSym!.fields ?? [], "MaxTokens", "Go struct field");
      assertIncludes(structSym!.fields ?? [], "Strict", "Go struct field");

      const method = findSymbol(ast!, "Cancel", "Service");
      assertTrue(method, "Go method symbol");
      assertEqual(method!.kind, "method", "Go method kind");
      assertEqual(method!.parentClass, "Service", "Go receiver type");
      assertEqual(method!.paramsCount, 1, "Go method params");
      const runFn = findSymbol(ast!, "Run");
      assertTrue(runFn, "Go function symbol");
      assertEqual(runFn!.paramsCount, 1, "Go function params");

      assertTrue(ast!.imports.some((imp) => imp.module === "fmt" && imp.importedNames.includes("*")), "Go import wildcard");
      const innerCall = ast!.calls.find((site) => site.callee === "Println");
      assertTrue(innerCall, "selector call");
      assertEqual(innerCall!.receiver, "fmt", "selector receiver");
      assertEqual(innerCall!.member, true, "selector member flag");
      const memberCall = ast!.calls.find((site) => site.callee === "Cancel");
      assertTrue(memberCall, "receiver method call");
      assertEqual(memberCall!.receiver, "s", "method receiver");
      assertEqual(memberCall!.argsCount, 1, "method args");
      assertEqual(memberCall!.caller, "Run", "method caller");
    });

    // 5. Rust: use imports, struct fields, impl parentClass, call.
    runTest("5) Rust extraction: use imports, struct fields, impl methods, call", () => {
      const ast = analyzeWithTreeSitter("service.rs", RS_SOURCE);
      assertTrue(ast, "Rust analysis must be defined");
      assertEqual(ast!.engine, "tree-sitter", "Rust engine");
      assertEqual(ast!.backend, "rust-ast", "Rust backend");
      assertEqual(ast!.syntaxErrors.length, 0, "Rust fixture parses cleanly");

      const structSym = findSymbol(ast!, "Service");
      assertTrue(structSym, "Rust struct symbol");
      assertEqual(structSym!.kind, "struct", "Rust struct kind");
      assertIncludes(structSym!.fields ?? [], "limit", "Rust field");
      assertIncludes(structSym!.fields ?? [], "hard", "Rust field");

      const cancelMethod = findSymbol(ast!, "cancel", "Service");
      assertTrue(cancelMethod, "Rust impl method symbol");
      assertEqual(cancelMethod!.kind, "method", "Rust method kind");
      assertEqual(cancelMethod!.parentClass, "Service", "Rust impl parentClass");
      assertEqual(cancelMethod!.paramsCount, 1, "self excluded from Rust params");
      const runFn = findSymbol(ast!, "run");
      assertTrue(runFn, "Rust function symbol");

      assertTrue(ast!.imports.some((imp) => imp.module === "crate::types" && imp.importedNames.includes("Quota")), "Rust use import");
      const call = ast!.calls.find((site) => site.callee === "cancel");
      assertTrue(call, "Rust method call");
      assertEqual(call!.receiver, "svc", "Rust call receiver");
      assertEqual(call!.argsCount, 1, "Rust call args");
      assertEqual(call!.caller, "run", "Rust call caller");
    });

    // 6. C: includes, struct + function-pointer field, function, prototype, call.
    runTest("6) C extraction: includes, struct/function-pointer fields, function, call", () => {
      const ast = analyzeWithTreeSitter("engine.c", C_SOURCE);
      assertTrue(ast, "C analysis must be defined");
      assertEqual(ast!.engine, "tree-sitter", "C engine");
      assertEqual(ast!.backend, "cpp-ast", "C backend");

      const structSym = findSymbol(ast!, "Engine");
      assertTrue(structSym, "C struct symbol");
      assertEqual(structSym!.kind, "struct", "C struct kind");
      assertIncludes(structSym!.fields ?? [], "max_bytes", "C plain field");
      assertIncludes(structSym!.fields ?? [], "on_cancel", "C function-pointer field is a field, not a method");
      assertTrue(!ast!.symbols.some((symbol) => symbol.name === "on_cancel"), "function pointer must not become a method symbol");

      const fn = findSymbol(ast!, "calc_frame");
      assertTrue(fn, "C function symbol");
      assertEqual(fn!.kind, "function", "C function kind");
      assertEqual(fn!.paramsCount, 2, "C function params");
      assertEqual(fn!.line, 9, "C function line");
      assertEqual(fn!.endLine, 12, "C function end line");
      assertTrue(findSymbol(ast!, "run"), "C prototype declaration symbol");

      assertTrue(ast!.imports.some((imp) => imp.module === "engine.h" && imp.importedNames.includes("engine")), "C include");
      assertTrue(ast!.imports.some((imp) => imp.module === "stdio.h"), "C system include");
      const call = ast!.calls.find((site) => site.callee === "printf");
      assertTrue(call, "C call");
      assertEqual(call!.argsCount, 2, "C call args");
      assertEqual(call!.line, 10, "C call line");
      assertEqual(call!.caller, "calc_frame", "C call caller");
    });

    // 7. C++: class fields, prototype dedupe, qualified definition, static + member calls.
    runTest("7) C++ extraction: class, prototype dedupe, qualified method, static/member calls", () => {
      const ast = analyzeWithTreeSitter("service.cpp", CPP_SOURCE);
      assertTrue(ast, "C++ analysis must be defined");
      assertEqual(ast!.engine, "tree-sitter", "C++ engine");
      assertEqual(ast!.backend, "cpp-ast", "C++ backend");
      assertEqual(ast!.syntaxErrors.length, 0, "C++ fixture parses cleanly (cpp grammar)");

      const cls = findSymbol(ast!, "OrderService");
      assertTrue(cls, "C++ class symbol");
      assertEqual(cls!.kind, "class", "C++ class kind");
      assertIncludes(cls!.fields ?? [], "pending", "C++ class field");

      const definitions = ast!.symbols.filter((symbol) => symbol.name === "cancelOrder");
      assertEqual(definitions.length, 1, "in-file prototype is deduped against the definition");
      assertEqual(definitions[0]!.kind, "method", "C++ method kind");
      assertEqual(definitions[0]!.parentClass, "OrderService", "C++ qualified parentClass");
      assertEqual(definitions[0]!.paramsCount, 1, "C++ method params");
      assertEqual(definitions[0]!.line, 9, "definition line wins over prototype line 5");

      const runFn = findSymbol(ast!, "run");
      assertTrue(runFn, "C++ function symbol");
      assertEqual(runFn!.paramsCount, 2, "C++ function params");
      assertTrue(ast!.imports.some((imp) => imp.module === "engine.hpp"), "C++ include");

      const staticCall = ast!.calls.find((site) => site.callee === "cancel");
      assertTrue(staticCall, "C++ qualified call");
      assertEqual(staticCall!.receiver, "Engine", "C++ qualified receiver");
      assertEqual(staticCall!.member, true, "C++ qualified member flag");
      const memberCall = ast!.calls.find((site) => site.callee === "cancelOrder");
      assertTrue(memberCall, "C++ member call");
      assertEqual(memberCall!.receiver, "svc", "C++ member receiver");
      assertEqual(memberCall!.argsCount, 1, "C++ member args");
    });

    // 8. C#: usings, class fields/property, method, invocation.
    runTest("8) C# extraction: usings, class fields/property, method, invocation", () => {
      const ast = analyzeWithTreeSitter("Service.cs", CS_SOURCE);
      assertTrue(ast, "C# analysis must be defined");
      assertEqual(ast!.engine, "tree-sitter", "C# engine");
      assertEqual(ast!.backend, "csharp-ast", "C# backend");
      assertEqual(ast!.syntaxErrors.length, 0, "C# fixture parses cleanly");

      const cls = findSymbol(ast!, "OrderService");
      assertTrue(cls, "C# class symbol");
      assertEqual(cls!.kind, "class", "C# class kind");
      assertEqual(cls!.exported, true, "public C# class exported");
      assertIncludes(cls!.fields ?? [], "_logger", "C# private field");
      assertIncludes(cls!.fields ?? [], "Pending", "C# property field");

      const method = findSymbol(ast!, "CancelOrder", "OrderService");
      assertTrue(method, "C# method symbol");
      assertEqual(method!.kind, "method", "C# method kind");
      assertEqual(method!.parentClass, "OrderService", "C# method parentClass");
      assertEqual(method!.paramsCount, 1, "C# method params");
      assertEqual(method!.exported, true, "public C# method exported");

      assertTrue(ast!.imports.some((imp) => imp.module === "System"), "C# using System");
      assertTrue(ast!.imports.some((imp) => imp.module === "App.Models"), "C# using App.Models");
      const call = ast!.calls.find((site) => site.callee === "Info");
      assertTrue(call, "C# invocation");
      assertEqual(call!.receiver, "_logger", "C# invocation receiver");
      assertEqual(call!.argsCount, 1, "C# invocation args");
      assertEqual(call!.caller, "CancelOrder", "C# invocation caller");
    });

    // 9. Syntax errors: ERROR/MISSING nodes are surfaced per language.
    runTest("9) syntax errors surfaced for malformed snippets in all six languages", () => {
      for (const [relPath, source] of BAD_SOURCES) {
        const ast = analyzeWithTreeSitter(relPath, source);
        assertTrue(ast, `${relPath} must still return a partial AST`);
        assertTrue(ast!.syntaxErrors.length > 0, `${relPath} must report syntaxErrors`);
        assertTrue(
          ast!.syntaxErrors.every((error) => error.line >= 1 && typeof error.message === "string"),
          `${relPath} syntax error shape`
        );
      }
    });

    // 10. Env-on analyzeSourceFile keeps the FileAstAnalysis contract usable by existing features.
    runTest("10) opt-in analyzeSourceFile result feeds existing analyzers shape", () => {
      process.env.GRAPHFLOW_TREE_SITTER = "1";
      const ast = analyzeSourceFile("service.py", PY_SOURCE);
      assertEqual(ast.engine, "tree-sitter", "engine marker");
      assertEqual(ast.relPath, "service.py", "relPath");
      assertEqual(ast.totalLines, PY_SOURCE.split("\n").length, "totalLines");
      assertTrue(Array.isArray(ast.symbols) && ast.symbols.length > 0, "symbols present");
      assertTrue(ast.symbols.every((symbol) => symbol.signature.length > 0), "signatures present");
      assertTrue(ast.calls.every((call) => typeof call.argsCount === "number"), "call argsCount present");
    });

    // 11. C/C++ headers: `.h` prefers the C++ grammar with a C fallback; prototypes stay symbols.
    runTest("11) C/C++ header parsing keeps prototypes and picks the right grammar", () => {
      const cHeader = [
        "struct Engine {",
        "  int max_bytes;",
        "  void (*on_cancel)(int);",
        "};",
        "int run(void);",
        "",
      ].join("\n");
      const cAst = analyzeWithTreeSitter("engine.h", cHeader);
      assertTrue(cAst, "C header analysis must be defined");
      assertEqual(cAst!.symbols.find((symbol) => symbol.name === "run")!.kind, "function", "C prototype symbol");
      assertIncludes(findSymbol(cAst!, "Engine")!.fields ?? [], "max_bytes", "C header struct field");

      const cppHeader = [
        "class Widget {",
        "public:",
        "  void draw(int x);",
        "  int width;",
        "};",
        "",
      ].join("\n");
      const cppAst = analyzeWithTreeSitter("widget.h", cppHeader);
      assertTrue(cppAst, "C++ header analysis must be defined");
      assertEqual(cppAst!.syntaxErrors.length, 0, "C++ header parses via the cpp grammar");
      assertEqual(findSymbol(cppAst!, "Widget")!.kind, "class", "C++ header class");
      const drawMethod = findSymbol(cppAst!, "draw", "Widget");
      assertTrue(drawMethod, "C++ header method prototype symbol");
      assertEqual(drawMethod!.paramsCount, 1, "prototype params");
    });
  } finally {
    if (savedEnv === undefined) {
      delete process.env.GRAPHFLOW_TREE_SITTER;
    } else {
      process.env.GRAPHFLOW_TREE_SITTER = savedEnv;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

try {
  main();
} catch (err) {
  failed += 1;
  console.error(`UNCAUGHT: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}

if (failed > 0) {
  process.exit(1);
}
