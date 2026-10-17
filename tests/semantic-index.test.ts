/**
 * GraphFlow — L0 semantic index tests (`tests/semantic-index.test.ts`)
 *
 * Standalone: `npx tsx tests/semantic-index.test.ts` (exit code 1 on failure).
 * All fixtures live under os.tmpdir(); the real repo is never mutated.
 *
 * Covers: module graph/tsconfig aliases, symbol table + import alias + barrel re-exports,
 * receiver type environment (generics/nullable/array, inheritance/super, factory returns,
 * branch conflicts -> unknown), resolved call targets with confidence, caching/invalidations,
 * determinism, performance, plus blast-radius and rename integration using resolved targets.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  computeBlastRadius,
  executeSurgicalEdit,
  getWorkspaceAstIndex,
} from "../src/index.js";
import {
  clearSemanticIndexCache,
  getSemanticIndex,
} from "../src/semantic-index.js";
import type { AstCallSite } from "../src/ast-engine.js";

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
function assertAtLeast(actual: number, minimum: number, message: string): void {
  if (!(actual >= minimum)) fail(`${message} (expected >= ${minimum}, got ${actual})`);
}
function assertIncludes(haystack: readonly string[], needle: string, message: string): void {
  if (!haystack.includes(needle)) fail(`${message} (missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)})`);
}

function createWorkspace(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `gf-semantic-${name}-`));
  workspaceRoots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

function writeWorkspaceFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
  getWorkspaceAstIndex(root).invalidateFile(relPath);
}

function findCall(root: string, file: string, callee: string, line?: number): AstCallSite {
  const ast = getWorkspaceAstIndex(root).getFileAnalysis(file)!.ast;
  const call = ast.calls.find((site) => site.callee === callee && (line === undefined || site.line === line));
  if (!call) fail(`call ${callee} not found in ${file}`);
  return call!;
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

const AB_WORKSPACE = {
  "ts/model.ts": [
    "export class A { cancel(): void {} }",
    "export class B { cancel(): void {} }",
    "export class OrderService { cancelOrder(id: string): boolean { return !!id; } }",
    "",
  ].join("\n"),
};

function main(): void {
  console.log("=== GraphFlow semantic index suite ===");

  // 1. Same-file A/B methods resolve to their own classes with high confidence.
  runTest("1) same-file A/B call targets resolve to the right class", () => {
    const root = createWorkspace("ab", {
      ...AB_WORKSPACE,
      "ts/app.ts": [
        "import { A, B } from './model.js';",
        "export function run(a: A, b: B): void {",
        "  a.cancel();",
        "  b.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    const aCall = index.resolveCall("ts/app.ts", findCall(root, "ts/app.ts", "cancel", 3));
    const bCall = index.resolveCall("ts/app.ts", findCall(root, "ts/app.ts", "cancel", 4));
    assertEqual(aCall.targetFile, "ts/model.ts", "a.cancel target file");
    assertEqual(aCall.targetSymbol, "cancel", "a.cancel target symbol");
    assertEqual(aCall.parentClass, "A", "a.cancel owning class");
    assertAtLeast(aCall.confidence, 0.9, "a.cancel confidence");
    assertEqual(bCall.parentClass, "B", "b.cancel owning class");
    assertTrue(index.getTypeEnvironment("ts/app.ts").get("a") === "A", "type env a -> A");
    assertTrue(index.getTypeEnvironment("ts/app.ts").get("b") === "B", "type env b -> B");
  });

  // 2. Import aliases + barrel re-exports resolve to the original declaration/module.
  runTest("2) import alias and barrel re-export resolution", () => {
    const root = createWorkspace("barrel", {
      ...AB_WORKSPACE,
      "ts/barrel.ts": "export * from './model.js';\n",
      "ts/alias.ts": [
        "import { OrderService as Svc } from './barrel.js';",
        "export function run(svc: Svc): boolean {",
        "  return svc.cancelOrder('x');",
        "}",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    assertEqual(index.resolveImport("ts/alias.ts", "./barrel.js"), "ts/barrel.ts", "module graph edge");
    const barrelNode = index.getModuleGraph().get("ts/barrel.ts")!;
    assertIncludes(barrelNode.exportAllFrom, "ts/model.ts", "barrel exportAllFrom model");
    const imported = index.resolveImportedSymbol("ts/alias.ts", "Svc");
    assertTrue(imported, "alias resolves to a declaration");
    assertEqual(imported!.decl.file, "ts/model.ts", "alias declaration file");
    assertEqual(imported!.decl.name, "OrderService", "alias resolves original class name");
    const resolved = index.resolveCall("ts/alias.ts", findCall(root, "ts/alias.ts", "cancelOrder"));
    assertEqual(resolved.targetFile, "ts/model.ts", "aliased receiver method target");
    assertEqual(resolved.parentClass, "OrderService", "aliased receiver owning class");
    assertAtLeast(resolved.confidence, 0.9, "aliased method confidence");
  });

  // 3. tsconfig paths alias resolution feeds the module graph + call resolution.
  runTest("3) tsconfig baseUrl/paths alias resolution", () => {
    const root = createWorkspace("tsconfig-alias", {
      "tsconfig.json": [
        "{",
        "  // JSONC comments are allowed",
        "  \"compilerOptions\": {",
        "    \"baseUrl\": \".\",",
        "    \"paths\": { \"@/*\": [\"src/*\"] },",
        "  },",
        "}",
      ].join("\n"),
      "src/model.ts": "export class OrderService { cancelOrder(id: string): boolean { return !!id; } }\n",
      "src/app.ts": [
        "import { OrderService } from '@/model';",
        "export function run(svc: OrderService): boolean { return svc.cancelOrder('x'); }",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    assertEqual(index.resolveImport("src/app.ts", "@/model"), "src/model.ts", "paths alias -> module");
    const resolved = index.resolveCall("src/app.ts", findCall(root, "src/app.ts", "cancelOrder"));
    assertEqual(resolved.targetFile, "src/model.ts", "paths alias call target");
    assertEqual(resolved.targetSymbol, "cancelOrder", "paths alias target symbol");
  });

  // 4. Inheritance + super: this/super/sub receivers map to the declaring base class.
  runTest("4) inheritance and super target the base declaration", () => {
    const root = createWorkspace("inherit", {
      ...AB_WORKSPACE,
      "ts/inherit.ts": [
        "import { A } from './model.js';",
        "export class Sub extends A {",
        "  retry(): void { this.cancel(); super.cancel(); }",
        "}",
        "export function use(sub: Sub): void { sub.cancel(); sub.retry(); }",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    const thisCall = index.resolveCall("ts/inherit.ts", findCall(root, "ts/inherit.ts", "cancel", 3));
    assertEqual(thisCall.targetFile, "ts/model.ts", "this.cancel target file");
    assertEqual(thisCall.parentClass, "A", "this.cancel base class");
    assertAtLeast(thisCall.confidence, 0.85, "this.cancel confidence");
    const superCallAst = getWorkspaceAstIndex(root)
      .getFileAnalysis("ts/inherit.ts")!
      .ast.calls.find((site) => site.callee === "cancel" && site.receiver === "super");
    assertTrue(superCallAst, "super.cancel call extracted");
    const superCall = index.resolveCall("ts/inherit.ts", superCallAst!);
    assertEqual(superCall.targetFile, "ts/model.ts", "super.cancel target file");
    assertAtLeast(superCall.confidence, 0.9, "super.cancel confidence");
    const subCall = index.resolveCall("ts/inherit.ts", findCall(root, "ts/inherit.ts", "cancel", 5));
    assertEqual(subCall.parentClass, "A", "subclass receiver maps to inherited base method");
    const retryCall = index.resolveCall("ts/inherit.ts", findCall(root, "ts/inherit.ts", "retry", 5));
    assertEqual(retryCall.parentClass, "Sub", "own method stays on subclass");
  });

  // 5. Generics / nullable / arrays unwrap to the base receiver type.
  runTest("5) generic/nullable/array receivers unwrap to the base type", () => {
    const root = createWorkspace("generics", {
      ...AB_WORKSPACE,
      "ts/generic.ts": [
        "import { OrderService } from './model.js';",
        "export function a(x: Box<OrderService>): boolean { return x.cancelOrder('x'); }",
        "export function b(x: OrderService | null): boolean { return x!.cancelOrder('x'); }",
        "export function c(x: OrderService[]): boolean { return x[0]!.cancelOrder('x'); }",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    for (const fileLine of [2, 3, 4]) {
      const call = getWorkspaceAstIndex(root)
        .getFileAnalysis("ts/generic.ts")!
        .ast.calls.find((site) => site.callee === "cancelOrder" && site.line === fileLine);
      assertTrue(call, `cancelOrder call line ${fileLine}`);
      const resolved = index.resolveCall("ts/generic.ts", call!);
      assertEqual(resolved.targetFile, "ts/model.ts", `wrapped receiver line ${fileLine} target`);
      assertEqual(resolved.parentClass, "OrderService", `wrapped receiver line ${fileLine} class`);
    }
  });

  // 6. Factory return type resolves chained receiver calls.
  runTest("6) annotated factory return type resolves chained calls", () => {
    const root = createWorkspace("factory", {
      ...AB_WORKSPACE,
      "ts/factory.ts": [
        "import { A } from './model.js';",
        "function getA(): A { return new A(); }",
        "export function run(): void { getA().cancel(); }",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    const chained = getWorkspaceAstIndex(root)
      .getFileAnalysis("ts/factory.ts")!
      .ast.calls.find((site) => site.callee === "cancel");
    assertTrue(chained, "chained factory call extracted");
    assertEqual(chained!.receiverCall, "getA", "receiverCall extracted");
    const resolved = index.resolveCall("ts/factory.ts", chained!);
    assertEqual(resolved.targetFile, "ts/model.ts", "factory call target file");
    assertEqual(resolved.parentClass, "A", "factory call owning class");
    assertEqual(resolved.reason, "factory-return", "factory resolution reason");
  });

  // 7. Conflicting branch assignments stay unknown (no guessing).
  runTest("7) conflicting branch receiver types stay unknown", () => {
    const root = createWorkspace("conflict", {
      ...AB_WORKSPACE,
      "ts/conflict.ts": [
        "import { A, B } from './model.js';",
        "export function run(cond: boolean): void {",
        "  let x = new A();",
        "  if (cond) {",
        "    x = new B();",
        "  }",
        "  x.cancel();",
        "}",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    const call = getWorkspaceAstIndex(root)
      .getFileAnalysis("ts/conflict.ts")!
      .ast.calls.find((site) => site.callee === "cancel")!;
    const resolved = index.resolveCall("ts/conflict.ts", call);
    assertEqual(resolved.targetFile, undefined, "conflicting receiver must not resolve");
    assertEqual(resolved.reason, "unresolved-receiver", "conflicting receiver reason");
  });

  // 8. Cross-file duck-typed receiver is not guessed by the semantic index.
  runTest("8) unresolved duck-typed receiver is not guessed", () => {
    const root = createWorkspace("duck", {
      ...AB_WORKSPACE,
      "ts/duck.ts": [
        "import { A } from './model.js';",
        "export function run(svc: any): void { svc.cancel(); }",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    const call = getWorkspaceAstIndex(root)
      .getFileAnalysis("ts/duck.ts")!
      .ast.calls.find((site) => site.callee === "cancel")!;
    const resolved = index.resolveCall("ts/duck.ts", call);
    assertEqual(resolved.targetFile, undefined, "duck call target stays unknown");
    assertEqual(resolved.confidence, 0, "duck call confidence 0");
  });

  // 9. Python method calls resolve across files (default tree-sitter/structural engine).
  runTest("9) Python cross-file method resolution", () => {
    const root = createWorkspace("python", {
      "py/model.py": [
        "class OrderService:",
        "    def cancel_order(self, order_id: str) -> bool:",
        "        return bool(order_id)",
        "",
      ].join("\n"),
      "py/app.py": [
        "from .model import OrderService",
        "",
        "def run(service: OrderService) -> bool:",
        "    return service.cancel_order('x')",
        "",
      ].join("\n"),
    });
    const index = getSemanticIndex(root);
    const call = getWorkspaceAstIndex(root)
      .getFileAnalysis("py/app.py")!
      .ast.calls.find((site) => site.callee === "cancel_order")!;
    const resolved = index.resolveCall("py/app.py", call);
    assertEqual(resolved.targetFile, "py/model.py", "Python target file");
    assertEqual(resolved.parentClass, "OrderService", "Python owning class");
  });

  // 10. Blast radius uses semantic targets: A/B disambiguation, alias and inherited receivers.
  runTest("10) blast radius uses resolved targets (A/B, alias, inherited)", () => {
    const root = createWorkspace("blast", {
      ...AB_WORKSPACE,
      "ts/alias.ts": [
        "import { OrderService as Svc } from './model.js';",
        "export function run(svc: Svc): boolean { return svc.cancelOrder('x'); }",
        "",
      ].join("\n"),
      "ts/inherit.ts": [
        "import { A } from './model.js';",
        "class Sub extends A {}",
        "export function use(sub: Sub): void { sub.cancel(); }",
        "",
      ].join("\n"),
    });
    const index = getWorkspaceAstIndex(root);
    const aliasBlast = computeBlastRadius(index, "ts/model.ts", "OrderService.cancelOrder", 10);
    assertTrue(
      aliasBlast.callSites.some((site) => site.file === "ts/alias.ts"),
      "aliased caller counted by blast radius"
    );
    const inheritedBlast = computeBlastRadius(index, "ts/model.ts", "A.cancel", 10);
    assertTrue(
      inheritedBlast.callSites.some((site) => site.file === "ts/inherit.ts"),
      "inherited subclass receiver counted for base method"
    );
    const bBlast = computeBlastRadius(index, "ts/model.ts", "B.cancel", 10);
    assertTrue(
      !bBlast.callSites.some((site) => site.file === "ts/inherit.ts"),
      "subclass receiver calling inherited A.cancel must not count for B.cancel"
    );
  });

  // 11. Rename uses semantic targets: alias and barrel call sites update, B stays untouched.
  runTest("11) rename updates alias/barrel call sites only", () => {
    const root = createWorkspace("rename", {
      ...AB_WORKSPACE,
      "ts/barrel.ts": "export * from './model.js';\n",
      "ts/alias.ts": [
        "import { OrderService as Svc } from './barrel.js';",
        "import { A } from './model.js';",
        "export function run(svc: Svc, a: A): boolean {",
        "  a.cancel();",
        "  return svc.cancelOrder('x');",
        "}",
        "",
      ].join("\n"),
    });
    const orderRename = executeSurgicalEdit({
      rootDir: root,
      file: "ts/model.ts",
      symbol: "cancelOrder",
      renameTo: "abortOrder",
    });
    assertEqual(orderRename.ok, true, `aliased method rename must succeed: ${orderRename.text}`);
    const appText = readFileSync(join(root, "ts/alias.ts"), "utf8");
    assertTrue(appText.includes("svc.abortOrder("), "aliased call site renamed");
    const aRename = executeSurgicalEdit({
      rootDir: root,
      file: "ts/model.ts",
      symbol: "A.cancel",
      renameTo: "abortCancel",
    });
    assertEqual(aRename.ok, false, "ambiguous A/B method rename must stay rejected");
    assertTrue(readFileSync(join(root, "ts/alias.ts"), "utf8").includes("a.cancel();"), "A call untouched after rejection");
  });

  // 12. Incremental invalidation: after editing + invalidating a file the index sees new decls.
  runTest("12) incremental invalidation sees edited files", () => {
    const root = createWorkspace("incremental", {
      "ts/model.ts": "export class A { cancel(): void {} }\n",
      "ts/app.ts": "import { A } from './model.js';\nexport function run(a: A): void { a.cancel(); }\n",
    });
    const index = getSemanticIndex(root);
    assertEqual(index.findDeclarations("abortCancel").length, 0, "new method not indexed yet");
    writeWorkspaceFile(root, "ts/model.ts", "export class A { abortCancel(): void {} }\n");
    index.invalidate("ts/model.ts");
    assertTrue(index.findDeclarations("abortCancel").length > 0, "edited declaration indexed after invalidate");
    const call = getWorkspaceAstIndex(root)
      .getFileAnalysis("ts/app.ts")!
      .ast.calls.find((site) => site.callee === "cancel")!;
    const staleResolution = index.resolveCall("ts/app.ts", call);
    assertEqual(staleResolution.targetFile, undefined, "stale call no longer resolves to removed method");
  });

  // 13. Determinism: rebuild produces the same declarations and resolved calls.
  runTest("13) index building is deterministic", () => {
    const root = createWorkspace("determinism", {
      ...AB_WORKSPACE,
      "ts/app.ts": [
        "import { A, B } from './model.js';",
        "export function run(a: A, b: B): void { a.cancel(); b.cancel(); }",
        "",
      ].join("\n"),
    });
    const first = getSemanticIndex(root);
    const snapshot = (index: ReturnType<typeof getSemanticIndex>): string => {
      const declarations = index
        .getFiles()
        .flatMap((file) => index.getDeclarationsInFile(file).map((decl) => `${decl.file}:${decl.parentClass ?? "-"}.${decl.name}:${decl.line}`));
      const ast = getWorkspaceAstIndex(root).getFileAnalysis("ts/app.ts")!.ast;
      const calls = ast.calls.map((call) => {
        const resolved = index.resolveCall("ts/app.ts", call);
        return `${resolved.callee}:${resolved.targetFile ?? "-"}:${resolved.parentClass ?? "-"}:${resolved.reason}`;
      });
      return JSON.stringify({ declarations, calls });
    };
    const before = snapshot(first);
    first.rebuild();
    const after = snapshot(first);
    assertEqual(after, before, "rebuilt index produces identical answers");
    clearSemanticIndexCache(root);
    const rebuilt = getSemanticIndex(root);
    assertEqual(snapshot(rebuilt), before, "fresh index for same workspace is deterministic");
  });

  // 14. Performance: 200-file cold build < 2s, warm queries < 200ms.
  runTest("14) performance stays within cold/warm budgets", () => {
    const files: Record<string, string> = {};
    const fileCount = 200;
    for (let i = 0; i < fileCount; i++) {
      const next = (i + 1) % fileCount;
      files[`src/f${i}.ts`] = [
        `import { Service${next} } from './f${next}.js';`,
        `export class Service${i} {`,
        `  cancel(id: string): boolean { return !!id; }`,
        "}",
        `export function run${i}(service: Service${i}): boolean { return service.cancel('x'); }`,
        "",
      ].join("\n");
    }
    const root = createWorkspace("perf", files);
    clearSemanticIndexCache(root);
    const coldStart = Date.now();
    const index = getSemanticIndex(root);
    const coldMs = Date.now() - coldStart;
    assertAtLeast(index.stats().files, fileCount, "all files indexed");
    assertTrue(coldMs < 2000, `cold build must be <2000ms, got ${coldMs}ms`);

    const ast = getWorkspaceAstIndex(root).getFileAnalysis("src/f0.ts")!.ast;
    const call = ast.calls.find((site) => site.callee === "cancel")!;
    const warmStart = Date.now();
    for (let i = 0; i < 50; i++) index.resolveCall("src/f0.ts", call);
    const warmMs = Date.now() - warmStart;
    assertTrue(warmMs < 200, `warm resolution must be <200ms, got ${warmMs}ms`);
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
