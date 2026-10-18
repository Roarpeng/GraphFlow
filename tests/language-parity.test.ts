/**
 * GraphFlow — Six-language capability parity matrix (`tests/language-parity.test.ts`)
 *
 * Proves that Python / Go / Rust / C / C++ / C# behave as close as possible to TS/JS for:
 *   - symbol slicing + spans (`executeSurgicalRead`)
 *   - type closure ([Type Closure] blocks)
 *   - receiver-aware blast radius (`computeBlastRadius`)
 *   - cross-file rename (`executeSurgicalEdit` rename)
 *   - knowledge-graph `defines` / `imports` / `calls` edges (`buildKnowledgeGraphData`)
 *
 * All 7 languages live in ONE temp workspace with the same conceptual fixture
 * (Base.cancel / Child / a user module calling b.cancel() and a subclass/receiver call), so
 * cross-language leakage is asserted explicitly, not just per-language success.
 *
 * Adversarial per-language cases are covered at the end: Go grouped params + embedded fields,
 * C++ header prototype/definition split, C# partial classes + record, Python decorators,
 * Rust trait/impl. Known-unsupported behavior is asserted as graceful/degraded (documented in
 * the test name) instead of forcing a wrong answer.
 *
 * Standalone: `npx tsx tests/language-parity.test.ts` (exit 1 on failure).
 * Temp dirs only; the repo is never mutated.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeSourceFile,
  buildKnowledgeGraphData,
  computeBlastRadius,
  executeSurgicalEdit,
  executeSurgicalRead,
  getWorkspaceAstIndex,
} from "../src/index.js";

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const tempRoots: string[] = [];

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
    fail(`${message} (missing ${JSON.stringify(needle)}; got ${JSON.stringify(haystack)})`);
  }
}
function assertSameSet(actual: readonly string[], expected: readonly string[], message: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assertEqual(JSON.stringify(a), JSON.stringify(e), message);
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

function createWorkspace(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `gf-parity-${name}-`));
  tempRoots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

// ── Parity fixture (same conceptual shape in all 7 languages) ──────────────

const PARITY_FILES: Record<string, string> = {
  "ts/base.ts": [
    "export class Base {",
    "  limit: number = 0;",
    "  cancel(id: string): boolean { return id.length > 0; }",
    "}",
    "",
  ].join("\n"),
  "ts/child.ts": ["import { Base } from './base.js';", "export class Child extends Base {}", ""].join("\n"),
  "ts/user.ts": [
    "import { Base } from './base.js';",
    "import { Child } from './child.js';",
    "export function run(b: Base, c: Child): boolean { return b.cancel('x') && c.cancel('y'); }",
    "",
  ].join("\n"),

  "py/base.py": [
    "class Base:",
    "    limit: int = 0",
    "    def cancel(self, order_id: str) -> bool:",
    "        return bool(order_id)",
    "",
  ].join("\n"),
  "py/child.py": ["from .base import Base", "", "class Child(Base):", "    pass", ""].join("\n"),
  "py/user.py": [
    "from .base import Base",
    "from .child import Child",
    "",
    "def run(b: Base, c: Child) -> bool:",
    "    first = b.cancel('x')",
    "    second = c.cancel('y')",
    "    return first and second",
    "",
  ].join("\n"),

  "go/base.go": [
    "package demo",
    "",
    "type Base struct {",
    "\tMaxTokens int",
    "}",
    "",
    "func (b *Base) Cancel(id int) bool {",
    "\treturn id > 0",
    "}",
    "",
  ].join("\n"),
  "go/child.go": [
    "package demo",
    "",
    "type Child struct {",
    "\tBase",
    "\tExtra string",
    "}",
    "",
    "func (c *Child) Run() bool {",
    "\treturn c.Cancel(1)",
    "}",
    "",
  ].join("\n"),
  "go/user.go": [
    "package demo",
    "",
    "func Run(b *Base, c *Child) bool {",
    "\tfirst := b.Cancel(1)",
    "\tsecond := c.Cancel(2)",
    "\treturn first && second",
    "}",
    "",
  ].join("\n"),

  "rs/base.rs": [
    "pub struct Base {",
    "    pub limit: usize,",
    "}",
    "",
    "impl Base {",
    "    pub fn cancel(&self, id: u32) -> bool {",
    "        id > 0",
    "    }",
    "}",
    "",
  ].join("\n"),
  "rs/child.rs": [
    "use crate::base::Base;",
    "",
    "pub struct Child {",
    "    pub base: Base,",
    "}",
    "",
    "impl Child {",
    "    pub fn cancel(&self, id: u32) -> bool {",
    "        id > 0",
    "    }",
    "}",
    "",
  ].join("\n"),
  "rs/base_user.rs": [
    "use crate::base::Base;",
    "",
    "pub fn run_base(b: &Base) -> bool {",
    "    b.cancel(1)",
    "}",
    "",
  ].join("\n"),
  "rs/user.rs": [
    "use crate::child::Child;",
    "",
    "pub fn run(c: &Child) -> bool {",
    "    c.cancel(2)",
    "}",
    "",
  ].join("\n"),

  "c/base.h": [
    "#ifndef BASE_H",
    "#define BASE_H",
    "typedef struct Base {",
    "  int max_tokens;",
    "} Base;",
    "int base_cancel(Base* b, int id);",
    "#endif",
    "",
  ].join("\n"),
  "c/base.c": [
    '#include "base.h"',
    "",
    "int base_cancel(Base* b, int id) {",
    "  return b->max_tokens + id > 0;",
    "}",
    "",
  ].join("\n"),
  "c/child.h": [
    "#ifndef CHILD_H",
    "#define CHILD_H",
    '#include "base.h"',
    "typedef struct Child {",
    "  Base base;",
    "  int extra;",
    "} Child;",
    "int child_cancel(Child* c, int id);",
    "#endif",
    "",
  ].join("\n"),
  "c/child.c": [
    '#include "child.h"',
    "",
    "int child_cancel(Child* c, int id) {",
    "  return base_cancel(&c->base, id);",
    "}",
    "",
  ].join("\n"),
  "c/user.c": [
    '#include "base.h"',
    '#include "child.h"',
    "",
    "int run(Base* b, Child* c) {",
    "  return base_cancel(b, 1) + child_cancel(c, 2);",
    "}",
    "",
  ].join("\n"),

  "cpp/base.hpp": [
    "#pragma once",
    "",
    "class Base {",
    "public:",
    "  int limit;",
    "  bool cancel(int id) { return id > 0; }",
    "};",
    "",
  ].join("\n"),
  "cpp/child.hpp": ['#include "base.hpp"', "", "class Child : public Base {};", ""].join("\n"),
  "cpp/user.cpp": [
    '#include "base.hpp"',
    '#include "child.hpp"',
    "",
    "bool run(Base& b, Child c) {",
    "  return b.cancel(1) && c.cancel(2);",
    "}",
    "",
  ].join("\n"),

  "cs/Base.cs": [
    "namespace Demo.Base;",
    "",
    "public class Base",
    "{",
    "    public int Limit { get; set; }",
    "    public virtual bool Cancel(int id) { return id > 0; }",
    "}",
    "",
  ].join("\n"),
  "cs/Child.cs": [
    "using Demo.Base;",
    "namespace Demo.Child;",
    "",
    "public class Child : Base { }",
    "",
  ].join("\n"),
  "cs/User.cs": [
    "using Demo.Base;",
    "using Demo.Child;",
    "namespace Demo.User;",
    "",
    "public static class User",
    "{",
    "    public static bool Run(Base b, Child c) { return b.Cancel(1) && c.Cancel(2); }",
    "}",
    "",
  ].join("\n"),
};

interface LanguageCase {
  id: string;
  dir: string;
  engine: string;
  baseClassFile: string;
  baseClassKind: string;
  baseFields: string[];
  childFile: string;
  childKind: string;
  childFields: string[];
  methodFile: string;
  method: string;
  methodParent: string;
  /** Expected symbol kind for the renamed method (C has no methods -> function). */
  methodKind?: string;
  paramsCount: number;
  userFile: string;
  userCalls: Array<{ callee: string; receiver: string; argsCount: number }>;
  blastTarget: { file: string; symbol: string };
  blastExpected: Array<{ file: string; min: number }>;
  sliceTarget: string;
  closureBaseFile: string;
  importEdges: Array<[string, string]>;
  methodNodeId: string;
  callsEdges: Array<[string, string]>;
  rename: { file: string; symbol: string; newName: string; touched: string[] };
  /** Files that declare a same-named method but are NOT part of this rename (assert unchanged). */
  untouchedSameNameFiles?: string[];
}

const TS_CASE: LanguageCase = {
  id: "ts",
  dir: "ts",
  engine: "babel",
  baseClassFile: "ts/base.ts",
  baseClassKind: "class",
  baseFields: ["limit"],
  childFile: "ts/child.ts",
  childKind: "class",
  childFields: [],
  methodFile: "ts/base.ts",
  method: "cancel",
  methodParent: "Base",
  paramsCount: 1,
  userFile: "ts/user.ts",
  userCalls: [
    { callee: "cancel", receiver: "b", argsCount: 1 },
    { callee: "cancel", receiver: "c", argsCount: 1 },
  ],
  blastTarget: { file: "ts/base.ts", symbol: "Base.cancel" },
  blastExpected: [{ file: "ts/user.ts", min: 2 }],
  sliceTarget: "ts/base.ts#Base.cancel",
  closureBaseFile: "ts/base.ts",
  importEdges: [
    ["ts/child.ts", "ts/base.ts"],
    ["ts/user.ts", "ts/base.ts"],
    ["ts/user.ts", "ts/child.ts"],
  ],
  methodNodeId: "sym:ts/base.ts#Base.cancel",
  callsEdges: [["sym:ts/user.ts#run", "sym:ts/base.ts#Base.cancel"]],
  rename: { file: "ts/base.ts", symbol: "cancel", newName: "abortTsCancel", touched: ["ts/base.ts", "ts/user.ts"] },
  untouchedSameNameFiles: ["ts/child.ts"],
};

const PY_CASE: LanguageCase = {
  id: "py",
  dir: "py",
  engine: "tree-sitter",
  baseClassFile: "py/base.py",
  baseClassKind: "class",
  baseFields: ["limit"],
  childFile: "py/child.py",
  childKind: "class",
  childFields: [],
  methodFile: "py/base.py",
  method: "cancel",
  methodParent: "Base",
  paramsCount: 1,
  userFile: "py/user.py",
  userCalls: [
    { callee: "cancel", receiver: "b", argsCount: 1 },
    { callee: "cancel", receiver: "c", argsCount: 1 },
  ],
  blastTarget: { file: "py/base.py", symbol: "Base.cancel" },
  blastExpected: [{ file: "py/user.py", min: 2 }],
  sliceTarget: "py/base.py#Base.cancel",
  closureBaseFile: "py/base.py",
  importEdges: [
    ["py/child.py", "py/base.py"],
    ["py/user.py", "py/base.py"],
    ["py/user.py", "py/child.py"],
  ],
  methodNodeId: "sym:py/base.py#Base.cancel",
  callsEdges: [["sym:py/user.py#run", "sym:py/base.py#Base.cancel"]],
  rename: { file: "py/base.py", symbol: "cancel", newName: "abortPyCancel", touched: ["py/base.py", "py/user.py"] },
  untouchedSameNameFiles: ["py/child.py"],
};

const GO_CASE: LanguageCase = {
  id: "go",
  dir: "go",
  engine: "tree-sitter",
  baseClassFile: "go/base.go",
  baseClassKind: "struct",
  baseFields: ["MaxTokens"],
  childFile: "go/child.go",
  childKind: "struct",
  childFields: ["Base", "Extra"],
  methodFile: "go/base.go",
  method: "Cancel",
  methodParent: "Base",
  paramsCount: 1,
  userFile: "go/user.go",
  userCalls: [
    { callee: "Cancel", receiver: "b", argsCount: 1 },
    { callee: "Cancel", receiver: "c", argsCount: 1 },
  ],
  blastTarget: { file: "go/base.go", symbol: "Base.Cancel" },
  blastExpected: [
    { file: "go/user.go", min: 2 },
    { file: "go/child.go", min: 1 },
  ],
  sliceTarget: "go/base.go#Base.Cancel",
  closureBaseFile: "go/base.go",
  // Go same-package files are not file imports: no `imports` edge is expected (documented gap).
  importEdges: [],
  methodNodeId: "sym:go/base.go#Base.Cancel",
  callsEdges: [
    ["sym:go/user.go#Run", "sym:go/base.go#Base.Cancel"],
    ["sym:go/child.go#Child.Run", "sym:go/base.go#Base.Cancel"],
  ],
  rename: { file: "go/base.go", symbol: "Cancel", newName: "AbortGoCancel", touched: ["go/base.go", "go/child.go", "go/user.go"] },
  untouchedSameNameFiles: [],
};

const RS_CASE: LanguageCase = {
  id: "rs",
  dir: "rs",
  engine: "tree-sitter",
  baseClassFile: "rs/base.rs",
  baseClassKind: "struct",
  baseFields: ["limit"],
  childFile: "rs/child.rs",
  childKind: "struct",
  childFields: ["base"],
  methodFile: "rs/child.rs",
  method: "cancel",
  methodParent: "Child",
  paramsCount: 1,
  userFile: "rs/user.rs",
  userCalls: [{ callee: "cancel", receiver: "c", argsCount: 1 }],
  blastTarget: { file: "rs/child.rs", symbol: "Child.cancel" },
  blastExpected: [{ file: "rs/user.rs", min: 1 }],
  sliceTarget: "rs/child.rs#Child.cancel",
  closureBaseFile: "rs/base.rs",
  importEdges: [
    ["rs/child.rs", "rs/base.rs"],
    ["rs/base_user.rs", "rs/base.rs"],
    ["rs/user.rs", "rs/child.rs"],
  ],
  methodNodeId: "sym:rs/child.rs#Child.cancel",
  callsEdges: [
    ["sym:rs/base_user.rs#run_base", "sym:rs/base.rs#Base.cancel"],
    ["sym:rs/user.rs#run", "sym:rs/child.rs#Child.cancel"],
  ],
  rename: { file: "rs/child.rs", symbol: "cancel", newName: "abortRsCancel", touched: ["rs/child.rs", "rs/user.rs"] },
  untouchedSameNameFiles: ["rs/base.rs"],
};

const C_CASE: LanguageCase = {
  id: "c",
  dir: "c",
  engine: "tree-sitter",
  baseClassFile: "c/base.h",
  baseClassKind: "struct",
  baseFields: ["max_tokens"],
  childFile: "c/child.h",
  childKind: "struct",
  childFields: ["base", "extra"],
  methodFile: "c/base.c",
  method: "base_cancel",
  methodParent: "",
  methodKind: "function",
  paramsCount: 2,
  userFile: "c/user.c",
  userCalls: [
    { callee: "base_cancel", receiver: "", argsCount: 2 },
    { callee: "child_cancel", receiver: "", argsCount: 2 },
  ],
  blastTarget: { file: "c/base.c", symbol: "base_cancel" },
  blastExpected: [
    { file: "c/user.c", min: 1 },
    { file: "c/child.c", min: 1 },
  ],
  sliceTarget: "c/base.c#base_cancel",
  closureBaseFile: "c/base.h",
  importEdges: [
    ["c/base.c", "c/base.h"],
    ["c/child.c", "c/child.h"],
    ["c/child.h", "c/base.h"],
    ["c/user.c", "c/base.h"],
    ["c/user.c", "c/child.h"],
  ],
  methodNodeId: "sym:c/base.c#base_cancel",
  callsEdges: [
    ["sym:c/user.c#run", "sym:c/base.c#base_cancel"],
    ["sym:c/user.c#run", "sym:c/child.c#child_cancel"],
  ],
  rename: { file: "c/base.c", symbol: "base_cancel", newName: "abort_c_base", touched: ["c/base.c", "c/base.h", "c/child.c", "c/user.c"] },
  untouchedSameNameFiles: ["c/child.h"],
};

const CPP_CASE: LanguageCase = {
  id: "cpp",
  dir: "cpp",
  engine: "tree-sitter",
  baseClassFile: "cpp/base.hpp",
  baseClassKind: "class",
  baseFields: ["limit"],
  childFile: "cpp/child.hpp",
  childKind: "class",
  childFields: [],
  methodFile: "cpp/base.hpp",
  method: "cancel",
  methodParent: "Base",
  paramsCount: 1,
  userFile: "cpp/user.cpp",
  userCalls: [
    { callee: "cancel", receiver: "b", argsCount: 1 },
    { callee: "cancel", receiver: "c", argsCount: 1 },
  ],
  blastTarget: { file: "cpp/base.hpp", symbol: "Base.cancel" },
  blastExpected: [{ file: "cpp/user.cpp", min: 2 }],
  sliceTarget: "cpp/base.hpp#Base.cancel",
  closureBaseFile: "cpp/base.hpp",
  importEdges: [
    ["cpp/child.hpp", "cpp/base.hpp"],
    ["cpp/user.cpp", "cpp/base.hpp"],
    ["cpp/user.cpp", "cpp/child.hpp"],
  ],
  methodNodeId: "sym:cpp/base.hpp#Base.cancel",
  callsEdges: [["sym:cpp/user.cpp#run", "sym:cpp/base.hpp#Base.cancel"]],
  rename: { file: "cpp/base.hpp", symbol: "cancel", newName: "abortCppCancel", touched: ["cpp/base.hpp", "cpp/user.cpp"] },
  untouchedSameNameFiles: ["cpp/child.hpp"],
};

const CS_CASE: LanguageCase = {
  id: "cs",
  dir: "cs",
  engine: "tree-sitter",
  baseClassFile: "cs/Base.cs",
  baseClassKind: "class",
  baseFields: ["Limit"],
  childFile: "cs/Child.cs",
  childKind: "class",
  childFields: [],
  methodFile: "cs/Base.cs",
  method: "Cancel",
  methodParent: "Base",
  paramsCount: 1,
  userFile: "cs/User.cs",
  userCalls: [
    { callee: "Cancel", receiver: "b", argsCount: 1 },
    { callee: "Cancel", receiver: "c", argsCount: 1 },
  ],
  blastTarget: { file: "cs/Base.cs", symbol: "Base.Cancel" },
  blastExpected: [{ file: "cs/User.cs", min: 2 }],
  sliceTarget: "cs/Base.cs#Base.Cancel",
  closureBaseFile: "cs/Base.cs",
  importEdges: [
    ["cs/Child.cs", "cs/Base.cs"],
    ["cs/User.cs", "cs/Base.cs"],
    ["cs/User.cs", "cs/Child.cs"],
  ],
  methodNodeId: "sym:cs/Base.cs#Base.Cancel",
  callsEdges: [["sym:cs/User.cs#User.Run", "sym:cs/Base.cs#Base.Cancel"]],
  rename: { file: "cs/Base.cs", symbol: "Cancel", newName: "AbortCsCancel", touched: ["cs/Base.cs", "cs/User.cs"] },
  untouchedSameNameFiles: ["cs/Child.cs"],
};

const LANGUAGE_CASES: LanguageCase[] = [TS_CASE, PY_CASE, GO_CASE, RS_CASE, C_CASE, CPP_CASE, CS_CASE];

// ── Shared read-only parity tests ──────────────────────────────────────────

function checkEngineAndSymbols(root: string, testCase: LanguageCase): void {
  const index = getWorkspaceAstIndex(root);
  for (const file of [testCase.baseClassFile, testCase.childFile, testCase.userFile, testCase.methodFile]) {
    const ast = index.getFileAnalysis(file)?.ast;
    assertTrue(ast, `${testCase.id}: analysis exists for ${file}`);
    assertEqual(ast!.engine, testCase.engine, `${testCase.id}: ${file} engine`);
  }
  const baseAst = index.getFileAnalysis(testCase.baseClassFile)!.ast;
  const baseClass = baseAst.symbols.find((s) => s.name === "Base");
  assertTrue(baseClass, `${testCase.id}: Base symbol`);
  assertEqual(baseClass!.kind, testCase.baseClassKind, `${testCase.id}: Base symbol kind`);
  assertTrue(baseClass!.line >= 1 && baseClass!.endLine >= baseClass!.line, `${testCase.id}: Base span`);
  assertSameSet(baseClass!.fields ?? [], testCase.baseFields, `${testCase.id}: Base fields`);
  const methodAst = index.getFileAnalysis(testCase.methodFile)!.ast;
  const method = methodAst.symbols.find(
    (s) => s.name === testCase.method && (s.parentClass ?? "") === testCase.methodParent
  );
  assertTrue(method, `${testCase.id}: method symbol ${testCase.methodParent}.${testCase.method}`);
  assertEqual(method!.kind, testCase.methodKind ?? "method", `${testCase.id}: method kind`);
  assertEqual(method!.paramsCount, testCase.paramsCount, `${testCase.id}: method paramsCount`);
  assertTrue(method!.signature.includes(testCase.method), `${testCase.id}: method signature`);

  const childAst = index.getFileAnalysis(testCase.childFile)!.ast;
  const childClass = childAst.symbols.find((s) => s.name === "Child");
  assertTrue(childClass, `${testCase.id}: Child symbol`);
  assertEqual(childClass!.kind, testCase.childKind, `${testCase.id}: Child symbol kind`);
  assertSameSet(childClass!.fields ?? [], testCase.childFields, `${testCase.id}: Child fields`);
}

function checkCallMetadata(root: string, testCase: LanguageCase): void {
  const ast = getWorkspaceAstIndex(root).getFileAnalysis(testCase.userFile)!.ast;
  for (const expected of testCase.userCalls) {
    const matches = ast.calls.filter((call) => call.callee === expected.callee);
    assertTrue(matches.length > 0, `${testCase.id}: call ${expected.callee} extracted`);
    const withReceiver = expected.receiver
      ? matches.find((call) => call.receiver === expected.receiver)
      : matches.find((call) => !call.receiver);
    assertTrue(withReceiver, `${testCase.id}: call ${expected.callee} receiver ${expected.receiver || "<none>"}`);
    assertEqual(!!withReceiver!.member, expected.receiver !== "", `${testCase.id}: member flag ${expected.callee}`);
    assertEqual(withReceiver!.argsCount, expected.argsCount, `${testCase.id}: argsCount ${expected.callee}`);
  }
}

function checkSlicingAndClosure(root: string, testCase: LanguageCase): void {
  const slice = executeSurgicalRead({ rootDir: root, targets: [testCase.sliceTarget], includeCallers: false });
  assertTrue(slice.text.includes(testCase.method), `${testCase.id}: slice contains method name`);
  assertTrue(
    slice.text.includes(testCase.methodFile),
    `${testCase.id}: slice header references declaration file`
  );

  const closure = executeSurgicalRead({ rootDir: root, targets: [`${testCase.childFile}#Child`], includeCallers: false });
  assertTrue(
    closure.text.includes(`[Type Closure] ${testCase.closureBaseFile}`),
    `${testCase.id}: type closure includes ${testCase.closureBaseFile}`
  );
}

function checkBlastRadius(root: string, testCase: LanguageCase): void {
  const index = getWorkspaceAstIndex(root);
  const blast = computeBlastRadius(index, testCase.blastTarget.file, testCase.blastTarget.symbol, 50);
  assertTrue(blast.totalCallSites > 0, `${testCase.id}: blast radius finds call sites`);
  const byFile = new Map<string, number>();
  for (const site of blast.callSites) {
    byFile.set(site.file, (byFile.get(site.file) ?? 0) + 1);
  }
  for (const expected of testCase.blastExpected) {
    const count = byFile.get(expected.file) ?? 0;
    assertTrue(
      count >= expected.min,
      `${testCase.id}: blast ${testCase.blastTarget.symbol} counts ${expected.file} (got ${count}, need >= ${expected.min})`
    );
  }
  // Language scoping: the same-named Base/Child/cancel fixtures exist in every language.
  for (const site of blast.callSites) {
    assertTrue(
      site.file.startsWith(`${testCase.dir}/`),
      `${testCase.id}: blast call site ${site.file} stays inside ${testCase.dir}/`
    );
  }
}

function checkKnowledgeGraph(
  testCase: LanguageCase,
  graph: ReturnType<typeof buildKnowledgeGraphData>
): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  assertIncludes(Array.from(nodeIds), testCase.methodNodeId, `${testCase.id}: KG defines node ${testCase.methodNodeId}`);
  const defines = graph.edges.filter((edge) => edge.kind === "defines");
  assertTrue(
    defines.some((edge) => edge.target === testCase.methodNodeId),
    `${testCase.id}: KG defines edge -> ${testCase.methodNodeId}`
  );

  const imports = graph.edges
    .filter((edge) => edge.kind === "imports")
    .map((edge) => [edge.source.replace(/^file:/, ""), edge.target.replace(/^file:/, "")] as [string, string]);
  for (const [source, target] of testCase.importEdges) {
    assertTrue(
      imports.some(([s, t]) => s === source && t === target),
      `${testCase.id}: KG imports edge ${source} -> ${target}`
    );
  }
  if (testCase.id === "go") {
    assertTrue(
      imports.filter(([source]) => source.startsWith("go/")).length === 0,
      "go: same-package files intentionally have no file import edges (documented gap)"
    );
  }

  const calls = graph.edges
    .filter((edge) => edge.kind === "calls")
    .map((edge) => [edge.source, edge.target] as [string, string]);
  for (const [source, target] of testCase.callsEdges) {
    assertTrue(
      calls.some(([s, t]) => s === source && t === target),
      `${testCase.id}: KG calls edge ${source} -> ${target}`
    );
  }
}

// ── Adversarial fixture ────────────────────────────────────────────────────

const ADVERSARIAL_FILES: Record<string, string> = {
  "adv-go/group.go": [
    "package demo",
    "",
    "type Child struct {",
    "\tBase",
    "\tExtra string",
    "}",
    "",
    "type Base struct { Max int }",
    "",
    "func grouped(a, b int, c string) int {",
    "\treturn a + b",
    "}",
    "",
  ].join("\n"),

  "adv-cpp/split.hpp": [
    "#pragma once",
    "",
    "class Engine {",
    "public:",
    "  int limit;",
    "  bool cancel(int id);",
    "};",
    "",
  ].join("\n"),
  "adv-cpp/split.cpp": [
    '#include "split.hpp"',
    "",
    "bool Engine::cancel(int id) {",
    "  return id > 0;",
    "}",
    "",
  ].join("\n"),
  "adv-cpp/use.cpp": ['#include "split.hpp"', "", "bool run(Engine e) {", "  return e.cancel(1);", "}", ""].join("\n"),

  "adv-cs/Part1.cs": [
    "namespace Demo.Partial;",
    "public partial class Split",
    "{",
    "    public void Process() { }",
    "}",
    "",
  ].join("\n"),
  "adv-cs/Part2.cs": [
    "namespace Demo.Partial;",
    "public partial class Split",
    "{",
    "    public int Value;",
    "}",
    "",
  ].join("\n"),
  "adv-cs/Point.cs": ["namespace Demo.Partial;", "public record struct Point(int X, int Y);", ""].join("\n"),
  "adv-cs/UsePartial.cs": [
    "namespace Demo.Partial;",
    "public static class UsePartial",
    "{",
    "    public static void Run(Split split) { split.Process(); }",
    "}",
    "",
  ].join("\n"),

  "adv-py/deco.py": [
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    "class Decorated:",
    "    limit: int = 0",
    "",
    "    @staticmethod",
    "    def cancel(order_id: str) -> bool:",
    "        return bool(order_id)",
    "",
  ].join("\n"),

  "adv-rs/trait.rs": [
    "pub trait Base {",
    "    fn cancel(&self) -> bool;",
    "}",
    "",
    "pub struct Child;",
    "",
    "impl Base for Child {",
    "    fn cancel(&self) -> bool {",
    "        true",
    "    }",
    "}",
    "",
    "pub fn run(c: &Child) -> bool {",
    "    c.cancel()",
    "}",
    "",
  ].join("\n"),
};

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log("=== GraphFlow six-language parity matrix (TS/JS reference) ===");
  const root = createWorkspace("matrix", PARITY_FILES);
  const index = getWorkspaceAstIndex(root);
  const graph = buildKnowledgeGraphData(index);
  const matrixRows: string[] = [];

  for (const testCase of LANGUAGE_CASES) {
    runTest(`${testCase.id}: engine + Base/Child/method symbols, spans, params, fields`, () => {
      checkEngineAndSymbols(root, testCase);
      matrixRows.push(`${testCase.id}: engine=${testCase.engine} symbols/spans=PASS`);
    });
    runTest(`${testCase.id}: call metadata (receiver/member/args)`, () => {
      checkCallMetadata(root, testCase);
    });
    runTest(`${testCase.id}: slicing + [Type Closure] includes Base`, () => {
      checkSlicingAndClosure(root, testCase);
      matrixRows.push(`${testCase.id}: slice/type-closure=PASS`);
    });
    runTest(`${testCase.id}: receiver-aware blast radius (own language only)`, () => {
      checkBlastRadius(root, testCase);
      matrixRows.push(`${testCase.id}: blast=${testCase.blastExpected.map((e) => `${e.file}:${e.min}`).join(",")}=PASS`);
    });
    runTest(`${testCase.id}: knowledge-graph defines/imports/calls edges`, () => {
      checkKnowledgeGraph(testCase, graph);
      matrixRows.push(`${testCase.id}: kg defines/imports/calls=PASS`);
    });
  }

  // Cross-language isolation: the TS reference run must not include any other language's calls.
  runTest("reference: TS blast radius does not leak into other language families", () => {
    const referenceBlast = computeBlastRadius(index, TS_CASE.blastTarget.file, TS_CASE.blastTarget.symbol, 50);
    for (const site of referenceBlast.callSites) {
      assertTrue(site.file.startsWith("ts/"), `TS blast stays in ts/ (got ${site.file})`);
    }
    const otherUserFiles = LANGUAGE_CASES.filter((c) => c.id !== "ts").map((c) => c.userFile);
    for (const userFile of otherUserFiles) {
      assertTrue(
        !referenceBlast.callSites.some((site) => site.file === userFile),
        `TS blast must not include ${userFile}`
      );
    }
  });

  // ── Rename parity: run last (mutates the workspace) ──
  for (const testCase of LANGUAGE_CASES) {
    runTest(`${testCase.id}: cross-file rename (${testCase.method} -> ${testCase.rename.newName})`, () => {
      const result = executeSurgicalEdit({
        rootDir: root,
        file: testCase.rename.file,
        symbol: testCase.rename.symbol,
        renameTo: testCase.rename.newName,
      });
      assertEqual(result.ok, true, `${testCase.id}: rename succeeds: ${result.text.split(/\r?\n/)[0]}`);
      assertSameSet(result.touchedFiles, testCase.rename.touched, `${testCase.id}: rename touched files`);
      const userText = readFileSync(join(root, testCase.userFile), "utf8");
      assertTrue(
        new RegExp(`\\b${testCase.rename.newName}\\b`).test(userText),
        `${testCase.id}: caller file contains ${testCase.rename.newName}`
      );
      assertTrue(
        !new RegExp(`\\b${testCase.method}\\b`).test(userText),
        `${testCase.id}: caller file no longer contains ${testCase.method}`
      );
      // Other languages' callers were not touched by this rename.
      for (const other of LANGUAGE_CASES) {
        if (other.id === testCase.id) continue;
        assertTrue(
          !result.touchedFiles.some((file) => file.startsWith(`${other.dir}/`)),
          `${testCase.id}: rename does not touch ${other.dir}/`
        );
      }
      // A same-named method in a sibling file that does not override/call the target stays intact.
      for (const untouched of testCase.untouchedSameNameFiles ?? []) {
        assertTrue(
          !result.touchedFiles.includes(untouched),
          `${testCase.id}: same-named sibling ${untouched} untouched`
        );
      }
    });
  }

  // ── Adversarial per-language cases ──
  const adversarialRoot = createWorkspace("adversarial", ADVERSARIAL_FILES);
  const adversarialIndex = getWorkspaceAstIndex(adversarialRoot);

  runTest("Go adversarial: grouped params and embedded fields", () => {
    const ast = adversarialIndex.getFileAnalysis("adv-go/group.go")!.ast;
    const grouped = ast.symbols.find((s) => s.name === "grouped");
    assertTrue(grouped, "go: grouped function symbol");
    assertEqual(grouped!.paramsCount, 3, "go: (a, b int, c string) counts 3 params");
    const child = ast.symbols.find((s) => s.name === "Child" && s.kind === "struct");
    assertTrue(child, "go: embedded Child struct symbol");
    assertIncludes(child!.fields ?? [], "Base", "go: embedded Base recorded as field");
    assertIncludes(child!.fields ?? [], "Extra", "go: named field Extra recorded");
  });

  runTest("C++ adversarial: header prototype + source definition split", () => {
    const headerAst = adversarialIndex.getFileAnalysis("adv-cpp/split.hpp")!.ast;
    const prototype = headerAst.symbols.find((s) => s.name === "cancel" && s.parentClass === "Engine");
    assertTrue(prototype, "cpp: header prototype symbol");
    assertEqual(prototype!.bodyStartLine, undefined, "cpp: header prototype has no body");
    const sourceAst = adversarialIndex.getFileAnalysis("adv-cpp/split.cpp")!.ast;
    const definition = sourceAst.symbols.find((s) => s.name === "cancel" && s.parentClass === "Engine");
    assertTrue(definition, "cpp: source definition symbol");
    assertTrue(definition!.bodyStartLine !== undefined, "cpp: source definition has a body");
    const blast = computeBlastRadius(adversarialIndex, "adv-cpp/split.cpp", "Engine.cancel", 20);
    assertTrue(blast.callSites.some((site) => site.file === "adv-cpp/use.cpp"), "cpp: blast finds caller via split declaration");
    const rename = executeSurgicalEdit({
      rootDir: adversarialRoot,
      file: "adv-cpp/split.cpp",
      symbol: "cancel",
      renameTo: "abortCancel",
    });
    assertEqual(rename.ok, true, `cpp: split-declaration rename succeeds: ${rename.text.split(/\r?\n/)[0]}`);
    assertIncludes(rename.touchedFiles, "adv-cpp/split.hpp", "cpp: rename updates header prototype");
    assertIncludes(rename.touchedFiles, "adv-cpp/use.cpp", "cpp: rename updates caller");
    assertTrue(
      readFileSync(join(adversarialRoot, "adv-cpp/split.hpp"), "utf8").includes("abortCancel"),
      "cpp: header prototype renamed"
    );
  });

  runTest("C# adversarial: partial classes + record mapping", () => {
    const part1 = adversarialIndex.getFileAnalysis("adv-cs/Part1.cs")!.ast;
    const part2 = adversarialIndex.getFileAnalysis("adv-cs/Part2.cs")!.ast;
    const split1 = part1.symbols.find((s) => s.name === "Split" && s.kind === "class");
    const split2 = part2.symbols.find((s) => s.name === "Split" && s.kind === "class");
    assertTrue(split1, "cs: partial class Split in part 1");
    assertTrue(split2, "cs: partial class Split in part 2");
    const record = adversarialIndex.getFileAnalysis("adv-cs/Point.cs")!.ast.symbols.find((s) => s.name === "Point");
    assertTrue(record, "cs: record struct Point symbol");
    assertEqual(record!.kind, "interface", "cs: record currently maps to interface kind (documented parity choice)");
    const blast = computeBlastRadius(adversarialIndex, "adv-cs/Part1.cs", "Split.Process", 20);
    assertTrue(blast.callSites.some((site) => site.file === "adv-cs/UsePartial.cs"), "cs: partial-class method blast finds caller");
    const rename = executeSurgicalEdit({
      rootDir: adversarialRoot,
      file: "adv-cs/Part1.cs",
      symbol: "Process",
      renameTo: "Execute",
    });
    assertEqual(rename.ok, true, `cs: partial-class method rename succeeds: ${rename.text.split(/\r?\n/)[0]}`);
    assertIncludes(rename.touchedFiles, "adv-cs/UsePartial.cs", "cs: partial-class caller renamed");
    assertTrue(
      readFileSync(join(adversarialRoot, "adv-cs/UsePartial.cs"), "utf8").includes(".Execute("),
      "cs: caller uses Execute"
    );
  });

  runTest("Python adversarial: decorated class/method spans and resolution", () => {
    const ast = adversarialIndex.getFileAnalysis("adv-py/deco.py")!.ast;
    const decorated = ast.symbols.find((s) => s.name === "Decorated" && s.kind === "class");
    assertTrue(decorated, "py: decorated class symbol");
    assertEqual(decorated!.line, 3, "py: decorated class span starts at the decorator line");
    const method = ast.symbols.find((s) => s.name === "cancel" && s.parentClass === "Decorated");
    assertTrue(method, "py: decorated method symbol");
    assertEqual(method!.line, 7, "py: decorated method span starts at its decorator line");
    assertTrue(
      readFileSync(join(adversarialRoot, "adv-py/deco.py"), "utf8").includes("@dataclass"),
      "py: decorator source preserved"
    );
    assertIncludes(decorated!.fields ?? [], "limit", "py: dataclass annotation field captured");
  });

  runTest("Rust adversarial: trait/impl recognized; trait dispatch documented as unsupported", () => {
    const ast = adversarialIndex.getFileAnalysis("adv-rs/trait.rs")!.ast;
    const traitSymbol = ast.symbols.find((s) => s.name === "Base" && s.kind === "interface");
    assertTrue(traitSymbol, "rs: trait Base maps to interface kind");
    const implMethod = ast.symbols.find((s) => s.name === "cancel" && s.parentClass === "Child");
    assertTrue(implMethod, "rs: impl Base for Child method has parentClass Child");
    const blast = computeBlastRadius(adversarialIndex, "adv-rs/trait.rs", "Child.cancel", 20);
    assertTrue(blast.callSites.some((site) => site.file === "adv-rs/trait.rs"), "rs: concrete impl method blast finds caller");
    // Documented gap: trait-method declarations are not emitted as method symbols, so
    // dispatching to the trait target yields a graceful empty result (never a wrong target).
    const traitBlast = computeBlastRadius(adversarialIndex, "adv-rs/trait.rs", "Base.cancel", 20);
    assertEqual(traitBlast.totalCallSites, 0, "rs: trait-level dispatch not modelled (documented unsupported)");
  });

  // ── Parity matrix / gap report ──
  console.log("\n=== parity matrix ===");
  for (const row of matrixRows) console.log(`  ${row}`);
  console.log("  gaps (documented, asserted as graceful degradation):");
  console.log("    - Go same-package siblings have no file `imports` edges (package scope, not file imports)");
  console.log("    - Rust trait-method declarations are not emitted as method symbols (trait dispatch unsupported)");
  console.log("    - C# `record` maps to interface kind and `using` namespaces resolve by file stem");
  console.log("    - C has no inheritance: parity uses function call/rename/type closure (struct field reference)");
  console.log("    - Go embedding models the first embedded type as the promoted parent (deep embedding not chained)");
  console.log("    - rename stays receiver-aware: a file mixing target and foreign same-named receiver calls is rejected");
  console.log("    - C++ split declarations are treated as one method; targeting the header prototype may under-count callers");
  console.log(`\n${passed} passed, ${failed} failed`);
}

try {
  main();
} catch (error) {
  failed += 1;
  console.error(`UNCAUGHT: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

if (failed > 0) process.exit(1);
