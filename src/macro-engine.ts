/**
 * GraphFlow 3.0 — Pillar 4: User Habit Memory & Auto-Compiled Macro Engine (`macro-engine.ts`)
 *
 * Principle 4: "根据用户习惯来记忆生成工具，以后直接干"
 * (Learn from the user's coding/testing/editing habits and compile recurring
 * patterns into parameterized, deterministic local tools with explicit trust states).
 *
 * Four genuine Habit-to-Tool mechanisms:
 *   1. Exact & Co-Access Context Bundles (`context-bundle`): Repeatedly read symbol/file
 *      clusters auto-compile into 1-step slice bundles.
 *   2. Exact Command Pipelines (`command-pipeline`): Repeated multi-step command sequences
 *      auto-compile into `.graphflow/macros/<id>.mjs` scripts.
 *   3. Parameterized Command Template Learning (`command-template`): Abstracts variable
 *      arguments (file paths, test names, flags) from similar commands (e.g.
 *      `npx vitest run tests/a.test.ts` + `npx vitest run tests/b.test.ts` ->
 *      template `npx vitest run {{arg1}}`) so habits are learned even when parameters vary!
 *   4. Co-Edit & Post-Edit Verification Habit Profiler (`UserHabitProfile`):
 *      - Tracks **Co-Edited File Pairs**: If editing file A is repeatedly followed by
 *        editing file B in the same session, remembers `A <-> B` and warns/pre-hints
 *        whenever A is edited alone!
 *      - Tracks **Directory Verify Habits**: If editing files in `src/surfaces/*` is
 *        repeatedly followed by running `node scripts/sync-surfaces.cjs --check`,
 *        binds that verification command to `src/surfaces` and suggests it after edits.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dehydrateCommandOutput } from "./dehydrator.js";
import { ensureGraphflowDir } from "./graphflow-dir.js";
import { mineGitCoChangeHistory, type GitMineOptions } from "./git-miner.js";
import { executeSurgicalRead, getWorkspaceAstIndex } from "./slicer.js";
import { executeSurgicalEdit } from "./surgical-edit.js";

export type TrajectoryActionKind = "read" | "edit" | "exec";

export interface TrajectoryEvent {
  ts: string;
  sessionId: string;
  kind: TrajectoryActionKind;
  key: string;
  items: string[];
  ok: boolean;
  /** Optional token-savings telemetry attached by the host interceptor. */
  tokensSaved?: number;
}

export type MacroKind = "context-bundle" | "command-pipeline" | "command-template" | "edit-codemod";

export interface CompiledMacro {
  id: string;
  name: string;
  kind: MacroKind;
  description: string;
  /**
   * For `context-bundle`: list of `file#symbol` or `file` targets.
   * For `command-pipeline`: ordered shell commands.
   * For `command-template`: single parameterized command string with `{{arg1}}`, `{{arg2}}`.
   */
  steps: string[];
  triggers: string[];
  occurrences: number;
  createdAt: string;
  lastUsedAt?: string;
  scriptPath?: string;
  state?: "discovered" | "proposed" | "approved" | "active" | "revoked";
  permissions?: Array<"read-only" | "writes-files" | "process-start" | "external-network">;
  sourceHash?: string;
  autoRun?: boolean;
  verifiedRecipe?: {
    sourceHash: string;
    verifiedAt: string;
    verificationCommand: string;
    permissions: NonNullable<CompiledMacro["permissions"]>;
    version: string;
  };
}

function macroSourceHash(rootDir: string, macro: CompiledMacro): string {
  const packagePath = join(rootDir, "package.json");
  const packageHash = existsSync(packagePath) ? shortHash(readFileSync(packagePath, "utf8")) : "none";
  let revision = "no-git";
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { /* workspace without git */ }
  return shortHash(JSON.stringify([macro.kind, macro.steps, packageHash, revision]));
}

function macroPermissions(macro: CompiledMacro): NonNullable<CompiledMacro["permissions"]> {
  if (macro.kind === "context-bundle") return ["read-only"];
  if (macro.kind === "edit-codemod") return ["writes-files"];
  const commands = macro.steps.join(" ");
  return /\b(?:curl|wget|ssh|scp|ftp|http|fetch)\b/i.test(commands)
    ? ["process-start", "external-network"] : ["process-start"];
}

export function setMacroTrust(rootDir: string, id: string, action: "propose" | "approve" | "activate" | "revoke", autoRun = false): CompiledMacro | undefined {
  const { macros, habits } = loadMacroStore(rootDir);
  const macro = macros.find((m) => m.id === id);
  if (!macro) return undefined;
  if (action === "revoke") { macro.state = "revoked"; macro.autoRun = false; }
  else if (action === "propose") {
    if (macro.state && macro.state !== "discovered") return undefined;
    macro.state = "proposed";
  }
  else if (action === "approve") {
    if (macro.state !== "proposed") return undefined;
    macro.state = "approved";
    macro.permissions = macroPermissions(macro);
    macro.sourceHash = macroSourceHash(rootDir, macro);
    macro.autoRun = autoRun && macro.permissions.length === 1 && macro.permissions[0] === "read-only";
  } else if (macro.state === "approved" && macro.sourceHash === macroSourceHash(rootDir, macro)) {
    macro.state = "active";
  } else return undefined;
  saveMacros(rootDir, macros, habits);
  return macro;
}

function projectVersion(rootDir: string): string {
  try { return String(JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version ?? "unknown"); }
  catch { return "unknown"; }
}

const VERIFY_COMMAND_RE = /^(?:npm\s+(?:test|run\s+(?:test|build|check|lint))|npx\s+(?:tsc|vitest|jest)|node\s+--test|pytest|go\s+test|cargo\s+test|dotnet\s+test|ctest)\b/i;

export function verifyMacroRecipe(rootDir: string, id: string, verificationCommand: string): { ok: boolean; text: string } {
  const { macros, habits } = loadMacroStore(rootDir);
  const macro = macros.find((m) => m.id === id);
  if (!macro || macro.state !== "active" || macro.sourceHash !== macroSourceHash(rootDir, macro))
    return { ok: false, text: `REJECTED [recipe-inactive] ${id}` };
  if (!VERIFY_COMMAND_RE.test(verificationCommand) || !safeArgv(verificationCommand))
    return { ok: false, text: "REJECTED [recipe-verifier] use a test/build/check command without shell operators." };
  const outcome = runSafeCommand(rootDir, verificationCommand);
  if (!outcome.ok) {
    delete macro.verifiedRecipe;
    saveMacros(rootDir, macros, habits);
    return { ok: false, text: `FAIL [recipe-verification] ${outcome.text}` };
  }
  macro.verifiedRecipe = { sourceHash: macro.sourceHash, verifiedAt: new Date().toISOString(),
    verificationCommand, permissions: macro.permissions ?? macroPermissions(macro), version: projectVersion(rootDir) };
  saveMacros(rootDir, macros, habits);
  return { ok: true, text: `PASS [verified-recipe ${id}] source=${macro.sourceHash} version=${macro.verifiedRecipe.version} verifier=${verificationCommand}` };
}

export function runVerifiedRecipe(rootDir: string, id: string, args: string[] = []): { ok: boolean; text: string } {
  const { macros } = loadMacroStore(rootDir);
  const macro = macros.find((m) => m.id === id);
  const recipe = macro?.verifiedRecipe;
  if (!macro || !recipe || macro.state !== "active" || recipe.sourceHash !== macroSourceHash(rootDir, macro) ||
      recipe.version !== projectVersion(rootDir))
    return { ok: false, text: `REJECTED [stale-recipe] ${id}; verify current workspace version first.` };
  const run = executeMacro(rootDir, id, args);
  if (!run.ok) return run;
  const verify = runSafeCommand(rootDir, recipe.verificationCommand);
  if (!verify.ok) {
    const refreshed = loadMacroStore(rootDir);
    const current = refreshed.macros.find((m) => m.id === id);
    if (current) { delete current.verifiedRecipe; current.state = "approved"; saveMacros(rootDir, refreshed.macros, refreshed.habits); }
    return { ok: false, text: `FAIL [recipe-invalidated ${id}] ${verify.text}` };
  }
  return { ok: true, text: `${run.text}\nPASS [recipe-reverified ${id}] ${verify.text}` };
}

/** Parse a recorded command into argv. Shell operators and substituted snippets are refused. */
function safeArgv(command: string): string[] | undefined {
  if (/[;&|<>`$\r\n]/.test(command)) return undefined;
  const tokens = command.match(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)+/g) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => token.replace(/^(["'])(.*)\1$/, "$2"));
}

function runSafeCommand(rootDir: string, command: string) {
  const argv = safeArgv(command);
  if (!argv) return { ok: false, durationMs: 0, rawEstimatedTokens: 0, text: "REJECTED [unsafe-command] shell metacharacters are not allowed in macros." };
  const started = Date.now();
  let executable = argv[0]!;
  let args = argv.slice(1);
  if (process.platform === "win32" && (executable === "npm" || executable === "npx")) {
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", `${executable}-cli.js`);
    if (!existsSync(cli)) return { ok: false, durationMs: 0, rawEstimatedTokens: 0, text: `REJECTED [missing-executable] ${cli}` };
    args = [cli, ...args];
    executable = process.execPath;
  }
  const proc = spawnSync(executable, args, { cwd: rootDir, shell: false, encoding: "utf8", timeout: 600_000 });
  return dehydrateCommandOutput({ rootDir, command, exitCode: proc.status ?? 1, durationMs: Date.now() - started,
    stdout: proc.stdout ?? "", stderr: (proc.stderr ?? "") + (proc.error ? `\n${proc.error.message}` : "") });
}

export interface CoEditHabit {
  fileA: string;
  fileB: string;
  coEditCount: number;
  /** Coupling confidence 0..1 (coEdits / total commits touching either side). */
  confidence?: number;
}

export interface DirectoryVerifyHabit {
  dirPrefix: string;
  command: string;
  count: number;
}

export interface UserHabitProfile {
  coEdits: CoEditHabit[];
  dirVerifyCommands: DirectoryVerifyHabit[];
}

interface MacroStoreFile {
  version: "3.0" | "3.1";
  macros: CompiledMacro[];
  habits?: UserHabitProfile;
  gitMinedAt?: string;
}

function trajectoryFilePath(rootDir: string): string {
  return join(rootDir, ".graphflow", "trajectories.jsonl");
}

function macroStoreFilePath(rootDir: string): string {
  return join(rootDir, ".graphflow", "macros.json");
}

function macroScriptsDir(rootDir: string): string {
  return join(rootDir, ".graphflow", "macros");
}

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

export function loadTrajectoryEvents(rootDir: string): TrajectoryEvent[] {
  const path = trajectoryFilePath(rootDir);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TrajectoryEvent);
  } catch {
    return [];
  }
}

export function loadMacroStore(rootDir: string): { macros: CompiledMacro[]; habits: UserHabitProfile } {
  const path = macroStoreFilePath(rootDir);
  const emptyHabits: UserHabitProfile = { coEdits: [], dirVerifyCommands: [] };
  if (!existsSync(path)) return { macros: [], habits: emptyHabits };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MacroStoreFile>;
    return {
      macros: Array.isArray(parsed.macros) ? parsed.macros : [],
      habits: {
        coEdits: Array.isArray(parsed.habits?.coEdits) ? parsed.habits!.coEdits : [],
        dirVerifyCommands: Array.isArray(parsed.habits?.dirVerifyCommands)
          ? parsed.habits!.dirVerifyCommands
          : [],
      },
    };
  } catch {
    return { macros: [], habits: emptyHabits };
  }
}

export function loadMacros(rootDir: string): CompiledMacro[] {
  return loadMacroStore(rootDir).macros;
}

export function loadUserHabits(rootDir: string): UserHabitProfile {
  return loadMacroStore(rootDir).habits;
}

export function saveMacros(
  rootDir: string,
  macros: CompiledMacro[],
  habits?: UserHabitProfile
): void {
  const path = macroStoreFilePath(rootDir);
  const current = loadMacroStore(rootDir);
  ensureGraphflowDir(rootDir);
  const payload: MacroStoreFile = {
    version: "3.0",
    macros,
    habits: habits ?? current.habits,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
}

function writeStandaloneMacroScript(rootDir: string, macro: CompiledMacro): string {
  const dir = macroScriptsDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const safeFile = `${macro.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.mjs`;
  const relScriptPath = `.graphflow/macros/${safeFile}`;
  const absScriptPath = join(rootDir, relScriptPath);
  // Generated runners are informational. Execution must pass the live trust and
  // edit transaction gates in executeMacro, including after a macro is revoked.
  const message = macro.kind === "context-bundle"
    ? `Context bundle macro ${macro.id}: ${macro.steps.join(", ")}`
    : `REJECTED [macro-runner] Use gf_macro(action="run", id="${macro.id}") so approval and transaction guards apply.`;
  const exitCode = macro.kind === "context-bundle" ? 0 : 1;
  writeFileSync(absScriptPath,
    `#!/usr/bin/env node\n${exitCode ? "console.error" : "console.log"}(${JSON.stringify(message)});\nprocess.exitCode = ${exitCode};\n`, "utf8");
  try { chmodSync(absScriptPath, 0o755); } catch { /* optional */ }
  return relScriptPath;
}

/**
 * Abstract variable file paths or arguments in a shell command into a normalized
 * skeleton (`{{arg1}}`) so commands like `npx vitest run tests/a.test.ts` and
 * `npx vitest run tests/b.test.ts` are recognized as the same user habit!
 */
export function extractCommandTemplate(cmd: string): {
  template: string;
  hasParams: boolean;
  exampleArgs: string[];
} {
  const tokens = cmd.trim().split(/\s+/);
  if (tokens.length < 2) {
    return { template: cmd.trim(), hasParams: false, exampleArgs: [] };
  }
  const exampleArgs: string[] = [];
  let argIdx = 0;
  const mapped = tokens.map((tok, idx) => {
    if (idx === 0) return tok; // command binary stays literal
    // Recognize file paths (containing `/` or ending with code/test extensions) as template parameters
    if (
      (tok.includes("/") || /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|c|h|cc|cpp|hpp|cxx|hxx|cs|json|md)$/.test(tok)) &&
      !tok.startsWith("-") &&
      !tok.startsWith("scripts/") // scripts/foo.cjs is usually the tool runner itself
    ) {
      argIdx += 1;
      exampleArgs.push(tok);
      return `{{arg${argIdx}}}`;
    }
    return tok;
  });

  return {
    template: mapped.join(" "),
    hasParams: argIdx > 0,
    exampleArgs,
  };
}

/**
 * One-off inspection commands are not habits. Recording them would pollute the
 * capped (500-event) trajectory log and evict real signal, so they are dropped
 * at the single choke point every recorder funnels through.
 */
const NOISE_CMD_RE =
  /^(cd|ls|dir|pwd|echo|cat|type|which|where|head|tail|wc|tree|file|stat|open|code|less|more|true|false|exit|set|export|source)\b/i;
const NOISE_GIT_RE =
  /^git\s+(status|log|diff|branch|show|rev-parse|config|add|commit|restore|stash)\b/i;

export function isNoiseCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return NOISE_CMD_RE.test(trimmed) || NOISE_GIT_RE.test(trimmed);
}

export function recordTrajectoryAndMine(
  rootDir: string,
  event: Omit<TrajectoryEvent, "ts"> & { ts?: string },
  minOccurrences = 2
): { recorded: TrajectoryEvent; newlyCompiled: CompiledMacro[]; habits: UserHabitProfile } {
  const fullEvent: TrajectoryEvent = {
    ts: event.ts ?? new Date().toISOString(),
    sessionId: event.sessionId,
    kind: event.kind,
    key: event.key,
    items: event.items,
    ok: event.ok,
  };

  // Noise exec commands are never persisted — no macro or habit may ever be
  // compiled from them.
  if (event.kind === "exec" && isNoiseCommand(event.key)) {
    return { recorded: fullEvent, newlyCompiled: [], habits: loadUserHabits(rootDir) };
  }

  ensureGraphflowDir(rootDir);
  const path = trajectoryFilePath(rootDir);
  const existing = loadTrajectoryEvents(rootDir);
  const updated = [...existing.slice(-499), fullEvent];
  writeFileSync(path, updated.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  const newlyCompiled = mineAndCompileMacros(rootDir, updated, minOccurrences);
  const habits = loadUserHabits(rootDir);
  return { recorded: fullEvent, newlyCompiled, habits };
}

/**
 * Mine both deterministic Macros AND User Habits (Co-Edit files, Parameterized Command
 * Templates, and Directory->Verify bindings) from the trajectory history.
 */
export function mineAndCompileMacros(
  rootDir: string,
  events?: TrajectoryEvent[],
  minOccurrences = 2
): CompiledMacro[] {
  const history = events ?? loadTrajectoryEvents(rootDir);
  const { macros: existingMacros } = loadMacroStore(rootDir);
  const macrosById = new Map(existingMacros.map((m) => [m.id, m]));
  const newlyCompiled: CompiledMacro[] = [];

  // ── 1. Mine `context-bundle` patterns (repeated multi-symbol/file reads) ──
  const readBundleCounts = new Map<string, { items: string[]; count: number }>();

  for (const ev of history) {
    if (ev.kind === "read" && ev.ok && ev.items.length >= 2) {
      const sorted = [...new Set(ev.items)].sort();
      const key = sorted.join("||");
      const entry = readBundleCounts.get(key) ?? { items: sorted, count: 0 };
      entry.count += 1;
      readBundleCounts.set(key, entry);
    }
  }

  for (let i = 0; i + 1 < history.length; i++) {
    const a = history[i]!;
    const b = history[i + 1]!;
    if (a.sessionId === b.sessionId && a.kind === "read" && b.kind === "read" && a.ok && b.ok) {
      const combined = [...new Set([...a.items, ...b.items])];
      if (combined.length >= 2 && combined.length <= 6) {
        const sorted = combined.sort();
        const key = sorted.join("||");
        const entry = readBundleCounts.get(key) ?? { items: sorted, count: 0 };
        entry.count += 1;
        readBundleCounts.set(key, entry);
      }
    }
  }

  for (const [, bundle] of readBundleCounts) {
    if (bundle.count < minOccurrences) continue;
    const id = `bundle_${shortHash(bundle.items.join("|"))}`;
    const existing = macrosById.get(id);
    if (existing) {
      existing.occurrences = Math.max(existing.occurrences, bundle.count);
      continue;
    }
    const triggers = bundle.items.flatMap((item) => {
      const parts = item.split("#");
      return parts.length === 2 ? [parts[0]!, parts[1]!, item] : [item];
    });
    const macro: CompiledMacro = {
      id,
      name: `Context Bundle (${bundle.items.length} targets)`,
      kind: "context-bundle",
      description: `One-shot surgical slice of ${bundle.items.join(" + ")}`,
      steps: bundle.items,
      triggers: [...new Set(triggers)],
      occurrences: bundle.count,
      createdAt: new Date().toISOString(),
    };
    macro.scriptPath = writeStandaloneMacroScript(rootDir, macro);
    macrosById.set(id, macro);
    newlyCompiled.push(macro);
  }

  // ── 2. Mine `command-pipeline` patterns (`exec -> exec` pairs in per-session exec order) ──
  // Pairs are counted over the per-session exec subsequence, not raw adjacency:
  // a read/edit interleaved between two execs no longer hides the pair.
  const execEvents = history.filter((ev) => ev.kind === "exec" && ev.ok && ev.items[0]);
  const execPipelineCounts = new Map<string, { cmds: string[]; count: number }>();
  for (let i = 0; i + 1 < execEvents.length; i++) {
    const a = execEvents[i]!;
    const b = execEvents[i + 1]!;
    const aCmd = a.items[0]!;
    const bCmd = b.items[0]!;
    if (a.sessionId === b.sessionId && aCmd !== bCmd) {
      const cmds = [aCmd, bCmd];
      const key = cmds.join(" && ");
      const entry = execPipelineCounts.get(key) ?? { cmds, count: 0 };
      entry.count += 1;
      execPipelineCounts.set(key, entry);
    }
  }
  const singleCmdCounts = new Map<string, { cmd: string; count: number }>();
  for (const ev of execEvents) {
    const entry = singleCmdCounts.get(ev.items[0]!) ?? { cmd: ev.items[0]!, count: 0 };
    entry.count += 1;
    singleCmdCounts.set(ev.items[0]!, entry);
  }

  for (const [, pipe] of execPipelineCounts) {
    if (pipe.count < minOccurrences) continue;
    const id = `pipe_${shortHash(pipe.cmds.join("&&"))}`;
    const existing = macrosById.get(id);
    if (existing) {
      existing.occurrences = Math.max(existing.occurrences, pipe.count);
      continue;
    }
    const macro: CompiledMacro = {
      id,
      name: `Command Pipeline (${pipe.cmds.length} steps)`,
      kind: "command-pipeline",
      description: `Run [${pipe.cmds.join(" -> ")}] locally with dehydrated output`,
      steps: pipe.cmds,
      triggers: pipe.cmds,
      occurrences: pipe.count,
      createdAt: new Date().toISOString(),
    };
    macro.scriptPath = writeStandaloneMacroScript(rootDir, macro);
    macrosById.set(id, macro);
    newlyCompiled.push(macro);
  }

  // A single FIXED command repeated N times is itself a habit. Without this rule
  // such commands fell through BOTH the >=2-step pipeline rule and the
  // parameterized-template rule (which requires varying args), so launch/dev
  // commands like `python tools/devctl.py up gateway` never compiled.
  for (const [, single] of singleCmdCounts) {
    const needsStrongerSignal = extractCommandTemplate(single.cmd).hasParams;
    if (single.count < (needsStrongerSignal ? minOccurrences + 1 : minOccurrences)) continue;
    const alreadyCovered = Array.from(macrosById.values()).some(
      (m) => m.kind === "command-pipeline" && m.steps.includes(single.cmd)
    );
    if (alreadyCovered) continue;
    const id = `pipe_${shortHash(single.cmd)}`;
    const existing = macrosById.get(id);
    if (existing) {
      existing.occurrences = Math.max(existing.occurrences, single.count);
      continue;
    }
    const macro: CompiledMacro = {
      id,
      name: `Command Pipeline (1 step, ${single.count}x habit)`,
      kind: "command-pipeline",
      description: `Run [${single.cmd}] locally with dehydrated output`,
      steps: [single.cmd],
      triggers: [single.cmd],
      occurrences: single.count,
      createdAt: new Date().toISOString(),
    };
    macro.scriptPath = writeStandaloneMacroScript(rootDir, macro);
    macrosById.set(id, macro);
    newlyCompiled.push(macro);
  }

  // ── 3. Mine Parameterized Command Templates (`command-template`) ──
  const templateCounts = new Map<string, { template: string; distinctCmds: Set<string>; count: number }>();
  for (const ev of history) {
    if (ev.kind === "exec" && ev.ok && ev.items[0]) {
      const extracted = extractCommandTemplate(ev.items[0]);
      if (!extracted.hasParams) continue;
      const entry = templateCounts.get(extracted.template) ?? {
        template: extracted.template,
        distinctCmds: new Set<string>(),
        count: 0,
      };
      entry.distinctCmds.add(ev.items[0]);
      entry.count += 1;
      templateCounts.set(extracted.template, entry);
    }
  }

  for (const [, tpl] of templateCounts) {
    // Promote when seen >= minOccurrences times across at least 2 distinct argument invocations
    if (tpl.count < minOccurrences || tpl.distinctCmds.size < 2) continue;
    const id = `tpl_${shortHash(tpl.template)}`;
    const existing = macrosById.get(id);
    if (existing) {
      existing.occurrences = Math.max(existing.occurrences, tpl.count);
      continue;
    }
    const macro: CompiledMacro = {
      id,
      name: `Parameterized Tool (${tpl.template})`,
      kind: "command-template",
      description: `Parameterized command habit: '${tpl.template}' (pass args=[...])`,
      steps: [tpl.template],
      triggers: [tpl.template.split(" ")[0] ?? tpl.template],
      occurrences: tpl.count,
      createdAt: new Date().toISOString(),
    };
    macro.scriptPath = writeStandaloneMacroScript(rootDir, macro);
    macrosById.set(id, macro);
    newlyCompiled.push(macro);
  }

  // ── 4. Mine User Habits: Co-Edit File Pairs & Directory->Verify Command Bindings ──
  const coEditCounts = new Map<string, { fileA: string; fileB: string; count: number }>();
  const dirVerifyCounts = new Map<string, { dirPrefix: string; command: string; count: number }>();

  // Pairs are counted over the edit/exec subsequence per session, not raw
  // adjacency — an interleaved read no longer hides a real edit->exec habit.
  const editExecEvents = history.filter((ev) => (ev.kind === "edit" || ev.kind === "exec") && ev.ok);
  for (let i = 0; i + 1 < editExecEvents.length; i++) {
    const a = editExecEvents[i]!;
    const b = editExecEvents[i + 1]!;
    if (a.sessionId !== b.sessionId) continue;

    // Habit A: Co-Edited Files (`edit A -> edit B`)
    if (a.kind === "edit" && b.kind === "edit") {
      const fileA = (a.items[0] ?? "").split("#")[0]!;
      const fileB = (b.items[0] ?? "").split("#")[0]!;
      if (fileA && fileB && fileA !== fileB) {
        const [first, second] = [fileA, fileB].sort() as [string, string];
        const key = `${first}||${second}`;
        const entry = coEditCounts.get(key) ?? { fileA: first, fileB: second, count: 0 };
        entry.count += 1;
        coEditCounts.set(key, entry);
      }
    }

    // Habit B: Post-Edit Verification Command (`edit in dir D -> exec cmd C`)
    if (a.kind === "edit" && b.kind === "exec" && b.items[0]) {
      const editedFile = (a.items[0] ?? "").split("#")[0]!;
      const dirPrefix = dirname(editedFile).replace(/\\/g, "/");
      const cmd = b.items[0];
      if (dirPrefix && dirPrefix !== ".") {
        const key = `${dirPrefix}||${cmd}`;
        const entry = dirVerifyCounts.get(key) ?? { dirPrefix, command: cmd, count: 0 };
        entry.count += 1;
        dirVerifyCounts.set(key, entry);
      }
    }
  }

  const coEdits: CoEditHabit[] = [];
  for (const [, ce] of coEditCounts) {
    if (ce.count >= minOccurrences) {
      coEdits.push({ fileA: ce.fileA, fileB: ce.fileB, coEditCount: ce.count });
    }
  }

  const dirVerifyCommands: DirectoryVerifyHabit[] = [];
  for (const [, dv] of dirVerifyCounts) {
    if (dv.count >= minOccurrences) {
      dirVerifyCommands.push({
        dirPrefix: dv.dirPrefix,
        command: dv.command,
        count: dv.count,
      });
    }
  }

  saveMacros(rootDir, Array.from(macrosById.values()), {
    coEdits,
    dirVerifyCommands,
  });

  return newlyCompiled;
}

export function registerCustomMacro(
  rootDir: string,
  input: {
    id?: string;
    name: string;
    kind: MacroKind;
    description?: string;
    steps: string[];
    triggers?: string[];
  }
): CompiledMacro {
  const { macros, habits } = loadMacroStore(rootDir);
  const prefix =
    input.kind === "command-pipeline"
      ? "pipe"
      : input.kind === "command-template"
        ? "tpl"
        : "bundle";
  const id = input.id?.trim() || `${prefix}_${shortHash(input.steps.join("|"))}`;
  const existingIdx = macros.findIndex((m) => m.id === id);

  const macro: CompiledMacro = {
    id,
    name: input.name,
    kind: input.kind,
    description: input.description ?? `${input.kind}: ${input.steps.join(" -> ")}`,
    steps: input.steps,
    triggers: input.triggers ?? input.steps,
    occurrences: existingIdx >= 0 ? macros[existingIdx]!.occurrences + 1 : 1,
    createdAt: existingIdx >= 0 ? macros[existingIdx]!.createdAt : new Date().toISOString(),
    state: "proposed",
  };
  macro.scriptPath = writeStandaloneMacroScript(rootDir, macro);

  if (existingIdx >= 0) {
    macros[existingIdx] = macro;
  } else {
    macros.push(macro);
  }
  saveMacros(rootDir, macros, habits);
  return macro;
}

/**
 * Execute a compiled macro (bundle, pipeline, or parameterized command-template)
 * in 1 step with 0 intermediate LLM turns.
 */
export function executeMacro(
  rootDir: string,
  macroId: string,
  templateArgs: string[] = [],
  dryRun = false
): {
  ok: boolean;
  macroId: string;
  text: string;
} {
  const { macros, habits } = loadMacroStore(rootDir);
  const macro = macros.find((m) => m.id === macroId || m.name === macroId);
  if (!macro) {
    const available = macros.map((m) => `${m.id} (${m.kind})`).join(", ");
    return {
      ok: false,
      macroId,
      text: `ERR [macro-not-found] '${macroId}'. Available macros: ${available || "none"}`,
    };
  }

  const permissions = macroPermissions(macro);
  if (dryRun) return { ok: true, macroId: macro.id, text: `WOULD_RUN [${macro.id}] state=${macro.state ?? "discovered"} permissions=${permissions?.join(",")} steps=${JSON.stringify(macro.steps)}` };
  if (macro.kind !== "context-bundle" && (macro.state !== "active" || macro.sourceHash !== macroSourceHash(rootDir, macro))) {
    return { ok: false, macroId: macro.id, text: `REJECTED [macro-not-active] ${macro.id}; approve and activate the current workspace version first.` };
  }

  macro.lastUsedAt = new Date().toISOString();
  macro.occurrences += 1;
  saveMacros(rootDir, macros, habits);

  if (macro.kind === "context-bundle") {
    const slice = executeSurgicalRead({
      rootDir,
      targets: macro.steps,
      includeCallers: true,
    });
    return {
      ok: true,
      macroId: macro.id,
      text: `# Macro [${macro.id}] ${macro.name} (${macro.steps.length} targets, ~${slice.estimatedTokens} tok vs ${slice.rawFileTokens} raw tok)\n\n${slice.text}`,
    };
  }

  if (macro.kind === "edit-codemod") {
    const oldSnippet = macro.steps[0] ?? "";
    const newSnippet = macro.steps[1] ?? "";
    const index = getWorkspaceAstIndex(rootDir);
    const targetFiles =
      templateArgs.length > 0
        ? templateArgs
        : index.getFiles().filter((rel) => {
            const raw = index.getRawFile(rel);
            return Boolean(raw && raw.content.includes(oldSnippet));
          });
    if (targetFiles.length === 0) {
      return {
        ok: true,
        macroId: macro.id,
        text: `PASS [codemod ${macro.id}] 0 files needed replacement.`,
      };
    }
    const edits = targetFiles.map((file) => ({
      file,
      oldCode: oldSnippet,
      newCode: newSnippet,
    }));
    const editRes = executeSurgicalEdit({
      rootDir,
      file: targetFiles[0]!,
      edits,
    });
    return {
      ok: editRes.ok,
      macroId: macro.id,
      text: `${editRes.ok ? "PASS" : "REJECTED"} [codemod ${macro.id}: ${editRes.touchedFiles.length} file(s)] -> ${editRes.text}`,
    };
  }

  if (macro.kind === "command-template") {
    const rawTemplate = macro.steps[0] ?? "";
    const resolvedCmd = rawTemplate
      .replace(/\{\{arg(\d+)\}\}/g, (_, idx) => templateArgs[Number(idx) - 1] ?? "")
      .trim();
    const res = runSafeCommand(rootDir, resolvedCmd);
    return {
      ok: res.ok,
      macroId: macro.id,
      text: `[macro ${macro.id}: ${resolvedCmd}] -> ${res.text}`,
    };
  }

  const stepSummaries: string[] = [];
  let totalMs = 0;
  let totalRawTokens = 0;
  for (let i = 0; i < macro.steps.length; i++) {
    const cmd = macro.steps[i]!;
    const res = runSafeCommand(rootDir, cmd);
    totalMs += res.durationMs;
    totalRawTokens += res.rawEstimatedTokens;
    if (!res.ok) {
      return {
        ok: false,
        macroId: macro.id,
        text: [
          `FAIL [macro ${macro.id} stopped at step ${i + 1}/${macro.steps.length}]`,
          ...stepSummaries,
          `Step ${i + 1} (${cmd}):\n${res.text}`,
        ].join("\n"),
      };
    }
    stepSummaries.push(`  [${i + 1}/${macro.steps.length}] ${cmd} -> ${res.text}`);
  }

  return {
    ok: true,
    macroId: macro.id,
    text: [
      `PASS [macro ${macro.id}: ${macro.steps.length}/${macro.steps.length} steps in ${totalMs}ms, raw ~${totalRawTokens} tok compressed]`,
      ...stepSummaries,
    ].join("\n"),
  };
}

/**
 * Heuristic guard — server-like / long-running commands must never be
 * AUTO-executed by the post-edit verify habit (they would block the edit flow
 * or spawn dev servers after every save). They stay recorded as habits; only
 * the auto-run is suppressed in favor of a hint.
 */
function looksLongRunning(cmd: string): boolean {
  const c = cmd.toLowerCase();
  if (/[&|]\s*$/.test(cmd.trim())) return true;
  return [
    "quiet_start",
    "devctl.py up",
    "devctl up",
    "npm run dev",
    "npm start",
    "yarn dev",
    "pnpm dev",
    "uvicorn",
    "flask run",
    "vite",
    "next dev",
    "next start",
    "dotnet run",
    "cargo run",
    "go run",
    "serve ",
    "watch ",
  ].some((frag) => c.includes(frag));
}

/**
 * Evaluate learned user habits after an edit:
 *   1. Checks if any edited file has a high-confidence Co-Edit partner that wasn't touched yet.
 *   2. Checks if the edited directory has a learned Post-Edit Verify command and runs it automatically!
 */
export function evaluatePostEditHabits(
  rootDir: string,
  editedFiles: string[],
  autoRunVerify = true
): { coEditHints: string[]; autoVerifySummary?: string } {
  const habits = loadUserHabits(rootDir);
  const editedSet = new Set(editedFiles);
  const coEditHints: string[] = [];

  for (const ce of habits.coEdits) {
    if (editedSet.has(ce.fileA) && !editedSet.has(ce.fileB)) {
      coEditHints.push(
        `Habit memory (${ce.coEditCount}x): editing '${ce.fileA}' is usually paired with '${ce.fileB}'`
      );
    } else if (editedSet.has(ce.fileB) && !editedSet.has(ce.fileA)) {
      coEditHints.push(
        `Habit memory (${ce.coEditCount}x): editing '${ce.fileB}' is usually paired with '${ce.fileA}'`
      );
    }
  }

  let autoVerifySummary: string | undefined;
  if (autoRunVerify && habits.dirVerifyCommands.length > 0) {
    for (const file of editedFiles) {
      const dir = dirname(file).replace(/\\/g, "/");
      const matchedHabit = habits.dirVerifyCommands.find((dv) => dv.dirPrefix === dir);
      if (matchedHabit) {
        // Never auto-run server-like commands after an edit — hint instead.
        if (looksLongRunning(matchedHabit.command)) {
          autoVerifySummary =
            `Auto-Verify Habit [${matchedHabit.dirPrefix} -> ${matchedHabit.command}]: ` +
            `auto-run skipped (long-running/server-like command); invoke it explicitly via gf_macro.`;
          break;
        }
        autoVerifySummary = `Auto-Verify Habit [${matchedHabit.dirPrefix} -> ${matchedHabit.command}]: approval required; run via gf_exec.`;
        break;
      }
    }
  }

  return {
    coEditHints,
    ...(autoVerifySummary ? { autoVerifySummary } : {}),
  };
}

export function findMatchingMacroHint(rootDir: string, keys: string[]): string | undefined {
  const { macros, habits } = loadMacroStore(rootDir);
  const hints: string[] = [];

  for (const m of macros) {
    if (m.kind === "context-bundle" && m.steps.some((step) => keys.includes(step))) {
      const others = m.steps.filter((step) => !keys.includes(step));
      if (others.length > 0) {
        hints.push(
          `// [Macro Hint] Co-accessed bundle '${m.id}' also includes: ${others.join(", ")} -> call gf_macro(action="run", id="${m.id}")`
        );
      }
    }
  }

  // Also surface co-edit partner files right when reading!
  const readFiles = new Set(keys.map((k) => k.split("#")[0]!.split(":")[0]!));
  for (const ce of habits.coEdits) {
    if (readFiles.has(ce.fileA) && !readFiles.has(ce.fileB)) {
      hints.push(`// [Habit Hint] '${ce.fileA}' is co-edited with '${ce.fileB}' (${ce.coEditCount}x history)`);
    } else if (readFiles.has(ce.fileB) && !readFiles.has(ce.fileA)) {
      hints.push(`// [Habit Hint] '${ce.fileB}' is co-edited with '${ce.fileA}' (${ce.coEditCount}x history)`);
    }
  }

  return hints.length > 0 ? hints.slice(0, 2).join("\n") : undefined;
}


/**
 * Finds a compiled command macro that already covers `cmd`.
 *
 * Command macros (`command-pipeline` / `command-template`) used to be mined but
 * never surfaced, so an agent re-derived the same build/test command on every
 * session even though a ready local script existed. Matching is exact first,
 * then by parameter template (`pytest {{arg1}}`), so a command run with a
 * different file still resolves to the same local tool.
 */
export function findCommandMacro(rootDir: string, cmd: string): CompiledMacro | undefined {
  const trimmed = cmd.trim();
  if (!trimmed) return undefined;
  const { macros } = loadMacroStore(rootDir);
  const commandMacros = macros.filter(
    (m) => m.kind === "command-pipeline" || m.kind === "command-template"
  );
  if (commandMacros.length === 0) return undefined;

  const exact = commandMacros.find((m) => m.triggers.includes(trimmed));
  if (exact) return exact;

  const { template, hasParams } = extractCommandTemplate(trimmed);
  if (!hasParams) return undefined;
  return commandMacros.find(
    (m) => m.kind === "command-template" && m.steps.includes(template)
  );
}

/**
 * Zero-Cold-Start Git History Miner integration:
 * Scans `git log` for temporal co-change file pairs and merges them into `habits.coEdits`.
 */
export function syncGitCoChangeHabits(
  rootDir: string,
  options: GitMineOptions = {}
): { commitsScanned: number; addedCoEdits: number; totalCoEdits: number } {
  const gitRes = mineGitCoChangeHistory(rootDir, options);
  const { macros, habits } = loadMacroStore(rootDir);
  const byKey = new Map<string, CoEditHabit>();

  for (const ce of habits.coEdits) {
    const [first, second] = [ce.fileA, ce.fileB].sort() as [string, string];
    byKey.set(`${first}||${second}`, { fileA: first, fileB: second, coEditCount: ce.coEditCount });
  }

  let addedCoEdits = 0;
  for (const pair of gitRes.coChangePairs) {
    const [first, second] = [pair.fileA, pair.fileB].sort() as [string, string];
    const key = `${first}||${second}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { fileA: first, fileB: second, coEditCount: pair.coCommitCount });
      addedCoEdits += 1;
    } else if (pair.coCommitCount > existing.coEditCount) {
      existing.coEditCount = pair.coCommitCount;
    }
  }

  const mergedCoEdits = Array.from(byKey.values()).sort((a, b) => b.coEditCount - a.coEditCount);
  saveMacros(rootDir, macros, {
    coEdits: mergedCoEdits,
    dirVerifyCommands: habits.dirVerifyCommands,
  });
  return {
    commitsScanned: gitRes.commitsScanned,
    addedCoEdits,
    totalCoEdits: mergedCoEdits.length,
  };
}

interface EditPatternEntry {
  oldSnippet: string;
  newSnippet: string;
  files: string[];
  count: number;
}

function editPatternsFilePath(rootDir: string): string {
  return join(rootDir, ".graphflow", "edit-patterns.json");
}

/**
 * Detect isomorphic code modifications across >= 2 files/calls and auto-compile an `edit-codemod` macro!
 */
export function recordEditPatternAndMine(
  rootDir: string,
  file: string,
  oldSnippet: string,
  newSnippet: string,
  minOccurrences = 2
): CompiledMacro | undefined {
  const cleanOld = oldSnippet.trim();
  const cleanNew = newSnippet.trim();
  if (!cleanOld || !cleanNew || cleanOld === cleanNew || cleanOld.length > 600 || cleanNew.length > 600) {
    return undefined;
  }

  ensureGraphflowDir(rootDir);
  const pPath = editPatternsFilePath(rootDir);
  let entries: EditPatternEntry[] = [];
  if (existsSync(pPath)) {
    try {
      entries = JSON.parse(readFileSync(pPath, "utf8")) as EditPatternEntry[];
    } catch {
      entries = [];
    }
  }

  const normFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  let matched = entries.find((e) => e.oldSnippet === cleanOld && e.newSnippet === cleanNew);
  if (!matched) {
    matched = { oldSnippet: cleanOld, newSnippet: cleanNew, files: [normFile], count: 1 };
    entries.push(matched);
  } else {
    matched.count += 1;
    if (!matched.files.includes(normFile)) matched.files.push(normFile);
  }

  writeFileSync(pPath, JSON.stringify(entries.slice(-100), null, 2), "utf8");

  if (matched.count >= minOccurrences) {
    return registerCustomMacro(rootDir, {
      id: `codemod_${shortHash(`${cleanOld}=>${cleanNew}`)}`,
      name: `Auto-Codemod (${cleanOld.slice(0, 24)} -> ${cleanNew.slice(0, 24)})`,
      kind: "edit-codemod",
      description: `Batch replace '${cleanOld.replace(/\s+/g, " ").slice(0, 40)}' -> '${cleanNew.replace(/\s+/g, " ").slice(0, 40)}' across target files`,
      steps: [cleanOld, cleanNew],
      triggers: matched.files,
    });
  }
  return undefined;
}
