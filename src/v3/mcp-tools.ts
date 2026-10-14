/**
 * GraphFlow 3.0 — Ultra-Lean MCP Tool Surface (`src/v3/mcp-tools.ts`)
 */

import {
  buildAffectedTestCommand,
  execAndDehydrate,
  recallArchivedOutput,
  resolveAffectedTests,
} from "./dehydrator.js";
import {
  evaluatePostEditHabits,
  executeMacro,
  findMatchingMacroHint,
  loadMacroStore,
  mineAndCompileMacros,
  recordTrajectoryAndMine,
  registerCustomMacro,
  type MacroKind,
} from "./macro-engine.js";
import { executeSurgicalRead } from "./slicer.js";
import { executeSurgicalEdit, type SingleEditSpec } from "./surgical-edit.js";

export interface V3ToolDefinition {
  name: "gf_read" | "gf_edit" | "gf_exec" | "gf_macro";
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const V3_TOOL_DEFINITIONS: readonly V3ToolDefinition[] = [
  {
    name: "gf_read",
    description:
      "Surgical read: `targets` (['file#sym', 'file:L1-L2', 'file']) or `q`. Returns code + types + callers. `q` + `topicId`/`resumeFromTurnId` resumes workbench/dialogue memory context.",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" } },
        q: { type: "string" },
        topK: { type: "number" },
        skeleton: { type: "boolean" },
        topicId: { type: "string", description: "Workbench topic to resume (requires q)." },
        resumeFromTurnId: { type: "string", description: "Dialogue turn to resume from (requires q)." },
        rootDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gf_edit",
    description:
      "Surgical edit by `symbol`, `startLine`+`endLine`, `oldCode`, `edits`, or `renameTo` with AST guard.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        symbol: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        oldCode: { type: "string" },
        newCode: { type: "string" },
        renameTo: { type: "string" },
        edits: { type: "array", items: { type: "object" } },
        rootDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gf_exec",
    description:
      "Run `cmd` (or 'affected-tests') with dehydrated output, or `handle` to recall raw log.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        run: { type: "boolean" },
        changedFiles: { type: "array", items: { type: "string" } },
        handle: { type: "string" },
        range: { type: "array", items: { type: "number" } },
        rootDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gf_macro",
    description:
      "Manage or run auto-compiled macros & habits ('list'|'run'|'save'|'mine').",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "run", "save", "mine"] },
        id: { type: "string" },
        kind: { type: "string", enum: ["context-bundle", "command-pipeline", "command-template"] },
        steps: { type: "array", items: { type: "string" } },
        args: { type: "array", items: { type: "string" } },
        rootDir: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

export interface V3ToolCallResponse {
  content: Array<{ type: "text"; text: string }>;
}

function plainTextResponse(text: string): V3ToolCallResponse {
  return {
    content: [{ type: "text", text }],
  };
}

export function executeV3ToolCall(
  name: string,
  args: Record<string, unknown> = {},
  defaultRootDir: string = process.cwd()
): V3ToolCallResponse {
  const rootDir =
    typeof args.rootDir === "string" && args.rootDir.trim()
      ? args.rootDir.trim()
      : defaultRootDir;
  const sessionId =
    typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : "main";

  switch (name) {
    case "gf_read": {
      const targets = Array.isArray(args.targets)
        ? args.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : undefined;
      const query = typeof args.q === "string" && args.q.trim() ? args.q.trim() : undefined;
      const topK = typeof args.topK === "number" ? args.topK : 3;
      const includeSkeleton = args.skeleton === true;

      const slice = executeSurgicalRead({
        rootDir,
        ...(targets && targets.length > 0 ? { targets } : {}),
        ...(query ? { query } : {}),
        topK,
        includeCallers: true,
        includeSkeleton,
        macroHintLookup: (keys) => findMatchingMacroHint(rootDir, keys),
      });

      let promoNote = "";
      if (slice.resolvedKeys.length > 0) {
        const { newlyCompiled } = recordTrajectoryAndMine(rootDir, {
          sessionId,
          kind: "read",
          key: slice.resolvedKeys.join("|"),
          items: slice.resolvedKeys,
          ok: true,
        });
        if (newlyCompiled.length > 0) {
          promoNote =
            `\n\n// [Auto-Recorded Tool] Repeated pattern promoted to macro '${newlyCompiled[0]!.id}': ` +
            `call gf_macro(action="run", id="${newlyCompiled[0]!.id}") next time!`;
        }
      }

      return plainTextResponse(slice.text + promoNote);
    }

    case "gf_edit": {
      const file = typeof args.file === "string" ? args.file.trim() : "";
      const newCode = typeof args.newCode === "string" ? args.newCode : undefined;
      const symbol = typeof args.symbol === "string" && args.symbol.trim() ? args.symbol.trim() : undefined;
      const startLine = typeof args.startLine === "number" ? args.startLine : undefined;
      const endLine = typeof args.endLine === "number" ? args.endLine : undefined;
      const oldCode = typeof args.oldCode === "string" ? args.oldCode : undefined;
      const renameTo = typeof args.renameTo === "string" && args.renameTo.trim() ? args.renameTo.trim() : undefined;
      const edits = Array.isArray(args.edits) ? (args.edits as SingleEditSpec[]) : undefined;

      const editRes = executeSurgicalEdit({
        rootDir,
        file,
        ...(symbol ? { symbol } : {}),
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        ...(oldCode !== undefined ? { oldCode } : {}),
        ...(newCode !== undefined ? { newCode } : {}),
        ...(renameTo ? { renameTo } : {}),
        ...(edits ? { edits } : {}),
        habitHook: (touchedFiles) => evaluatePostEditHabits(rootDir, touchedFiles, true),
      });

      for (const tf of editRes.touchedFiles.length > 0 ? editRes.touchedFiles : [editRes.file]) {
        const targetKey = symbol && tf === editRes.file ? `${tf}#${symbol}` : tf;
        recordTrajectoryAndMine(rootDir, {
          sessionId,
          kind: "edit",
          key: targetKey,
          items: [targetKey],
          ok: editRes.ok,
        });
      }

      return plainTextResponse(editRes.text);
    }

    case "gf_exec": {
      const handle = typeof args.handle === "string" && args.handle.trim() ? args.handle.trim() : undefined;
      if (handle) {
        const range = Array.isArray(args.range) ? args.range : [];
        const startLine = typeof range[0] === "number" ? range[0] : 1;
        const endLine = typeof range[1] === "number" ? range[1] : startLine + 100;
        return plainTextResponse(recallArchivedOutput(rootDir, handle, startLine, endLine));
      }

      const cmd = typeof args.cmd === "string" && args.cmd.trim() ? args.cmd.trim() : "affected-tests";
      const changedFiles = Array.isArray(args.changedFiles)
        ? args.changedFiles.filter((f): f is string => typeof f === "string")
        : undefined;

      if (cmd === "affected-tests" || cmd === "run-affected-tests") {
        const { changedFiles: resolvedChanges, affectedTests } = resolveAffectedTests(
          rootDir,
          changedFiles
        );
        if (affectedTests.length === 0) {
          return plainTextResponse(
            `PASS [affected-tests] 0 test files affected by changes (${resolvedChanges.length} changed file(s)).`
          );
        }
        const suggestedCmd = buildAffectedTestCommand(affectedTests);
        if (args.run === true || cmd === "run-affected-tests") {
          const runRes = execAndDehydrate({ rootDir, command: suggestedCmd });
          return plainTextResponse(
            `# Affected Tests Executed (${affectedTests.join(", ")}):\n${runRes.text}`
          );
        }
        return plainTextResponse(
          `# Affected Tests (${affectedTests.length} test file(s) from ${resolvedChanges.length} changed file(s)):\n` +
            affectedTests.map((t) => `- ${t}`).join("\n") +
            `\nRun Command: ${suggestedCmd}`
        );
      }

      const execRes = execAndDehydrate({ rootDir, command: cmd });
      const { newlyCompiled } = recordTrajectoryAndMine(rootDir, {
        sessionId,
        kind: "exec",
        key: cmd,
        items: [cmd],
        ok: execRes.ok,
      });

      const promoNote =
        newlyCompiled.length > 0
          ? `\n// [Auto-Recorded Tool] Pattern compiled into macro '${newlyCompiled[0]!.id}' (${newlyCompiled[0]!.kind}: ${newlyCompiled[0]!.scriptPath})`
          : "";

      return plainTextResponse(execRes.text + promoNote);
    }

    case "gf_macro": {
      const action = typeof args.action === "string" ? args.action : "list";
      if (action === "list") {
        const { macros, habits } = loadMacroStore(rootDir);
        const lines: string[] = [];
        if (macros.length === 0 && habits.coEdits.length === 0 && habits.dirVerifyCommands.length === 0) {
          return plainTextResponse("# Macros & Habits (0 recorded yet — repeated reads/edits/execs auto-compile after 2 uses)");
        }
        if (macros.length > 0) {
          lines.push(`# Compiled Deterministic Macros (${macros.length}):`);
          for (const m of macros) {
            lines.push(
              `- ${m.id} [${m.kind}, uses=${m.occurrences}]: ${m.description}` +
                (m.scriptPath ? ` (script: ${m.scriptPath})` : "")
            );
          }
        }
        if (habits.coEdits.length > 0 || habits.dirVerifyCommands.length > 0) {
          lines.push(`# Learned User Habits:`);
          for (const ce of habits.coEdits) {
            lines.push(`- [co-edit ${ce.coEditCount}x] ${ce.fileA} <-> ${ce.fileB}`);
          }
          for (const dv of habits.dirVerifyCommands) {
            lines.push(`- [auto-verify ${dv.count}x] dir '${dv.dirPrefix}' -> \`${dv.command}\``);
          }
        }
        return plainTextResponse(lines.join("\n"));
      }

      if (action === "mine") {
        const newly = mineAndCompileMacros(rootDir);
        const { macros } = loadMacroStore(rootDir);
        return plainTextResponse(
          `Mined trajectories: ${newly.length} new macro(s) compiled (${macros.length} total).`
        );
      }

      if (action === "save") {
        const id = typeof args.id === "string" ? args.id.trim() : undefined;
        const kind: MacroKind =
          args.kind === "command-pipeline"
            ? "command-pipeline"
            : args.kind === "command-template"
              ? "command-template"
              : "context-bundle";
        const steps = Array.isArray(args.steps)
          ? args.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          : [];
        if (steps.length === 0) {
          return plainTextResponse("ERR [invalid-macro] Provide non-empty 'steps' array.");
        }
        const saved = registerCustomMacro(rootDir, {
          ...(id ? { id } : {}),
          name: id ?? `custom_${kind}`,
          kind,
          steps,
        });
        return plainTextResponse(
          `OK [macro-saved] id=${saved.id} kind=${saved.kind} steps=${saved.steps.length} script=${saved.scriptPath}`
        );
      }

      if (action === "run") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) {
          return plainTextResponse("ERR [missing-id] Provide macro 'id' to run.");
        }
        const templateArgs = Array.isArray(args.args)
          ? args.args.filter((a): a is string => typeof a === "string")
          : [];
        const res = executeMacro(rootDir, id, templateArgs);
        return plainTextResponse(res.text);
      }

      return plainTextResponse(`ERR [unknown-action] '${action}'. Use 'list', 'run', 'save', or 'mine'.`);
    }

    default:
      return plainTextResponse(`ERR [unknown-v3-tool] '${name}'`);
  }
}
