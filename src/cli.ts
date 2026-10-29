#!/usr/bin/env node
/**
 * GraphFlow 3.1 — Pure Token-First Surgical CLI (`src/cli.ts`)
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  detectInstalledAgents,
  getAgentRegistrationStatus,
  installAllAgents,
  uninstallAllAgents,
  type AgentRegistrationStatus,
} from "./agent-installer.js";
import {
  interceptPostToolUse,
  interceptPreToolUse,
  interceptUserPromptSubmit,
} from "./host-interceptor.js";
import { DEFAULT_FLYWHEEL_TTL_DAYS, inspectFlywheel, pruneFlywheel } from "./flywheel.js";
import { PACKAGE_VERSION } from "./mcp-server.js";
import { executeV3ToolCall } from "./mcp-tools.js";
import {
  TASK_PROMOTION_USES,
  appendInstructionLogEntry,
  findTask,
  formatHarvestReport,
  formatTaskDetails,
  formatTaskHelp,
  formatTaskSummary,
  harvestInstructionLog,
  listTasks,
  recordTaskUse,
  runTask,
} from "./task-reflector.js";
import { isTreeSitterAvailable } from "./tree-sitter-engine.js";

const requireFromCli = createRequire(__filename);

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

interface ParsedFlagArgs {
  positionals: string[];
  values: Map<string, string>;
  multiValues: Map<string, string[]>;
  flags: Set<string>;
}

/**
 * Small deterministic argv tokenizer shared by `read`, `exec`, `uninstall`, and
 * `task`. Value flags consume their next token (`--root <dir>` as well as
 * `--root=<dir>`), a bare `--` terminates flag parsing, and any other
 * `-`-prefixed token is treated as a flag. Repeated value flags are preserved
 * in `multiValues` (e.g. `--step a --step b`). Only real positionals are
 * returned, so a flag value can never leak into the command/targets list.
 */
function parseFlagArgs(args: string[], valueFlags: readonly string[]): ParsedFlagArgs {
  const valueFlagSet = new Set(valueFlags);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const multiValues = new Map<string, string[]>();
  const flags = new Set<string>();

  const recordValue = (name: string, value: string): void => {
    values.set(name, value);
    const existing = multiValues.get(name);
    if (existing) existing.push(value);
    else multiValues.set(name, [value]);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (valueFlagSet.has(arg)) {
      const value = args[i + 1];
      if (value !== undefined) {
        recordValue(arg, value);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        const name = arg.slice(0, eq);
        if (valueFlagSet.has(name)) {
          recordValue(name, arg.slice(eq + 1));
          continue;
        }
      }
      flags.add(arg);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      flags.add(arg);
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, values, multiValues, flags };
}

export interface ParsedExecArgs {
  cmd: string;
  run: boolean;
  rootDir?: string;
}

/**
 * Parse `graphflow exec [cmd...] [--run] [--root <dir>] [-- <cmd...>]`.
 * Defaults to the impacted-test router (`affected-tests`) when no positional
 * command is supplied. Use `--` to forward flags to the wrapped command.
 */
export function parseExecArgs(args: string[], defaultCmd = "affected-tests"): ParsedExecArgs {
  const parsed = parseFlagArgs(args, ["--root"]);
  const rootDir = parsed.values.get("--root");
  return {
    cmd: parsed.positionals.length > 0 ? parsed.positionals.join(" ") : defaultCmd,
    run: parsed.flags.has("--run"),
    ...(rootDir !== undefined ? { rootDir } : {}),
  };
}

export interface ParsedUninstallArgs {
  agentIds?: string[];
  all: boolean;
  rootDir?: string;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Parse `graphflow uninstall [--agents <id1,id2>] [--all] [--root <dir>]`.
 * With neither `--agents` nor `--all` the CLI uninstalls detected agents only.
 */
export function parseUninstallArgs(args: string[]): ParsedUninstallArgs {
  const parsed = parseFlagArgs(args, ["--agents", "--root"]);
  const agentsCsv = parsed.values.get("--agents");
  const agentIds = agentsCsv === undefined ? [] : splitCsv(agentsCsv);
  const rootDir = parsed.values.get("--root");
  return {
    ...(agentIds.length > 0 ? { agentIds } : {}),
    all: parsed.flags.has("--all"),
    ...(rootDir !== undefined ? { rootDir } : {}),
  };
}

export interface ParsedReadArgs {
  targets: string[];
  q?: string;
  skeleton: boolean;
  dedup: boolean;
  rootDir?: string;
}

/** Parse `graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]`. */
export function parseReadArgs(args: string[]): ParsedReadArgs {
  const parsed = parseFlagArgs(args, ["-q", "--query", "--root"]);
  const q = parsed.values.get("-q") ?? parsed.values.get("--query");
  const rootDir = parsed.values.get("--root");
  return {
    targets: parsed.positionals,
    ...(q !== undefined ? { q } : {}),
    skeleton: parsed.flags.has("--skeleton"),
    dedup: parsed.flags.has("--dedup"),
    ...(rootDir !== undefined ? { rootDir } : {}),
  };
}

export interface ParsedTaskArgs {
  subcommand: string;
  target?: string;
  instruction?: string;
  steps: string[];
  args: string[];
  json: boolean;
  rootDir?: string;
  logPath?: string;
}

/**
 * Parse `graphflow task <list|show|record|run|log|harvest> ...`:
 *   task list [--json]
 *   task show <id|instruction> [--json]
 *   task record "<instruction>" --step "<cmd>" [--step ...] [--steps ...] [--args ...] [--json]
 *   task run <id|instruction> [args...] [--args ...] [--json]
 *   task log "<instruction>" --step "<cmd>" [--log <path>]   (append to JSONL only)
 *   task harvest [--log <path>] [--json]                     (promote repeated log entries)
 * `--root <dir>` is honored by every subcommand; `--steps` is an alias for
 * another `--step` value; `--log` overrides `.graphflow/instruction-log.jsonl`
 * (must stay inside the workspace).
 */
export function parseTaskArgs(args: string[]): ParsedTaskArgs {
  const parsed = parseFlagArgs(args, ["--root", "--step", "--steps", "--args", "--log"]);
  const subcommand = (parsed.positionals[0] ?? "list").trim().toLowerCase();
  const positionals = parsed.positionals.slice(1);
  const rootDir = parsed.values.get("--root");
  const logPath = parsed.values.get("--log");
  const steps = [
    ...(parsed.multiValues.get("--step") ?? []),
    ...(parsed.multiValues.get("--steps") ?? []),
  ];
  const extraArgs = parsed.multiValues.get("--args") ?? [];
  const json = parsed.flags.has("--json");
  const common = {
    subcommand,
    json,
    ...(rootDir !== undefined ? { rootDir } : {}),
    ...(logPath !== undefined ? { logPath } : {}),
  };

  if (subcommand === "record" || subcommand === "log") {
    return { ...common, instruction: positionals.join(" ").trim(), steps, args: extraArgs };
  }
  if (subcommand === "run") {
    return {
      ...common,
      target: (positionals[0] ?? "").trim(),
      steps: [],
      args: [...positionals.slice(1), ...extraArgs],
    };
  }
  if (subcommand === "show") {
    return { ...common, target: positionals.join(" ").trim(), steps: [], args: [] };
  }
  return { ...common, steps: [], args: [] };
}

export interface ParsedReflectArgs {
  instruction: string;
  args: string[];
  json: boolean;
  rootDir?: string;
}

export interface ParsedFlywheelArgs {
  prune: boolean;
  /** TTL in days; `NaN` signals an invalid `--ttl-days` value (main rejects it). */
  ttlDays: number;
  rootDir?: string;
}

/**
 * Parse `graphflow flywheel [--prune] [--ttl-days N] [--root <dir>]`.
 * `ttlDays` defaults to 30 and is `NaN` when `--ttl-days` is not a positive
 * finite number, so the caller can fail with a usage error instead of
 * silently pruning everything (or nothing).
 */
export function parseFlywheelArgs(args: string[]): ParsedFlywheelArgs {
  const parsed = parseFlagArgs(args, ["--root", "--ttl-days"]);
  const rootDir = parsed.values.get("--root");
  const ttlRaw = parsed.values.get("--ttl-days");
  const ttlParsed = ttlRaw === undefined ? undefined : Number(ttlRaw);
  const ttlDays =
    ttlParsed === undefined
      ? DEFAULT_FLYWHEEL_TTL_DAYS
      : Number.isFinite(ttlParsed) && ttlParsed > 0
        ? ttlParsed
        : Number.NaN;
  return {
    prune: parsed.flags.has("--prune"),
    ttlDays,
    ...(rootDir !== undefined ? { rootDir } : {}),
  };
}

/** Parse `graphflow reflect "<instruction>" [args...] [--root <dir>] [--json]`. */
export function parseReflectArgs(args: string[]): ParsedReflectArgs {
  const parsed = parseFlagArgs(args, ["--root"]);
  const instruction = (parsed.positionals[0] ?? "").trim();
  const rootDir = parsed.values.get("--root");
  return {
    instruction,
    args: parsed.positionals.slice(1),
    json: parsed.flags.has("--json"),
    ...(rootDir !== undefined ? { rootDir } : {}),
  };
}

/**
 * One-line `graphflow status` entry, e.g.
 * `[MCP ✓] [Skill ✓] [Rule -] [Hook ✓] Cursor (cursor)`.
 * `-` means "not registered" or "this host has no such surface".
 */
export function formatRegistrationStatusLine(status: AgentRegistrationStatus): string {
  const mark = (value: boolean | undefined): string => (value ? "✓" : "-");
  return (
    `[MCP ${mark(status.mcp)}] [Skill ${mark(status.skill)}] ` +
    `[Rule ${mark(status.rule)}] [Hook ${mark(status.hook)}] ` +
    `${status.name} (${status.id})`
  );
}

function printUsage(): void {
  console.log(
    [
      `GraphFlow v${PACKAGE_VERSION} — Token-First Surgical Code Engine`,
      "",
      "Usage:",
      "  graphflow install [--workspace] [--agents <id1,id2>] [--no-prune]",
      "  graphflow uninstall [--agents <id1,id2>] [--all] [--root <dir>]",
      "  graphflow status [--agents <id1,id2>] [--all]",
      "  graphflow doctor parsers [--strict] | graphflow parsers",
      "  graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]",
      "  graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <newName>]",
      "  graphflow exec [cmd] [--run] [--root <dir>] [-- <cmd...>]",
      "  graphflow macro <list|run|mine|mine-git|save> [id] [args...]",
      "  graphflow task <list|show|record|run|log|harvest> [--step <cmd>] [--log <path>] [--json] [--root <dir>]",
      '  graphflow reflect "<instruction>" [args...] [--json] [--root <dir>]',
      "  graphflow flywheel [--prune] [--ttl-days N] [--root <dir>]",
      "  graphflow hook <pre-tool|post-tool|user-prompt> [--protocol generic|cursor|gemini]",
      "  graphflow version | help",
      "",
      "Notes:",
      "  uninstall without flags removes detected agents only; --all removes every profile.",
      "  exec defaults to affected-tests and forwards everything after `--` to the command.",
      "  task/reflect: recording the same instruction twice compiles a local .mjs runner;",
      "  the 3rd use runs it with no LLM/network. Use `--step` once per shell step to record.",
      "  task log/harvest: append to .graphflow/instruction-log.jsonl (e.g. from a shell wrapper or",
      "  DSH skill) then harvest to promote repeated instructions; `task harvest` is incremental.",
      "  flywheel: session-journal health check; --prune removes pending-episode entries older",
      "  than --ttl-days (default 30). Other kinds and unparsable lines are always kept.",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0]?.trim() ?? "help";
  const rest = argv.slice(1);
  const rootDir = readFlag(rest, "--root") ?? process.cwd();

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  if (cmd === "install" || cmd === "init") {
    const includeWorkspace = rest.includes("--workspace") || rest.includes("--all");
    const agentsCsv = readFlag(rest, "--agents");
    const agentIds = agentsCsv
      ? agentsCsv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const report = installAllAgents({
      workspaceRoot: rootDir,
      includeWorkspace,
      ...(agentIds ? { agentIds } : {}),
      ...(rest.includes("--no-prune") ? { pruneLegacy: false } : {}),
    });
    // An unknown --agents id must not look like a successful install.
    if (agentIds && report.results.length === 0) {
      console.error(
        `ERR [unknown-agent] none of --agents ${agentIds.join(",")} matched a known profile.`
      );
      process.exitCode = 1;
      return;
    }
    const mcpCount = report.results.filter((r) => r.category === "mcp" && r.status !== "error").length;    const skillCount = report.results.filter((r) => r.category === "skill" && r.status !== "error").length;
    const ruleCount = report.results.filter((r) => r.category === "rule" && r.status !== "error").length;
    const hookCount = report.results.filter((r) => r.category === "hook" && r.status !== "error").length;
    console.log(
      `GraphFlow v${PACKAGE_VERSION} installed across ${report.detectedAgents.length} detected agent(s): ` +
        `MCP=${mcpCount}, Skills=${skillCount}, Rules=${ruleCount}, Hooks=${hookCount}`
    );
    for (const item of report.results) {
      const suffix = item.message ? ` — ${item.message}` : "";
      console.log(
        `  [${item.status.toUpperCase()}] (${item.category}) ${item.agentName} -> ${item.targetPath}${suffix}`
      );
    }
    if (report.results.some((r) => r.status === "error")) process.exitCode = 1;
    return;
  }

  if (cmd === "uninstall") {
    const parsed = parseUninstallArgs(rest);
    const removed = uninstallAllAgents({
      workspaceRoot: parsed.rootDir ?? rootDir,
      ...(parsed.agentIds ? { agentIds: parsed.agentIds } : {}),
      ...(parsed.all ? { all: true } : {}),
    });
    console.log(`GraphFlow v${PACKAGE_VERSION} uninstalled (${removed.length} item(s) removed).`);
    for (const item of removed) {
      const suffix = item.message ? ` — ${item.message}` : "";
      console.log(
        `  [${item.status.toUpperCase()}] (${item.category}) ${item.agentName} -> ${item.targetPath}${suffix}`
      );
    }
    if (removed.some((r) => r.status === "error")) process.exitCode = 1;
    return;
  }

  if ((cmd === "doctor" && rest[0] === "parsers") || cmd === "parsers") {
    const grammarPackages: Array<[string, string]> = [
      ["python", "tree-sitter-python"],
      ["go", "tree-sitter-go"],
      ["rust", "tree-sitter-rust"],
      ["c", "tree-sitter-c"],
      ["cpp", "tree-sitter-cpp"],
      ["csharp", "tree-sitter-c-sharp"],
    ];
    const packageVersion = (name: string): string | undefined => {
      try {
        const pkgPath = requireFromCli.resolve(`${name}/package.json`);
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
        return pkg.version;
      } catch {
        return undefined;
      }
    };
    const available = isTreeSitterAvailable();
    const envValue = process.env.GRAPHFLOW_TREE_SITTER;
    console.log(`GraphFlow v${PACKAGE_VERSION} — parser backends`);
    console.log(`  TS/JS: @babel/parser (engine "babel")`);
    console.log(`  tree-sitter core: ${packageVersion("tree-sitter") ?? "NOT INSTALLED"}`);
    for (const [family, pkg] of grammarPackages) {
      const version = packageVersion(pkg);
      console.log(`  ${family.padEnd(7)} ${pkg}: ${version ?? "NOT INSTALLED"}`);
    }
    console.log(
      `  default engine: ${
        envValue === "0"
          ? "structural (GRAPHFLOW_TREE_SITTER=0)"
          : available
            ? "tree-sitter"
            : "structural (tree-sitter unavailable)"
      }`
    );
    if (!available) {
      console.log(
        "  hint: install the optional native grammars (`npm install`) or keep using the structural fallback."
      );
      if (rest.includes("--strict")) process.exitCode = 1;
    }
    return;
  }

  if (cmd === "status" || cmd === "doctor") {
    const agentsCsv = readFlag(rest, "--agents");
    const agentIds = agentsCsv
      ? agentsCsv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const all = rest.includes("--all");
    const detected = detectInstalledAgents();
    const statuses = getAgentRegistrationStatus({
      ...(agentIds?.length ? { agentIds } : {}),
      ...(all ? { all: true } : {}),
    });
    console.log(
      `GraphFlow v${PACKAGE_VERSION} — Detected ${detected.length} coding agent(s): ` +
        (detected.map((d) => `${d.name} (${d.id})`).join(", ") || "none")
    );
    if (statuses.length === 0) {
      console.log("  No agent registrations in scope.");
    } else {
      for (const status of statuses) {
        console.log(`  ${formatRegistrationStatusLine(status)}`);
      }
    }
    return;
  }

  if (cmd === "hook") {
    const sub = rest[0]?.trim() ?? "pre-tool";
    let rawStdin = "";
    try {
      rawStdin = readFileSync(0, "utf8");
    } catch {
      rawStdin = "{}";
    }
    let payload: Record<string, unknown> = {};
    try {
      // `JSON.parse("null")` succeeds and yields `null`, and `"[]"`/`"1"` yield
      // non-objects: every later `payload.x` read then throws or silently reads
      // garbage. Hook payloads come from an external tool over a pipe, so only a
      // real object is treated as a payload.
      const parsed: unknown = JSON.parse(rawStdin || "{}");
      payload =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      payload = {};
    }
    // The hook payload's cwd may be any subdirectory of the workspace; walk up
    // to the nearest ancestor that already owns a `.graphflow` store so events
    // land in the workspace root instead of spawning scattered stores.
    const resolveHookRoot = (startDir: string): string => {
      let dir = startDir;
      for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, ".graphflow"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return startDir;
    };
    const hookRoot = resolveHookRoot(
      typeof payload.cwd === "string" && payload.cwd ? payload.cwd : rootDir
    );
    if (sub === "pre-tool" || sub === "PreToolUse" || sub === "preToolUse") {
      const res = interceptPreToolUse(
        payload as unknown as Parameters<typeof interceptPreToolUse>[0],
        { rootDir: hookRoot }
      );
      process.stdout.write(`${JSON.stringify(res.hookProtocolOutput)}\n`);
      return;
    }
    if (sub === "post-tool" || sub === "PostToolUse" || sub === "postToolUse") {
      const res = interceptPostToolUse(
        payload as unknown as Parameters<typeof interceptPostToolUse>[0],
        { rootDir: hookRoot }
      );
      process.stdout.write(`${JSON.stringify(res.hookProtocolOutput)}\n`);
      return;
    }
    if (sub === "user-prompt" || sub === "UserPromptSubmit" || sub === "prompt" || sub === "BeforeAgent") {
      // Prompt Reflex: hosts spell the prompt field differently (prompt /
      // user_prompt / input); --protocol picks the host's stdout dialect.
      const protocolRaw = readFlag(rest, "--protocol");
      const protocol = protocolRaw === "cursor" || protocolRaw === "gemini" ? protocolRaw : "generic";
      const rawPrompt = payload.prompt ?? payload.user_prompt ?? payload.input;
      const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
      const res = interceptUserPromptSubmit(
        {
          hook_event_name: "UserPromptSubmit",
          ...(typeof rawPrompt === "string" ? { prompt: rawPrompt } : {}),
          ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        },
        { rootDir: hookRoot, ...(sessionId !== undefined ? { sessionId } : {}) }
      );
      if (res.action === "blocked") {
        if (protocol === "cursor") {
          process.stdout.write(
            `${JSON.stringify({ continue: false, user_message: res.summary ?? "" })}\n`
          );
        } else if (protocol === "gemini") {
          process.stdout.write(
            `${JSON.stringify({ decision: "deny", reason: res.summary ?? "" })}\n`
          );
        } else {
          // Generic dialect: stderr carries the summary, stdout stays empty, and
          // a non-zero exit code tells the host the prompt was consumed.
          process.stderr.write(`${res.summary ?? ""}\n`);
          process.exitCode = 2;
        }
        return;
      }
      if (res.action === "hint") {
        if (protocol === "cursor") {
          process.stdout.write("{}\n");
        } else if (protocol === "gemini") {
          process.stdout.write(
            `${JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "BeforeAgent",
                additionalContext: res.hint ?? "",
              },
            })}\n`
          );
        } else {
          process.stdout.write(
            `${JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: res.hint ?? "",
              },
            })}\n`
          );
        }
        return;
      }
      // allow: print nothing in the generic dialect; JSON-speaking hosts get {}.
      if (protocol === "cursor" || protocol === "gemini") {
        process.stdout.write("{}\n");
      }
      return;
    }
    process.stdout.write("{}\n");
    return;
  }

  if (cmd === "read" || cmd === "gf-read") {
    const parsed = parseReadArgs(rest);
    const effectiveRoot = parsed.rootDir ?? rootDir;
    const res = executeV3ToolCall(
      "gf_read",
      {
        ...(parsed.targets.length > 0 ? { targets: parsed.targets } : {}),
        ...(parsed.q ? { q: parsed.q } : {}),
        skeleton: parsed.skeleton,
        dedup: parsed.dedup,
        rootDir: effectiveRoot,
      },
      effectiveRoot
    );
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "edit" || cmd === "gf-edit") {
    const file = rest[0] ?? "";
    const symbol = readFlag(rest, "--symbol");
    const newCode = readFlag(rest, "--new");
    const oldCode = readFlag(rest, "--old");
    const renameTo = readFlag(rest, "--rename");
    const res = executeV3ToolCall(
      "gf_edit",
      {
        file,
        ...(symbol ? { symbol } : {}),
        ...(newCode !== undefined ? { newCode } : {}),
        ...(oldCode !== undefined ? { oldCode } : {}),
        ...(renameTo ? { renameTo } : {}),
        rootDir,
      },
      rootDir
    );
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "exec" || cmd === "gf-exec") {
    const parsed = parseExecArgs(rest);
    const effectiveRoot = parsed.rootDir ?? rootDir;
    const res = executeV3ToolCall(
      "gf_exec",
      { cmd: parsed.cmd, run: parsed.run, rootDir: effectiveRoot },
      effectiveRoot
    );
    console.log(res.content[0]?.text ?? "");
    // A failed command must fail the CLI too, or CI reads a red run as green.
    const execExit = res.structuredContent?.exitCode;
    if (typeof execExit === "number" && execExit !== 0) process.exitCode = execExit;
    return;
  }

  if (cmd === "task" || cmd === "gf-task") {
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(formatTaskHelp());
      return;
    }
    const parsed = parseTaskArgs(rest);
    const effectiveRoot = parsed.rootDir ?? rootDir;
    const json = parsed.json;

    if (parsed.subcommand === "list") {
      const tasks = listTasks(effectiveRoot);
      if (json) {
        console.log(JSON.stringify({ rootDir: effectiveRoot, tasks }, null, 2));
        return;
      }
      if (tasks.length === 0) {
        console.log(
          "# Reflected Tasks (0 recorded yet — record the same instruction twice with --step to compile a local runner)"
        );
        return;
      }
      console.log(`# Reflected Tasks (${tasks.length}):`);
      for (const task of tasks) console.log(formatTaskSummary(task));
      return;
    }

    if (parsed.subcommand === "show") {
      const target = parsed.target ?? "";
      const tasks = listTasks(effectiveRoot);
      const byId = tasks.find((task) => task.id === target);
      const found = byId ?? (target ? findTask(effectiveRoot, target)?.record : undefined);
      if (!found) {
        console.error(`MISS [task-not-found] ${JSON.stringify(target)}`);
        process.exitCode = 1;
        return;
      }
      console.log(json ? JSON.stringify(found, null, 2) : formatTaskDetails(found));
      return;
    }

    if (parsed.subcommand === "record") {
      const instruction = parsed.instruction ?? "";
      if (!instruction) {
        console.error('ERR [task-record] Provide an instruction string: graphflow task record "<instruction>" --step "<cmd>"');
        process.exitCode = 1;
        return;
      }
      if (parsed.steps.length === 0) {
        console.error("ERR [task-record] Provide at least one --step \"<shell command>\" to record.");
        process.exitCode = 1;
        return;
      }
      try {
        const record = recordTaskUse(effectiveRoot, instruction, parsed.steps, {
          ...(parsed.args.length > 0 ? { args: parsed.args } : {}),
        });
        if (json) {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(
          `OK [task-recorded] id=${record.id} uses=${record.count}/${TASK_PROMOTION_USES} ` +
            `${record.scriptPath ? `compiled=${record.scriptPath}` : "not-compiled-yet"} ` +
            `instruction=${JSON.stringify(record.instructionRaw)}`
        );
      } catch (error) {
        console.error(`ERR [task-record] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }

    if (parsed.subcommand === "log") {
      const instruction = parsed.instruction ?? "";
      if (!instruction) {
        console.error('ERR [task-log] Provide an instruction string: graphflow task log "<instruction>" --step "<cmd>"');
        process.exitCode = 1;
        return;
      }
      if (parsed.steps.length === 0) {
        console.error('ERR [task-log] Provide at least one --step "<shell command>" to log.');
        process.exitCode = 1;
        return;
      }
      try {
        const entry = appendInstructionLogEntry(
          effectiveRoot,
          instruction,
          parsed.steps,
          parsed.logPath !== undefined ? { logPath: parsed.logPath } : {}
        );
        if (json) {
          console.log(JSON.stringify(entry, null, 2));
          return;
        }
        console.log(
          `OK [instruction-logged] at=${entry.at} log=${parsed.logPath ?? ".graphflow/instruction-log.jsonl"} ` +
            `(run \`graphflow task harvest\` to promote repeated instructions)`
        );
      } catch (error) {
        console.error(`ERR [task-log] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }

    if (parsed.subcommand === "harvest") {
      try {
        const report = harvestInstructionLog(
          effectiveRoot,
          parsed.logPath !== undefined ? { logPath: parsed.logPath } : {}
        );
        console.log(json ? JSON.stringify(report, null, 2) : formatHarvestReport(report));
      } catch (error) {
        console.error(`ERR [task-harvest] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }

    if (parsed.subcommand === "run") {
      const target = parsed.target ?? "";
      if (!target) {
        console.error('ERR [task-run] Provide a reflected task id or instruction: graphflow task run "<id|instruction>" [args...]');
        process.exitCode = 1;
        return;
      }
      const result = runTask(effectiveRoot, target, parsed.args);
      console.log(json ? JSON.stringify(result, null, 2) : result.text);
      if (!result.hit || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
      return;
    }

    console.error(
      `ERR [unknown-task-command] '${parsed.subcommand}'. Use list|show|record|run|log|harvest.`
    );
    process.exitCode = 1;
    return;
  }

  if (cmd === "reflect") {
    const parsed = parseReflectArgs(rest);
    const effectiveRoot = parsed.rootDir ?? rootDir;
    if (!parsed.instruction) {
      console.error('usage: graphflow reflect "<instruction>" [args...] [--json] [--root <dir>]');
      process.exitCode = 1;
      return;
    }
    const result = runTask(effectiveRoot, parsed.instruction, parsed.args);
    console.log(parsed.json ? JSON.stringify(result, null, 2) : result.text);
    if (!result.hit || result.exitCode !== 0) process.exitCode = result.exitCode || 1;
    return;
  }

  if (cmd === "flywheel") {
    const parsed = parseFlywheelArgs(rest);
    const effectiveRoot = parsed.rootDir ?? rootDir;
    if (!Number.isFinite(parsed.ttlDays) || parsed.ttlDays <= 0) {
      console.error(
        `ERR [flywheel] --ttl-days must be a positive number of days (got ${JSON.stringify(
          readFlag(rest, "--ttl-days") ?? "?"
        )}).`
      );
      process.exitCode = 1;
      return;
    }
    const report = inspectFlywheel(effectiveRoot, parsed.ttlDays);
    console.log(`GraphFlow v${PACKAGE_VERSION} — flywheel journal ${report.journalPath}`);
    if (!report.exists) {
      console.log("  journal: missing (nothing to inspect or prune)");
      return;
    }
    const statusDist = Object.keys(report.statusCounts)
      .sort()
      .map((status) => `${status}=${report.statusCounts[status]}`)
      .join(", ");
    console.log(
      `  pending episodes: ${report.pendingTotal}${statusDist ? ` (${statusDist})` : ""}`
    );
    console.log(
      `  oldest pending age: ${
        report.oldestPendingAgeDays === null
          ? "-"
          : `${report.oldestPendingAgeDays.toFixed(1)} days`
      }`
    );
    console.log(`  over TTL (${report.ttlDays} days): ${report.overTtl}`);
    if (report.parseErrors > 0) console.log(`  parse errors (kept as-is): ${report.parseErrors}`);
    if (!parsed.prune) {
      console.log(
        `  (dry run — pass --prune to remove pending episodes older than ${report.ttlDays} days)`
      );
      return;
    }
    const result = pruneFlywheel(effectiveRoot, parsed.ttlDays);
    console.log(
      `OK [flywheel-pruned] pruned=${result.pruned} kept=${result.kept} ` +
        `parseErrors=${result.parseErrors} ttlDays=${result.ttlDays}`
    );
    return;
  }

  if (cmd === "graph" || cmd === "visualize") {
    const res = executeV3ToolCall("gf_macro", { action: "visualize", rootDir }, rootDir);
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "brief") {
    const res = executeV3ToolCall("gf_macro", { action: "brief", rootDir }, rootDir);
    console.log(res.content[0]?.text ?? "");
    return;
  }

  if (cmd === "macro" || cmd === "gf-macro") {
    const action = rest[0] ?? "list";
    const id = rest[1];
    const macroArgs = rest.slice(2).filter((a) => !a.startsWith("-"));
    const res = executeV3ToolCall(
      "gf_macro",
      {
        action,
        ...(id ? { id } : {}),
        ...(macroArgs.length > 0 ? { args: macroArgs } : {}),
        rootDir,
      },
      rootDir
    );
    console.log(res.content[0]?.text ?? "");
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exitCode = 1;
}

// Only auto-run when executed as the CLI entry point. Importing this module
// (e.g. from tests that exercise the pure arg parsers) must stay side-effect free.
const isCliEntryPoint =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isCliEntryPoint) {
  main().catch((err) => {
    console.error("GraphFlow CLI error:", err);
    process.exitCode = 1;
  });
}
