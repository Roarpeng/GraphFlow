/**
 * GraphFlow 3.3 — Core Semantics Regression Tests (`tests/core-semantics.test.ts`)
 *
 * Standalone (no test runner): run with `npx tsx tests/core-semantics.test.ts`.
 * Exits non-zero on any failure. All fixtures live under os.tmpdir(); the real repo
 * is never read or mutated by these tests.
 *
 * Covers:
 *   1. TS method-level blast radius finds member calls through the imported class.
 *   2. TS cross-repo rename updates member/this call sites and leaves a clean workspace.
 *   3. Python method-level blast radius finds member calls through the imported class.
 *   4. Python structural syntax guard rejects invalid gf_edit payloads (missing ':' etc.).
 *   5. Language scoping: a Rust `cancel` never matches C++ declarations/callers.
 *   6. C/C++ `#include` (wildcard import) is never a specific-symbol importer.
 *   7. Go/Rust struct declarations report kind "struct" and keep type-closure display.
 *   8. C++ prototypes/declarations are not counted as call sites.
 *   9. Python method rename updates member call sites.
 *  10. Rename refuses (REJECTED + rolled back) when a duck-typed caller cannot be resolved.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeSourceFile,
  computeBlastRadius,
  executeSurgicalEdit,
  executeSurgicalRead,
  getWorkspaceAstIndex,
} from "../src/index.js";

let passed = 0;
let failed = 0;
const workspaceRoots: string[] = [];

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

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    fail(`${message} (missing ${JSON.stringify(needle)}; got:\n${haystack.slice(0, 1200)})`);
  }
}

function assertNotIncludes(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    fail(`${message} (unexpected ${JSON.stringify(needle)}; got:\n${haystack.slice(0, 1200)})`);
  }
}

function createWorkspace(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `gf-core-semantics-${name}-`));
  workspaceRoots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

function readWorkspaceFile(root: string, relPath: string): string {
  return readFileSync(join(root, relPath), "utf8");
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

const TS_MODEL = [
  "export class OrderService {",
  "  cancelOrder(orderId: string, reason?: string): boolean {",
  "    return Boolean(orderId ?? reason);",
  "  }",
  "",
  "  retry(orderId: string): boolean {",
  "    return this.cancelOrder(orderId);",
  "  }",
  "}",
].join("\n");

const TS_APP = [
  "import { OrderService } from './model.js';",
  "",
  "export function run(service: OrderService, orderId: string): boolean {",
  "  return service.cancelOrder(orderId, 'user-request');",
  "}",
].join("\n");

function main(): void {
  console.log("=== GraphFlow core semantics regression suite ===");

  // 1. TS method-level blast radius through the imported parent class.
  runTest("1) TS method blast radius finds member calls via imported class", () => {
    const root = createWorkspace("ts-blast", { "ts/model.ts": TS_MODEL, "ts/app.ts": TS_APP });
    const index = getWorkspaceAstIndex(root);

    const appAst = index.getFileAnalysis("ts/app.ts")!.ast;
    const memberCall = appAst.calls.find((c) => c.callee === "cancelOrder");
    assertTrue(memberCall, "analyzer must record service.cancelOrder(...) as a call");
    assertEqual(memberCall!.receiver, "service", "member call must carry its receiver identifier");
    assertEqual(memberCall!.member, true, "member call must be flagged member=true");

    const blast = computeBlastRadius(index, "ts/model.ts", "cancelOrder", 10);
    assertTrue(blast.totalCallSites >= 1, `expected >=1 call site, got ${blast.totalCallSites}`);
    assertTrue(
      blast.callSites.some((site) => site.file === "ts/app.ts"),
      `expected a call site in ts/app.ts, got ${JSON.stringify(blast.callSites.map((s) => s.file))}`
    );
    assertTrue(
      blast.importers.some((imp) => imp.file === "ts/app.ts"),
      "ts/app.ts imports the parent class, so it must be listed as an importer"
    );

    const read = executeSurgicalRead({
      rootDir: root,
      targets: ["ts/model.ts#cancelOrder"],
      includeCallers: true,
    });
    assertIncludes(read.text, "[Blast Radius:", "gf_read must surface the method blast radius");
    assertIncludes(read.text, "ts/app.ts:", "gf_read must list the external member call site");
  });

  // 2. TS rename updates member + this call sites and never leaves old references behind.
  runTest("2) TS rename updates member/this call sites without breaking callers", () => {
    const root = createWorkspace("ts-rename", { "ts/model.ts": TS_MODEL, "ts/app.ts": TS_APP });

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "ts/model.ts",
      symbol: "cancelOrder",
      renameTo: "abortOrder",
    });
    assertEqual(result.ok, true, `rename must succeed; got: ${result.text}`);
    assertTrue(
      result.touchedFiles.includes("ts/model.ts") && result.touchedFiles.includes("ts/app.ts"),
      `both definition and member call site must be touched, got ${JSON.stringify(result.touchedFiles)}`
    );

    const modelText = readWorkspaceFile(root, "ts/model.ts");
    const appText = readWorkspaceFile(root, "ts/app.ts");
    assertIncludes(appText, "service.abortOrder(", "member call site must be renamed");
    assertIncludes(modelText, "this.abortOrder(", "this.method() call site must be renamed");
    assertNotIncludes(modelText, "cancelOrder", "old name must be gone from the declaration file");
    assertNotIncludes(appText, "cancelOrder", "old name must be gone from the caller file");

    assertEqual(analyzeSourceFile("ts/model.ts", modelText).syntaxErrors.length, 0, "renamed model.ts must parse cleanly");
    assertEqual(analyzeSourceFile("ts/app.ts", appText).syntaxErrors.length, 0, "renamed app.ts must parse cleanly");

    // index must be invalidated so follow-up analysis sees the renamed call sites.
    const index = getWorkspaceAstIndex(root);
    const blast = computeBlastRadius(index, "ts/model.ts", "abortOrder", 10);
    assertTrue(blast.totalCallSites >= 2, `expected both this/ service call sites after rename, got ${blast.totalCallSites}`);
    assertEqual(computeBlastRadius(index, "ts/model.ts", "cancelOrder", 10).totalCallSites, 0, "old name must have no call sites left");
  });

  // 3. Python method blast radius through an imported parent class.
  runTest("3) Python method blast radius finds member calls via imported class", () => {
    const root = createWorkspace("py-blast", {
      "py/model.py": [
        "class OrderService:",
        "    def cancel_order(self, order_id):",
        "        return bool(order_id)",
      ].join("\n"),
      "py/app.py": [
        "from .model import OrderService",
        "",
        "def run(service: OrderService, order_id):",
        "    return service.cancel_order(order_id)",
      ].join("\n"),
    });
    const index = getWorkspaceAstIndex(root);

    const model = index.getFileAnalysis("py/model.py")!.ast;
    const cancelSym = model.symbols.find((s) => s.name === "cancel_order");
    assertTrue(cancelSym, "Python method symbol must be extracted");
    assertEqual(cancelSym!.kind, "method", "def inside class must be kind method");
    assertEqual(cancelSym!.parentClass, "OrderService", "method must carry parentClass");

    const blast = computeBlastRadius(index, "py/model.py", "cancel_order", 10);
    assertTrue(blast.totalCallSites >= 1, `expected >=1 Python call site, got ${blast.totalCallSites}`);
    assertTrue(
      blast.callSites.some((site) => site.file === "py/app.py"),
      `expected a call site in py/app.py, got ${JSON.stringify(blast.callSites.map((s) => s.file))}`
    );
    assertTrue(
      blast.importers.some((imp) => imp.file === "py/app.py"),
      "py/app.py imports OrderService and must be listed as an importer"
    );
  });

  // 4. Python syntax guard: invalid gf_edit payloads are rejected and rolled back.
  runTest("4) Python syntax guard rejects gf_edit payloads with missing ':'", () => {
    const root = createWorkspace("py-syntax", {
      "py/svc.py": [
        "def handle(order_id):",
        "    return order_id",
      ].join("\n"),
    });

    const invalidEdit = executeSurgicalEdit({
      rootDir: root,
      file: "py/svc.py",
      symbol: "handle",
      newCode: ["def handle(order_id):", "    if order_id", "        return order_id"].join("\n"),
    });
    assertEqual(invalidEdit.ok, false, `missing ':' must be rejected; got: ${invalidEdit.text}`);
    assertIncludes(invalidEdit.text, "REJECTED [syntax-error]", "rejection must be reported");
    assertIncludes(invalidEdit.text, "missing ':'", "diagnostic must name the missing colon");
    assertIncludes(
      readWorkspaceFile(root, "py/svc.py"),
      "def handle(order_id):",
      "invalid edit must be rolled back on disk"
    );

    // Inline compound statement after a def colon (`def f(): if x`) is never valid Python.
    const inlineEdit = executeSurgicalEdit({
      rootDir: root,
      file: "py/svc.py",
      symbol: "handle",
      newCode: "def handle(order_id): if order_id",
    });
    assertEqual(inlineEdit.ok, false, "one-line compound suite must be rejected");
    assertIncludes(inlineEdit.text, "REJECTED [syntax-error]", "one-line suite rejection must be reported");

    // Unbalanced brackets are rejected too.
    const unbalanced = executeSurgicalEdit({
      rootDir: root,
      file: "py/svc.py",
      symbol: "handle",
      newCode: ["def handle(order_id):", "    return bool(order_id"].join("\n"),
    });
    assertEqual(unbalanced.ok, false, "unbalanced brackets must be rejected");
    assertIncludes(unbalanced.text, "REJECTED [syntax-error]", "unbalanced bracket rejection must be reported");

    // No false positives on realistic Python: docstrings, multi-line signatures, try/except,
    // match/case, comprehensions, slices, lambdas, backslash continuations, f-strings.
    const validPython = [
      "from dataclasses import dataclass",
      "",
      "@dataclass",
      "class Config:",
      '    """Multi-line docstring with ( brackets [ and ] inside.',
      "    Second docstring line with a : colon and an 'if x' snippet.",
      '    """',
      "    max_tokens: int",
      "    strict: bool",
      "",
      "def compute(config: Config,",
      "            scale: int = 2,",
      "            *,",
      "            extra=0) -> int:",
      '    """Compute with a docstring containing def fake(): pass and a : colon."""',
      "    values = {key: value for key, value in {'a': 1}.items() if value}",
      "    pairs = [(x, x * 2) for x in range(scale) if x]",
      "    sliced = values['a'] if values else [1, 2, 3][0:2]",
      "    fn = lambda item: item + 1",
      "    total = fn(config.max_tokens) + extra",
      "    if config.strict:",
      "        return min(total, 1000)",
      "    elif total > 10:",
      "        return total",
      "    else:",
      "        return max(total, 0)",
      "",
      "def classify(value):",
      "    match value:",
      "        case {'kind': kind} if kind:",
      "            return kind",
      "        case [first, *rest]:",
      "            return first",
      "        case _:",
      "            return None",
      "",
      "def guarded(path):",
      "    try:",
      "        with open(path) as handle:",
      "            return len(handle.read())",
      "    except (OSError, ValueError) as err:",
      "        return -1",
      "    finally:",
      "        pass",
      "",
      "def continuation(a, \\",
      "                 b):",
      "    return a + b",
      "",
      "def while_else(items):",
      "    while items:",
      "        return items.pop()",
      "    else:",
      "        return None",
      "",
      "def async_call():",
      "    async def inner():",
      "        return 1",
      "    return inner",
      "",
      "def fstring(name: str) -> str:",
      '    return f"hello {name!r}: (not a bracket)"',
      "",
    ].join("\n");
    const validAst = analyzeSourceFile("py/valid_kitchen_sink.py", validPython);
    assertEqual(
      validAst.syntaxErrors.length,
      0,
      `valid Python must produce no syntax diagnostics; got ${JSON.stringify(validAst.syntaxErrors)}`
    );
  });

  // 5. Language scoping: Rust `cancel` must not match C++ declarations/callers.
  runTest("5) Rust cancel does NOT match C++ declarations or callers", () => {
    const root = createWorkspace("lang-scope", {
      "cpp/engine.hpp": ["struct Engine {", "  bool cancel(int id);", "};"].join("\n"),
      "cpp/engine.cpp": [
        '#include "engine.hpp"',
        "",
        "bool Engine::cancel(int id) {",
        "  return id > 0;",
        "}",
        "",
        "bool Engine::cancel(int id);",
      ].join("\n"),
      "rs/client.rs": [
        "pub struct Client;",
        "",
        "impl Client {",
        "    pub fn cancel(&self, id: u32) -> bool {",
        "        id > 0",
        "    }",
        "}",
        "",
        "pub fn run(client: &Client) -> bool {",
        "    client.cancel(3)",
        "}",
      ].join("\n"),
    });
    const index = getWorkspaceAstIndex(root);

    const rustBlast = computeBlastRadius(index, "rs/client.rs", "cancel", 10);
    assertTrue(
      !rustBlast.callSites.some((site) => site.file.startsWith("cpp/")),
      `Rust blast radius must not include C++ files, got ${JSON.stringify(rustBlast.callSites.map((s) => s.file))}`
    );
    assertTrue(
      !rustBlast.importers.some((imp) => imp.file.startsWith("cpp/")),
      "Rust blast radius must not list C++ importers"
    );

    const cppBlast = computeBlastRadius(index, "cpp/engine.cpp", "cancel", 10);
    assertEqual(cppBlast.totalCallSites, 0, "C++ declaration-only cancel must have 0 call sites");
    assertTrue(
      !cppBlast.callSites.some((site) => site.file.endsWith(".rs")),
      "C++ blast radius must not include Rust files"
    );
  });

  // 6. C/C++ #include is a wildcard import, never a specific-symbol importer.
  runTest("6) C++ #include is not a symbol importer", () => {
    const root = createWorkspace("cpp-include", {
      "cpp/engine.cpp": [
        "struct CppFrameLimit { int maxBytes; };",
        "",
        "int calcCppFrame(const CppFrameLimit& lim, int bonus) {",
        "  return lim.maxBytes + bonus;",
        "}",
      ].join("\n"),
      "cpp/engine_test.cpp": [
        '#include "engine.cpp"',
        "",
        "int invokeSameDir() {",
        "  CppFrameLimit lim{1};",
        "  return calcCppFrame(lim, 2);",
        "}",
      ].join("\n"),
      "cpp/other/consumer.cpp": [
        '#include "engine.cpp"',
        "",
        "int invokeOtherDir() {",
        "  CppFrameLimit lim{1};",
        "  return calcCppFrame(lim, 2);",
        "}",
      ].join("\n"),
    });
    const index = getWorkspaceAstIndex(root);

    const consumerAst = index.getFileAnalysis("cpp/other/consumer.cpp")!.ast;
    assertTrue(
      consumerAst.imports.some((imp) => imp.importedNames.includes("*")),
      "C/C++ #include must be modelled as a wildcard import"
    );

    const blast = computeBlastRadius(index, "cpp/engine.cpp", "calcCppFrame", 10);
    assertEqual(blast.importers.length, 0, "wildcard #include must not be listed as a symbol importer");
    assertTrue(
      blast.totalCallSites >= 1 && blast.callSites.some((site) => site.file === "cpp/engine_test.cpp"),
      `same-dir TU caller must count, got ${JSON.stringify(blast.callSites.map((s) => s.file))}`
    );
    assertTrue(
      !blast.callSites.some((site) => site.file === "cpp/other/consumer.cpp"),
      "a different-directory caller relying only on a wildcard #include must not be counted"
    );
  });

  // 7. Go/Rust struct declarations use kind "struct" and keep type-closure display.
  runTest("7) Go/Rust struct declarations report kind struct and keep type closure", () => {
    const root = createWorkspace("struct-kind", {
      "go/types.go": ["package budget", "", "type GoBudgetSpec struct {", "    MaxTokens int", "    Strict    bool", "}"].join("\n"),
      "go/engine.go": [
        "package budget",
        "",
        "func ComputeGoBudget(spec GoBudgetSpec, factor int) int {",
        "    return spec.MaxTokens * factor",
        "}",
      ].join("\n"),
      "rs/types.rs": ["pub struct RustQuota {", "    pub limit: usize,", "    pub hard: bool,", "}"].join("\n"),
      "rs/engine.rs": [
        "use crate::types::RustQuota;",
        "",
        "pub fn eval_rust_quota(q: &RustQuota, mult: usize) -> usize {",
        "    q.limit * mult",
        "}",
      ].join("\n"),
    });

    const goTypes = analyzeSourceFile("go/types.go", readWorkspaceFile(root, "go/types.go"));
    const goSpec = goTypes.symbols.find((s) => s.name === "GoBudgetSpec");
    assertTrue(goSpec, "Go struct symbol must be extracted");
    assertEqual(goSpec!.kind, "struct", "Go struct must be reported as kind struct, not interface");
    assertEqual(goSpec!.fields?.length, 2, "Go struct fields must still be extracted");

    const rsTypes = analyzeSourceFile("rs/types.rs", readWorkspaceFile(root, "rs/types.rs"));
    const rsQuota = rsTypes.symbols.find((s) => s.name === "RustQuota");
    assertTrue(rsQuota, "Rust struct symbol must be extracted");
    assertEqual(rsQuota!.kind, "struct", "Rust struct must be reported as kind struct, not interface");

    const goRead = executeSurgicalRead({
      rootDir: root,
      targets: ["go/engine.go#ComputeGoBudget"],
      includeCallers: false,
    });
    assertIncludes(goRead.text, "(struct GoBudgetSpec)", "type-closure display must say struct for Go");
    assertIncludes(goRead.text, "[Type Closure] go/types.go", "Go struct type closure must still resolve");

    const rsRead = executeSurgicalRead({
      rootDir: root,
      targets: ["rs/engine.rs#eval_rust_quota"],
      includeCallers: false,
    });
    assertIncludes(rsRead.text, "(struct RustQuota)", "type-closure display must say struct for Rust");
    assertIncludes(rsRead.text, "[Type Closure] rs/types.rs", "Rust struct type closure must still resolve");
  });

  // 8. C++ prototype/declaration lines are not call sites.
  runTest("8) C++ declarations are not counted as calls", () => {
    const cppSource = [
      "struct Engine {",
      "  bool cancel(int id);",
      "};",
      "",
      "bool Engine::cancel(int id) {",
      "  return id > 0;",
      "}",
      "",
      "bool Engine::cancel(int id);",
    ].join("\n");
    const ast = analyzeSourceFile("cpp/engine.cpp", cppSource);
    const cancelCalls = ast.calls.filter((call) => call.callee === "cancel");
    assertTrue(cancelCalls.length > 0, "analyzer should record declaration lines with isDeclaration=true");
    assertTrue(
      cancelCalls.some((call) => call.isDeclaration === true),
      `pure declaration must be flagged isDeclaration; got ${JSON.stringify(cancelCalls)}`
    );
    assertTrue(
      !cancelCalls.some((call) => !call.isDeclaration),
      `no non-declaration call to cancel may be recorded; got ${JSON.stringify(cancelCalls)}`
    );

    const root = createWorkspace("cpp-decl", { "cpp/engine.cpp": cppSource });
    const index = getWorkspaceAstIndex(root);
    assertEqual(
      computeBlastRadius(index, "cpp/engine.cpp", "cancel", 10).totalCallSites,
      0,
      "declaration-only C++ symbol must have no blast-radius call sites"
    );
  });

  // 9. Python method rename updates member call sites.
  runTest("9) Python rename updates member call sites", () => {
    const root = createWorkspace("py-rename", {
      "py/model.py": ["class OrderService:", "    def cancel_order(self, order_id):", "        return bool(order_id)"].join("\n"),
      "py/app.py": [
        "from .model import OrderService",
        "",
        "def run(service: OrderService, order_id):",
        "    return service.cancel_order(order_id)",
      ].join("\n"),
    });

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "py/model.py",
      symbol: "cancel_order",
      renameTo: "abort_order",
    });
    assertEqual(result.ok, true, `Python method rename must succeed; got: ${result.text}`);
    assertIncludes(
      readWorkspaceFile(root, "py/app.py"),
      "service.abort_order(",
      "Python member call site must be renamed"
    );
    assertNotIncludes(readWorkspaceFile(root, "py/model.py"), "cancel_order", "old Python method name must be gone");
    assertEqual(
      analyzeSourceFile("py/app.py", readWorkspaceFile(root, "py/app.py")).syntaxErrors.length,
      0,
      "renamed Python caller must remain syntactically valid"
    );
  });

  // 10. Rename refuses to silently leave a broken duck-typed caller.
  runTest("10) rename rejects unresolved duck-typed callers and rolls back", () => {
    const root = createWorkspace("ts-rename-reject", {
      "ts/model.ts": TS_MODEL,
      "ts/app.ts": TS_APP,
      "ts/duck.ts": [
        "export function invoke(svc: { cancelOrder(id: string): boolean }): boolean {",
        '  return svc.cancelOrder("x");',
        "}",
      ].join("\n"),
    });

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "ts/model.ts",
      symbol: "cancelOrder",
      renameTo: "abortOrder",
    });
    assertEqual(result.ok, false, `unresolved duck-typed caller must force rejection; got: ${result.text}`);
    assertIncludes(result.text, "REJECTED [rename-unresolved-callers]", "rejection kind must be reported");
    assertIncludes(result.text, "ts/duck.ts", "the unresolved file must be listed");

    // Rollback: nothing was written.
    assertIncludes(readWorkspaceFile(root, "ts/model.ts"), "cancelOrder", "declaration file must be untouched");
    assertIncludes(readWorkspaceFile(root, "ts/app.ts"), "service.cancelOrder(", "known caller must be untouched");
    assertNotIncludes(readWorkspaceFile(root, "ts/app.ts"), "abortOrder", "no partial rename may leak to disk");
    assertTrue(existsSync(join(root, "ts/duck.ts")), "workspace must not be deleted/partially committed");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

try {
  main();
} catch (err) {
  failed += 1;
  console.error(`UNCAUGHT: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  for (const root of workspaceRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

if (failed > 0) {
  process.exit(1);
}
