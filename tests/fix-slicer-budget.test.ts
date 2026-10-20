/**
 * GraphFlow — read-budget / type-closure regressions (`tests/fix-slicer-budget.test.ts`)
 *
 * Standalone: `npx tsx tests/fix-slicer-budget.test.ts`
 *
 * Covers:
 *   R1  a >=1200-line class must be returned as a structured digest that keeps every
 *       method signature, stays near the budget (>=60%), and says what it folded;
 *   R2  the default type-closure limit is no longer 5 (6 referenced types are all kept);
 *   E5  skeleton/budget trimming must never delete an AstSymbol declaration line.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executeSurgicalRead, getWorkspaceAstIndex } from "../src/index.js";

let passed = 0;
let failed = 0;
const roots: string[] = [];

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function run(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gf-fix-slicer-"));
  roots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

function bigClassSource(methodCount: number, bodyLines: number): { source: string; methodNames: string[] } {
  const lines: string[] = ["export class MegaService {"];
  const methodNames: string[] = [];
  for (let m = 0; m < methodCount; m++) {
    const name = `computeStage${m}`;
    methodNames.push(name);
    lines.push(`  ${name}(input: string): string {`);
    for (let b = 0; b < bodyLines; b++) {
      lines.push(`    const step${m}_${b} = input + ":${m}:${b}";`);
    }
    lines.push(`    return step${m}_${bodyLines - 1};`);
    lines.push("  }");
    lines.push("");
  }
  lines.push("}");
  lines.push("");
  return { source: lines.join("\n"), methodNames };
}

run("R1 large class becomes a signature-complete digest near the budget", () => {
  const { source, methodNames } = bigClassSource(62, 20);
  const root = workspace({ "src/mega.ts": source });
  const rawBytes = Buffer.byteLength(source, "utf8");
  const result = executeSurgicalRead({
    rootDir: root,
    targets: ["src/mega.ts#MegaService"],
    includeCallers: false,
  });

  assert(result.text.length <= rawBytes, `digest must fit the budget (${result.text.length} > ${rawBytes})`);
  assert(
    result.text.length >= rawBytes * 0.6,
    `digest must use at least 60% of the budget (${result.text.length}/${rawBytes} = ${(
      (result.text.length / rawBytes) *
      100
    ).toFixed(1)}%)`
  );
  for (const name of methodNames) {
    assert(result.text.includes(`${name}(`), `method signature ${name} must stay visible`);
  }
  assert(/\/\/ \[digest: kept \d+\/\d+ lines, bodies folded\]/.test(result.text), "digest summary marker missing");
  assert(/\{ \.\.\. \} \[\d+ lines omitted\]/.test(result.text), "per-member omission marker missing");
});

run("R2 default type closure keeps 6 referenced types (no 5-type cap)", () => {
  const typeNames = ["AlphaType", "BetaType", "GammaType", "DeltaType", "EpsilonType", "ZetaType"];
  const typeDefs = typeNames.map((name, i) => `export interface ${name} { field${i}: string }`);
  const target = typeNames.map((name, i) => `t${i}: ${name}`).join(", ");
  const source = [...typeDefs, "", `export function useAll(${target}): string {`, "  return String(t0);", "}", ""].join(
    "\n"
  );
  const root = workspace({ "src/closure.ts": source });
  const result = executeSurgicalRead({
    rootDir: root,
    targets: ["src/closure.ts#useAll"],
    includeCallers: false,
  });
  const headers = result.text.match(/\/\/ \[Type Closure\]/g) ?? [];
  assert(headers.length === 6, `expected 6 type closures, got ${headers.length}`);
  for (const name of typeNames) {
    assert(result.text.includes(`(interface ${name})`), `missing closure for ${name}`);
  }
});

run("R2 GRAPHFLOW_TYPE_CLOSURE_MAX overrides the default limit", () => {
  const typeNames = ["AOne", "BTwo", "CThree", "DFour"];
  const source = [
    ...typeNames.map((name) => `export interface ${name} { v: string }`),
    "",
    `export function pick(${typeNames.map((name, i) => `a${i}: ${name}`).join(", ")}): void {}`,
    "",
  ].join("\n");
  const root = workspace({ "src/limit.ts": source });
  const previous = process.env.GRAPHFLOW_TYPE_CLOSURE_MAX;
  try {
    process.env.GRAPHFLOW_TYPE_CLOSURE_MAX = "2";
    const result = executeSurgicalRead({
      rootDir: root,
      targets: ["src/limit.ts#pick"],
      includeCallers: false,
    });
    const headers = result.text.match(/\/\/ \[Type Closure\]/g) ?? [];
    assert(headers.length === 2, `expected 2 closures with the env cap, got ${headers.length}`);
  } finally {
    if (previous === undefined) delete process.env.GRAPHFLOW_TYPE_CLOSURE_MAX;
    else process.env.GRAPHFLOW_TYPE_CLOSURE_MAX = previous;
  }
});

run("E5 skeleton under budget pressure keeps every symbol declaration line", () => {
  const lines: string[] = ["'use strict';", ""];
  const declarations: number[] = [];
  for (let i = 0; i < 40; i++) {
    declarations.push(lines.length + 1);
    lines.push(`function helper${i}(value) {`);
    for (let b = 0; b < 18; b++) lines.push(`  const tmp${i}_${b} = value + ${b};`);
    lines.push("  return value;");
    lines.push("}");
    lines.push("");
  }
  const source = lines.join("\n");
  const root = workspace({ "lib/skeleton.js": source });
  const previous = process.env.GRAPHFLOW_READ_BUDGET_RATIO;
  try {
    process.env.GRAPHFLOW_READ_BUDGET_RATIO = "0.05";
    const result = executeSurgicalRead({
      rootDir: root,
      targets: ["lib/skeleton.js"],
      includeSkeleton: true,
      includeCallers: false,
    });
    const parsed = getWorkspaceAstIndex(root).getFileAnalysis("lib/skeleton.js");
    assert(parsed !== undefined, "fixture must be indexed");
    for (const sym of parsed!.ast.symbols) {
      assert(
        result.text.includes(`${String(sym.line).padStart(4)}: `),
        `declaration line ${sym.line} (${sym.name}) was deleted by the budget trim`
      );
    }
    assert(/lines omitted by read budget/.test(result.text), "trimmed skeleton should state its omissions");
  } finally {
    if (previous === undefined) delete process.env.GRAPHFLOW_READ_BUDGET_RATIO;
    else process.env.GRAPHFLOW_READ_BUDGET_RATIO = previous;
  }
});

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
