/**
 * `resolveAffectedTests` shells out to `git status --porcelain`. Without `-z` git applies
 * `core.quotepath` and wraps every non-ASCII path in quotes with octal escapes
 * (`?? "\344\270\255..."`), so the changed file never matches the workspace index and its
 * tests are reported as unaffected — a silent no-op on Windows and for any CJK/Cyrillic
 * filename.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAffectedTests } from "../src/index.js";

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

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function withRepo(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gf-git-status-"));
  try {
    git(root, ["init", "-q"]);
    writeFileSync(join(root, "中文模块.ts"), "export const 问候 = (): string => \"你好\";\n", "utf8");
    writeFileSync(
      join(root, "中文模块.test.ts"),
      "import { 问候 } from \"./中文模块\";\nconsole.log(问候());\n",
      "utf8"
    );
    git(root, ["add", "-A"]);
    git(root, [
      "-c",
      "user.name=graphflow-test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "seed",
    ]);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

check("A modified non-ASCII source file still routes to its test", () => {
  withRepo((root) => {
    writeFileSync(
      join(root, "中文模块.ts"),
      "export const 问候 = (): string => \"你好\";\nexport const 告别 = (): string => \"再见\";\n",
      "utf8"
    );

    const result = resolveAffectedTests(root);

    assert.deepEqual(result.changedFiles, ["中文模块.ts"], "the changed file must survive the git parse");
    assert.deepEqual(result.affectedTests, ["中文模块.test.ts"], "the importing test must be routed");
  });
});

check("A renamed non-ASCII file reports only its new path", () => {
  withRepo((root) => {
    git(root, ["mv", "中文模块.ts", "重命名模块.ts"]);
    // `git mv` also rewrites the importer, which is what a real rename looks like.
    writeFileSync(
      join(root, "中文模块.test.ts"),
      "import { 问候 } from \"./重命名模块\";\nconsole.log(问候());\n",
      "utf8"
    );

    const result = resolveAffectedTests(root);

    assert.ok(
      result.changedFiles.includes("重命名模块.ts"),
      `renamed target must be reported, got ${JSON.stringify(result.changedFiles)}`
    );
    assert.ok(
      !result.changedFiles.includes("中文模块.ts"),
      `the pre-rename path must not leak into the changed set, got ${JSON.stringify(result.changedFiles)}`
    );
    assert.deepEqual(result.affectedTests, ["中文模块.test.ts"], "the importer must still be routed");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
