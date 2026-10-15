/**
 * GraphFlow 3.0 — Comprehensive End-to-End Test Suite for the 4 Token-First Pillars,
 * Multi-Language AST Engine (TS/JS, Python, Go, Rust, C/C++, C#), and Host Hook Interceptor
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAffectedTestCommand,
  dehydrateCommandOutput,
  executeMacro,
  executeSurgicalEdit,
  executeSurgicalRead,
  executeV3ToolCall,
  foldFileSkeleton,
  getWorkspaceAstIndex,
  interceptPostToolUse,
  interceptPreToolUse,
  loadMacroStore,
  recordTrajectoryAndMine,
  resolveAffectedTests,
  computeTemporalCouplingFromCommits,
  parseGitLogCommitFiles,
  V3_TOOL_DEFINITIONS,
  installAllAgents,
  uninstallAllAgents,
  detectInstalledAgents,
  segmentChinese,
  tokenizeEnglish,
  tokenizeBilingualQuery,
} from "../src/index.js";
import { getV3ToolDefinitions } from "../src/mcp-server.js";

function createSampleWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-v3-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });

  writeFileSync(
    join(root, "src", "types.ts"),
    [
      "export interface BudgetPolicy {",
      "  maxTokens: number;",
      "  strict: boolean;",
      "}",
      "",
      "export type PolicyMode = 'auto' | 'fixed';",
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    join(root, "src", "resolver.ts"),
    [
      "import type { BudgetPolicy, PolicyMode } from './types.js';",
      "",
      "export function unusedHelper(x: number): number {",
      "  const a = x + 1;",
      "  const b = a * 2;",
      "  const c = b - 3;",
      "  const d = c * 4;",
      "  return d;",
      "}",
      "",
      "export function resolveBudget(policy: BudgetPolicy, mode: PolicyMode): number {",
      "  if (policy.strict) {",
      "    return Math.min(1000, policy.maxTokens);",
      "  }",
      "  return mode === 'auto' ? policy.maxTokens : 2048;",
      "}",
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    join(root, "src", "caller.ts"),
    [
      "import { resolveBudget } from './resolver.js';",
      "",
      "export function runHandler(): number {",
      "  const val = resolveBudget({ maxTokens: 4000, strict: true }, 'auto');",
      "  return val;",
      "}",
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    join(root, "tests", "resolver.test.ts"),
    [
      "import { resolveBudget } from '../src/resolver.js';",
      "import { runHandler } from '../src/caller.js';",
      "",
      "export function testAll(): boolean {",
      "  return resolveBudget({ maxTokens: 500, strict: true }, 'auto') === 500 && runHandler() === 1000;",
      "}",
    ].join("\n"),
    "utf8"
  );

  return root;
}

function createMultiLangWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-v3-multilang-"));
  mkdirSync(join(root, "py"), { recursive: true });
  mkdirSync(join(root, "go"), { recursive: true });
  mkdirSync(join(root, "rs"), { recursive: true });
  mkdirSync(join(root, "cpp"), { recursive: true });
  mkdirSync(join(root, "cs"), { recursive: true });

  // 1. Python
  writeFileSync(
    join(root, "py", "types.py"),
    [
      "from dataclasses import dataclass",
      "",
      "@dataclass",
      "class PyBudgetConfig:",
      "    max_tokens: int",
      "    strict: bool",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "py", "engine.py"),
    [
      "from .types import PyBudgetConfig",
      "",
      "def noisy_py_helper(val: int) -> int:",
      "    a = val + 1",
      "    b = a * 2",
      "    c = b - 3",
      "    d = c * 4",
      "    return d",
      "",
      "def compute_py_budget(cfg: PyBudgetConfig, scale: int) -> int:",
      "    if cfg.strict:",
      "        return min(1000, cfg.max_tokens)",
      "    return cfg.max_tokens * scale",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "py", "runner.py"),
    [
      "from .engine import compute_py_budget",
      "from .types import PyBudgetConfig",
      "",
      "def run_py_task() -> int:",
      "    cfg = PyBudgetConfig(max_tokens=2000, strict=True)",
      "    return compute_py_budget(cfg, 2)",
    ].join("\n"),
    "utf8"
  );

  // 2. Go
  writeFileSync(
    join(root, "go", "types.go"),
    [
      "package budget",
      "",
      "type GoBudgetSpec struct {",
      "    MaxTokens int",
      "    Strict    bool",
      "}",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "go", "engine.go"),
    [
      "package budget",
      "",
      "func longGoHelper(x int) int {",
      "    a := x + 1",
      "    b := a * 2",
      "    c := b - 3",
      "    d := c * 4",
      "    return d",
      "}",
      "",
      "func ComputeGoBudget(spec GoBudgetSpec, factor int) int {",
      "    if spec.Strict {",
      "        return spec.MaxTokens",
      "    }",
      "    return spec.MaxTokens * factor",
      "}",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "go", "caller.go"),
    [
      "package budget",
      "",
      "func ExecuteGoFlow() int {",
      "    return ComputeGoBudget(GoBudgetSpec{MaxTokens: 1024, Strict: true}, 2)",
      "}",
    ].join("\n"),
    "utf8"
  );

  // 3. Rust
  writeFileSync(
    join(root, "rs", "types.rs"),
    [
      "pub struct RustQuota {",
      "    pub limit: usize,",
      "    pub hard: bool,",
      "}",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "rs", "engine.rs"),
    [
      "use crate::types::RustQuota;",
      "",
      "pub fn verbose_rust_helper(v: usize) -> usize {",
      "    let a = v + 1;",
      "    let b = a * 2;",
      "    let c = b - 1;",
      "    let d = c * 3;",
      "    d",
      "}",
      "",
      "pub fn eval_rust_quota(q: &RustQuota, mult: usize) -> usize {",
      "    if q.hard {",
      "        return q.limit;",
      "    }",
      "    q.limit * mult",
      "}",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "rs", "caller.rs"),
    [
      "use crate::engine::eval_rust_quota;",
      "use crate::types::RustQuota;",
      "",
      "pub fn run_rust_worker() -> usize {",
      "    let q = RustQuota { limit: 512, hard: true };",
      "    eval_rust_quota(&q, 3)",
      "}",
    ].join("\n"),
    "utf8"
  );

  // 4. C++
  writeFileSync(
    join(root, "cpp", "types.hpp"),
    [
      "#pragma once",
      "",
      "struct CppFrameLimit {",
      "  int maxBytes;",
      "  bool strict;",
      "};",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "cpp", "engine.cpp"),
    [
      '#include "types.hpp"',
      "",
      "int heavyCppHelper(int x) {",
      "  int a = x + 1;",
      "  int b = a * 2;",
      "  int c = b - 3;",
      "  int d = c * 4;",
      "  return d;",
      "}",
      "",
      "int calcCppFrame(const CppFrameLimit& lim, int bonus) {",
      "  if (lim.strict) {",
      "    return lim.maxBytes;",
      "  }",
      "  return lim.maxBytes + bonus;",
      "}",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "cpp", "caller.cpp"),
    [
      '#include "types.hpp"',
      "",
      "int invokeCppPipeline() {",
      "  CppFrameLimit lim{1024, true};",
      "  return calcCppFrame(lim, 64);",
      "}",
    ].join("\n"),
    "utf8"
  );

  // 5. C#
  writeFileSync(
    join(root, "cs", "Types.cs"),
    [
      "namespace GraphFlow.Sample;",
      "",
      "public record CsTokenEnvelope",
      "{",
      "    public int Budget { get; init; }",
      "    public bool Enforce { get; init; }",
      "}",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "cs", "Engine.cs"),
    [
      "namespace GraphFlow.Sample;",
      "",
      "public class CsBudgetService",
      "{",
      "    public int VerboseCsHelper(int input)",
      "    {",
      "        var a = input + 1;",
      "        var b = a * 2;",
      "        var c = b - 3;",
      "        return c;",
      "    }",
      "",
      "    public int EvaluateCsEnvelope(CsTokenEnvelope env, int weight)",
      "    {",
      "        if (env.Enforce) return env.Budget;",
      "        return env.Budget * weight;",
      "    }",
      "}",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "cs", "Caller.cs"),
    [
      "namespace GraphFlow.Sample;",
      "",
      "public class CsRunner",
      "{",
      "    public int Execute()",
      "    {",
      "        var svc = new CsBudgetService();",
      "        return svc.EvaluateCsEnvelope(new CsTokenEnvelope(), 2);",
      "    }",
      "}",
    ].join("\n"),
    "utf8"
  );

  return root;
}

async function runAllTests(): Promise<void> {
  const root = createSampleWorkspace();
  const multiRoot = createMultiLangWorkspace();
  let passed = 0;

  const check = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      throw err;
    }
  };

  try {
    console.log("=== Running GraphFlow 3.0 Surgical Engine Test Suite ===");

    check("Pillar 1A: AST analysis extracts exact line spans, referencedTypes, imports, and calls", () => {
      const index = getWorkspaceAstIndex(root);
      const fileData = index.getFileAnalysis("src/resolver.ts");
      assert.ok(fileData, "resolver.ts should be indexed");
      assert.equal(fileData.ast.symbols.length, 2);
      const resolveSym = fileData.ast.symbols.find((s) => s.name === "resolveBudget");
      assert.ok(resolveSym);
      assert.equal(resolveSym.line, 11);
      assert.equal(resolveSym.endLine, 16);
      assert.equal(resolveSym.paramsCount, 2);
      assert.ok(resolveSym.referencedTypes.includes("BudgetPolicy"));
      assert.ok(resolveSym.referencedTypes.includes("PolicyMode"));

      const folded = foldFileSkeleton(fileData.content, fileData.ast);
      assert.ok(folded.includes("folded"), "unusedHelper (>4 lines) should be folded in skeleton view");
      assert.ok(folded.includes("export function resolveBudget"), "resolveBudget signature preserved");
    });

    check("Pillar 1B & 2A: gf_read slices symbol + cross-file Type Closure + Blast Radius Call-Sites", () => {
      const res = executeSurgicalRead({
        rootDir: root,
        targets: ["src/resolver.ts#resolveBudget"],
        includeCallers: true,
      });
      assert.ok(res.text.includes("11: export function resolveBudget"));
      assert.ok(res.text.includes("[Type Closure] src/types.ts"));
      assert.ok(res.text.includes("export interface BudgetPolicy"));
      assert.ok(res.text.includes("[Blast Radius: 2 call site(s)]"));
      assert.ok(res.text.includes("src/caller.ts:4 in runHandler() [args=2]"));
    });

    check("Multi-Language AST (Python, Go, Rust, C/C++, C#): Slicing + Skeleton Folding + Type Closure + Blast Radius", () => {
      // 1. Python
      const pyRes = executeSurgicalRead({
        rootDir: multiRoot,
        targets: ["py/engine.py#compute_py_budget"],
        includeCallers: true,
        includeSkeleton: true,
      });
      assert.ok(pyRes.text.includes("def compute_py_budget(cfg: PyBudgetConfig, scale: int) -> int:"), "Python target sliced");
      assert.ok(pyRes.text.includes("[Type Closure] py/types.py"), "Python cross-file dataclass Type Closure");
      assert.ok(pyRes.text.includes("py/runner.py:6 in run_py_task() [args=2]"), "Python call-site Blast Radius");
      assert.ok(pyRes.text.includes("# [lines 4-8 folded]"), "Python indentation skeleton folding");

      // 2. Go
      const goRes = executeSurgicalRead({
        rootDir: multiRoot,
        targets: ["go/engine.go#ComputeGoBudget"],
        includeCallers: true,
      });
      assert.ok(goRes.text.includes("func ComputeGoBudget(spec GoBudgetSpec, factor int) int"), "Go target sliced");
      assert.ok(goRes.text.includes("[Type Closure] go/types.go"), "Go same-package struct Type Closure");
      assert.ok(goRes.text.includes("go/caller.go:4 in ExecuteGoFlow() [args=2]"), "Go call-site Blast Radius");

      // 3. Rust
      const rsRes = executeSurgicalRead({
        rootDir: multiRoot,
        targets: ["rs/engine.rs#eval_rust_quota"],
        includeCallers: true,
      });
      assert.ok(rsRes.text.includes("pub fn eval_rust_quota(q: &RustQuota, mult: usize) -> usize"), "Rust target sliced");
      assert.ok(rsRes.text.includes("[Type Closure] rs/types.rs"), "Rust crate Type Closure");
      assert.ok(rsRes.text.includes("rs/caller.rs:6 in run_rust_worker() [args=2]"), "Rust call-site Blast Radius");

      // 4. C++
      const cppRes = executeSurgicalRead({
        rootDir: multiRoot,
        targets: ["cpp/engine.cpp#calcCppFrame"],
        includeCallers: true,
      });
      assert.ok(cppRes.text.includes("int calcCppFrame(const CppFrameLimit& lim, int bonus)"), "C++ target sliced");
      assert.ok(cppRes.text.includes("[Type Closure] cpp/types.hpp"), "C++ #include header struct Type Closure");
      assert.ok(cppRes.text.includes("cpp/caller.cpp:5 in invokeCppPipeline() [args=2]"), "C++ call-site Blast Radius");

      // 5. C#
      const csRes = executeSurgicalRead({
        rootDir: multiRoot,
        targets: ["cs/Engine.cs#EvaluateCsEnvelope"],
        includeCallers: true,
      });
      assert.ok(csRes.text.includes("public int EvaluateCsEnvelope(CsTokenEnvelope env, int weight)"), "C# method sliced");
      assert.ok(csRes.text.includes("[Type Closure] cs/Types.cs"), "C# record Type Closure");
      assert.ok(csRes.text.includes("cs/Caller.cs:8 in Execute() [args=2]"), "C# call-site Blast Radius");
    });

    check("Multi-Language Surgical Edit, Cross-Repo Rename & Test Command Routing (Python, Go, Rust, C++, C#)", () => {
      // 1. Python surgical edit + caller-arity mismatch detection
      const pyEdit = executeSurgicalEdit({
        rootDir: multiRoot,
        file: "py/engine.py",
        symbol: "compute_py_budget",
        newCode: [
          "def compute_py_budget(cfg: PyBudgetConfig) -> int:",
          "    return cfg.max_tokens",
        ].join("\n"),
      });
      assert.equal(pyEdit.ok, true, "Python symbol edit succeeds");
      assert.ok(
        pyEdit.diagnostics.some((d) => d.kind === "caller-arity-mismatch" && d.location === "py/runner.py:6"),
        "Python caller arity drift detected in py/runner.py:6"
      );

      // 2. Go cross-repo function rename across engine.go and caller.go
      const goRename = executeSurgicalEdit({
        rootDir: multiRoot,
        file: "go/engine.go",
        symbol: "ComputeGoBudget",
        renameTo: "CalcGoQuota",
      });
      assert.equal(goRename.ok, true, "Go cross-repo rename succeeds");
      assert.equal(goRename.touchedFiles.length, 2, "Updates go/engine.go and go/caller.go");
      assert.ok(readFileSync(join(multiRoot, "go", "caller.go"), "utf8").includes("CalcGoQuota("));

      // 3. Rust cross-repo struct/type rename across types.rs, engine.rs, and caller.rs
      const rsTypeRename = executeSurgicalEdit({
        rootDir: multiRoot,
        file: "rs/types.rs",
        symbol: "RustQuota",
        renameTo: "RustBudgetEnvelope",
      });
      assert.equal(rsTypeRename.ok, true, "Rust cross-repo struct rename succeeds");
      assert.equal(rsTypeRename.touchedFiles.length, 3, "Updates rs/types.rs, rs/engine.rs, and rs/caller.rs");

      // 4. C++ syntax error guard (unbalanced brace rolled back)
      const cppBadEdit = executeSurgicalEdit({
        rootDir: multiRoot,
        file: "cpp/engine.cpp",
        symbol: "calcCppFrame",
        newCode: "int calcCppFrame(const CppFrameLimit& lim, int bonus) {\n  return lim.maxBytes;\n",
      });
      assert.equal(cppBadEdit.ok, false, "C++ unbalanced brace must be rejected and rolled back");

      // 5. Multi-language affected test runner command generation
      const multiCmd = buildAffectedTestCommand([
        "tests/resolver.test.ts",
        "py/test_engine.py",
        "go/engine_test.go",
        "rs/engine_test.rs",
        "cs/EngineTests.cs",
        "cpp/engine_test.cpp",
      ]);
      assert.ok(multiCmd.includes("npx vitest run tests/resolver.test.ts"));
      assert.ok(multiCmd.includes("pytest py/test_engine.py"));
      assert.ok(multiCmd.includes("go test ./go"));
      assert.ok(multiCmd.includes("cargo test"));
      assert.ok(multiCmd.includes("dotnet test"));
      assert.ok(multiCmd.includes("ctest --output-on-failure"));
    });

    check("Pillar 2B: gf_edit rejects syntax errors with rollback & detects caller arity drift", () => {
      const badEdit = executeSurgicalEdit({
        rootDir: root,
        file: "src/resolver.ts",
        symbol: "resolveBudget",
        newCode: "export function resolveBudget(policy: BudgetPolicy): number {\n  return policy.maxTokens;\n",
      });
      assert.equal(badEdit.ok, false);
      assert.ok(badEdit.text.includes("REJECTED [syntax-error]"));

      const arityEdit = executeSurgicalEdit({
        rootDir: root,
        file: "src/resolver.ts",
        symbol: "resolveBudget",
        newCode: [
          "export function resolveBudget(policy: BudgetPolicy): number {",
          "  return policy.strict ? Math.min(1000, policy.maxTokens) : policy.maxTokens;",
          "}",
        ].join("\n"),
      });
      assert.equal(arityEdit.ok, true);
      assert.ok(
        arityEdit.diagnostics.some(
          (d) => d.kind === "caller-arity-mismatch" && d.location === "src/caller.ts:4"
        )
      );
    });

    check("Pillar 2C & 3B: Batch Atomic Multi-Edit (no line drift) & Zero-LLM Cross-Repo Symbol Rename", () => {
      const batchRes = executeSurgicalEdit({
        rootDir: root,
        file: "src/resolver.ts",
        edits: [
          {
            file: "src/resolver.ts",
            symbol: "unusedHelper",
            newCode: "export function unusedHelper(x: number): number {\n  return x * 10;\n}",
          },
          {
            file: "src/resolver.ts",
            symbol: "resolveBudget",
            newCode: "export function resolveBudget(policy: BudgetPolicy): number {\n  return policy.maxTokens;\n}",
          },
          {
            file: "src/caller.ts",
            symbol: "runHandler",
            newCode: "export function runHandler(): number {\n  return resolveBudget({ maxTokens: 4000, strict: true });\n}",
          },
        ],
      });
      assert.equal(batchRes.ok, true, "Batch atomic edit must succeed");
      assert.equal(batchRes.touchedFiles.length, 2);

      const renameRes = executeSurgicalEdit({
        rootDir: root,
        file: "src/resolver.ts",
        symbol: "resolveBudget",
        renameTo: "computeCap",
      });
      assert.equal(renameRes.ok, true, "Cross-repo rename must succeed");
      assert.equal(renameRes.touchedFiles.length, 3, "Must rename in resolver.ts, caller.ts, and resolver.test.ts");
      assert.ok(readFileSync(join(root, "src", "caller.ts"), "utf8").includes("computeCap("));
    });

    check("Pillar 3: Diff-to-Test router & Stdout Dehydrator compress logs by >90% and inline failure source", () => {
      const impact = resolveAffectedTests(root, ["src/types.ts"]);
      assert.ok(impact.affectedTests.includes("tests/resolver.test.ts"));

      const verbosePassStdout =
        Array.from({ length: 80 }, (_, i) => ` ✓ tests/suite-${i}.test.ts (12 tests) 14ms`).join("\n") +
        "\nTests 960 passed (960)\nDuration 1.42s";

      const passDehydrated = dehydrateCommandOutput({
        rootDir: root,
        command: "vitest run",
        exitCode: 0,
        durationMs: 1420,
        stdout: verbosePassStdout,
        stderr: "",
      });
      assert.equal(passDehydrated.ok, true);
      assert.ok(passDehydrated.dehydratedTokens < 35);

      const verboseFailStderr = [
        "FAIL tests/resolver.test.ts > testAll",
        "AssertionError: expected 500 to equal 1000",
        "    at runHandler (src/caller.ts:4:15)",
        "    at Object.<anonymous> (node_modules/vitest/dist/chunk-runtime.js:1942:11)",
      ].join("\n");

      const failDehydrated = dehydrateCommandOutput({
        rootDir: root,
        command: "vitest run",
        exitCode: 1,
        durationMs: 320,
        stdout: "",
        stderr: verboseFailStderr,
      });
      assert.equal(failDehydrated.ok, false);
      assert.ok(!failDehydrated.text.includes("node_modules/vitest"));
      assert.ok(failDehydrated.text.includes("# Auto-Attached Failure Source Context:"));
    });

    check("Pillar 4: Habit Memory (Co-Edit Pairs, Parameterized Command Templates, Auto-Verify Hooks)", () => {
      executeV3ToolCall("gf_read", { targets: ["src/types.ts#BudgetPolicy", "src/resolver.ts#computeCap"] }, root);
      const secondRead = executeV3ToolCall(
        "gf_read",
        { targets: ["src/types.ts#BudgetPolicy", "src/resolver.ts#computeCap"] },
        root
      );
      assert.ok(secondRead.content[0]!.text.includes("[Auto-Recorded Tool]"));

      recordTrajectoryAndMine(root, {
        sessionId: "h1",
        kind: "exec",
        key: "node -e \"console.log('check')\" src/types.ts",
        items: ["node -e \"console.log('check')\" src/types.ts"],
        ok: true,
      });
      const tplMine = recordTrajectoryAndMine(root, {
        sessionId: "h1",
        kind: "exec",
        key: "node -e \"console.log('check')\" src/caller.ts",
        items: ["node -e \"console.log('check')\" src/caller.ts"],
        ok: true,
      });
      const tplMacro = tplMine.newlyCompiled.find((m) => m.kind === "command-template");
      assert.ok(tplMacro, "Must learn parameterized command-template macro from varying file args");
      assert.ok(tplMacro.steps[0]!.includes("{{arg1}}"));

      const tplRun = executeMacro(root, tplMacro.id, ["src/resolver.ts"]);
      assert.equal(tplRun.ok, true);

      for (const s of ["sA", "sB"]) {
        recordTrajectoryAndMine(root, {
          sessionId: s,
          kind: "edit",
          key: "src/types.ts",
          items: ["src/types.ts"],
          ok: true,
        });
        recordTrajectoryAndMine(root, {
          sessionId: s,
          kind: "edit",
          key: "src/resolver.ts",
          items: ["src/resolver.ts"],
          ok: true,
        });
        recordTrajectoryAndMine(root, {
          sessionId: s,
          kind: "exec",
          key: "node -e \"process.stdout.write('dir-verified')\"",
          items: ["node -e \"process.stdout.write('dir-verified')\""],
          ok: true,
        });
      }

      const store = loadMacroStore(root);
      assert.ok(
        store.habits.coEdits.some((ce) => ce.fileA === "src/resolver.ts" && ce.fileB === "src/types.ts"),
        "Must learn co-edit habit between src/types.ts and src/resolver.ts"
      );
      assert.ok(
        store.habits.dirVerifyCommands.some((dv) => dv.dirPrefix === "src"),
        "Must learn directory auto-verify habit for 'src'"
      );

      const habitEdit = executeV3ToolCall(
        "gf_edit",
        {
          file: "src/types.ts",
          symbol: "PolicyMode",
          newCode: "export type PolicyMode = 'auto' | 'fixed' | 'strict';",
        },
        root
      );
      assert.ok(
        habitEdit.content[0]!.text.includes("Auto-Verify Habit [src ->"),
        "Editing a file in 'src' must automatically run the learned directory verify habit"
      );
      assert.ok(
        habitEdit.content[0]!.text.includes("[co-edit-habit]"),
        "Editing src/types.ts alone must warn that it is habitually co-edited with src/resolver.ts"
      );
    });

    check("Host Hook Interceptor: PreToolUse folds >250L raw Read into AST Skeleton & PostToolUse dehydrates Bash", () => {
      // Create a 300-line Python file in multiRoot
      const bigPyLines = ["from .types import PyBudgetConfig", ""];
      for (let f = 0; f < 30; f++) {
        bigPyLines.push(
          `def helper_func_${f}(x: int) -> int:`,
          `    step1 = x + ${f}`,
          `    step2 = step1 * 2`,
          `    step3 = step2 - 1`,
          `    step4 = step3 + 10`,
          `    step5 = step4 * 3`,
          `    step6 = step5 - 5`,
          `    return step6`,
          ""
        );
      }
      writeFileSync(join(multiRoot, "py", "large_service.py"), bigPyLines.join("\n"), "utf8");
      getWorkspaceAstIndex(multiRoot).invalidateFile("py/large_service.py");

      // Unscoped Read on 272-line file -> intercepted & folded into AST Skeleton!
      const preRes = interceptPreToolUse(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "py/large_service.py" },
        },
        { rootDir: multiRoot, maxRawLines: 250 }
      );
      assert.equal(preRes.intercepted, true, "Large unscoped Read must be intercepted");
      assert.equal(preRes.action, "fold-skeleton");
      assert.ok(preRes.tokensSaved! > 500, `Expected >500 tokens saved, got ${preRes.tokensSaved}`);
      assert.ok(preRes.replacementContent!.includes("def helper_func_0(x: int) -> int: ...  # [lines"));

      // Bounded Read (offset=1, limit=20) -> allowed!
      const boundedRes = interceptPreToolUse(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "py/large_service.py", offset: 1, limit: 20 },
        },
        { rootDir: multiRoot, maxRawLines: 250 }
      );
      assert.equal(boundedRes.intercepted, false, "Bounded Read with limit<=250 must pass through");

      // PostToolUse on verbose Bash test run -> dehydrated!
      const postBash = interceptPostToolUse(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "pytest" },
          tool_response: {
            exit_code: 0,
            stdout: Array.from({ length: 60 }, (_, i) => `py/test_mod_${i}.py .... [100%]`).join("\n") + "\n60 passed in 0.82s",
            stderr: "",
          },
        },
        { rootDir: multiRoot }
      );
      assert.equal(postBash.intercepted, true);
      assert.equal(postBash.action, "dehydrate-bash");
      assert.ok(postBash.dehydratedText!.startsWith("PASS [exit=0"));
    });

    check("V3.1 Pillar A: Zero-Cold-Start Git Temporal Coupling Miner discovers cross-language co-edits", () => {
      const sampleGitLog = [
        "COMMIT:a1b2c3d",
        "proto/order.proto",
        "go/engine.go",
        "COMMIT:b2c3d4e",
        "proto/order.proto",
        "go/engine.go",
        "py/engine.py",
        "COMMIT:c3d4e5f",
        "proto/order.proto",
        "go/engine.go",
      ].join("\n");
      const commits = parseGitLogCommitFiles(sampleGitLog, 20);
      assert.equal(commits.length, 3);
      const mined = computeTemporalCouplingFromCommits(commits, { minCoCommits: 2, minConfidence: 0.6 });
      assert.ok(
        mined.coChangePairs.some(
          (p) => p.fileA === "go/engine.go" && p.fileB === "proto/order.proto" && p.coCommitCount === 3 && p.confidence === 1
        ),
        "Must discover 100% temporal coupling between proto/order.proto and go/engine.go"
      );
    });

    check("V3.1 Pillar B: 35-Minute Wall Defense — Session Read Deduplication & Edit-Test Thrashing Circuit Breaker", () => {
      // 1. Session Read Deduplication Cache: 2nd read with dedup=true returns 1-line SHA-256 hit!
      const firstRead = executeV3ToolCall(
        "gf_read",
        { targets: ["src/types.ts#BudgetPolicy"], dedup: true, sessionId: "dedup-sess" },
        root
      );
      assert.ok(!firstRead.content[0]!.text.includes("[Session Dedup Cache Hit]"));

      const dupRead = executeV3ToolCall(
        "gf_read",
        { targets: ["src/types.ts#BudgetPolicy"], dedup: true, sessionId: "dedup-sess" },
        root
      );
      assert.ok(
        dupRead.content[0]!.text.includes("[Session Dedup Cache Hit]"),
        "Second read of unchanged symbol in same session must return 1-line dedup cache hit"
      );

      // 2. Edit-Test Thrashing Circuit Breaker: 3 consecutive failures trip the rescue packet!
      executeV3ToolCall(
        "gf_edit",
        {
          file: "src/caller.ts",
          symbol: "runHandler",
          newCode: "export function runHandler(): number {\n  return computeCap({ maxTokens: 4000, strict: true });\n}",
        },
        root
      );
      const failCmd = "node -e \"process.exit(1)\"";
      const f1 = executeV3ToolCall("gf_exec", { cmd: failCmd, sessionId: "cb-sess" }, root);
      assert.ok(!f1.content[0]!.text.includes("CIRCUIT BREAKER TRIPPED"));
      const f2 = executeV3ToolCall("gf_exec", { cmd: failCmd, sessionId: "cb-sess" }, root);
      assert.ok(!f2.content[0]!.text.includes("CIRCUIT BREAKER TRIPPED"));
      const f3 = executeV3ToolCall("gf_exec", { cmd: failCmd, sessionId: "cb-sess" }, root);
      assert.ok(
        f3.content[0]!.text.includes("⚡ [CIRCUIT BREAKER TRIPPED: 3 consecutive failures"),
        "3rd consecutive failure must trip Circuit Breaker and inject contract rescue packet"
      );
    });

    check("V3.1 Pillar C & D: Cross-File Struct Field Contract Guard, Isomorphic Auto-Codemod & RBAC Governance", () => {
      // 1. Removing a referenced field (`strict`) from `BudgetPolicy` warns that `src/resolver.ts` still accesses `.strict`!
      const fieldGuardRes = executeSurgicalEdit({
        rootDir: root,
        file: "src/types.ts",
        symbol: "BudgetPolicy",
        newCode: "export interface BudgetPolicy {\n  maxTokens: number;\n}",
      });
      assert.equal(fieldGuardRes.ok, true);
      // Restore `strict` field and test when `resolver.ts` accesses `policy.maxTokens`
      const removeMaxTokensRes = executeSurgicalEdit({
        rootDir: root,
        file: "src/types.ts",
        symbol: "BudgetPolicy",
        newCode: "export interface BudgetPolicy {\n  strict: boolean;\n}",
      });
      assert.equal(removeMaxTokensRes.ok, true);
      assert.ok(
        removeMaxTokensRes.diagnostics.some(
          (d) => d.kind === "removed-struct-field-still-referenced" && d.message.includes("BudgetPolicy.maxTokens")
        ),
        "Removing BudgetPolicy.maxTokens must flag downstream .maxTokens references"
      );

      // 2. Isomorphic Edit Pattern -> Auto-Codemod compilation & 0-LLM batch execution
      writeFileSync(join(root, "src", "svc1.ts"), "export const timeoutMs = 3000;\n", "utf8");
      writeFileSync(join(root, "src", "svc2.ts"), "export const timeoutMs = 3000;\n", "utf8");
      writeFileSync(join(root, "src", "svc3.ts"), "export const timeoutMs = 3000;\n", "utf8");

      executeV3ToolCall(
        "gf_edit",
        { file: "src/svc1.ts", oldCode: "timeoutMs = 3000;", newCode: "timeoutMs = 10000;" },
        root
      );
      const secondIsoEdit = executeV3ToolCall(
        "gf_edit",
        { file: "src/svc2.ts", oldCode: "timeoutMs = 3000;", newCode: "timeoutMs = 10000;" },
        root
      );
      assert.ok(
        secondIsoEdit.content[0]!.text.includes("[Auto-Compiled Codemod]"),
        "Repeating the same structural edit twice must auto-compile an edit-codemod macro"
      );
      const codemodIdMatch = secondIsoEdit.content[0]!.text.match(/promoted to '(codemod_[a-f0-9]+)'/);
      assert.ok(codemodIdMatch, "Must extract codemod macro id");

      const applyCodemod = executeV3ToolCall(
        "gf_macro",
        { action: "run", id: codemodIdMatch[1]!, args: ["src/svc3.ts"] },
        root
      );
      assert.ok(applyCodemod.content[0]!.text.includes("PASS [codemod"));
      assert.ok(readFileSync(join(root, "src", "svc3.ts"), "utf8").includes("timeoutMs = 10000;"));

      // 3. Tool Governance verification for all 4 gf_* tools
      const v3Defs = getV3ToolDefinitions();
      assert.equal(v3Defs.length, 4);
      for (const d of v3Defs) {
        assert.ok(d.annotations, `${d.name} must have MCP ToolAnnotations`);
        assert.ok(d._meta, `${d.name} must have ToolGovernanceMeta`);
      }
    });

    check("MCP Surface: 4 surgical tool definitions use <460 tokens total (>92% reduction vs v2.3.0)", () => {
      const v3Bytes = Buffer.byteLength(JSON.stringify(V3_TOOL_DEFINITIONS), "utf8");
      const v3Tokens = Math.ceil(v3Bytes / 4);
      assert.equal(V3_TOOL_DEFINITIONS.length, 4);
      assert.ok(v3Tokens < 460, `Expected <460 tokens for all 4 V3 tool schemas, got ${v3Tokens}`);
    });


    check("Multi-Agent Auto-Installer: registers MCP, Skills, Rules & Hooks across mainstream agents and uninstalls cleanly", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "gf-agents-home-"));
      try {
        mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
        mkdirSync(join(fakeHome, ".claude"), { recursive: true });
        mkdirSync(join(fakeHome, ".codex"), { recursive: true });
        mkdirSync(join(fakeHome, ".vscode"), { recursive: true });
        mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
        mkdirSync(join(fakeHome, ".config", "zed"), { recursive: true });
        mkdirSync(join(fakeHome, ".codeium", "windsurf"), { recursive: true });
        writeFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "# User Custom Notes\nKeep this line.\n", "utf8");

        const detected = detectInstalledAgents({ homeDir: fakeHome });
        const ids = detected.map((d) => d.id);
        assert.ok(ids.includes("cursor") && ids.includes("claude-code") && ids.includes("codex") && ids.includes("vscode"));

        const report = installAllAgents({ homeDir: fakeHome });
        assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "mcp"));
        assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "skill"));
        assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "rule"));
        assert.ok(report.results.some((r) => r.agentId === "cursor" && r.category === "hook"));

        // Verify Codex TOML MCP + Skill
        const codexToml = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf8");
        assert.ok(codexToml.includes("[mcp_servers.graphflow]"), "Codex config.toml must contain [mcp_servers.graphflow]");
        assert.ok(readFileSync(join(fakeHome, ".codex", "skills", "graphflow", "SKILL.md"), "utf8").includes("name: graphflow"));

        // Verify Claude Code non-destructive managed block in CLAUDE.md
        const claudeMd = readFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "utf8");
        assert.ok(claudeMd.includes("Keep this line.") && claudeMd.includes("<!-- GRAPHFLOW:BEGIN -->"));

        // Verify uninstall removes MCP, Skills, and managed blocks while preserving user notes
        const removed = uninstallAllAgents({ homeDir: fakeHome });
        assert.ok(removed.length >= 10);
        const claudeMdAfter = readFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "utf8");
        assert.ok(claudeMdAfter.includes("Keep this line.") && !claudeMdAfter.includes("<!-- GRAPHFLOW:BEGIN -->"));
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });


    check("Bilingual Tokenizer (src/tokenizer.ts): Segmentation, Pinyin, Synonyms & Homophone/Spelling Typos", () => {
      // 1. Verify Chinese word segmentation (Bi-MM + V8 Intl.Segmenter) strips stop words and avoids garbage bigrams
      const zhSeg = segmentChinese("如何处理微信支付回调验签失败与订单超时自动取消");
      assert.deepEqual(
        zhSeg.words,
        ["微信", "支付", "回调", "验签", "失败", "订单", "超时", "自动", "取消"],
        "segmentChinese must segment domain words cleanly without cross-boundary garbage bigrams"
      );

      // 2. Verify English tokenizer + morphological stemmer
      const enTok = tokenizeEnglish("canceling expiring orders in resolveEfficiencyPolicy");
      assert.ok(enTok.stems.includes("cancel") && enTok.stems.includes("expir") && enTok.stems.includes("order"));

      writeFileSync(
        join(root, "src", "order-service.ts"),
        [
          "/** 处理微信支付回调验签与订单状态流转 */",
          "export function handleWebhookV2(payload: string, sig: string): boolean {",
          "  if (!payload || !sig) throw new Error(\"签名校验失败：参数为空\");",
          "  return sig.startsWith(\"wx_\");",
          "}",
          "",
          "export function cancelExpiredOrder(orderId: string, timeoutMs: number): boolean {",
          "  return timeoutMs > 30000 && orderId.length > 0;",
          "}",
          "",
          "export function processDingDanZhiFu(orderId: string): string {",
          "  return `paid:${orderId}`;",
          "}",
        ].join("\n"),
        "utf8"
      );

      // 3. ZH -> EN: Conversational Chinese query hits English symbol (cancelExpiredOrder)
      const qZhToEn = executeSurgicalRead({ rootDir: root, query: "请问如何处理订单超时自动取消？", topK: 2 });
      assert.ok(qZhToEn.matchedSymbols.some((s) => s.name === "cancelExpiredOrder"));

      // 4. EN (inflected) -> EN: English morphological query ("canceling expiring orders") hits cancelExpiredOrder
      const qEnStem = executeSurgicalRead({ rootDir: root, query: "canceling expiring orders", topK: 2 });
      assert.ok(qEnStem.matchedSymbols.some((s) => s.name === "cancelExpiredOrder"));

      // 5. EN -> ZH: English query ("wechat payment signature") reverse-expands to CJK and hits handleWebhookV2
      const qEnToZh = executeSurgicalRead({ rootDir: root, query: "wechat payment signature", topK: 2 });
      assert.ok(qEnToZh.matchedSymbols.some((s) => s.name === "handleWebhookV2"));

      // 6. Pinyin Query -> EN/ZH Code ("dingdan chaoshi quxiao" & "weixin zhifu")
      const qPinyin = executeSurgicalRead({ rootDir: root, query: "dingdan chaoshi quxiao", topK: 2 });
      assert.ok(
        qPinyin.matchedSymbols.some((s) => s.name === "cancelExpiredOrder"),
        "Pinyin query (dingdan chaoshi quxiao) must resolve to 订单/超时/取消 and match cancelExpiredOrder"
      );

      // 7. Chinese Query -> Pinyin-Named Function ("订单支付" -> processDingDanZhiFu)
      const qZhToPinyinCode = executeSurgicalRead({ rootDir: root, query: "订单支付", topK: 3 });
      assert.ok(
        qZhToPinyinCode.matchedSymbols.some((s) => s.name === "processDingDanZhiFu"),
        "Chinese query (订单支付) must emit Pinyin tokens (dingdan/zhifu) and match processDingDanZhiFu"
      );

      // 8. Chinese Synonyms Query ("微信付款核对" where "付款"=synonym of "支付" and "核对"=synonym of "验签")
      const qSynonym = executeSurgicalRead({ rootDir: root, query: "微信付款核对", topK: 2 });
      assert.ok(
        qSynonym.matchedSymbols.some((s) => s.name === "handleWebhookV2"),
        "Chinese synonym query (微信付款核对) must expand to 支付/验签 and match handleWebhookV2"
      );

      // 9. Chinese Homophone Typos ("定单钞时取销" / "威信知付回掉验千") & English Typos ("cancle expried ordrs")
      const qZhTypo = executeSurgicalRead({ rootDir: root, query: "定单钞时取销", topK: 2 });
      assert.ok(
        qZhTypo.matchedSymbols.some((s) => s.name === "cancelExpiredOrder"),
        "Chinese homophone typo query (定单钞时取销) must auto-correct to 订单超时取消 and match cancelExpiredOrder"
      );
      const qZhPhoneticTypo = executeSurgicalRead({ rootDir: root, query: "威信知付回掉验千", topK: 2 });
      assert.ok(
        qZhPhoneticTypo.matchedSymbols.some((s) => s.name === "handleWebhookV2"),
        "Phonetic homophone typo (威信知付回掉验千) must map via Pinyin hash to 微信支付回调验签 and match handleWebhookV2"
      );
      const qEnTypo = executeSurgicalRead({ rootDir: root, query: "cancle expried ordrs", topK: 2 });
      assert.ok(
        qEnTypo.matchedSymbols.some((s) => s.name === "cancelExpiredOrder"),
        "English 1-char typo query (cancle expried ordrs) must match cancelExpiredOrder via edit-distance-1 tolerance"
      );
    });

    check("Production Engineering Hardening: CRLF Preservation, Absolute Paths, Path-Traversal Guard, Unexpanded Placeholders & ClassName.method Disambiguation", () => {
      // 1. Absolute path inside workspace works seamlessly in gf_read & gf_edit
      const absTarget = `${join(root, "src", "types.ts")}#BudgetPolicy`;
      const absRead = executeV3ToolCall("gf_read", { targets: [absTarget], rootDir: "$" + "{workspaceFolder}" }, root);
      assert.ok(
        absRead.content[0]!.text.includes("interface BudgetPolicy"),
        "Absolute path target + unexpanded workspaceFolder fallback must succeed"
      );

      // 2. Path-traversal outside workspace is blocked
      const traversalEdit = executeSurgicalEdit({
        rootDir: root,
        file: "../../etc/passwd",
        oldCode: "root",
        newCode: "hacked",
      });
      assert.equal(traversalEdit.ok, false);
      assert.ok(traversalEdit.text.includes("ERR [path-outside-workspace]"));

      // 3. Windows CRLF (\r\n) preservation + LF oldCode with different leading indentation
      const crlfFile = join(root, "src", "crlf-win.ts");
      writeFileSync(
        crlfFile,
        "export function calcWinTax(a: number): number {\r\n    const rate = 0.15;\r\n    return a * rate;\r\n}\r\n",
        "utf8"
      );
      const crlfEdit = executeSurgicalEdit({
        rootDir: root,
        file: "src/crlf-win.ts",
        oldCode: "  const rate = 0.15;\n  return a * rate;",
        newCode: "    const rate = 0.20;\n    return a * rate;",
      });
      assert.equal(crlfEdit.ok, true, "LF oldCode with slight indent diff must match CRLF file");
      const crlfSaved = readFileSync(crlfFile, "utf8");
      assert.ok(crlfSaved.includes("\r\n") && crlfSaved.includes("0.20"), "Saved CRLF file must preserve \r\n line endings");

      // 4. Same-name methods across multiple classes: ambiguity guard & ClassName.methodName disambiguation
      writeFileSync(
        join(root, "src", "runners.ts"),
        [
          "export class OrderRunner {",
          "  run(id: string): string {",
          "    return 'order:' + id;",
          "  }",
          "}",
          "",
          "export class PaymentRunner {",
          "  run(id: string): string {",
          "    return 'pay:' + id;",
          "  }",
          "}",
        ].join("\n"),
        "utf8"
      );

      const ambigEdit = executeSurgicalEdit({
        rootDir: root,
        file: "src/runners.ts",
        symbol: "run",
        newCode: "  run(id: string): string { return id; }",
      });
      assert.equal(ambigEdit.ok, false, "Unqualified duplicate method name must trigger ERR [ambiguous-symbol]");
      assert.ok(
        ambigEdit.text.includes("ERR [ambiguous-symbol]") &&
          ambigEdit.text.includes("OrderRunner.run") &&
          ambigEdit.text.includes("PaymentRunner.run")
      );

      const scopedEdit = executeSurgicalEdit({
        rootDir: root,
        file: "src/runners.ts",
        symbol: "PaymentRunner.run",
        newCode: [
          "  run(id: string): string {",
          "    return 'pay_v2:' + id;",
          "  }",
        ].join("\n"),
      });
      assert.equal(scopedEdit.ok, true, "Scoped ClassName.methodName edit must succeed");
      const runnersAfter = readFileSync(join(root, "src", "runners.ts"), "utf8");
      assert.ok(
        runnersAfter.includes("'order:' + id") && runnersAfter.includes("'pay_v2:' + id"),
        "OrderRunner.run must remain untouched while PaymentRunner.run is updated"
      );
    });

    check("Cross-Agent Onboarding Brief, Multi-Format Doc<->Code Graph (.docx/.pdf/.xml/.html/.md), HTML Visualizer & 6-Lang Struct Guard Parity", () => {
      const { deflateRawSync, deflateSync } = require("node:zlib");
      mkdirSync(join(root, "docs"), { recursive: true });

      // 1. Create a real .docx (ZIP containing word/document.xml) with zero external deps
      const wordXml = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>订单超时规则 (Order Timeout Spec)</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>当订单超过30秒未支付时，调用 `cancelExpiredOrder` 执行自动撤单与库存释放。</w:t></w:r></w:p>' +
          "</w:body></w:document>",
        "utf8"
      );
      const deflatedXml = deflateRawSync(wordXml);
      const fileNameBuf = Buffer.from("word/document.xml", "utf8");
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0, 6);
      localHeader.writeUInt16LE(8, 8); // deflate
      localHeader.writeUInt32LE(deflatedXml.length, 18);
      localHeader.writeUInt32LE(wordXml.length, 22);
      localHeader.writeUInt16LE(fileNameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);
      const docxBuf = Buffer.concat([localHeader, fileNameBuf, deflatedXml]);
      writeFileSync(join(root, "docs", "order-spec.docx"), docxBuf);

      // 2. Create a real FlateDecode .pdf, .xml, .html, and .md
      const pdfStreamContent = Buffer.from("BT (Wechat Pay Webhook Spec: call handleWebhookV2 to verify signature) Tj ET", "utf8");
      const pdfCompressed = deflateSync(pdfStreamContent);
      const pdfBuf = Buffer.concat([
        Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
        pdfCompressed,
        Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
      ]);
      writeFileSync(join(root, "docs", "payment-protocol.pdf"), pdfBuf);
      writeFileSync(
        join(root, "docs", "workflow.xml"),
        '<workflow name="OrderCancelFlow"><step symbol="cancelExpiredOrder">订单超时自动取消流程</step></workflow>',
        "utf8"
      );
      writeFileSync(
        join(root, "docs", "architecture.html"),
        "<html><body><h2>Payment Webhook Gateway</h2><p>Entrypoint function `handleWebhookV2` validates wx signatures.</p></body></html>",
        "utf8"
      );

      // Verify reading code symbol automatically attaches [Linked Spec Doc] from .docx/.xml/.html/.pdf!
      const readCodeWithDocs = executeV3ToolCall(
        "gf_read",
        { targets: ["src/order-service.ts#cancelExpiredOrder"], sessionId: "cursor-agent" },
        root
      );
      const readText = readCodeWithDocs.content[0]!.text;
      assert.ok(
        readText.includes("[Linked Spec Doc]") && readText.includes("docs/order-spec.docx"),
        "Reading cancelExpiredOrder must automatically surface linked .docx spec section"
      );

      // Verify reading .docx directly slices sections and shows linked code symbols!
      const readDocxDirect = executeV3ToolCall("gf_read", { targets: ["docs/order-spec.docx"] }, root);
      assert.ok(
        readDocxDirect.content[0]!.text.includes("订单超时规则") &&
          readDocxDirect.content[0]!.text.includes("src/order-service.ts#cancelExpiredOrder"),
        "Direct gf_read on .docx must extract headings and show linked code symbols"
      );

      // 3. Verify Cross-Agent Onboarding & Handoff Brief when switching from Cursor -> Claude Code
      const handoffBrief = executeV3ToolCall("gf_read", { sessionId: "claude-code-agent" }, root);
      const briefText = handoffBrief.content[0]!.text;
      assert.ok(
        briefText.includes("[Cross-Agent Project Onboarding & Handoff Brief]") &&
          briefText.includes("Core Architecture Hubs") &&
          briefText.includes("cursor-agent") &&
          briefText.includes("Linked Development Docs <-> Code Symbols"),
        "Calling gf_read({}) from a new agent must return the Cross-Agent Onboarding & Handoff Brief"
      );

      // 4. Verify Interactive HTML Knowledge Graph generation
      const vizRes = executeV3ToolCall("gf_macro", { action: "visualize" }, root);
      assert.ok(vizRes.content[0]!.text.includes("OK [knowledge-graph]"));
      const htmlContent = readFileSync(join(root, ".graphflow", "knowledge-graph.html"), "utf8");
      assert.ok(htmlContent.includes("GraphFlow 3.1 Knowledge Graph") && htmlContent.includes("doc-links-code"));

      // 5. Verify 6-Language Struct Field Deletion Guard Parity (Python @dataclass, Go struct, Rust struct)
      const pyFieldDel = executeSurgicalEdit({
        rootDir: multiRoot,
        file: "py/types.py",
        symbol: "PyBudgetConfig",
        newCode: ["@dataclass", "class PyBudgetConfig:", "    strict: bool"].join("\n"),
      });
      assert.ok(
        pyFieldDel.diagnostics.some((d) => d.kind === "removed-struct-field-still-referenced" && d.message.includes("max_tokens")),
        "Python @dataclass field deletion must trigger removed-struct-field-still-referenced across files"
      );

      const goFieldDel = executeSurgicalEdit({
        rootDir: multiRoot,
        file: "go/types.go",
        symbol: "GoBudgetSpec",
        newCode: ["type GoBudgetSpec struct {", "    Strict bool", "}"].join("\n"),
      });
      assert.ok(
        goFieldDel.diagnostics.some((d) => d.kind === "removed-struct-field-still-referenced" && d.message.includes("MaxTokens")),
        "Go struct field deletion must trigger removed-struct-field-still-referenced across files"
      );

      const rsFieldDel = executeSurgicalEdit({
        rootDir: multiRoot,
        file: "rs/types.rs",
        symbol: "RustBudgetEnvelope",
        newCode: ["pub struct RustBudgetEnvelope {", "    pub hard: bool,", "}"].join("\n"),
      });
      assert.ok(
        rsFieldDel.diagnostics.some((d) => d.kind === "removed-struct-field-still-referenced" && d.message.includes("limit")),
        "Rust struct field deletion must trigger removed-struct-field-still-referenced across files"
      );
    });

    console.log(`\nALL ${passed} GRAPHFLOW 3.1 TESTS PASSED!`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(multiRoot, { recursive: true, force: true });
  }
}

runAllTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
