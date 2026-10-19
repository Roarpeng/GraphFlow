/**
 * `graphflow hook pre-tool` reads its payload from stdin, which is fed by an external
 * tool: the input is not under our control. `JSON.parse` accepts `null`, `[]`, `42` and
 * `"text"`, so a `payload.cwd` read on the parsed value used to throw
 * `TypeError: Cannot read properties of null (reading 'cwd')` and the hook exited
 * non-zero instead of answering `{"decision":"allow"}`.
 *
 * Standalone: `npx tsx tests/cli-hook-stdin.test.ts`
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = join(__dirname, "..");
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
const cliScript = join(repoRoot, "src", "cli.ts");
const workspace = mkdtempSync(join(tmpdir(), "gf-hook-stdin-"));

const cases: Array<{ name: string; stdin: string | null }> = [
  { name: "JavaScript null literal", stdin: "null" },
  { name: "empty array", stdin: "[]" },
  { name: "bare number", stdin: "42" },
  { name: "quoted string", stdin: '"graphflow"' },
  { name: "empty input", stdin: "" },
  { name: "malformed JSON", stdin: "{oops" },
  { name: "normal object payload", stdin: '{"cwd":"."}' },
];

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, cliScript, "hook", "pre-tool"], {
    cwd: workspace,
    input: testCase.stdin ?? "",
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });

  const problems: string[] = [];
  if (result.status !== 0) problems.push(`exit code ${result.status}`);
  if (result.stderr && /TypeError|GraphFlow CLI error/.test(result.stderr)) {
    problems.push(`stderr: ${result.stderr.trim().split(/\r?\n/)[0]}`);
  }
  let decision: unknown;
  try {
    decision = (JSON.parse(result.stdout) as { decision?: unknown }).decision;
  } catch {
    problems.push(`stdout is not JSON: ${JSON.stringify(result.stdout.slice(0, 120))}`);
  }
  if (decision !== "allow") problems.push(`decision=${JSON.stringify(decision)}`);

  if (problems.length === 0) {
    passed += 1;
    console.log(`PASS ${testCase.name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${testCase.name}: ${problems.join("; ")}`);
  }
}

rmSync(workspace, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
