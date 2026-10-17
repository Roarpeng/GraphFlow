/**
 * GraphFlow test runner — executes every `tests/*.test.ts` file in a child
 * process so one suite's `process.exit()` cannot hide the others.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const testsDir = __dirname;
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error("No tests/*.test.ts files found.");
  process.exit(1);
}

const failures: Array<{ file: string; status: number | null; signal: NodeJS.Signals | null }> = [];
const startedAt = Date.now();

for (const file of files) {
  const fullPath = join(testsDir, file);
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, ["--import", "tsx", fullPath], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    failures.push({ file, status: result.status, signal: result.signal });
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length}/${files.length} test file(s) in ${seconds}s:`);
  for (const failure of failures) {
    console.error(`  - ${failure.file} (status=${failure.status ?? "null"}, signal=${failure.signal ?? "none"})`);
  }
  process.exit(1);
}

console.log(`\nALL ${files.length} TEST FILES PASSED in ${seconds}s.`);
