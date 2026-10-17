/**
 * Knowledge-graph inheritance support: a subclass receiver must reach the base
 * method when no override exists, and `super.m()` must target the base method.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildKnowledgeGraphData, getWorkspaceAstIndex } from "../src/index.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

check("TS subclass receiver and super() resolve to the base method", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-graph-inherit-"));
  try {
    write(
      root,
      "ts/inherit.ts",
      [
        "class A {",
        "  cancel(): boolean { return true; }",
        "}",
        "",
        "class B extends A {",
        "  run(): boolean {",
        "    return super.cancel();",
        "  }",
        "}",
        "",
        "function main(): boolean {",
        "  const b = new B();",
        "  return b.cancel();",
        "}",
        "",
      ].join("\n")
    );
    const graph = buildKnowledgeGraphData(getWorkspaceAstIndex(root));
    const calls = graph.edges.filter((edge) => edge.kind === "calls");
    const targets = calls.map((edge) => `${edge.source} -> ${edge.target}`);
    assert.ok(
      calls.some(
        (edge) =>
          edge.source === "sym:ts/inherit.ts#main" &&
          edge.target === "sym:ts/inherit.ts#A.cancel"
      ),
      `subclass receiver must call A.cancel; got ${targets.join(", ")}`
    );
    assert.ok(
      calls.some(
        (edge) =>
          edge.source === "sym:ts/inherit.ts#B.run" &&
          edge.target === "sym:ts/inherit.ts#A.cancel"
      ),
      `super.cancel() must call A.cancel; got ${targets.join(", ")}`
    );
    assert.ok(
      !calls.some((edge) => edge.target === "sym:ts/inherit.ts#B.cancel"),
      "B.cancel does not exist and must not be invented"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("Python subclass receiver resolves the inherited method", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-graph-inherit-py-"));
  try {
    write(
      root,
      "py/inherit.py",
      [
        "class A:",
        "    def cancel(self) -> bool:",
        "        return True",
        "",
        "class B(A):",
        "    pass",
        "",
        "def main() -> bool:",
        "    b = B()",
        "    return b.cancel()",
        "",
      ].join("\n")
    );
    const graph = buildKnowledgeGraphData(getWorkspaceAstIndex(root));
    const calls = graph.edges.filter((edge) => edge.kind === "calls");
    assert.ok(
      calls.some(
        (edge) =>
          edge.source === "sym:py/inherit.py#main" &&
          edge.target === "sym:py/inherit.py#A.cancel"
      ),
      `Python B() receiver must call A.cancel; got ${calls
        .map((edge) => `${edge.source} -> ${edge.target}`)
        .join(", ")}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
