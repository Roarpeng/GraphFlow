/**
 * Regression tests for symbol extraction fixes (E1/E3/E4).
 *
 * Standalone: `npx tsx tests/fix-ast-symbols.test.ts` (exit code 1 on failure).
 * Fixtures are inline strings so the suite never touches the workspace.
 */

import { analyzeSourceFile } from "../src/index.js";
import { analyzeWithTreeSitter, isTreeSitterAvailable } from "../src/tree-sitter-engine.js";

let passed = 0;
let failed = 0;

function assertTrue(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
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

// ── E1: `export {default as X} from` must enter the dependency graph ────────

const REEXPORT_FIXTURE = [
  "export {default as calculateRetryDelay} from './calculate-retry-delay.js';",
  "export {default as parseLinkHeader} from './parse-link-header.js';",
  "export {a as b} from './named.js';",
  "export * from './barrel.js';",
].join("\n");

runTest("E1 default re-export records the exported alias", () => {
  const ast = analyzeSourceFile("index.ts", REEXPORT_FIXTURE);
  const retry = ast.imports.find((imp) => imp.module === "./calculate-retry-delay.js");
  assertTrue(retry !== undefined, "calculate-retry-delay re-export missing");
  assertTrue(
    retry!.importedNames.includes("calculateRetryDelay"),
    `alias missing from importedNames: ${JSON.stringify(retry!.importedNames)}`
  );
  assertTrue(
    !retry!.importedNames.includes("default"),
    "literal 'default' must not be recorded as the imported symbol"
  );
  const link = ast.imports.find((imp) => imp.module === "./parse-link-header.js");
  assertTrue(link?.importedNames.includes("parseLinkHeader") === true, "parseLinkHeader alias missing");
});

runTest("E1 `export {a as b} from` still records the source/local name", () => {
  const ast = analyzeSourceFile("index.ts", REEXPORT_FIXTURE);
  const named = ast.imports.find((imp) => imp.module === "./named.js");
  assertTrue(named !== undefined, "named re-export missing");
  assertTrue(named!.importedNames.includes("a"), `expected 'a', got ${JSON.stringify(named!.importedNames)}`);
  assertTrue(!named!.importedNames.includes("b"), "renamed alias must not replace the source name");
});

// ── E3: CommonJS / object-property functions are symbols ───────────────────

const EXPRESS_FIXTURE = [
  "var app = {};",
  "app.get = function get(path, fn) { return path; };",
  "app.listen = function listen() { return 0; };",
  "app.settings = {};",
  "res.send = function send(body) { return body; };",
  "res.status = (code) => code;",
  "exports.normalizeType = function normalizeType(type) { return type; };",
  "module.exports.compileETag = (val) => val;",
].join("\n");

runTest("E3 object-property assignments become exported function symbols", () => {
  const ast = analyzeSourceFile("lib/application.js", EXPRESS_FIXTURE);
  const byName = new Map(ast.symbols.map((sym) => [sym.name, sym]));

  for (const name of ["get", "listen", "send", "status", "normalizeType", "compileETag"]) {
    const sym = byName.get(name);
    assertTrue(sym !== undefined, `symbol '${name}' missing (have ${[...byName.keys()].join(",")})`);
    assertEqual(sym!.kind, "function", `kind for '${name}'`);
    assertEqual(sym!.exported, true, `exported for '${name}'`);
  }

  assertEqual(byName.get("get")!.parentClass, "app", "app.get parentClass");
  assertEqual(byName.get("send")!.parentClass, "res", "res.send parentClass");
  assertEqual(byName.get("normalizeType")!.parentClass, "exports", "exports.foo parentClass");
  assertEqual(byName.get("compileETag")!.parentClass, "module.exports", "module.exports.foo parentClass");
  assertEqual(byName.get("get")!.line, 2, "app.get line");
  assertTrue(byName.get("get")!.endLine >= 2, "app.get endLine");
});

runTest("E3 non-function CommonJS assignments are variables", () => {
  const ast = analyzeSourceFile("lib/application.js", EXPRESS_FIXTURE);
  const settings = ast.symbols.find((sym) => sym.name === "settings");
  assertTrue(settings !== undefined, "app.settings symbol missing");
  assertEqual(settings!.kind, "variable", "app.settings kind");
});

// ── E4: decorators must not hide the Python def/class header ───────────────

const PYTHON_FIXTURE = [
  "from blinker import Namespace",
  "",
  "_signals = Namespace()",
  "template_rendered = _signals.signal('template-rendered')",
  "",
  "@setupmethod",
  "def add_url_rule(self, rule, endpoint=None):",
  "    return rule",
  "",
  "@decorator",
  "class App(Base):",
  "    def setup(self):",
  "        local_value = 1",
  "        return local_value",
  "",
].join("\n");

runTest("E4 decorator keeps def/class names and line anchors", () => {
  if (!isTreeSitterAvailable()) {
    console.log("       (tree-sitter bindings unavailable; E4 tree-sitter assertions skipped)");
    return;
  }
  const ast = analyzeWithTreeSitter("src/flask/app.py", PYTHON_FIXTURE);
  assertTrue(ast !== undefined, "tree-sitter analysis returned undefined");

  const fn = ast!.symbols.find((sym) => sym.name === "add_url_rule");
  assertTrue(fn !== undefined, `add_url_rule missing (have ${ast!.symbols.map((s) => s.name).join(",")})`);
  assertEqual(fn!.line, 7, "decorated function line must point at `def`");
  assertTrue(fn!.signature.trimStart().startsWith("def add_url_rule"), `signature: ${fn!.signature}`);

  const cls = ast!.symbols.find((sym) => sym.name === "App");
  assertTrue(cls !== undefined, "decorated class App missing");
  assertEqual(cls!.line, 10, "decorated class keeps the decorator line anchor");
  assertTrue(cls!.signature.trimStart().startsWith("class App"), `signature: ${cls!.signature}`);

  // Method body assignments stay local; module-level assignments are variables.
  assertTrue(!ast!.symbols.some((sym) => sym.name === "local_value"), "function-local assignment leaked");
  const signal = ast!.symbols.find((sym) => sym.name === "template_rendered");
  assertTrue(signal !== undefined, "module-level assignment missing");
  assertEqual(signal!.kind, "variable", "module-level assignment kind");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`\nAll ${passed} fix-ast symbol tests passed.`);
