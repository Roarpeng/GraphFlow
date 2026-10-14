/**
 * GraphFlow 3.0 — Pillar 4: User Habit Memory & Auto-Compiled Macro Engine (`macro-engine.ts`)
 *
 * Principle 4: "根据用户习惯来记忆生成工具，以后直接干"
 * (Learn from the user's coding/testing/editing habits and compile recurring
 * patterns into parameterized, deterministic tools that execute with 0 LLM turns).
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
 *        binds that verification command to `src/surfaces` and can auto-execute it!
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execAndDehydrate } from "./dehydrator.js";
import { executeSurgicalRead } from "./slicer.js";

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

export type MacroKind = "context-bundle" | "command-pipeline" | "command-template";

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
}

export interface CoEditHabit {
  fileA: string;
  fileB: string;
  coEditCount: number;
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
  version: "3.0";
  macros: CompiledMacro[];
  habits?: UserHabitProfile;
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
  mkdirSync(join(rootDir, ".graphflow"), { recursive: true });
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

  let scriptContent: string;
  if (macro.kind === "command-pipeline") {
    scriptContent = [
      `#!/usr/bin/env node`,
      `// Auto-compiled by GraphFlow 3.0 Macro Engine (${macro.id}: ${macro.description})`,
      `import { spawnSync } from "node:child_process";`,
      `const steps = ${JSON.stringify(macro.steps, null, 2)};`,
      `const start = Date.now();`,
      `for (let i = 0; i < steps.length; i++) {`,
      `  const cmd = steps[i];`,
      `  const res = spawnSync(cmd, { shell: true, encoding: "utf8" });`,
      `  if (res.status !== 0) {`,
      `    console.error(\`FAIL [step \${i + 1}/\${steps.length}] \${cmd}\\n\${(res.stderr || res.stdout || "").slice(0, 1200)}\`);`,
      `    process.exit(res.status ?? 1);`,
      `  }`,
      `}`,
      `console.log(\`PASS [macro ${macro.id}: \${steps.length}/\${steps.length} steps in \${Date.now() - start}ms]\`);`,
    ].join("\n");
  } else if (macro.kind === "command-template") {
    scriptContent = [
      `#!/usr/bin/env node`,
      `// Auto-compiled Parameterized Habit Tool (${macro.id}: ${macro.description})`,
      `import { spawnSync } from "node:child_process";`,
      `const template = ${JSON.stringify(macro.steps[0] ?? "")};`,
      `const args = process.argv.slice(2);`,
      `const cmd = template.replace(/\\{\\{arg(\\d+)\\}\\}/g, (_, idx) => args[Number(idx) - 1] ?? "");`,
      `const res = spawnSync(cmd, { shell: true, encoding: "utf8" });`,
      `if (res.status !== 0) {`,
      `  console.error(res.stderr || res.stdout);`,
      `  process.exit(res.status ?? 1);`,
      `}`,
      `console.log(\`PASS [template ${macro.id}] \${cmd}\`);`,
    ].join("\n");
  } else {
    scriptContent = [
      `#!/usr/bin/env node`,
      `// Auto-compiled Context Bundle (${macro.id}: ${macro.description})`,
      `console.log(${JSON.stringify(`Context bundle macro ${macro.id}: ${macro.steps.join(", ")}`)});`,
    ].join("\n");
  }

  writeFileSync(absScriptPath, scriptContent + "\n", "utf8");
  try {
    chmodSync(absScriptPath, 0o755);
  } catch {
    // ignore
  }
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

  mkdirSync(join(rootDir, ".graphflow"), { recursive: true });
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

  // ── 2. Mine `command-pipeline` patterns (consecutive `exec -> exec` pairs) ──
  const execPipelineCounts = new Map<string, { cmds: string[]; count: number }>();
  for (let i = 0; i + 1 < history.length; i++) {
    const a = history[i]!;
    const b = history[i + 1]!;
    if (
      a.sessionId === b.sessionId &&
      a.kind === "exec" &&
      b.kind === "exec" &&
      a.ok &&
      b.ok &&
      a.items[0] &&
      b.items[0] &&
      a.items[0] !== b.items[0]
    ) {
      const cmds = [a.items[0], b.items[0]];
      const key = cmds.join(" && ");
      const entry = execPipelineCounts.get(key) ?? { cmds, count: 0 };
      entry.count += 1;
      execPipelineCounts.set(key, entry);
    }
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

  for (let i = 0; i + 1 < history.length; i++) {
    const a = history[i]!;
    const b = history[i + 1]!;
    if (a.sessionId !== b.sessionId || !a.ok || !b.ok) continue;

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
  templateArgs: string[] = []
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

  if (macro.kind === "command-template") {
    const rawTemplate = macro.steps[0] ?? "";
    const resolvedCmd = rawTemplate
      .replace(/\{\{arg(\d+)\}\}/g, (_, idx) => templateArgs[Number(idx) - 1] ?? "")
      .trim();
    const res = execAndDehydrate({ rootDir, command: resolvedCmd });
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
    const res = execAndDehydrate({ rootDir, command: cmd });
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
        const res = execAndDehydrate({ rootDir, command: matchedHabit.command, timeoutMs: 15_000 });
        autoVerifySummary = `Auto-Verify Habit [${matchedHabit.dirPrefix} -> ${matchedHabit.command}]: ${res.text}`;
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
