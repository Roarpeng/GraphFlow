/**
 * Rename identifier boundaries: `\b` is an ASCII word boundary, so a bare
 * `\bname\b` also matches inside `$name` (JS permits `$` in identifiers) and
 * inside non-ASCII identifiers such as `名字`. Renaming `name` must leave
 * `$name`/`名字` alone, and renaming `名字` must leave `名字后缀` alone.
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

check("Rename keeps a `$`-prefixed sibling identifier intact", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-rename-dollar-"));
  try {
    const file = join(root, "dollar.js");
    writeFileSync(
      file,
      ["const el = 1;", "const $el = 2;", "export const total = el + $el;", ""].join("\n"),
      "utf8"
    );

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "dollar.js",
      symbol: "el",
      renameTo: "count",
    });

    assert.equal(result.ok, true, `rename must succeed: ${result.text}`);
    const updated = readFileSync(file, "utf8");
    assert.match(updated, /const count = 1;/, "the plain identifier must be renamed");
    assert.match(updated, /const \$el = 2;/, "the `$el` sibling must be untouched");
    assert.match(updated, /count \+ \$el;/, "the reference to the renamed identifier must be rewritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("Rename of a non-ASCII identifier leaves the longer sibling intact", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-rename-cjk-"));
  try {
    const file = join(root, "cjk.js");
    writeFileSync(
      file,
      ["const 名字 = 1;", "const 名字后缀 = 2;", "export const 合计 = 名字 + 名字后缀;", ""].join("\n"),
      "utf8"
    );

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "cjk.js",
      symbol: "名字",
      renameTo: "昵称",
    });

    assert.equal(result.ok, true, `rename must succeed: ${result.text}`);
    const updated = readFileSync(file, "utf8");
    assert.match(updated, /const 昵称 = 1;/, "the exact identifier must be renamed");
    assert.match(updated, /const 名字后缀 = 2;/, "the longer identifier must be untouched");
    assert.match(updated, /昵称 \+ 名字后缀;/, "only the exact match inside the expression is rewritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("Rename reports the unresolvable leftover after a boundary-safe rewrite", () => {
  const root = mkdtempSync(join(tmpdir(), "gf-rename-word-"));
  try {
    const file = join(root, "plain.js");
    writeFileSync(file, ["const el = 1;", "export const $el = el;", ""].join("\n"), "utf8");

    const result = executeSurgicalEdit({
      rootDir: root,
      file: "plain.js",
      symbol: "el",
      renameTo: "count",
    });

    assert.equal(result.ok, true, `rename must succeed: ${result.text}`);
    const updated = readFileSync(file, "utf8");
    assert.equal(
      updated,
      ["const count = 1;", "export const $el = count;", ""].join("\n"),
      "whole-file rename must rewrite exactly the standalone identifier"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
