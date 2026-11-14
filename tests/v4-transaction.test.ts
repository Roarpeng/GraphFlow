import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { commitEditTransaction, prepareEditTransaction } from "../src/edit-transaction.js";
import { executeSurgicalEdit } from "../src/surgical-edit.js";
import { executeMacro, registerCustomMacro, runVerifiedRecipe, setMacroTrust, verifyMacroRecipe } from "../src/macro-engine.js";

const root = mkdtempSync(join(tmpdir(), "gf-v4-"));
try {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export function add(x: number) { return x + 1; }\n");
  writeFileSync(join(root, "src", "b.ts"), "import { add } from './a.js';\nexport const answer = add(1);\n");
  const original = readFileSync(join(root, "src", "a.ts"), "utf8");
  assert.equal(prepareEditTransaction(root, [{ file: "../outside.ts", before: "", after: "x" }]).status, "REJECTED");

  const blocked = executeSurgicalEdit({ rootDir: root, file: "src/a.ts", symbol: "add",
    newCode: "export function add() { return 2; }" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, "REJECTED");
  assert.equal(readFileSync(join(root, "src", "a.ts"), "utf8"), original);
  const batchContract = executeSurgicalEdit({ rootDir: root, file: "src/a.ts", edits: [
    { file: "src/a.ts", symbol: "add", newCode: "export function add() { return 2; }" },
    { file: "src/b.ts", startLine: 2, endLine: 2, newCode: "export const answer = add(1);" },
  ] });
  assert.equal(batchContract.status, "REJECTED");
  assert.equal(readFileSync(join(root, "src", "a.ts"), "utf8"), original);

  const prepared = executeSurgicalEdit({ rootDir: root, file: "src/a.ts", symbol: "add",
    newCode: "export function add(x: number) { return x + 2; }", mode: "prepare" });
  assert.equal(prepared.status, "PREPARED");
  assert.equal(readFileSync(join(root, "src", "a.ts"), "utf8"), original);
  assert.ok(prepared.proposalId);
  const committed = executeSurgicalEdit({ rootDir: root, file: "", mode: "commit", proposalId: prepared.proposalId });
  assert.equal(committed.status, "COMMITTED");
  assert.match(readFileSync(join(root, "src", "a.ts"), "utf8"), /x \+ 2/);

  const stale = executeSurgicalEdit({ rootDir: root, file: "src/a.ts", symbol: "add",
    newCode: "export function add(x: number) { return x + 3; }", mode: "prepare" });
  writeFileSync(join(root, "src", "a.ts"), "export function add(x: number) { return x + 9; }\n");
  const staleResult = executeSurgicalEdit({ rootDir: root, file: "", mode: "commit", proposalId: stale.proposalId });
  assert.equal(staleResult.status, "STALE_BASELINE");
  assert.match(readFileSync(join(root, "src", "a.ts"), "utf8"), /x \+ 9/);

  const batch = executeSurgicalEdit({ rootDir: root, file: "src/a.ts", edits: [
    { file: "src/a.ts", symbol: "add", newCode: "export function add(x: number) { return x + 4; }" },
    { file: "src/b.ts", startLine: 2, endLine: 2, newCode: "export const answer = (" },
  ] });
  assert.equal(batch.ok, false);
  assert.match(readFileSync(join(root, "src", "a.ts"), "utf8"), /x \+ 9/);

  const direct = prepareEditTransaction(root, [
    { file: "src/a.ts", before: readFileSync(join(root, "src", "a.ts"), "utf8"), after: "export const a = 1;\n" },
    { file: "src/b.ts", before: readFileSync(join(root, "src", "b.ts"), "utf8"), after: "export const b = 2;\n" },
  ]);
  const lock = join(root, ".graphflow", "edit-transactions", "commit.lock");
  mkdirSync(lock);
  assert.equal(commitEditTransaction(root, direct.proposalId!).status, "REJECTED");
  rmSync(lock, { recursive: true });
  assert.equal(commitEditTransaction(root, direct.proposalId!).status, "COMMITTED");

  const beforeA = readFileSync(join(root, "src", "a.ts"), "utf8");
  const beforeB = readFileSync(join(root, "src", "b.ts"), "utf8");
  const interrupted = prepareEditTransaction(root, [
    { file: "src/a.ts", before: beforeA, after: "export const changedA = 1;\n" },
    { file: "src/b.ts", before: beforeB, after: "export const changedB = 2;\n" },
  ]);
  const recovered = commitEditTransaction(root, interrupted.proposalId!, {
    beforeWrite: (_file, index) => { if (index === 1) throw new Error("injected disk failure"); },
  });
  assert.equal(recovered.status, "RECOVERABLE_FAILURE");
  assert.equal(readFileSync(join(root, "src", "a.ts"), "utf8"), beforeA);
  assert.equal(readFileSync(join(root, "src", "b.ts"), "utf8"), beforeB);

  const macro = registerCustomMacro(root, { id: "test_macro", name: "test", kind: "command-template",
    steps: ["node -e {{arg1}}"] });
  assert.equal(executeMacro(root, macro.id, ["console.log('ok')"]).ok, false);
  assert.equal(setMacroTrust(root, macro.id, "approve")?.state, "approved");
  assert.equal(setMacroTrust(root, macro.id, "activate")?.state, "active");
  assert.equal(executeMacro(root, macro.id, ["console.log('ok');process.exit(0)"]).ok, false);
  assert.equal(executeMacro(root, macro.id, ["console.log('ok')"]).ok, true);
  writeFileSync(join(root, "verify.test.js"), "const test = require('node:test'); test('ok', () => {});\n");
  assert.equal(verifyMacroRecipe(root, macro.id, "node --test verify.test.js").ok, true);
  assert.equal(runVerifiedRecipe(root, macro.id, ["console.log('ok')"]).ok, true);
  const runner = spawnSync(process.execPath, [join(root, macro.scriptPath!)], { encoding: "utf8" });
  assert.notEqual(runner.status, 0);
  assert.match(runner.stderr, /macro-runner/);
  writeFileSync(join(root, "package.json"), '{"version":"2"}');
  assert.equal(runVerifiedRecipe(root, macro.id, ["console.log('ok')"]).ok, false);
  assert.equal(executeMacro(root, macro.id, ["console.log('ok')"]).ok, false);
  assert.equal(setMacroTrust(root, macro.id, "revoke")?.state, "revoked");
  assert.ok(existsSync(join(root, ".graphflow", "macros.json")));
  console.log("PASS v4 transaction, conflict, guard and macro trust checks");
} finally {
  rmSync(root, { recursive: true, force: true });
}
