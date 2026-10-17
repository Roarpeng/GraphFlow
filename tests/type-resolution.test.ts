/**
 * GraphFlow 3.3.2 — Receiver-Type Resolution Tests (`tests/type-resolution.test.ts`)
 *
 * Standalone: `npx tsx tests/type-resolution.test.ts` (exit code 1 on failure).
 * Every fixture lives under os.tmpdir(); the real repo is never read or mutated.
 *
 * Covers the lightweight receiver-type inference that makes method blast radius and
 * rename stop misattributing same-named methods across classes:
 *   - TS/Python one file with `A.cancel` + `B.cancel`: `b.cancel()` counts for B only.
 *   - `this.cancel()` / `self.cancel()` count for the enclosing class.
 *   - Go / C# / C++ / Rust: a typed receiver is attributed, a same-named method on a
 *     different receiver type is not.
 *   - `this.field.method()` resolves the field type per enclosing class; Go resolves
 *     sibling-method calls through the method receiver variable.
 *   - Cross-file: known-foreign receivers are excluded, unknown duck-typed receivers
 *     still fall back to the importer heuristic.
 *   - Inheritance: `class B extends A` (TS/Python/C#/C++) resolves `super`/`base`/`A::m`
 *     to A, and a B receiver dispatches to inherited A methods only without an override.
 *   - Flow-insensitive reassignment: last assignment in one block wins; assignments split
 *     across different blocks with different types stay unknown.
 *   - Generics/nullable/array wrappers (`Box<Order>`, `Order | null`, `Order[]`,
 *     `Promise<Order>`) unwrap to the base receiver type; `auto`/`var` + `new`/`{}` resolve.
 *   - Rename: same-file A/B is rejected as ambiguous; a file whose only `<name>` calls
 *     resolve to another class is skipped (B untouched); a mixed file is rejected;
 *     inherited and `super` call sites are renamed.
 *   - `inferReceiverTypes` is exported and returns per-language receiver -> type maps.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  computeBlastRadius,
  executeSurgicalEdit,
  executeSurgicalRead,
  getWorkspaceAstIndex,
  inferReceiverTypeIndex,
  inferReceiverTypes,
  parseClassParents,
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
    fail(`${message} (missing ${JSON.stringify(needle)}; got:\n${haystack.slice(0, 800)})`);
  }
}

function assertNotIncludes(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    fail(`${message} (unexpected ${JSON.stringify(needle)})`);
  }
}

function createWorkspace(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `gf-type-resolution-${name}-`));
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

function blast(root: string, targetFile: string, symbolQuery: string): ReturnType<typeof computeBlastRadius> {
  return computeBlastRadius(getWorkspaceAstIndex(root), targetFile, symbolQuery, 20);
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

const TS_AB_FILE = [
  "class A { cancel(): void {} }",
  "class B { cancel(): void {} }",
  "export function run(b: B): void { b.cancel(); }",
  "",
].join("\n");

const PY_AB_FILE = [
  "class A:",
  "    def cancel(self):",
  "        return True",
  "",
  "class B:",
  "    def cancel(self):",
  "        return False",
  "",
  "def run(b: B):",
  "    return b.cancel()",
  "",
].join("\n");

function main(): void {
  console.log("=== GraphFlow receiver-type resolution suite ===");

  // 1. TS: same file, A and B both declare cancel(); b.cancel() is B's caller only.
  runTest("1) TS same-file A/B: b.cancel() counts for B only, A gets 0", () => {
    const root = createWorkspace("ts-ab", { "model.ts": TS_AB_FILE });
    const aBlast = blast(root, "model.ts", "A.cancel");
    const bBlast = blast(root, "model.ts", "B.cancel");
    assertEqual(aBlast.totalCallSites, 0, `A.cancel must have no call sites, got ${JSON.stringify(aBlast.callSites)}`);
    assertEqual(bBlast.totalCallSites, 1, "B.cancel must have exactly one call site");
    assertEqual(bBlast.callSites[0]?.line, 3, "b.cancel() is on line 3");
  });

  // 2. Python: same-file A/B attribution.
  runTest("2) Python same-file A/B: b.cancel() counts for B only, A gets 0", () => {
    const root = createWorkspace("py-ab", { "model.py": PY_AB_FILE });
    assertEqual(blast(root, "model.py", "A.cancel").totalCallSites, 0, "A.cancel must have no call sites");
    const bBlast = blast(root, "model.py", "B.cancel");
    assertEqual(bBlast.totalCallSites, 1, "B.cancel must have exactly one call site");
    assertEqual(bBlast.callSites[0]?.line, 10, "b.cancel() is on line 10");
  });

  // 3. TS: this.cancel() is attributed to the enclosing class.
  runTest("3) TS this.cancel() inside A counts for A", () => {
    const root = createWorkspace("ts-this", {
      "a.ts": [
        "class A {",
        "  cancel(): void {}",
        "  retry(): void {",
        "    this.cancel();",
        "  }",
        "}",
        "",
        "class B {",
        "  cancel(): void {}",
        "  retry(): void {",
        "    this.cancel();",
        "  }",
        "}",
      ].join("\n"),
    });
    const aBlast = blast(root, "a.ts", "A.cancel");
    assertEqual(aBlast.totalCallSites, 1, "A must count only its own this.cancel()");
    assertEqual(aBlast.callSites[0]?.line, 4, "A.this.cancel() is on line 4");
    const bBlast = blast(root, "a.ts", "B.cancel");
    assertEqual(bBlast.totalCallSites, 1, "B must count only its own this.cancel()");
    assertEqual(bBlast.callSites[0]?.line, 11, "B.this.cancel() is on line 11");
  });

  // 4. Python: self.cancel() is attributed to the enclosing class.
  runTest("4) Python self.cancel() counts for the enclosing class", () => {
    const root = createWorkspace("py-self", {
      "a.py": [
        "class A:",
        "    def cancel(self):",
        "        return True",
        "    def retry(self):",
        "        return self.cancel()",
        "",
        "class B:",
        "    def cancel(self):",
        "        return False",
        "    def retry(self):",
        "        return self.cancel()",
      ].join("\n"),
    });
    const aBlast = blast(root, "a.py", "A.cancel");
    assertEqual(aBlast.totalCallSites, 1, "A must count only its own self.cancel()");
    assertEqual(aBlast.callSites[0]?.line, 5, "A.self.cancel() is on line 5");
    assertEqual(blast(root, "a.py", "B.cancel").totalCallSites, 1, "B must count only its own self.cancel()");
  });

  // 5. Go: receiver type inferred from `var x Type`.
  runTest("5) Go receiver method: typed receiver counts, different type does not", () => {
    const root = createWorkspace("go-recv", {
      "svc.go": [
        "package svc",
        "",
        "type Service struct{}",
        "type Other struct{}",
        "",
        "func (s *Service) Cancel() {}",
        "func (o *Other) Cancel() {}",
        "",
        "func Run() {",
        "\tvar s Service",
        "\ts.Cancel()",
        "\tvar other Other",
        "\tother.Cancel()",
        "}",
        "",
      ].join("\n"),
    });
    const serviceBlast = blast(root, "svc.go", "Service.Cancel");
    assertEqual(serviceBlast.totalCallSites, 1, `Service.Cancel must have 1 call site, got ${JSON.stringify(serviceBlast.callSites)}`);
    assertEqual(serviceBlast.callSites[0]?.line, 11, "s.Cancel() is on line 11");
    const otherBlast = blast(root, "svc.go", "Other.Cancel");
    assertEqual(otherBlast.totalCallSites, 1, `Other.Cancel must have 1 call site, got ${JSON.stringify(otherBlast.callSites)}`);
    assertEqual(otherBlast.callSites[0]?.line, 13, "other.Cancel() is on line 13");
  });

  // 6. C#: receiver type inferred from `var x = new Type()`.
  runTest("6) C# receiver method: typed receiver counts, different type does not", () => {
    const root = createWorkspace("cs-recv", {
      "Svc.cs": [
        "public class OrderService",
        "{",
        "    public void Cancel()",
        "    {",
        "    }",
        "}",
        "public class OtherService",
        "{",
        "    public void Cancel()",
        "    {",
        "    }",
        "}",
        "public class Runner",
        "{",
        "    public void Run()",
        "    {",
        "        var svc = new OrderService();",
        "        svc.Cancel();",
        "        var other = new OtherService();",
        "        other.Cancel();",
        "    }",
        "}",
        "",
      ].join("\n"),
    });
    const orderBlast = blast(root, "Svc.cs", "OrderService.Cancel");
    assertEqual(orderBlast.totalCallSites, 1, `OrderService.Cancel must have 1 call site, got ${JSON.stringify(orderBlast.callSites)}`);
    assertEqual(orderBlast.callSites[0]?.line, 18, "svc.Cancel() is on line 18");
    const otherBlast = blast(root, "Svc.cs", "OtherService.Cancel");
    assertEqual(otherBlast.totalCallSites, 1, "OtherService.Cancel must have 1 call site");
    assertEqual(otherBlast.callSites[0]?.line, 20, "other.Cancel() is on line 20");
  });

  // 7. C++: receiver type inferred from `Type x;`.
  runTest("7) C++ receiver method: declared receiver counts, different type does not", () => {
    const root = createWorkspace("cpp-recv", {
      "svc.cpp": [
        "class OrderService { public: void cancel(); };",
        "class OtherService { public: void cancel(); };",
        "void OrderService::cancel() {}",
        "void OtherService::cancel() {}",
        "void run() {",
        "  OrderService svc;",
        "  svc.cancel();",
        "  OtherService other;",
        "  other.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const orderBlast = blast(root, "svc.cpp", "OrderService.cancel");
    assertEqual(orderBlast.totalCallSites, 1, `OrderService.cancel must have 1 call site, got ${JSON.stringify(orderBlast.callSites)}`);
    assertEqual(orderBlast.callSites[0]?.line, 7, "svc.cancel() is on line 7");
    const otherBlast = blast(root, "svc.cpp", "OtherService.cancel");
    assertEqual(otherBlast.totalCallSites, 1, "OtherService.cancel must have 1 call site");
    assertEqual(otherBlast.callSites[0]?.line, 9, "other.cancel() is on line 9");
  });

  // 8. Rust: receiver type inferred from `let x: &Type`.
  runTest("8) Rust receiver method: annotated receiver counts, different type does not", () => {
    const root = createWorkspace("rs-recv", {
      "svc.rs": [
        "pub struct OrderService;",
        "pub struct OtherService;",
        "",
        "impl OrderService {",
        "    pub fn cancel(&self) {}",
        "}",
        "",
        "impl OtherService {",
        "    pub fn cancel(&self) {}",
        "}",
        "",
        "pub fn run() {",
        "    let svc: OrderService = OrderService;",
        "    svc.cancel();",
        "    let other: OtherService = OtherService;",
        "    other.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const orderBlast = blast(root, "svc.rs", "OrderService::cancel");
    assertEqual(orderBlast.totalCallSites, 1, `OrderService::cancel must have 1 call site, got ${JSON.stringify(orderBlast.callSites)}`);
    assertEqual(orderBlast.callSites[0]?.line, 14, "svc.cancel() is on line 14");
    const otherBlast = blast(root, "svc.rs", "OtherService::cancel");
    assertEqual(otherBlast.totalCallSites, 1, "OtherService::cancel must have 1 call site");
    assertEqual(otherBlast.callSites[0]?.line, 16, "other.cancel() is on line 16");
  });

  // 9. Cross-file: known-foreign receivers excluded, unknown duck receivers still counted.
  runTest("9) cross-file: foreign known receiver excluded, unknown duck receiver kept", () => {
    const root = createWorkspace("cross-file", {
      "ts/model.ts": "export class A { cancel(): void {} }\n",
      "ts/b.ts": "export class B { cancel(): void {} }\n",
      "ts/known.ts": [
        "import { A } from './model.js';",
        "import { B } from './b.js';",
        "export function run(b: B): void {",
        "  b.cancel();",
        "}",
        "export function touch(a: A): void { void a; }",
        "",
      ].join("\n"),
      "ts/duck.ts": [
        "import { A } from './model.js';",
        "export function runDuck(svc: any): void {",
        "  svc.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const result = blast(root, "ts/model.ts", "A.cancel");
    assertEqual(result.totalCallSites, 1, `only the unknown duck receiver must count, got ${JSON.stringify(result.callSites)}`);
    assertEqual(result.callSites[0]?.file, "ts/duck.ts", "duck-typed call is the only counted caller");
    assertTrue(
      result.importers.some((imp) => imp.file === "ts/known.ts"),
      "known.ts imports A and must still be listed as an importer"
    );
  });

  // 10. inferReceiverTypes is exported and works across all six analyzers.
  runTest("10) inferReceiverTypes maps receivers to declared types in all 6 languages", () => {
    const tsMap = inferReceiverTypes("a.ts", "const svc = new OrderService();\n");
    assertEqual(tsMap.get("svc"), "OrderService", "TS new-expression inference");
    const tsParamMap = inferReceiverTypes("b.ts", "export function run(worker: Worker): void {}\n");
    assertEqual(tsParamMap.get("worker"), "Worker", "TS parameter annotation inference");

    const pyMap = inferReceiverTypes("a.py", "svc = OrderService()\n");
    assertEqual(pyMap.get("svc"), "OrderService", "Python constructor inference");
    const pyDottedMap = inferReceiverTypes("b.py", "svc = pkg.OrderService()\n");
    assertEqual(pyDottedMap.get("svc"), "OrderService", "Python dotted constructor inference");

    const goMap = inferReceiverTypes("a.go", "package p\n\nfunc f() {\n\tvar svc Service\n\t_ = svc\n}\n");
    assertEqual(goMap.get("svc"), "Service", "Go var inference");
    const goDottedMap = inferReceiverTypes("b.go", "package p\n\nfunc f() {\n\tvar svc pkg.Service\n\t_ = svc\n}\n");
    assertEqual(goDottedMap.get("svc"), "Service", "Go dotted type inference");

    const rsMap = inferReceiverTypes("a.rs", "fn f() {\n    let svc: &OrderService = &OrderService;\n}\n");
    assertEqual(rsMap.get("svc"), "OrderService", "Rust let annotation inference");

    const cppMap = inferReceiverTypes("a.cpp", "void f() {\n  OrderService svc;\n}\n");
    assertEqual(cppMap.get("svc"), "OrderService", "C++ declaration inference");

    const csMap = inferReceiverTypes("a.cs", "class X { void F() { var svc = new OrderService(); } }\n");
    assertEqual(csMap.get("svc"), "OrderService", "C# var-new inference");
  });

  // 11. Rename: same-file A/B both declare cancel() -> ambiguous, nothing written.
  runTest("11) rename same-file A/B rejected as ambiguous and leaves file intact", () => {
    const original = TS_AB_FILE;
    const root = createWorkspace("rename-ab", { "model.ts": original });
    const result = executeSurgicalEdit({
      rootDir: root,
      file: "model.ts",
      symbol: "cancel",
      renameTo: "abortCancel",
    });
    assertEqual(result.ok, false, `ambiguous same-file rename must be rejected, got: ${result.text}`);
    assertIncludes(result.text, "ambiguous-symbol", "rejection must explain the symbol ambiguity");
    assertEqual(readWorkspaceFile(root, "model.ts"), original, "file must remain byte-identical");
  });

  // 12. Rename: a file whose cancel() calls are all B's must not be rewritten.
  runTest("12) rename skips other-class-only candidate file; B stays untouched", () => {
    const root = createWorkspace("rename-other-class", {
      "a.ts": "export class A { cancel(): void {} }\n",
      "b.ts": "export class B { cancel(): void {} }\n",
      "other.ts": [
        "import { A } from './a.js';",
        "import { B } from './b.js';",
        "export function run(b: B): void { b.cancel(); }",
        "export function touch(a: A): void { void a; }",
        "",
      ].join("\n"),
    });
    const bOriginal = readWorkspaceFile(root, "b.ts");
    const otherOriginal = readWorkspaceFile(root, "other.ts");
    const result = executeSurgicalEdit({
      rootDir: root,
      file: "a.ts",
      symbol: "cancel",
      renameTo: "abortCancel",
    });
    assertEqual(result.ok, true, `rename must succeed without staging B callers, got: ${result.text}`);
    assertEqual(result.touchedFiles.join(","), "a.ts", `only a.ts may be touched, got ${JSON.stringify(result.touchedFiles)}`);
    assertIncludes(readWorkspaceFile(root, "a.ts"), "abortCancel", "A method must be renamed");
    assertNotIncludes(readWorkspaceFile(root, "a.ts"), "cancel", "old name must be gone from a.ts");
    assertEqual(readWorkspaceFile(root, "b.ts"), bOriginal, "B declaration must be untouched");
    assertEqual(readWorkspaceFile(root, "other.ts"), otherOriginal, "B call site must be untouched");
  });

  // 13. Rename: a file mixing A and B receivers cannot be blind-replaced -> ambiguous.
  runTest("13) rename mixed-receiver candidate is rejected and leaves files intact", () => {
    const root = createWorkspace("rename-mixed", {
      "m.ts": "export class A { cancel(): void {} }\n",
      "o.ts": "export class B { cancel(): void {} }\n",
      "use.ts": [
        "import { A } from './m.js';",
        "import { B } from './o.js';",
        "export function run(a: A, b: B): void { a.cancel(); b.cancel(); }",
        "",
      ].join("\n"),
    });
    const useOriginal = readWorkspaceFile(root, "use.ts");
    const result = executeSurgicalEdit({
      rootDir: root,
      file: "m.ts",
      symbol: "cancel",
      renameTo: "abort",
    });
    assertEqual(result.ok, false, `mixed-receiver rename must be rejected, got: ${result.text}`);
    assertIncludes(result.text, "ambiguous-symbol", "rejection must explain the ambiguity");
    assertEqual(readWorkspaceFile(root, "use.ts"), useOriginal, "mixed call file must remain untouched");
    assertIncludes(readWorkspaceFile(root, "m.ts"), "cancel", "declaration must remain untouched");
  });

  // 15. TS: `this.field.cancel()` resolves the field type per enclosing class.
  runTest("15) TS this.field receiver type resolved per enclosing class", () => {
    const root = createWorkspace("ts-field", {
      "svc.ts": [
        "import { OrderService, OtherService } from './model.js';",
        "class A {",
        "  private service!: OrderService;",
        "  run(): void { this.service.cancel(); }",
        "}",
        "class B {",
        "  private service!: OtherService;",
        "  run(): void { this.service.cancel(); }",
        "}",
        "",
      ].join("\n"),
      "model.ts": [
        "export class OrderService { cancel(): void {} }",
        "export class OtherService { cancel(): void {} }",
        "",
      ].join("\n"),
    });
    const orderBlast = blast(root, "model.ts", "OrderService.cancel");
    assertEqual(orderBlast.totalCallSites, 1, `A.service is OrderService, got ${JSON.stringify(orderBlast.callSites)}`);
    assertEqual(orderBlast.callSites[0]?.line, 4, "A's this.service.cancel() is on line 4");
    const otherBlast = blast(root, "model.ts", "OtherService.cancel");
    assertEqual(otherBlast.totalCallSites, 1, `B.service is OtherService, got ${JSON.stringify(otherBlast.callSites)}`);
    assertEqual(otherBlast.callSites[0]?.line, 8, "B's this.service.cancel() is on line 8");
  });

  // 16. Go: a method's receiver variable resolves calls to sibling methods.
  runTest("16) Go method receiver context resolves same-receiver calls", () => {
    const root = createWorkspace("go-method-ctx", {
      "svc.go": [
        "package svc",
        "",
        "type Service struct{}",
        "type Other struct{}",
        "",
        "func (s *Service) Cancel() {}",
        "func (s *Service) Run() {",
        "\ts.Cancel()",
        "}",
        "func (o *Other) Run() {",
        "\to.Cancel()",
        "}",
        "func (o *Other) Cancel() {}",
        "",
      ].join("\n"),
    });
    const serviceBlast = blast(root, "svc.go", "Service.Cancel");
    assertEqual(serviceBlast.totalCallSites, 1, `Service.Cancel call site, got ${JSON.stringify(serviceBlast.callSites)}`);
    assertEqual(serviceBlast.callSites[0]?.line, 8, "s.Cancel() is on line 8");
    const otherBlast = blast(root, "svc.go", "Other.Cancel");
    assertEqual(otherBlast.totalCallSites, 1, "Other.Cancel call site");
    assertEqual(otherBlast.callSites[0]?.line, 11, "o.Cancel() is on line 11");
  });

  // 17. gf_read surfaces per-method blast radius (slicer passes sym.parentClass).
  runTest("17) gf_read disambiguates same-named methods in one file", () => {
    const root = createWorkspace("read-ab", { "model.ts": TS_AB_FILE });
    const readA = executeSurgicalRead({
      rootDir: root,
      targets: ["model.ts#A.cancel"],
      includeCallers: true,
    });
    assertIncludes(
      readA.text,
      "0 external callers/importers",
      `A.cancel read must show no callers; got:\n${readA.text}`
    );
    const readB = executeSurgicalRead({
      rootDir: root,
      targets: ["model.ts#B.cancel"],
      includeCallers: true,
    });
    assertIncludes(readB.text, "[Blast Radius: 1 call site(s)]", "B.cancel read must show its caller");
    assertIncludes(readB.text, "model.ts:3", "B.cancel caller is b.cancel() on line 3");
  });

  // 18. Rename: a normally typed foreign caller is still updated (no regression).
  runTest("18) rename still updates a typed method call site", () => {
    const root = createWorkspace("rename-positive", {
      "model.ts": [
        "export class OrderService {",
        "  cancelOrder(orderId: string): boolean {",
        "    return Boolean(orderId);",
        "  }",
        "}",
        "",
      ].join("\n"),
      "app.ts": [
        "import { OrderService } from './model.js';",
        "export function run(service: OrderService, id: string): boolean {",
        "  return service.cancelOrder(id);",
        "}",
        "",
      ].join("\n"),
    });
    const result = executeSurgicalEdit({
      rootDir: root,
      file: "model.ts",
      symbol: "cancelOrder",
      renameTo: "abortOrder",
    });
    assertEqual(result.ok, true, `typed method rename must succeed, got: ${result.text}`);
    assertTrue(result.touchedFiles.includes("app.ts"), "typed caller must be updated");
    assertIncludes(readWorkspaceFile(root, "app.ts"), "service.abortOrder(", "call site must be renamed");
    assertIncludes(readWorkspaceFile(root, "model.ts"), "abortOrder(", "declaration must be renamed");
  });

  // 19. TS inheritance: super.cancel() counts for A, overridden B receivers count for B.
  runTest("19) TS inheritance: super.cancel() counts for the parent method", () => {
    const source = [
      "class A {",
      "  cancel(): void {}",
      "}",
      "export class B extends A {",
      "  cancel(): void {",
      "    super.cancel();",
      "  }",
      "}",
      "export function inherited(a: A, b: B): void {",
      "  const x = new B();",
      "  b.cancel();",
      "  x.cancel();",
      "}",
      "",
    ].join("\n");
    const root = createWorkspace("ts-super", { "m.ts": source });

    const parents = parseClassParents("m.ts", source);
    assertEqual(parents.get("B"), "A", "TS `class B extends A` must be parsed into the parent map");
    const index = inferReceiverTypeIndex("m.ts", source);
    assertEqual(index.parents?.get("B"), "A", "ReceiverTypeIndex must expose the parent map");

    const aBlast = blast(root, "m.ts", "A.cancel");
    assertEqual(aBlast.totalCallSites, 1, `A.cancel must only see super.cancel(), got ${JSON.stringify(aBlast.callSites)}`);
    assertEqual(aBlast.callSites[0]?.line, 6, "super.cancel() is on line 6");
    const bBlast = blast(root, "m.ts", "B.cancel");
    assertEqual(bBlast.totalCallSites, 2, "B.cancel override must see b.cancel() and new B().cancel()");
    assertEqual(
      bBlast.callSites.map((site) => site.line).join(","),
      "11,12",
      "overridden B call sites are lines 11 and 12"
    );
  });

  // 20. TS inherited receiver without an override dispatches to the base method.
  runTest("20) TS inherited B receiver counts for A.cancel when B does not override", () => {
    const root = createWorkspace("ts-inherited", {
      "m.ts": [
        "class A {",
        "  cancel(): void {}",
        "}",
        "class B extends A {",
        "  retry(): void {",
        "    this.cancel();",
        "  }",
        "}",
        "export function run(): void {",
        "  const b = new B();",
        "  b.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const aBlast = blast(root, "m.ts", "A.cancel");
    assertEqual(aBlast.totalCallSites, 2, `inherited this/b calls must reach A.cancel, got ${JSON.stringify(aBlast.callSites)}`);
    assertEqual(aBlast.callSites.map((site) => site.line).join(","), "6,11", "inherited calls are lines 6 and 11");
    // B declares no cancel(): a qualified B.cancel query must not invent callers.
    assertEqual(blast(root, "m.ts", "B.cancel").totalCallSites, 0, "nonexistent B.cancel must have no callers");
  });

  // 21. Python inheritance: super().cancel() counts for A only.
  runTest("21) Python inheritance: super().cancel() counts for the parent method", () => {
    const source = [
      "class A:",
      "    def cancel(self):",
      "        return True",
      "",
      "class B(A):",
      "    def cancel(self):",
      "        return super().cancel()",
      "",
      "def inherited(b: B):",
      "    return b.cancel()",
      "",
    ].join("\n");
    const root = createWorkspace("py-super", { "m.py": source });
    const parents = parseClassParents("m.py", source);
    assertEqual(parents.get("B"), "A", "Python `class B(A)` must be parsed into the parent map");
    const aBlast = blast(root, "m.py", "A.cancel");
    assertEqual(aBlast.totalCallSites, 1, `A.cancel must only see super().cancel(), got ${JSON.stringify(aBlast.callSites)}`);
    assertEqual(aBlast.callSites[0]?.line, 7, "super().cancel() is on line 7");
    assertEqual(blast(root, "m.py", "B.cancel").totalCallSites, 1, "B.cancel override sees b.cancel()");
  });

  // 22. Python inherited receiver without an override.
  runTest("22) Python inherited B receiver counts for A.cancel when B does not override", () => {
    const root = createWorkspace("py-inherited", {
      "m.py": [
        "class A:",
        "    def cancel(self):",
        "        return True",
        "",
        "class B(A):",
        "    pass",
        "",
        "def run():",
        "    b = B()",
        "    return b.cancel()",
        "",
      ].join("\n"),
    });
    const aBlast = blast(root, "m.py", "A.cancel");
    assertEqual(aBlast.totalCallSites, 1, `inherited b.cancel() must reach A.cancel, got ${JSON.stringify(aBlast.callSites)}`);
    assertEqual(aBlast.callSites[0]?.line, 10, "b.cancel() is on line 10");
  });

  // 23. C# inheritance: base.Cancel() counts for A only.
  runTest("23) C# inheritance: base.Cancel() counts for the parent method", () => {
    const source = [
      "public class A",
      "{",
      "    public void Cancel()",
      "    {",
      "    }",
      "}",
      "public class B : A",
      "{",
      "    public void Cancel()",
      "    {",
      "        base.Cancel();",
      "    }",
      "}",
      "public class Runner",
      "{",
      "    public void Run()",
      "    {",
      "        var b = new B();",
      "        b.Cancel();",
      "    }",
      "}",
      "",
    ].join("\n");
    const root = createWorkspace("cs-base", { "m.cs": source });
    const parents = parseClassParents("m.cs", source);
    assertEqual(parents.get("B"), "A", "C# `class B : A` must be parsed into the parent map");
    const aBlast = blast(root, "m.cs", "A.Cancel");
    assertEqual(aBlast.totalCallSites, 1, `A.Cancel must only see base.Cancel(), got ${JSON.stringify(aBlast.callSites)}`);
    assertEqual(aBlast.callSites[0]?.line, 11, "base.Cancel() is on line 11");
    assertEqual(blast(root, "m.cs", "B.Cancel").totalCallSites, 1, "B.Cancel override sees b.Cancel()");
  });

  // 24. C++ inheritance: A::cancel() and inherited B receivers reach A; override reaches C.
  runTest("24) C++ inheritance: A::base calls and inherited receivers resolve", () => {
    const source = [
      "class A { public: void cancel(); };",
      "class B : public A { };",
      "class C : public A { public: void cancel(); };",
      "void A::cancel() {}",
      "void C::cancel() { A::cancel(); }",
      "void run() {",
      "  B b;",
      "  b.cancel();",
      "  C c;",
      "  c.cancel();",
      "}",
      "",
    ].join("\n");
    const root = createWorkspace("cpp-inherit", { "m.cpp": source });
    const parents = parseClassParents("m.cpp", source);
    assertEqual(parents.get("B"), "A", "C++ `class B : public A` must be parsed into the parent map");
    assertEqual(parents.get("C"), "A", "C++ `class C : public A` must be parsed into the parent map");
    const aBlast = blast(root, "m.cpp", "A.cancel");
    assertEqual(aBlast.totalCallSites, 2, `A::cancel() + inherited b.cancel() must count, got ${JSON.stringify(aBlast.callSites)}`);
    assertEqual(aBlast.callSites.map((site) => site.line).join(","), "5,8", "A call sites are lines 5 and 8");
    const cBlast = blast(root, "m.cpp", "C.cancel");
    assertEqual(cBlast.totalCallSites, 1, "overridden C.cancel() only sees c.cancel()");
    assertEqual(cBlast.callSites[0]?.line, 10, "c.cancel() is on line 10");
  });

  // 25. Reassignment: last assignment in a block wins.
  runTest("25) TS reassignment: last assignment wins", () => {
    const root = createWorkspace("ts-reassign", {
      "r.ts": [
        "class A { cancel(): void {} }",
        "class B { cancel(): void {} }",
        "export function lastWins(): void {",
        "  let x = new A();",
        "  x = new B();",
        "  x.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    assertEqual(blast(root, "r.ts", "A.cancel").totalCallSites, 0, "A must not be credited after reassignment to B");
    const bBlast = blast(root, "r.ts", "B.cancel");
    assertEqual(bBlast.totalCallSites, 1, "B must own the final call");
    assertEqual(bBlast.callSites[0]?.line, 6, "x.cancel() is on line 6");
  });

  // 26. Conflicting branch assignments are unknown (no attribution to either class).
  runTest("26) TS reassignment: conflicting branch assignments stay unknown", () => {
    const root = createWorkspace("ts-conflict", {
      "r.ts": [
        "class A { cancel(): void {} }",
        "class B { cancel(): void {} }",
        "export function conflicting(cond: boolean): void {",
        "  let y = new A();",
        "  if (cond) {",
        "    y = new B();",
        "  }",
        "  y.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    assertEqual(blast(root, "r.ts", "A.cancel").totalCallSites, 0, "conflicting receiver must not count for A");
    assertEqual(blast(root, "r.ts", "B.cancel").totalCallSites, 0, "conflicting receiver must not count for B");
  });

  // 27. Generics / nullable / arrays unwrap to the base receiver type.
  runTest("27) generics, nullable and array wrappers unwrap to the base type", () => {
    const root = createWorkspace("ts-generics", {
      "g.ts": [
        "class Order { cancel(): void {} }",
        "export function viaGeneric(x: Box<Order>): void { x.cancel(); }",
        "export function viaNullable(x: Order | null): void { x.cancel(); }",
        "export function viaArray(x: Order[]): void { x.cancel(); }",
        "export function viaPromise(x: Promise<Order>): void { x.cancel(); }",
        "",
      ].join("\n"),
    });
    const orderBlast = blast(root, "g.ts", "Order.cancel");
    assertEqual(orderBlast.totalCallSites, 4, `all wrapped receivers must unwrap to Order, got ${JSON.stringify(orderBlast.callSites)}`);
    assertEqual(orderBlast.callSites.map((site) => site.line).join(","), "2,3,4,5", "wrapped calls are lines 2-5");
  });

  // 28. C++ auto + Rust `let x = Type::new()` resolve without explicit annotations.
  runTest("28) auto/var forms with new/{} resolve to the constructed type", () => {
    const cppRoot = createWorkspace("cpp-auto", {
      "a.cpp": [
        "class OrderService { public: void cancel(); };",
        "void OrderService::cancel() {}",
        "void run() {",
        "  auto* svc = new OrderService();",
        "  svc->cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const cppBlast = blast(cppRoot, "a.cpp", "OrderService.cancel");
    assertEqual(cppBlast.totalCallSites, 1, `C++ auto* + new must resolve, got ${JSON.stringify(cppBlast.callSites)}`);
    assertEqual(cppBlast.callSites[0]?.line, 5, "svc->cancel() is on line 5");

    const rustRoot = createWorkspace("rust-ctor", {
      "r.rs": [
        "pub struct OrderService;",
        "impl OrderService {",
        "    pub fn new() -> Self { OrderService }",
        "    pub fn cancel(&self) {}",
        "}",
        "pub fn run() {",
        "    let svc = OrderService::new();",
        "    svc.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const rustBlast = blast(rustRoot, "r.rs", "OrderService::cancel");
    assertEqual(rustBlast.totalCallSites, 1, `Rust Type::new() must resolve, got ${JSON.stringify(rustBlast.callSites)}`);
    assertEqual(rustBlast.callSites[0]?.line, 8, "svc.cancel() is on line 8");
  });

  // 29. Rename: inherited subclass call sites are updated (no override involved).
  runTest("29) rename updates inherited subclass call sites", () => {
    const root = createWorkspace("rename-inherited", {
      "a.ts": "export class A { cancel(): void {} }\n",
      "b.ts": "import { A } from './a.js';\nexport class B extends A {}\n",
      "c.ts": [
        "import { B } from './b.js';",
        "export function run(b: B): void {",
        "  b.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const bOriginal = readWorkspaceFile(root, "b.ts");
    const result = executeSurgicalEdit({ rootDir: root, file: "a.ts", symbol: "cancel", renameTo: "abort" });
    assertEqual(result.ok, true, `inherited rename must succeed, got: ${result.text}`);
    assertEqual(result.touchedFiles.sort().join(","), "a.ts,c.ts", `a.ts + inherited caller must be updated, got ${JSON.stringify(result.touchedFiles)}`);
    assertIncludes(readWorkspaceFile(root, "c.ts"), "b.abort();", "inherited call site must be renamed");
    assertEqual(readWorkspaceFile(root, "b.ts"), bOriginal, "subclass declaration file must stay untouched");
  });

  // 30. Rename: super call sites are updated.
  runTest("30) rename updates super call sites", () => {
    const root = createWorkspace("rename-super", {
      "a.ts": "export class A { cancel(): void {} }\n",
      "b.ts": [
        "import { A } from './a.js';",
        "export class B extends A {",
        "  retry(): void {",
        "    super.cancel();",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    const result = executeSurgicalEdit({ rootDir: root, file: "a.ts", symbol: "cancel", renameTo: "abort" });
    assertEqual(result.ok, true, `super rename must succeed, got: ${result.text}`);
    assertIncludes(readWorkspaceFile(root, "b.ts"), "super.abort();", "super call site must be renamed");
    assertTrue(result.touchedFiles.includes("b.ts"), "b.ts must be touched");
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
