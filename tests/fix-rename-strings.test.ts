/**
 * Rename must never rewrite a string literal or an import path.
 *
 * A real-repository run renamed `combineURLs` in axios and rewrote the module
 * specifier `'../helpers/combineURLs.js'` into `'../helpers/joinURLs.js'`, which
 * breaks the import at runtime (ERR_MODULE_NOT_FOUND). Identifiers in code must
 * change; paths, comments and ordinary strings must not.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSurgicalEdit } from "../src/index.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-rename-strings-"));
  mkdirSync(join(root, "lib", "helpers"), { recursive: true });
  mkdirSync(join(root, "lib", "core"), { recursive: true });
  writeFileSync(
    join(root, "lib", "helpers", "combine.js"),
    "export default function combine(a, b) {\n  return a + b;\n}\n",
    "utf8"
  );
  writeFileSync(
    join(root, "lib", "core", "use.js"),
    [
      'import combine from "../helpers/combine.js";',
      'const label = "combine";',
      "export const total = combine(1, 2);",
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "lib", "index.js"),
    'export {default as combine} from "./helpers/combine.js";\n',
    "utf8"
  );
  return root;
}

check("rename keeps import specifiers and string literals intact", () => {
  const root = makeRepo();
  try {
    const result = executeSurgicalEdit({
      rootDir: root,
      file: "lib/helpers/combine.js",
      symbol: "combine",
      renameTo: "join",
    });
    assert.equal(result.ok, true, result.text);

    const use = readFileSync(join(root, "lib", "core", "use.js"), "utf8");
    assert.match(use, /import join from "\.\.\/helpers\/combine\.js";/, `specifier changed:\n${use}`);
    assert.match(use, /export const total = join\(1, 2\);/, "the call site must be renamed");
    assert.match(use, /const label = "combine";/, "a string literal must not be renamed");

    const barrel = readFileSync(join(root, "lib", "index.js"), "utf8");
    assert.match(
      barrel,
      /export \{default as join\} from "\.\/helpers\/combine\.js";/,
      `re-export alias must change but its path must not:\n${barrel}`
    );

    for (const file of ["use.js", "index.js"]) {
      assert.ok(
        !readFileSync(join(root, "lib", file === "use.js" ? "core" : "", file), "utf8").includes("join.js"),
        `${file}: a module path was rewritten`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("rename leaves comment mentions alone", () => {
  const root = makeRepo();
  try {
    writeFileSync(
      join(root, "lib", "core", "use.js"),
      [
        'import combine from "../helpers/combine.js";',
        "// combine is documented here",
        "export const total = combine(1, 2);",
        "",
      ].join("\n"),
      "utf8"
    );
    const result = executeSurgicalEdit({
      rootDir: root,
      file: "lib/helpers/combine.js",
      symbol: "combine",
      renameTo: "join",
    });
    assert.equal(result.ok, true, result.text);
    const use = readFileSync(join(root, "lib", "core", "use.js"), "utf8");
    assert.match(use, /\/\/ combine is documented here/, "comments are prose, not call sites");
    assert.match(use, /join\(1, 2\)/, "the real call site still changes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
