/**
 * Rename safety: two same-named methods in one file must not be blindly rewritten.
 * The correct outcome is a deterministic REJECTED [ambiguous-symbol] with no write.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSurgicalEdit } from "../src/index.js";

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

check("Python rename rejects same-named sibling methods instead of rewriting both", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-rename-ambig-"));
  try {
    const file = join(root, "two.py");
    const original = [
      "class A:",
      "    def cancel(self) -> bool:",
      "        return True",
      "",
      "class B:",
      "    def cancel(self) -> bool:",
      "        return False",
      "",
      "def run() -> bool:",
      "    b = B()",
      "    return b.cancel()",
      "",
    ].join("\n");
    writeFileSync(file, original, "utf8");

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "two.py",
      symbol: "cancel",
      renameTo: "cancel_v2",
    });

    assert.equal(result.ok, false, "ambiguous rename must be rejected");
    assert.match(result.text, /ambiguous-symbol/, "error must explain the ambiguity");
    assert.equal(readFileSync(file, "utf8"), original, "file must remain byte-identical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("Cross-file rename rejects a candidate module that declares the same name", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-rename-cross-"));
  try {
    const aFile = join(root, "a.py");
    const bFile = join(root, "b.py");
    const aOriginal = "class A:\n    def cancel(self) -> bool:\n        return True\n";
    const bOriginal = [
      "from a import A",
      "",
      "class B:",
      "    def cancel(self) -> bool:",
      "        return False",
      "",
      "def run() -> bool:",
      "    b = B()",
      "    return b.cancel()",
      "",
    ].join("\n");
    writeFileSync(aFile, aOriginal, "utf8");
    writeFileSync(bFile, bOriginal, "utf8");

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "a.py",
      symbol: "cancel",
      renameTo: "cancel_v2",
    });

    assert.equal(result.ok, false, "cross-file ambiguity must be rejected");
    assert.match(result.text, /ambiguous-symbol/, "error must explain the ambiguity");
    assert.equal(readFileSync(aFile, "utf8"), aOriginal, "declaration file must be untouched");
    assert.equal(readFileSync(bFile, "utf8"), bOriginal, "sibling module must be untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
