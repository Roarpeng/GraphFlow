/**
 * Tests for P-C local task reflection (`src/task-reflector.ts`) and its CLI/MCP
 * integrations. Covers promotion after 2 uses, compiled local `.mjs` runners
 * (no LLM/network), normalized/Jaccard matching, path safety, repeated-record
 * idempotency, `graphflow task/reflect` via subprocess, and `gf_macro`
 * task-list/task-run/task-record actions with the 4-tool wire budget intact.
 *
 * Standalone: `npx tsx tests/task-reflector.test.ts`.
 * All fixtures live under `tmpdir()` and are removed afterwards.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TASK_LOG_REL_PATH,
  TASK_NEAR_MATCH_THRESHOLD,
  TASK_PROMOTION_USES,
  appendInstructionLogEntry,
  compileTask,
  findTask,
  formatHarvestReport,
  formatTaskDetails,
  formatTaskSummary,
  harvestInstructionLog,
  harvestTaskInstruction,
  instructionLogFilePath,
  jaccardSimilarity,
  listTasks,
  loadTasks,
  normalizeInstructionKey,
  recordTaskUse,
  runTask,
  taskScriptFilePath,
  taskStoreFilePath,
  tokenizeInstruction,
  type ReflectedTask,
} from "../src/task-reflector.js";
import { parseReflectArgs, parseTaskArgs } from "../src/cli.js";
import { executeV3ToolCall, V3_TOOL_DEFINITIONS } from "../src/mcp-tools.js";

const REPO_ROOT = join(__dirname, "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

const results: Array<{ name: string; ok: boolean }> = [];
const createdRoots: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`FAIL ${name}\n${detail}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

function assertThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gf-task-reflect-"));
  createdRoots.push(root);
  return root;
}

/** Cross-platform shell step that creates a marker file relative to the workspace root. */
function markerStep(file = "marker.txt", content = "ran"): string {
  return `node -e "require('node:fs').writeFileSync('${file}','${content}')"`;
}

function writeFile(root: string, relPath: string, content: string): string {
  const absolute = join(root, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return absolute;
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
  });
}

function promote(root: string, instruction: string, steps: string[] = [markerStep()]): ReflectedTask {
  recordTaskUse(root, instruction, steps);
  return recordTaskUse(root, instruction, steps);
}

function testNormalization(): void {
  check("normalization folds case, whitespace, punctuation and stopwords", () => {
    const base = normalizeInstructionKey("Create the marker file!");
    assertEqual(normalizeInstructionKey("  create   THE   marker-file!!!  "), base, "variant key");
    assertEqual(normalizeInstructionKey("ｃｒｅａｔｅ ｔｈｅ ｍａｒｋｅｒ ｆｉｌｅ"), base, "NFKC full-width");
    assert(base.length > 0, "key must not be empty");
    assert(!base.includes("the"), `stopwords must be stripped: ${base}`);
  });

  check("CJK instructions normalize punctuation/full-width variants", () => {
    const base = normalizeInstructionKey("运行测试并写标记");
    assertEqual(normalizeInstructionKey("运行测试，并写标记！"), base, "CJK punctuation");
    assertEqual(normalizeInstructionKey("运行测试 并写标记"), base, "CJK whitespace");
    assert(tokenizeInstruction("运行测试").length === 4, "CJK runs split into chars");
  });

  check("token Jaccard similarity behaves and is threshold-comparable", () => {
    assertEqual(jaccardSimilarity(["a", "b", "c"], ["a", "b", "c"]), 1, "identical sets");
    assertEqual(jaccardSimilarity(["a", "b"], ["c", "d"]), 0, "disjoint sets");
    const sevenOfEight = jaccardSimilarity(
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"],
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
    );
    assertEqual(sevenOfEight, 7 / 8, "7/8 intersection");
    assert(sevenOfEight >= TASK_NEAR_MATCH_THRESHOLD, "7/8 must clear the default threshold");
  });
}

function testPromotionAndLocalRun(): void {
  const root = makeRoot();
  const instruction = "Create the marker file for the reflection check";
  const variant = "  create THE marker-file for reflection check!!! ";

  check("first use records but does not compile", () => {
    const first = recordTaskUse(root, instruction, [markerStep()]);
    assertEqual(first.count, 1, "count");
    assertEqual(first.scriptPath, undefined, "not compiled on first use");
    assertEqual(loadTasks(root).length, 1, "one stored task");
    assert(existsSync(taskStoreFilePath(root)), "store file written");
    assert(!existsSync(taskScriptFilePath(root, first.id)), "script not created yet");
    assert(first.id.startsWith("t_"), `task id: ${first.id}`);
  });

  check("second normalized use promotes and compiles a local runner", () => {
    const second = recordTaskUse(root, variant, [markerStep()]);
    const tasks = loadTasks(root);
    assertEqual(tasks.length, 1, "normalized variants must not create a second task");
    assertEqual(second.count, TASK_PROMOTION_USES, "count after 2nd use");
    assertEqual(second.scriptPath, `.graphflow/tasks/${second.id}.mjs`, "scriptPath");
    const scriptAbs = join(root, second.scriptPath!);
    assert(existsSync(scriptAbs), "compiled runner exists");
    const script = readFileSync(scriptAbs, "utf8");
    assert(script.includes("spawnSync"), "runner executes steps via spawnSync");
    assert(!script.includes("fetch(") && !script.includes("node:http"), "runner must be local-only");
    assert(script.includes("writeFileSync"), "recorded step embedded in runner");
  });

  check("third use runs the compiled local runner (no LLM/network) and creates the marker", () => {
    const before = loadTasks(root)[0]!;
    assert(!existsSync(join(root, "marker.txt")), "marker must not exist before running");
    const run = runTask(root, instruction);
    assertEqual(run.hit, true, `expected hit, text=${run.text}`);
    assertEqual(run.exitCode, 0, `exit code, text=${run.text}`);
    assertEqual(run.taskId, before.id, "taskId");
    assertEqual(run.matchedBy, "exact", "normalized variants match exactly");
    assert(existsSync(join(root, "marker.txt")), "recorded shell step created the marker");
    assert(run.text.includes("# Reflected Task"), `text header:\n${run.text}`);
    assert(run.text.includes("local-runner"), `text must note local runner:\n${run.text}`);
    assert(run.text.includes("PASS"), `dehydrated PASS receipt:\n${run.text}`);
    assertEqual(loadTasks(root)[0]!.count, TASK_PROMOTION_USES + 1, "run counts as a use");
    assert(run.durationMs >= 0, "duration measured");
  });

  check("runTask also accepts a task id and template args", () => {
    const root2 = makeRoot();
    const argInstruction = "Write the supplied reflection argument to a file";
    const argStep = `node -e "require('node:fs').writeFileSync('arg.txt','{{arg1}}')"`;
    promote(root2, argInstruction, [argStep]);
    const run = runTask(root2, "Write the supplied reflection argument to a file", ["hello-args"]);
    assertEqual(run.hit, true, `hit: ${run.text}`);
    assertEqual(readFileSync(join(root2, "arg.txt"), "utf8"), "hello-args", "arg1 substitution");
    const byId = runTask(root2, loadTasks(root2)[0]!.id);
    assertEqual(byId.matchedBy, "id", "run by id");
    assertEqual(byId.hit, true, "by-id hit");
  });

  check("workspace-relative step cwd is honored by the local runner", () => {
    const root3 = makeRoot();
    mkdirSync(join(root3, "sub"), { recursive: true });
    const cwdInstruction = "Write the cwd marker inside a subdirectory";
    const cwdStep = `node -e "require('node:fs').writeFileSync('cwd-marker.txt','ok')"`;
    promote(root3, cwdInstruction, [{ cmd: cwdStep, cwd: "sub" }]);
    const run = runTask(root3, cwdInstruction);
    assertEqual(run.hit, true, `hit: ${run.text}`);
    assertEqual(run.exitCode, 0, `exit: ${run.text}`);
    assert(existsSync(join(root3, "sub", "cwd-marker.txt")), "step ran in the recorded cwd");
    assert(!existsSync(join(root3, "cwd-marker.txt")), "marker not written at the workspace root");
  });
}

function testMatching(): void {
  const root = makeRoot();
  const instruction = "alpha beta gamma delta epsilon zeta eta";
  promote(root, instruction, [markerStep("matched.txt")]);

  check("near-match Jaccard finds a slightly longer instruction", () => {
    const found = findTask(root, `${instruction} theta`);
    assert(found, "expected a near match");
    assertEqual(found!.score, 7 / 8, "near score");
    assert(found!.score < 1, "near match is not exact");
    const run = runTask(root, `${instruction} theta`);
    assertEqual(run.hit, true, `near-match run: ${run.text}`);
    assertEqual(run.matchedBy, "near", "matchedBy near");
    assert(existsSync(join(root, "matched.txt")), "near-matched runner executed its step");
  });

  check("configurable threshold can reject the same near match", () => {
    assertEqual(findTask(root, `${instruction} theta`, { threshold: 0.99 }), undefined, "strict threshold");
    assert(findTask(root, `${instruction} theta`, { threshold: 0.5 }), "lenient threshold matches");
  });

  check("different instructions MISS without creating files", () => {
    const miss = findTask(root, "deploy the production kubernetes cluster");
    assertEqual(miss, undefined, "unrelated instruction must miss");
    const run = runTask(root, "deploy the production kubernetes cluster");
    assertEqual(run.hit, false, "runTask records a miss");
    assertEqual(run.exitCode, 1, "miss exit code");
    assert(run.text.startsWith("MISS [no-reflected-task]"), `miss text:\n${run.text}`);
    assert(!existsSync(join(root, "deploy.txt")), "no step ran on miss");
  });

  check("list/summary/details expose stored tasks", () => {
    const tasks = listTasks(root);
    assert(tasks.length >= 1, "tasks listed");
    const summary = formatTaskSummary(tasks[0]!);
    assert(summary.includes(tasks[0]!.id) && summary.includes("uses="), `summary: ${summary}`);
    const details = formatTaskDetails(tasks[0]!);
    assert(details.includes("Steps:") && details.includes("alpha beta"), `details: ${details}`);
    assert(details.includes("Script: .graphflow/tasks/"), `details compile state: ${details}`);
  });
}

function testPathSafety(): void {
  check("instruction/id cannot escape .graphflow", () => {
    const root = makeRoot();
    const evilInstruction = "../../../../tmp/graphflow-evil escape attempt";
    recordTaskUse(root, evilInstruction, [markerStep("safe.txt")]);
    const record = recordTaskUse(root, evilInstruction, [markerStep("safe.txt")]);
    assert(/^t_[a-f0-9]{10}$/.test(record.id), `sanitized id: ${record.id}`);
    assertEqual(record.scriptPath, `.graphflow/tasks/${record.id}.mjs`, "scriptPath stays inside .graphflow/tasks");
    const scriptAbs = join(root, record.scriptPath!);
    assert(scriptAbs.startsWith(join(root, ".graphflow", "tasks")), "script under .graphflow/tasks");
    assert(!existsSync(join(root, "..", "..", "..", "tmp", "graphflow-evil")), "nothing escaped the workspace");
    const escapeRun = runTask(root, "../../../../tmp/graphflow-evil escape attempt");
    assertEqual(escapeRun.hit, true, "the recorded (hashed) task still runs locally");
    assert(existsSync(join(root, "safe.txt")), "runner executed inside the workspace");
  });

  check("unsafe step cwd and invalid ids are rejected", () => {
    const root = makeRoot();
    assertThrows(
      () => recordTaskUse(root, "escape via cwd", [{ cmd: markerStep(), cwd: "../outside" }]),
      "cwd escaping the workspace must throw"
    );
    assertThrows(
      () => recordTaskUse(root, "absolute cwd", [{ cmd: markerStep(), cwd: join(root, "src") }]),
      "absolute cwd must throw"
    );
    const unsafeRecord = {
      id: "../evil",
      instructionRaw: "x",
      instructionKey: "x",
      count: 2,
      steps: [markerStep()],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    } as ReflectedTask;
    assertThrows(() => compileTask(root, unsafeRecord), "invalid task id must throw");
    assert(!existsSync(join(root, ".graphflow", "evil.mjs")), "no script written for unsafe id");
    const miss = runTask(root, "../tasks.json");
    assertEqual(miss.hit, false, "path-like id must MISS");
  });
}

function testRepeatedRecordIdempotency(): void {
  check("repeated record calls stay idempotent (single task, single script)", () => {
    const root = makeRoot();
    const instruction = "Repeat the idempotent reflection recording";
    const steps = [markerStep("idempotent.txt")];
    const outputs = [recordTaskUse(root, instruction, steps), recordTaskUse(root, instruction, steps)];
    outputs.push(recordTaskUse(root, instruction, steps), recordTaskUse(root, instruction, steps));
    const tasks = loadTasks(root);
    assertEqual(tasks.length, 1, "one task for repeated normalized recordings");
    assertEqual(tasks[0]!.count, 4, "all uses counted");
    const scriptsDir = join(root, ".graphflow", "tasks");
    const scripts = readdirSync(scriptsDir).filter((name) => name.endsWith(".mjs"));
    assertEqual(scripts.length, 1, `exactly one compiled runner: ${scripts.join(",")}`);
    const parsed = JSON.parse(readFileSync(taskStoreFilePath(root), "utf8")) as { version: number; tasks: unknown[] };
    assertEqual(parsed.version, 1, "store version");
    assertEqual(parsed.tasks.length, 1, "store has one task");
  });
}

function testCliIntegration(): void {
  const root = makeRoot();
  const instruction = "Run the CLI reflected marker task";
  promote(root, instruction, [markerStep("cli-marker.txt")]);

  check("graphflow reflect runs the matched task via subprocess", () => {
    const result = runCli(root, ["reflect", instruction, "--json"]);
    assertEqual(result.status, 0, `reflect exit=${result.status} stderr=${result.stderr}`);
    const parsed = JSON.parse((result.stdout ?? "").trim()) as { hit: boolean; taskId: string; text: string };
    assertEqual(parsed.hit, true, "hit");
    assert(parsed.text.includes("# Reflected Task"), `text:\n${parsed.text}`);
    assert(existsSync(join(root, "cli-marker.txt")), "CLI-run task executed the recorded step");
  });

  check("graphflow reflect returns MISS for an unknown instruction", () => {
    const result = runCli(root, ["reflect", "unrelated production deployment instruction"]);
    assertEqual(result.status, 1, "MISS exit code");
    assert((result.stdout ?? "").includes("MISS [no-reflected-task]"), `stdout=${result.stdout}`);
  });

  check("graphflow task list --json shows reflected tasks", () => {
    const result = runCli(root, ["task", "list", "--json"]);
    assertEqual(result.status, 0, `list exit=${result.status} stderr=${result.stderr}`);
    const parsed = JSON.parse((result.stdout ?? "").trim()) as { tasks: Array<{ id: string; count: number }> };
    assertEqual(parsed.tasks.length, 1, "one task");
    assertEqual(parsed.tasks[0]!.count, 2 + 1, "recorded count incl. the reflect use");
  });

  check("graphflow task record + task run round-trips through the CLI", () => {
    const fresh = makeRoot();
    const cliInstruction = "Write a CLI recorded marker";
    for (let i = 0; i < 2; i += 1) {
      const recorded = runCli(fresh, [
        "task", "record", cliInstruction, "--step", markerStep("cli-record-marker.txt"),
      ]);
      assertEqual(recorded.status, 0, `record #${i + 1} stderr=${recorded.stderr}`);
    }
    const show = runCli(fresh, ["task", "show", cliInstruction]);
    assertEqual(show.status, 0, `show stderr=${show.stderr}`);
    assert((show.stdout ?? "").includes("Script: .graphflow/tasks/"), `show output=${show.stdout}`);
    const run = runCli(fresh, ["task", "run", cliInstruction, "--json"]);
    assertEqual(run.status, 0, `run stderr=${run.stderr}`);
    const parsed = JSON.parse((run.stdout ?? "").trim()) as { hit: boolean; exitCode: number };
    assertEqual(parsed.hit, true, "hit");
    assertEqual(parsed.exitCode, 0, "exit code");
    assert(existsSync(join(fresh, "cli-record-marker.txt")), "runner step executed");
  });

  check("task/reflect argv parsers keep flag values out of positionals", () => {
    const list = parseTaskArgs(["list", "--json"]);
    assertEqual(list.subcommand, "list", "list subcommand");
    assertEqual(list.json, true, "json flag");
    const record = parseTaskArgs([
      "record", "record this", "--step", "a", "--step", "b", "--args", "x", "--json",
    ]);
    assertEqual(record.instruction, "record this", "instruction");
    assertEqual(JSON.stringify(record.steps), JSON.stringify(["a", "b"]), "repeated --step");
    assertEqual(JSON.stringify(record.args), JSON.stringify(["x"]), "record args");
    const stepsAlias = parseTaskArgs(["record", "alias steps", "--steps", "c"]);
    assertEqual(JSON.stringify(stepsAlias.steps), JSON.stringify(["c"]), "--steps alias");
    const run = parseTaskArgs(["run", "t_abc123", "arg1", "--args", "arg2"]);
    assertEqual(run.target, "t_abc123", "run target");
    assertEqual(JSON.stringify(run.args), JSON.stringify(["arg1", "arg2"]), "run args");
    const reflect = parseReflectArgs(["analyze repo", "a", "b", "--json"]);
    assertEqual(reflect.instruction, "analyze repo", "reflect instruction");
    assertEqual(JSON.stringify(reflect.args), JSON.stringify(["a", "b"]), "reflect args");
    assertEqual(reflect.json, true, "reflect json");
  });
}

function testMcpIntegration(): void {
  const root = makeRoot();
  const instruction = "Run the MCP reflected marker task";
  const steps = [markerStep("mcp-marker.txt")];

  check("gf_macro task-record/task-run/task-list work through the MCP surface", () => {
    const first = executeV3ToolCall("gf_macro", {
      action: "task-record",
      instruction,
      steps,
      rootDir: root,
    }).content[0]?.text ?? "";
    assert(first.includes("OK [task-recorded]"), `first record: ${first}`);
    const second = executeV3ToolCall("gf_macro", {
      action: "task-record",
      instruction,
      steps,
      rootDir: root,
    }).content[0]?.text ?? "";
    assert(second.includes("OK [task-recorded]") && second.includes("compiled="), `second record: ${second}`);
    const list = executeV3ToolCall("gf_macro", { action: "task-list", rootDir: root }).content[0]?.text ?? "";
    assert(list.includes("# Reflected Tasks (1)"), `task-list: ${list}`);
    assert(list.includes("uses=2"), `task-list uses: ${list}`);
    const run = executeV3ToolCall("gf_macro", {
      action: "task-run",
      instruction,
      rootDir: root,
    }).content[0]?.text ?? "";
    assert(run.includes("# Reflected Task"), `task-run: ${run}`);
    assert(existsSync(join(root, "mcp-marker.txt")), "MCP-run task executed the recorded step");
    const missing = executeV3ToolCall("gf_macro", {
      action: "task-run",
      instruction: "never recorded production deployment",
      rootDir: root,
    }).content[0]?.text ?? "";
    assert(missing.startsWith("MISS [no-reflected-task]"), `mcp miss: ${missing}`);
    const bad = executeV3ToolCall("gf_macro", { action: "task-record", instruction, steps: [], rootDir: root })
      .content[0]?.text ?? "";
    assert(bad.startsWith("ERR [task-record]"), `bad record: ${bad}`);
  });

  check("the MCP surface still exposes exactly 4 tools under the 460-token wire budget", () => {
    assertEqual(V3_TOOL_DEFINITIONS.length, 4, "4 tools");
    const wireChars = JSON.stringify(V3_TOOL_DEFINITIONS).length;
    assert(wireChars < 1840, `wire chars ${wireChars} (${wireChars / 4} tokens) must stay <460 tokens`);
    const macro = V3_TOOL_DEFINITIONS.find((tool) => tool.name === "gf_macro");
    assert(macro, "gf_macro definition present");
    const actions = (macro!.inputSchema.properties.action as { enum?: string[] }).enum ?? [];
    for (const expected of ["task-list", "task-run", "task-record", "task-harvest"]) {
      assert(actions.includes(expected), `action enum must include ${expected}`);
    }
    assert("instruction" in macro!.inputSchema.properties, "instruction input property present");
  });
}

function testAutoHarvest(): void {
  function logLine(instruction: string, steps: string[] = [markerStep()]): string {
    return JSON.stringify({ instruction, steps, at: new Date().toISOString() });
  }

  check("harvest promotes repeated normalized JSONL log entries and is incremental", () => {
    const root = makeRoot();
    const instruction = "Harvest the repeated marker instruction";
    writeFile(
      root,
      TASK_LOG_REL_PATH,
      [
        logLine(instruction, [markerStep("harvest-marker.txt")]),
        logLine("  harvest THE repeated marker instruction! ", [markerStep("harvest-marker.txt")]),
      ].join("\n") + "\n"
    );
    const report = harvestInstructionLog(root);
    assertEqual(report.logPath, TASK_LOG_REL_PATH, "workspace-relative log path");
    assertEqual(report.entriesRead, 2, "complete log entries read");
    assertEqual(report.entriesInvalid, 0, "no invalid entries");
    assertEqual(report.usesRecorded, 2, "both normalized entries recorded");
    assertEqual(report.tasksPromoted.length, 1, "repeated instruction promoted");
    const tasks = loadTasks(root);
    assertEqual(tasks.length, 1, "one reflected task");
    assert(tasks[0]!.scriptPath?.startsWith(".graphflow/tasks/"), `script: ${tasks[0]!.scriptPath}`);
    const rerun = harvestInstructionLog(root);
    assertEqual(rerun.usesRecorded, 0, "incremental harvest must not double count");
    assertEqual(loadTasks(root)[0]!.count, 2, "count unchanged on re-harvest");
    const run = runTask(root, instruction);
    assertEqual(run.hit, true, `hit: ${run.text}`);
    assertEqual(run.exitCode, 0, `exit: ${run.text}`);
    assert(existsSync(join(root, "harvest-marker.txt")), "harvested runner executed its step");
    const script = readFileSync(join(root, tasks[0]!.scriptPath!), "utf8");
    assert(script.includes("spawnSync"), "runner uses spawnSync");
    assert(!script.includes("fetch(") && !script.includes("node:http"), "runner stays local-only");
  });

  check("harvestTaskInstruction appends + harvests incrementally and promotes on the 2nd use", () => {
    const root = makeRoot();
    const instruction = "Auto harvest this instruction";
    const first = harvestTaskInstruction(root, instruction, [markerStep("auto-marker.txt")]);
    assert(first.record, "first harvest returns the recorded task");
    assertEqual(first.report.entriesRead, 1, "one new line");
    assertEqual(first.report.usesRecorded, 1, "one use");
    assertEqual(first.report.tasksPromoted.length, 0, "not promoted on first use");
    assertEqual(first.record!.count, 1, "count 1");
    assertEqual(first.record!.scriptPath, undefined, "not compiled yet");
    const second = harvestTaskInstruction(root, "AUTO harvest this instruction.", [
      markerStep("auto-marker.txt"),
    ]);
    assertEqual(second.report.entriesRead, 1, "only the appended line is harvested");
    assertEqual(second.report.usesRecorded, 1, "second use recorded");
    assertEqual(second.report.tasksPromoted.length, 1, "promoted on the second normalized use");
    assertEqual(second.record!.count, 2, "count 2");
    assert(second.record!.scriptPath?.startsWith(".graphflow/tasks/"), "compiled runner");
    const summary = formatHarvestReport(second.report, second.record);
    assert(summary.includes("PASS [task-harvest]"), `summary: ${summary}`);
    assert(summary.includes("compiled="), `summary compile state: ${summary}`);
    const third = harvestInstructionLog(root);
    assertEqual(third.usesRecorded, 0, "no further uses without new lines");
    assertEqual(loadTasks(root)[0]!.count, 2, "count stays 2");
    const lines = readFileSync(join(root, TASK_LOG_REL_PATH), "utf8").trim().split("\n");
    assertEqual(lines.length, 2, "both uses appended to the JSONL log");
  });

  check("malformed log lines are skipped and incomplete trailing lines wait for a newline", () => {
    const root = makeRoot();
    const valid = logLine("Malformed line tolerant task", [markerStep("tolerant.txt")]);
    const invalidEmpty = JSON.stringify({ instruction: "", steps: [] });
    const incomplete = logLine("Incomplete trailing instruction", [markerStep("incomplete.txt")]);
    const body = `${[valid, "not json at all", invalidEmpty].join("\n")}\n${incomplete}`;
    writeFile(root, TASK_LOG_REL_PATH, body);
    const report = harvestInstructionLog(root);
    assertEqual(report.entriesRead, 3, "only complete lines are read");
    assertEqual(report.entriesInvalid, 2, "garbage + empty instruction skipped");
    assertEqual(report.usesRecorded, 1, "one valid entry recorded");
    assertEqual(loadTasks(root).length, 1, "one task from valid line");
    const stillPartial = harvestInstructionLog(root);
    assertEqual(stillPartial.entriesRead, 0, "unterminated trailing line is not consumed");
    writeFile(root, TASK_LOG_REL_PATH, `${body}\n`);
    const completed = harvestInstructionLog(root);
    assertEqual(completed.entriesRead, 1, "completed trailing line is harvested");
    assertEqual(completed.usesRecorded, 1, "trailing instruction recorded once");
    assertEqual(loadTasks(root).length, 2, "two tasks after completing the partial line");
  });

  check("instruction log paths cannot escape the workspace (custom in-workspace log works)", () => {
    const root = makeRoot();
    assertThrows(() => instructionLogFilePath(root, "../outside.jsonl"), "relative escape rejected");
    assertThrows(
      () => harvestInstructionLog(root, { logPath: "../../escape.jsonl" }),
      "harvest escape rejected"
    );
    assertThrows(
      () =>
        appendInstructionLogEntry(root, "Path safety log instruction", [markerStep()], {
          logPath: join(root, "..", "outside-log.jsonl"),
        }),
      "absolute outside log rejected"
    );
    assertThrows(
      () =>
        harvestTaskInstruction(root, "Path safety harvest instruction", [markerStep()], {
          logPath: join(root, "..", "outside-harvest.jsonl"),
        }),
      "harvestTaskInstruction escape rejected"
    );
    assert(!existsSync(join(root, "..", "outside-log.jsonl")), "no outside log file created");
    const relLog = "custom/instruction-log.jsonl";
    appendInstructionLogEntry(root, "Custom log path instruction", [markerStep("custom-marker.txt")], {
      logPath: relLog,
    });
    appendInstructionLogEntry(root, "Custom log path instruction", [markerStep("custom-marker.txt")], {
      logPath: relLog,
    });
    const report = harvestInstructionLog(root, { logPath: relLog });
    assertEqual(report.logPath, relLog, "custom workspace-relative log path");
    assertEqual(report.tasksPromoted.length, 1, "custom log promoted");
    assert(existsSync(join(root, "custom", "instruction-log.jsonl")), "custom log written in workspace");
    assert(existsSync(join(root, ".graphflow", "task-harvest.json")), "harvest state inside .graphflow");
    const run = runTask(root, "Custom log path instruction");
    assertEqual(run.hit, true, `custom log run: ${run.text}`);
    assert(existsSync(join(root, "custom-marker.txt")), "custom-log task executed locally");
  });

  check("CLI task log + task harvest round-trips into a local runner", () => {
    const root = makeRoot();
    const instruction = "CLI harvested instruction";
    const marker = "cli-harvest-marker.txt";
    for (let i = 0; i < 2; i += 1) {
      const logged = runCli(root, ["task", "log", instruction, "--step", markerStep(marker)]);
      assertEqual(logged.status, 0, `log #${i + 1} stderr=${logged.stderr}`);
      assert((logged.stdout ?? "").includes("OK [instruction-logged]"), `log stdout=${logged.stdout}`);
    }
    const harvested = runCli(root, ["task", "harvest", "--json"]);
    assertEqual(harvested.status, 0, `harvest stderr=${harvested.stderr}`);
    const report = JSON.parse((harvested.stdout ?? "").trim()) as {
      entriesRead: number;
      usesRecorded: number;
      tasksPromoted: string[];
    };
    assertEqual(report.entriesRead, 2, "CLI harvest entries");
    assertEqual(report.usesRecorded, 2, "CLI harvest uses");
    assertEqual(report.tasksPromoted.length, 1, "CLI harvest promoted");
    const listed = runCli(root, ["task", "list", "--json"]);
    assertEqual(listed.status, 0, `list stderr=${listed.stderr}`);
    const tasks = (JSON.parse((listed.stdout ?? "").trim()) as {
      tasks: Array<{ scriptPath?: string }>;
    }).tasks;
    assert(tasks[0]?.scriptPath?.startsWith(".graphflow/tasks/"), `listed script: ${tasks[0]?.scriptPath}`);
    const reflected = runCli(root, ["reflect", instruction]);
    assertEqual(reflected.status, 0, `reflect stderr=${reflected.stderr}`);
    assert(existsSync(join(root, marker)), "CLI-harvested runner executed its step");
  });

  check("gf_macro action task-harvest promotes from the log and keeps the 4-tool wire budget", () => {
    const root = makeRoot();
    const instruction = "MCP harvested instruction";
    const marker = "mcp-harvest-marker.txt";
    appendInstructionLogEntry(root, instruction, [markerStep(marker)]);
    appendInstructionLogEntry(root, instruction, [markerStep(marker)]);
    const harvestText = executeV3ToolCall("gf_macro", { action: "task-harvest", rootDir: root })
      .content[0]?.text ?? "";
    assert(harvestText.includes("PASS [task-harvest]"), `task-harvest text: ${harvestText}`);
    assert(!harvestText.includes("promoted=none"), `expected a promoted task: ${harvestText}`);
    const runText = executeV3ToolCall("gf_macro", { action: "task-run", instruction, rootDir: root })
      .content[0]?.text ?? "";
    assert(runText.includes("# Reflected Task"), `task-run text: ${runText}`);
    assert(existsSync(join(root, marker)), "MCP-harvested task executed its step");

    // MCP auto-append path: instruction + steps are logged and harvested together.
    const root2 = makeRoot();
    const appendInstruction = "MCP appended harvest instruction";
    const first = executeV3ToolCall("gf_macro", {
      action: "task-harvest",
      instruction: appendInstruction,
      steps: [markerStep("mcp-append-marker.txt")],
      rootDir: root2,
    }).content[0]?.text ?? "";
    assert(first.includes("uses=1") && first.includes("not-compiled-yet"), `first append harvest: ${first}`);
    const second = executeV3ToolCall("gf_macro", {
      action: "task-harvest",
      instruction: `  ${appendInstruction.toLowerCase()}!`,
      steps: [markerStep("mcp-append-marker.txt")],
      rootDir: root2,
    }).content[0]?.text ?? "";
    assert(second.includes("uses=2") && second.includes("compiled="), `second append harvest: ${second}`);

    assertEqual(V3_TOOL_DEFINITIONS.length, 4, "4 tools");
    const wireChars = JSON.stringify(V3_TOOL_DEFINITIONS).length;
    assert(wireChars < 1840, `wire chars ${wireChars} (${wireChars / 4} tokens) must stay <460 tokens`);
    const macro = V3_TOOL_DEFINITIONS.find((tool) => tool.name === "gf_macro");
    const actions = (macro!.inputSchema.properties.action as { enum?: string[] }).enum ?? [];
    assert(actions.includes("task-harvest"), "action enum includes task-harvest");
  });
}

function main(): void {
  try {
    testNormalization();
    testPromotionAndLocalRun();
    testMatching();
    testPathSafety();
    testRepeatedRecordIdempotency();
    testCliIntegration();
    testMcpIntegration();
    testAutoHarvest();
  } finally {
    for (const root of createdRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} task-reflector checks passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
