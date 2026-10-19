/**
 * GraphFlow P-C — Local Task Reflection (`src/task-reflector.ts`)
 *
 * Turns a repeated natural-language task instruction into a deterministic local
 * runner, so the 3rd identical/near-identical request executes with **zero LLM
 * turns and no network**:
 *
 *   use 1  → record `.graphflow/tasks.json` (normalized instruction key)
 *   use 2  → auto-compile `.graphflow/tasks/<id>.mjs` (shell steps only)
 *   use 3+ → `runTask()` spawns the local script via `node`, args substituted
 *
 * Deliberate limits: no LLM, no network, no arbitrary JS evaluation. Steps are
 * shell commands (optionally with a workspace-relative `cwd`) embedded in the
 * generated script as JSON data; only `{{argN}}`/`{{args}}` placeholders are
 * substituted. Scripts and the store always live under `<rootDir>/.graphflow/`.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dehydrateCommandOutput } from "./dehydrator.js";
import { isNoiseCommand } from "./macro-engine.js";
import { stemEnglishWord } from "./tokenizer.js";

/** Uses required before a reflected task is compiled into a local runner. */
export const TASK_PROMOTION_USES = 2;
/** Token-Jaccard threshold for near-match lookup (configurable per call). */
export const TASK_NEAR_MATCH_THRESHOLD = 0.86;
export const TASK_STORE_VERSION = 1;
/** Workspace-relative directory for compiled task runners. */
export const TASK_SCRIPT_DIR = ".graphflow/tasks";
/** Default JSONL log consumed by `harvestInstructionLog` (written externally). */
export const TASK_LOG_REL_PATH = ".graphflow/instruction-log.jsonl";

const TASK_STORE_REL_PATH = ".graphflow/tasks.json";
const TASK_HARVEST_STATE_REL_PATH = ".graphflow/task-harvest.json";
const TASK_RUN_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "and", "or", "in", "on", "at", "by", "with",
  "please", "then", "this", "that", "it", "is", "are", "be", "do", "my", "me", "our",
  "your", "from", "as", "into", "than",
]);

const CJK_STOP_CHARS = new Set(["的", "了", "吧", "呢", "吗", "啊", "请", "我", "你", "您"]);

const TOKEN_RE =
  /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

export interface TaskStepCommand {
  cmd: string;
  /** Workspace-relative working directory (absolute/escaping paths rejected). */
  cwd?: string;
}

export type TaskStep = string | TaskStepCommand;

export interface ReflectedTask {
  id: string;
  instructionRaw: string;
  instructionKey: string;
  count: number;
  steps: TaskStep[];
  args?: string[];
  /** Workspace-relative path of the compiled runner, once promoted. */
  scriptPath?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface TaskStoreFile {
  version: number;
  tasks: ReflectedTask[];
}

export interface RecordTaskOptions {
  args?: string[];
  /** Skip auto-compilation (tests/`--no-compile`); default true. */
  autoCompile?: boolean;
  now?: Date;
}

export interface FindTaskOptions {
  threshold?: number;
}

export interface TaskMatch {
  record: ReflectedTask;
  score: number;
}

export interface RunTaskResult {
  hit: boolean;
  text: string;
  exitCode: number;
  durationMs: number;
  taskId?: string;
  score?: number;
  matchedBy?: "id" | "exact" | "near";
}

/** One JSONL line in `.graphflow/instruction-log.jsonl`. */
export interface InstructionLogEntry {
  instruction: string;
  steps: TaskStep[];
  at: string;
}

export interface AppendInstructionLogOptions {
  /** Workspace-relative (or absolute inside the workspace) log path. */
  logPath?: string;
  now?: Date;
}

export interface HarvestInstructionLogOptions {
  /** Workspace-relative (or absolute inside the workspace) log path. */
  logPath?: string;
  /** Default true: promoted tasks compile their local runner. */
  autoCompile?: boolean;
  /** Reprocess the whole log (tests/maintenance) instead of the saved offset. */
  replay?: boolean;
  now?: Date;
}

export interface HarvestReport {
  /** Workspace-relative log path that was harvested. */
  logPath: string;
  entriesRead: number;
  entriesInvalid: number;
  usesRecorded: number;
  /** Task ids that reached the promotion threshold during this harvest. */
  tasksPromoted: string[];
}

export interface HarvestTaskResult {
  report: HarvestReport;
  record?: ReflectedTask;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Normalize an instruction into comparable tokens: NFKC (full-width → ASCII),
 * lowercase, punctuation/symbols → spaces, English stopwords removed and
 * stemmed, CJK runs split into individual characters (NFKC also folds
 * full-width/CJK punctuation before tokenization).
 */
export function tokenizeInstruction(instruction: string): string[] {
  if (typeof instruction !== "string") return [];
  const normalized = instruction
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  const tokens: string[] = [];
  for (const match of normalized.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (!token) continue;
    if (/^[a-z0-9]+$/.test(token)) {
      if (ENGLISH_STOP_WORDS.has(token)) continue;
      tokens.push(stemEnglishWord(token));
    } else if (!CJK_STOP_CHARS.has(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

/** Stable normalized key stored in `.graphflow/tasks.json`. */
export function normalizeInstructionKey(instruction: string): string {
  return tokenizeInstruction(instruction).join(" ");
}

/** Token-set Jaccard similarity in [0, 1]. */
export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function taskIdForKey(instructionKey: string): string {
  return `t_${createHash("sha256").update(instructionKey, "utf8").digest("hex").slice(0, 10)}`;
}

function isValidTaskId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function tasksDir(rootDir: string): string {
  return join(rootDir, TASK_SCRIPT_DIR);
}

/** Absolute path of the task store (tests/path-safety assertions). */
export function taskStoreFilePath(rootDir: string): string {
  return join(rootDir, TASK_STORE_REL_PATH);
}

/** Absolute path of a compiled task runner; rejects unsafe ids. */
export function taskScriptFilePath(rootDir: string, taskId: string): string {
  if (!isValidTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
  return join(tasksDir(rootDir), `${taskId}.mjs`);
}

/** Normalize/validate shell steps (strings or `{ cmd, cwd? }` objects). */
export function normalizeTaskSteps(steps: readonly TaskStep[]): TaskStep[] {
  const out: TaskStep[] = [];
  for (const step of steps) {
    if (typeof step === "string") {
      const cmd = step.trim();
      if (cmd) out.push(cmd);
      continue;
    }
    if (step && typeof step === "object" && typeof step.cmd === "string" && step.cmd.trim()) {
      const cmd = step.cmd.trim();
      const cwd = typeof step.cwd === "string" && step.cwd.trim() ? step.cwd.trim() : undefined;
      out.push(cwd ? { cmd, cwd } : { cmd });
    }
  }
  return out;
}

function assertStepCwdsAreSafe(rootDir: string, steps: TaskStep[]): void {
  const rootAbs = resolve(rootDir);
  for (const step of steps) {
    if (typeof step === "string" || step.cwd === undefined) continue;
    if (isAbsolute(step.cwd)) throw new Error(`step cwd must be workspace-relative: ${step.cwd}`);
    const absolute = resolve(rootAbs, step.cwd);
    if (absolute !== rootAbs && !absolute.startsWith(rootAbs + sep)) {
      throw new Error(`step cwd escapes the workspace: ${step.cwd}`);
    }
  }
}

function sanitizeStoredTask(raw: Record<string, unknown>): ReflectedTask | undefined {
  const id = typeof raw.id === "string" && isValidTaskId(raw.id) ? raw.id : "";
  const instructionRaw = typeof raw.instructionRaw === "string" ? raw.instructionRaw : "";
  const instructionKey = typeof raw.instructionKey === "string" ? raw.instructionKey : "";
  if (!id || !instructionRaw || !instructionKey) return undefined;
  const steps = normalizeTaskSteps(Array.isArray(raw.steps) ? (raw.steps as TaskStep[]) : []);
  if (steps.length === 0) return undefined;
  const count = typeof raw.count === "number" && Number.isFinite(raw.count)
    ? Math.max(0, Math.floor(raw.count))
    : 0;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString();
  const lastUsedAt = typeof raw.lastUsedAt === "string" ? raw.lastUsedAt : createdAt;
  const task: ReflectedTask = { id, instructionRaw, instructionKey, count, steps, createdAt, lastUsedAt };
  if (Array.isArray(raw.args)) {
    const args = raw.args.filter((arg): arg is string => typeof arg === "string");
    if (args.length > 0) task.args = args;
  }
  if (typeof raw.scriptPath === "string" && raw.scriptPath.startsWith(`${TASK_SCRIPT_DIR}/`)) {
    task.scriptPath = raw.scriptPath;
  }
  return task;
}

/** Load the reflected-task store; malformed entries are ignored, never thrown. */
export function loadTasks(rootDir: string): ReflectedTask[] {
  const storePath = taskStoreFilePath(rootDir);
  if (!existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
    const rawTasks = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as TaskStoreFile).tasks)
        ? (parsed as TaskStoreFile).tasks
        : [];
    const tasks: ReflectedTask[] = [];
    for (const raw of rawTasks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const task = sanitizeStoredTask(raw as Record<string, unknown>);
      if (task) tasks.push(task);
    }
    return tasks;
  } catch {
    return [];
  }
}

function saveTasks(rootDir: string, tasks: ReflectedTask[]): void {
  const storePath = taskStoreFilePath(rootDir);
  mkdirSync(dirname(storePath), { recursive: true });
  const payload: TaskStoreFile = { version: TASK_STORE_VERSION, tasks };
  const tmpPath = `${storePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmpPath, storePath);
}

/** Deterministic local runner source. Steps are embedded as JSON data only. */
function renderTaskRunner(steps: TaskStep[]): string {
  const embeddedSteps = steps.map((step) =>
    typeof step === "string" ? { cmd: step } : { cmd: step.cmd, ...(step.cwd ? { cwd: step.cwd } : {}) }
  );
  return (
    [
      "#!/usr/bin/env node",
      "// Generated by GraphFlow task-reflector — deterministic local task runner.",
      "// Do not edit by hand: edit .graphflow/tasks.json and re-record the instruction.",
      'import { spawnSync } from "node:child_process";',
      'import { dirname, resolve, sep } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "",
      'const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");',
      `const STEPS = ${JSON.stringify(embeddedSteps)};`,
      "const ARGS = process.argv.slice(2);",
      "const TIMEOUT_MS = 120000;",
      "",
      "function substitute(value) {",
      '  return value.replace(/\\{\\{args\\}\\}/g, ARGS.join(" ")).replace(/\\{\\{arg(\\d+)\\}\\}/g, (_match, index) => ARGS[Number(index) - 1] ?? "");',
      "}",
      "",
      "function withinRoot(target) {",
      "  return target === ROOT || target.startsWith(ROOT + sep);",
      "}",
      "",
      "let failed = false;",
      "for (let i = 0; i < STEPS.length; i += 1) {",
      "  const step = STEPS[i];",
      "  const cmd = substitute(step.cmd);",
      '  const cwd = resolve(ROOT, step.cwd ?? ".");',
      "  if (!withinRoot(cwd)) {",
      "    console.log(`ERR [unsafe-cwd] step ${i + 1}: ${cwd}`);",
      "    failed = true;",
      "    break;",
      "  }",
      "  console.log(`# step ${i + 1}/${STEPS.length}: ${cmd}`);",
      "  const result = spawnSync(cmd, {",
      "    cwd,",
      "    shell: true,",
      '    encoding: "utf8",',
      "    timeout: TIMEOUT_MS,",
      "    maxBuffer: 8 * 1024 * 1024,",
      "    windowsHide: true,",
      "  });",
      '  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;',
      "  if (output.trim().length > 0) console.log(output.trimEnd());",
      "  if (result.error) {",
      "    console.log(`ERR [step-error] ${result.error.message}`);",
      "    failed = true;",
      "    break;",
      "  }",
      "  if (result.status !== 0) {",
      "    failed = true;",
      "    break;",
      "  }",
      "}",
      "if (failed) process.exit(1);",
      'console.log(`PASS [local-task] ${STEPS.length} step(s)`);',
      "",
    ].join("\n")
  );
}

function compileTaskToStore(rootDir: string, task: ReflectedTask): string {
  if (!isValidTaskId(task.id)) throw new Error(`invalid task id: ${task.id}`);
  const scriptsDir = tasksDir(rootDir);
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = taskScriptFilePath(rootDir, task.id);
  if (!resolve(scriptPath).startsWith(resolve(scriptsDir) + sep)) {
    throw new Error("unsafe task script path");
  }
  writeFileSync(scriptPath, renderTaskRunner(task.steps), "utf8");
  task.scriptPath = `${TASK_SCRIPT_DIR}/${task.id}.mjs`;
  return task.scriptPath;
}

/**
 * Compile a task record into `.graphflow/tasks/<id>.mjs`. When the record is
 * already in the store the updated scriptPath is persisted; otherwise the
 * passed record object is updated (still written under `.graphflow/tasks/`).
 */
export function compileTask(rootDir: string, record: ReflectedTask): ReflectedTask {
  const tasks = loadTasks(rootDir);
  const stored = tasks.find((task) => task.id === record.id);
  const target = stored ?? record;
  assertStepCwdsAreSafe(rootDir, target.steps);
  compileTaskToStore(rootDir, target);
  if (stored) saveTasks(rootDir, tasks);
  return { ...target, steps: [...target.steps] };
}

/**
 * Record one use of a task instruction with its shell steps. The 2nd use
 * (normalized instruction identity) auto-compiles the local runner.
 */
export function recordTaskUse(
  rootDir: string,
  instruction: string,
  steps: readonly TaskStep[],
  opts: RecordTaskOptions = {}
): ReflectedTask {
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    throw new Error("instruction must not be empty");
  }
  const normalizedSteps = normalizeTaskSteps(steps);
  if (normalizedSteps.length === 0) {
    throw new Error("steps must not be empty (shell command strings or { cmd, cwd? } objects)");
  }
  assertStepCwdsAreSafe(rootDir, normalizedSteps);
  const instructionRaw = normalizeWhitespace(instruction);
  const instructionKey = normalizeInstructionKey(instructionRaw);
  if (!instructionKey) throw new Error("instruction has no meaningful tokens after normalization");

  const tasks = loadTasks(rootDir);
  const nowIso = (opts.now ?? new Date()).toISOString();
  let record = tasks.find((task) => task.instructionKey === instructionKey);
  if (!record) {
    record = {
      id: taskIdForKey(instructionKey),
      instructionRaw,
      instructionKey,
      count: 0,
      steps: normalizedSteps,
      createdAt: nowIso,
      lastUsedAt: nowIso,
    };
    tasks.push(record);
  }
  record.count += 1;
  record.instructionRaw = instructionRaw;
  record.steps = normalizedSteps;
  record.lastUsedAt = nowIso;
  if (opts.args && opts.args.length > 0) {
    record.args = opts.args.filter((arg): arg is string => typeof arg === "string");
  }
  if (opts.autoCompile !== false && record.count >= TASK_PROMOTION_USES) {
    compileTaskToStore(rootDir, record);
  }
  saveTasks(rootDir, tasks);
  return { ...record, steps: [...record.steps] };
}

/**
 * Best token-Jaccard against stored tasks, including scores below the near-match
 * threshold. `0` when the workspace has no comparable tasks.
 */
export function bestTaskSimilarity(rootDir: string, instruction: string): number {
  const instructionKey = normalizeInstructionKey(instruction);
  if (!instructionKey) return 0;
  const tasks = loadTasks(rootDir);
  const queryTokens = instructionKey.split(" ").filter(Boolean);
  if (queryTokens.length === 0 || tasks.length === 0) return 0;
  let bestScore = 0;
  for (const task of tasks) {
    if (task.instructionKey === instructionKey) return 1;
    const score = jaccardSimilarity(queryTokens, task.instructionKey.split(" ").filter(Boolean));
    if (score > bestScore) bestScore = score;
  }
  return bestScore;
}

/** Exact-key or token-Jaccard near-match lookup. */
export function findTask(
  rootDir: string,
  instruction: string,
  opts: FindTaskOptions = {}
): TaskMatch | undefined {
  const instructionKey = normalizeInstructionKey(instruction);
  if (!instructionKey) return undefined;
  const tasks = loadTasks(rootDir);
  const threshold = opts.threshold ?? TASK_NEAR_MATCH_THRESHOLD;
  const queryTokens = instructionKey.split(" ").filter(Boolean);
  let best: ReflectedTask | undefined;
  let bestScore = 0;
  for (const task of tasks) {
    if (task.instructionKey === instructionKey) return { record: task, score: 1 };
    const score = jaccardSimilarity(queryTokens, task.instructionKey.split(" ").filter(Boolean));
    if (score > bestScore) {
      best = task;
      bestScore = score;
    }
  }
  if (best && bestScore >= threshold) return { record: best, score: bestScore };
  return undefined;
}

/** Reflected tasks, most recently used first. */
export function listTasks(rootDir: string): ReflectedTask[] {
  return loadTasks(rootDir).sort(
    (a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || b.count - a.count
  );
}

/** One-line list entry. */
export function formatTaskSummary(task: ReflectedTask): string {
  const state = task.scriptPath
    ? "compiled"
    : `needs ${Math.max(0, TASK_PROMOTION_USES - task.count)} more use(s)`;
  return `- ${task.id} [uses=${task.count}, ${state}]: ${task.instructionRaw}`;
}

/** Multi-line `task show` entry. */
export function formatTaskDetails(task: ReflectedTask): string {
  const lines = [
    `# Reflected Task ${task.id} (uses=${task.count})`,
    `Instruction: ${task.instructionRaw}`,
    `Key: ${task.instructionKey}`,
    `Created: ${task.createdAt}`,
    `Last used: ${task.lastUsedAt}`,
    `Script: ${task.scriptPath ?? "(not compiled yet)"}`,
    "Steps:",
  ];
  task.steps.forEach((step, index) => {
    const cmd = typeof step === "string" ? step : step.cmd;
    const cwd = typeof step === "string" || !step.cwd ? "" : ` (cwd: ${step.cwd})`;
    lines.push(`  ${index + 1}. ${cmd}${cwd}`);
  });
  if (task.args && task.args.length > 0) lines.push(`Default args: ${task.args.join(" ")}`);
  return lines.join("\n");
}

function missResult(rootDir: string, instructionOrId: string, startedAt: number): RunTaskResult {
  const score = bestTaskSimilarity(rootDir, instructionOrId);
  return {
    hit: false,
    score,
    text:
      `MISS [no-reflected-task] No reflected task matched ${JSON.stringify(instructionOrId)}.\n` +
      `Record the same instruction ${TASK_PROMOTION_USES}x with its shell steps to compile a local runner, e.g.\n` +
      `  graphflow task record "<instruction>" --step "<cmd>"\n` +
      `or MCP gf_macro({ action: "task-record", instruction, steps: ["<cmd>"] }).\n` +
      `(jaccard=${score.toFixed(3)})`,
    exitCode: 1,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run a reflected task by instruction (exact/near match) or id. Compiles lazily,
 * spawns the local runner with `node`, and returns dehydrated output. Never
 * touches an LLM or the network.
 */
export function runTask(
  rootDir: string,
  instructionOrId: string,
  args: readonly string[] = []
): RunTaskResult {
  const startedAt = Date.now();
  const query = typeof instructionOrId === "string" ? instructionOrId.trim() : "";
  let record: ReflectedTask | undefined;
  let matchedBy: "id" | "exact" | "near" | undefined;
  let score: number | undefined;

  if (query) {
    if (isValidTaskId(query)) {
      const byId = loadTasks(rootDir).find((task) => task.id === query);
      if (byId) {
        record = byId;
        matchedBy = "id";
      }
    }
    if (!record) {
      const match = findTask(rootDir, query);
      if (match) {
        record = match.record;
        score = match.score;
        matchedBy = match.score >= 1 ? "exact" : "near";
      }
    }
  }

  if (!record) return missResult(rootDir, instructionOrId, startedAt);
  const matchedRecord = record;

  const compiled = compileTask(rootDir, matchedRecord);
  if (!compiled.scriptPath) {
    return {
      hit: false,
      text: `ERR [task-not-compiled] ${matchedRecord.id}: local runner could not be compiled.`,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
    };
  }
  const scriptAbs = join(rootDir, compiled.scriptPath);
  const spawnResult = spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd: rootDir,
    shell: false,
    encoding: "utf8",
    timeout: TASK_RUN_TIMEOUT_MS,
    maxBuffer: MAX_CAPTURE_BYTES,
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  const exitCode = spawnResult.status ?? (spawnResult.error ? 1 : 0);
  const stdout = spawnResult.stdout ?? "";
  const stderr = `${spawnResult.stderr ?? ""}${
    spawnResult.error ? `\n${spawnResult.error.message}` : ""
  }`;

  // Count this local execution as a use (after the spawned run).
  const tasks = loadTasks(rootDir);
  const stored = tasks.find((task) => task.id === matchedRecord.id);
  let finalRecord = matchedRecord;
  if (stored) {
    stored.count += 1;
    stored.lastUsedAt = new Date().toISOString();
    saveTasks(rootDir, tasks);
    finalRecord = stored;
  }

  const dehydrated = dehydrateCommandOutput({
    rootDir,
    command: `task ${finalRecord.id} ${finalRecord.instructionRaw.slice(0, 80)}`,
    exitCode,
    durationMs,
    stdout,
    stderr,
  });
  const matchNote =
    matchedBy === "id"
      ? "matched by id"
      : matchedBy === "near"
        ? `near match score=${(score ?? 0).toFixed(3)}`
        : "exact normalized match";
  const header =
    `# Reflected Task ${finalRecord.id} [uses=${finalRecord.count}, local-runner] ${matchNote}\n` +
    `Instruction: ${finalRecord.instructionRaw}\n\n`;
  const result: RunTaskResult = {
    hit: true,
    text: `${header}${dehydrated.text}`,
    exitCode,
    durationMs,
    taskId: finalRecord.id,
    matchedBy: matchedBy ?? "exact",
  };
  if (score !== undefined) result.score = score;
  return result;
}

// ---------------------------------------------------------------------------
// P-C2: auto-harvest of externally-written JSONL instruction logs
// ---------------------------------------------------------------------------

function isWithinWorkspace(rootAbs: string, absolutePath: string): boolean {
  return absolutePath === rootAbs || absolutePath.startsWith(rootAbs + sep);
}

/**
 * Resolve the instruction log path and keep it inside the workspace. Rejects
 * absolute paths or `../` traversal outside `rootDir` (path-safety guard).
 */
export function instructionLogFilePath(rootDir: string, logPath?: string): string {
  const rootAbs = resolve(rootDir);
  const raw = typeof logPath === "string" && logPath.trim() ? logPath.trim() : TASK_LOG_REL_PATH;
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(rootAbs, raw);
  if (!isWithinWorkspace(rootAbs, candidate)) {
    throw new Error(`instruction log must stay inside the workspace: ${raw}`);
  }
  return candidate;
}

interface HarvestStateFile {
  version: number;
  logs: Record<string, { offset: number; updatedAt?: string }>;
}

function harvestStateFilePath(rootDir: string): string {
  return join(rootDir, TASK_HARVEST_STATE_REL_PATH);
}

function loadHarvestState(rootDir: string): HarvestStateFile {
  const statePath = harvestStateFilePath(rootDir);
  if (!existsSync(statePath)) return { version: 1, logs: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, logs: {} };
    const rawLogs = (parsed as { logs?: unknown }).logs;
    const logs: Record<string, { offset: number; updatedAt?: string }> = {};
    if (rawLogs && typeof rawLogs === "object" && !Array.isArray(rawLogs)) {
      for (const [key, value] of Object.entries(rawLogs as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const offset = (value as { offset?: unknown }).offset;
        if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) continue;
        const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
        logs[key] = typeof updatedAt === "string"
          ? { offset: Math.floor(offset), updatedAt }
          : { offset: Math.floor(offset) };
      }
    }
    return { version: 1, logs };
  } catch {
    return { version: 1, logs: {} };
  }
}

function saveHarvestState(rootDir: string, state: HarvestStateFile): void {
  const statePath = harvestStateFilePath(rootDir);
  mkdirSync(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmpPath, statePath);
}

/**
 * Append one `{ instruction, steps, at }` JSON line to the local instruction
 * log (default `.graphflow/instruction-log.jsonl`). Does not harvest by itself;
 * use `harvestInstructionLog`/`harvestTaskInstruction` to promote repeats.
 */
export function appendInstructionLogEntry(
  rootDir: string,
  instruction: string,
  steps: readonly TaskStep[],
  opts: AppendInstructionLogOptions = {}
): InstructionLogEntry {
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    throw new Error("instruction must not be empty");
  }
  const normalizedSteps = normalizeTaskSteps(steps);
  if (normalizedSteps.length === 0) {
    throw new Error("steps must not be empty (shell command strings or { cmd, cwd? } objects)");
  }
  assertStepCwdsAreSafe(rootDir, normalizedSteps);
  const logAbs = instructionLogFilePath(rootDir, opts.logPath);
  mkdirSync(dirname(logAbs), { recursive: true });
  const entry: InstructionLogEntry = {
    instruction: normalizeWhitespace(instruction),
    steps: normalizedSteps,
    at: (opts.now ?? new Date()).toISOString(),
  };
  appendFileSync(logAbs, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export interface AutoLogExecutedCommandOptions {
  /** Natural-language instruction. Defaults to the command itself. */
  instruction?: string;
  /** Workspace-relative cwd stored on the step when it stays inside the workspace. */
  cwd?: string;
}

/**
 * Opt-in automatic instruction log. Callers are the `graphflow install` PostToolUse
 * hook and `gf_exec` when `run: true`. Set `GRAPHFLOW_AUTO_LOG=0` to disable.
 * A repeated identical command is harvested immediately so the second run promotes
 * a local task without an external writer. Failures are swallowed.
 */
export function autoLogExecutedCommand(
  rootDir: string,
  command: string,
  opts: AutoLogExecutedCommandOptions = {}
): void {
  try {
    if (process.env.GRAPHFLOW_AUTO_LOG === "0") return;
    const cmd = command.trim();
    if (!cmd || isNoiseCommand(cmd)) return;
    const instruction = opts.instruction?.trim() || cmd;
    const cwd = opts.cwd?.trim();
    const step: TaskStep =
      cwd && !isAbsolute(cwd) && !cwd.split(/[/\\]/).includes("..") ? { cmd, cwd } : cmd;
    appendInstructionLogEntry(rootDir, instruction, [step]);
    harvestInstructionLog(rootDir);
  } catch {
    // Logging must never break the tool or the host hook.
  }
}

/**
 * Harvest new lines from the JSONL instruction log: valid entries are recorded
 * as task uses (normalized identity), malformed/incomplete lines are skipped,
 * and repeated normalized instructions reach the promotion threshold and get a
 * compiled local runner. Incremental by byte offset stored in
 * `.graphflow/task-harvest.json`; `replay: true` reprocesses the whole log.
 * No LLM, no network; the log path must stay inside the workspace.
 */
export function harvestInstructionLog(
  rootDir: string,
  opts: HarvestInstructionLogOptions = {}
): HarvestReport {
  const rootAbs = resolve(rootDir);
  const logAbs = instructionLogFilePath(rootDir, opts.logPath);
  const logRel = relative(rootAbs, logAbs).replace(/\\/g, "/");
  const report: HarvestReport = {
    logPath: logRel,
    entriesRead: 0,
    entriesInvalid: 0,
    usesRecorded: 0,
    tasksPromoted: [],
  };
  if (!existsSync(logAbs)) return report;

  let buffer: Buffer;
  try {
    buffer = readFileSync(logAbs);
  } catch {
    return report;
  }

  const state = loadHarvestState(rootDir);
  const stored = state.logs[logRel];
  const requestedOffset = opts.replay ? 0 : stored ? stored.offset : 0;
  const startOffset =
    requestedOffset >= 0 && requestedOffset <= buffer.length ? Math.floor(requestedOffset) : 0;
  const lastNewline = buffer.lastIndexOf(0x0a);
  const completeLength = lastNewline >= 0 ? lastNewline + 1 : 0;

  if (completeLength <= startOffset) {
    if (startOffset !== requestedOffset) {
      state.logs[logRel] = { offset: startOffset, updatedAt: new Date().toISOString() };
      saveHarvestState(rootDir, state);
    }
    return report;
  }

  const segment = buffer.subarray(startOffset, completeLength).toString("utf8");
  const promoted = new Set<string>();
  for (const line of segment.split("\n")) {
    if (!line.trim()) continue;
    report.entriesRead += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      report.entriesInvalid += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      report.entriesInvalid += 1;
      continue;
    }
    const entry = parsed as { instruction?: unknown; steps?: unknown; at?: unknown };
    const instruction = typeof entry.instruction === "string" ? entry.instruction : "";
    const steps = normalizeTaskSteps(Array.isArray(entry.steps) ? (entry.steps as TaskStep[]) : []);
    if (!instruction.trim() || steps.length === 0) {
      report.entriesInvalid += 1;
      continue;
    }
    const recordOptions: RecordTaskOptions = {};
    if (opts.autoCompile === false) recordOptions.autoCompile = false;
    if (opts.now) recordOptions.now = opts.now;
    try {
      const record = recordTaskUse(rootAbs, instruction, steps, recordOptions);
      report.usesRecorded += 1;
      if (record.scriptPath && record.count >= TASK_PROMOTION_USES) promoted.add(record.id);
    } catch {
      report.entriesInvalid += 1;
    }
  }

  report.tasksPromoted = [...promoted];
  state.logs[logRel] = { offset: completeLength, updatedAt: new Date().toISOString() };
  saveHarvestState(rootDir, state);
  return report;
}

/**
 * Append one instruction use to the JSONL log and immediately harvest it. This
 * is the safe local-capture entry point for a shell wrapper / DSH skill (no
 * host hook, no daemon): every call logs `{instruction, steps, at}`, and the
 * second normalized use promotes + compiles the local runner.
 */
export function harvestTaskInstruction(
  rootDir: string,
  instruction: string,
  steps: readonly TaskStep[],
  opts: HarvestInstructionLogOptions = {}
): HarvestTaskResult {
  const logOptions: AppendInstructionLogOptions = {};
  if (opts.logPath !== undefined) logOptions.logPath = opts.logPath;
  if (opts.now !== undefined) logOptions.now = opts.now;
  const entry = appendInstructionLogEntry(rootDir, instruction, steps, logOptions);
  const report = harvestInstructionLog(rootDir, opts);
  const instructionKey = normalizeInstructionKey(entry.instruction);
  const record = loadTasks(resolve(rootDir)).find((task) => task.instructionKey === instructionKey);
  return record ? { report, record } : { report };
}

/** One-line CLI/MCP summary of a harvest report. */
export function formatHarvestReport(report: HarvestReport, record?: ReflectedTask): string {
  const promoted = report.tasksPromoted.length > 0 ? report.tasksPromoted.join(",") : "none";
  const lines = [
    `PASS [task-harvest] log=${report.logPath} entries=${report.entriesRead} ` +
      `invalid=${report.entriesInvalid} uses=${report.usesRecorded} promoted=${promoted}`,
  ];
  if (record) {
    lines.push(
      `  instruction=${JSON.stringify(record.instructionRaw)} id=${record.id} uses=${record.count} ` +
        `${record.scriptPath ? `compiled=${record.scriptPath}` : "not-compiled-yet"}`
    );
  }
  return lines.join("\n");
}
