import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeV3ToolCall, V3_TOOL_DEFINITIONS } from "../src/mcp-tools.js";

const root = mkdtempSync(join(tmpdir(), "gf-v4-evidence-"));
try {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export function add(x: number) { return x + 1; }\n");
  const read = (args: Record<string, unknown>) => executeV3ToolCall("gf_read", { ...args, rootDir: root }, root);
  const first = read({ targets: ["src/a.ts#add"], detail: "locate", maxOutputTokens: 80 });
  assert.ok(first.content[0]!.text.length <= 320);
  const receiptId = first.structuredContent?.receiptId as string;
  assert.match(receiptId, /^read:/);
  assert.match(read({ targets: ["src/a.ts#add"], detail: "locate", sinceReceipt: receiptId }).content[0]!.text, /UNCHANGED/);
  writeFileSync(join(root, "src", "a.ts"), "export function add(x: number) { return x + 2; }\n");
  const changed = read({ targets: ["src/a.ts#add"], detail: "code", sinceReceipt: receiptId, maxOutputTokens: 80 });
  assert.notEqual(changed.structuredContent?.receiptId, receiptId);
  assert.match(changed.content[0]!.text, /Delta|STALE|Receipt/);
  assert.ok(changed.content[0]!.text.length <= 320);
  writeFileSync(join(root, "src", "long.ts"), ["export function longTask() {", ...Array.from({ length: 40 }, (_, i) => `  const n${i} = ${i};`), "  return 1;", "}", ""].join("\n"));
  const paged = read({ targets: ["src/long.ts#longTask"], detail: "code", maxOutputTokens: 80 });
  assert.equal(paged.structuredContent?.truncated, true);
  const cursor = paged.structuredContent?.nextCursor as string;
  const next = read({ cursor, maxOutputTokens: 80 });
  assert.ok(next.content[0]!.text.length <= 320);
  assert.notEqual(next.structuredContent?.nextCursor, cursor);
  writeFileSync(join(root, "src", "long.ts"), "export function longTask() { return 2; }\n");
  assert.match(read({ cursor, maxOutputTokens: 80 }).content[0]!.text, /STALE_RECEIPT/);

  const plan = executeV3ToolCall("gf_exec", { cmd: "affected-tests", changedFiles: ["src/a.ts"], planOnly: true, rootDir: root }, root);
  assert.equal(plan.structuredContent?.coverageStatus, "UNKNOWN");
  assert.equal(plan.structuredContent?.status, "UNKNOWN");
  const noTests = executeV3ToolCall("gf_exec", { cmd: "affected-tests", changedFiles: ["src/a.ts"], run: true, rootDir: root }, root);
  assert.equal(noTests.structuredContent?.status, "NO_TESTS");

  const command = 'node -e "process.exit(7)"';
  for (let i = 0; i < 3; i++) {
    const failed = executeV3ToolCall("gf_exec", { cmd: command, run: true, changedFiles: ["src/a.ts"], rootDir: root }, root);
    assert.equal(failed.structuredContent?.status, "FAIL");
    assert.match(failed.structuredContent?.failureFingerprint as string, /^sha256:/);
  }
  const stopped = executeV3ToolCall("gf_exec", { cmd: command, run: true, changedFiles: ["src/a.ts"], rootDir: root }, root);
  assert.match(stopped.content[0]!.text, /repeated-failure/);
  const override = executeV3ToolCall("gf_exec", { cmd: command, run: true, changedFiles: ["src/a.ts"], overrideFailureStop: true,
    overrideReason: "I inspected the failing command", rootDir: root }, root);
  assert.equal(override.structuredContent?.status, "FAIL");
  const ledger = readFileSync(join(root, ".graphflow", "evidence-ledger.jsonl"), "utf8");
  assert.ok(ledger.includes("estimatedOutputTokens"));
  assert.ok(!ledger.includes(command));
  assert.ok(JSON.stringify(V3_TOOL_DEFINITIONS).length / 4 < 460);
  console.log("PASS v4 receipt, verification status, failure stop and ledger checks");
} finally {
  rmSync(root, { recursive: true, force: true });
}
