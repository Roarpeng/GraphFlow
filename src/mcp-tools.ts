/**
 * GraphFlow 3.1 — Ultra-Lean MCP Tool Surface (`src/mcp-tools.ts`)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkAndRecordSessionRead,
  recordTestAndCheckCircuitBreaker,
} from "./circuit-breaker.js";
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
  recordEditPatternAndMine,
  recordTrajectoryAndMine,
  registerCustomMacro,
  syncGitCoChangeHabits,
  type MacroKind,
} from "./macro-engine.js";
import {
  generateCrossAgentBrief,
  generateKnowledgeGraphHtml,
  recordCrossAgentActivity,
} from "./doc-graph.js";
import { executeSurgicalRead, getWorkspaceAstIndex, resolveSafeWorkspaceRoot } from "./slicer.js";
import { executeSurgicalEdit, type SingleEditSpec } from "./surgical-edit.js";
import {
  formatHarvestReport,
  formatTaskSummary,
  harvestInstructionLog,
  harvestTaskInstruction,
  listTasks,
  recordTaskUse,
  runTask,
  type TaskStep,
} from "./task-reflector.js";

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
    description: "Read: `targets` (file#sym, file:L1-L2), `q`, `topicId`.",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" } },
        q: { type: "string" },
        topK: { type: "number" },
        skeleton: { type: "boolean" },
        dedup: { type: "boolean" },
        topicId: { type: "string" },
        rootDir: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gf_edit",
    description: "Edit by `symbol`, lines, `oldCode`, `edits`, `renameTo`.",
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
    description: "Run `cmd`/affected-tests dehydrated; preview unless run:true.",
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
    description: "Macros/habits/tasks: list,run,save,mine,mine-git,task-*.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list",
            "run",
            "save",
            "mine",
            "mine-git",
            "visualize",
            "brief",
            "task-list",
            "task-run",
            "task-record",
            "task-harvest",
          ],
        },
        id: { type: "string" },
        kind: { type: "string", enum: ["context-bundle", "command-pipeline", "command-template", "edit-codemod"] },
        steps: { type: "array", items: { type: "string" } },
        args: { type: "array", items: { type: "string" } },
        instruction: { type: "string" },
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
  const rootDir = resolveSafeWorkspaceRoot(
    typeof args.rootDir === "string" ? args.rootDir : undefined,
    defaultRootDir
  );
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
      const topicId =
        typeof args.topicId === "string" && args.topicId.trim()
          ? args.topicId.trim()
          : typeof args.resumeFromTurnId === "string" && args.resumeFromTurnId.trim()
            ? args.resumeFromTurnId.trim()
            : undefined;

      let topicPrefix = "";
      if (topicId) {
        const journalPath = join(rootDir, ".graphflow", "session-journal.jsonl");
        if (existsSync(journalPath)) {
          const lines = readFileSync(journalPath, "utf8").split(/\r?\n/).filter(Boolean);
          const hit = [...lines].reverse().find((l) => l.includes(topicId));
          if (hit) topicPrefix = `// [Topic Resume: ${topicId}] ${hit.slice(0, 240)}\n\n`;
        }
        if (!topicPrefix) {
          topicPrefix = `// [Topic Resume: ${topicId}] Active workbench topic restored.\n\n`;
        }
      }

      const slice = executeSurgicalRead({
        rootDir,
        ...(targets && targets.length > 0 ? { targets } : {}),
        ...(query ? { query } : {}),
        topK,
        includeCallers: true,
        includeSkeleton,
        macroHintLookup: (keys) => findMatchingMacroHint(rootDir, keys),
      });

      if (args.dedup === true && slice.resolvedKeys.length > 0) {
        const key = slice.resolvedKeys.join("|");
        const dedupRes = checkAndRecordSessionRead(
          rootDir,
          sessionId,
          key,
          slice.text,
          slice.estimatedTokens
        );
        if (dedupRes.isDuplicate && dedupRes.dedupNotice) {
          return plainTextResponse(topicPrefix + dedupRes.dedupNotice);
        }
      }

      let promoNote = "";
      if (slice.resolvedKeys.length > 0 && !slice.resolvedKeys.includes("@brief")) {
        recordCrossAgentActivity(rootDir, {
          agentHint: sessionId,
          action: "read",
          summary: `Read ${slice.resolvedKeys.slice(0, 3).join(", ")}`,
          files: slice.resolvedKeys,
          ok: true,
        });
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

      return plainTextResponse((topicPrefix + slice.text + promoNote).trim());
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

      recordCrossAgentActivity(rootDir, {
        agentHint: sessionId,
        action: "edit",
        summary: `${editRes.mode} on ${(editRes.touchedFiles.length > 0 ? editRes.touchedFiles : [editRes.file]).join(", ")}${symbol ? "#" + symbol : ""}`,
        files: editRes.touchedFiles.length > 0 ? editRes.touchedFiles : [editRes.file],
        ok: editRes.ok,
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

      let codemodNote = "";
      if (editRes.ok && oldCode && newCode) {
        const cm = recordEditPatternAndMine(rootDir, file, oldCode, newCode);
        if (cm) {
          codemodNote = `\n// [Auto-Compiled Codemod] Isomorphic edit promoted to '${cm.id}': call gf_macro(action="run", id="${cm.id}", args=["file1", "file2"]) to batch-apply with 0 LLM tokens!`;
        }
      }

      return plainTextResponse(editRes.text + codemodNote);
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
        const suggestedCmd = buildAffectedTestCommand(affectedTests, rootDir);
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

      if (args.run !== true) {
        return plainTextResponse(
          `# Preview (not executed)\nCmd: ${cmd}\nPass run: true to execute.`
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

      // Only test-like commands (test/vitest/jest/pytest/ctest/go|cargo|dotnet test) update [Last Test Status].
      const looksLikeTestCmd = /test|jest/i.test(cmd);
      recordCrossAgentActivity(rootDir, {
        agentHint: sessionId,
        action: "exec",
        summary: `Ran '${cmd}' (exit=${execRes.exitCode})`,
        files: [],
        ok: execRes.ok,
        ...(looksLikeTestCmd
          ? {
              lastTestCommand: cmd,
              lastTestOk: execRes.ok,
              lastTestSummary: execRes.text.split("\n")[0] ?? "",
            }
          : {}),
      });
      const cb = recordTestAndCheckCircuitBreaker(rootDir, sessionId, cmd, execRes.ok);
      const cbNote = cb.tripped && cb.rescuePacket ? `\n\n${cb.rescuePacket}` : "";
      const promoNote =
        newlyCompiled.length > 0
          ? `\n// [Auto-Recorded Tool] Pattern compiled into macro '${newlyCompiled[0]!.id}' (${newlyCompiled[0]!.kind}: ${newlyCompiled[0]!.scriptPath})`
          : "";

      return plainTextResponse(execRes.text + cbNote + promoNote);
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

      if (action === "visualize") {
        const viz = generateKnowledgeGraphHtml(getWorkspaceAstIndex(rootDir));
        return plainTextResponse(
          `OK [knowledge-graph] Generated interactive HTML graph (${viz.nodeCount} nodes, ${viz.edgeCount} edges) -> ${viz.htmlPath}`
        );
      }
      if (action === "brief") {
        return plainTextResponse(generateCrossAgentBrief(getWorkspaceAstIndex(rootDir)));
      }
      if (action === "mine-git") {
        const gitRes = syncGitCoChangeHabits(rootDir);
        return plainTextResponse(
          `PASS [mine-git] Scanned ${gitRes.commitsScanned} git commit(s): added ${gitRes.addedCoEdits} temporal co-change habit(s) (${gitRes.totalCoEdits} total coEdits).`
        );
      }

      if (action === "task-list") {
        const tasks = listTasks(rootDir);
        if (tasks.length === 0) {
          return plainTextResponse(
            "# Reflected Tasks (0 recorded yet — record the same instruction with its steps twice to compile a local runner)"
          );
        }
        return plainTextResponse(
          `# Reflected Tasks (${tasks.length}):\n${tasks.map((task) => formatTaskSummary(task)).join("\n")}`
        );
      }

      if (action === "task-record") {
        const instruction =
          typeof args.instruction === "string" && args.instruction.trim()
            ? args.instruction
            : typeof args.id === "string"
              ? args.id
              : "";
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        const steps: TaskStep[] = rawSteps.filter(
          (step): step is string => typeof step === "string" && step.trim().length > 0
        );
        if (!instruction.trim()) {
          return plainTextResponse(
            'ERR [task-record] Provide `instruction` (and `steps` array of shell commands).'
          );
        }
        if (steps.length === 0) {
          return plainTextResponse(
            "ERR [task-record] Provide a non-empty `steps` array of shell command strings."
          );
        }
        try {
          const taskArgs = Array.isArray(args.args)
            ? args.args.filter((arg): arg is string => typeof arg === "string")
            : [];
          const record = recordTaskUse(rootDir, instruction, steps, {
            ...(taskArgs.length > 0 ? { args: taskArgs } : {}),
          });
          return plainTextResponse(
            `OK [task-recorded] id=${record.id} uses=${record.count}/${2} ` +
              `${record.scriptPath ? `compiled=${record.scriptPath}` : "not-compiled-yet"} ` +
              `instruction=${JSON.stringify(record.instructionRaw)}`
          );
        } catch (error) {
          return plainTextResponse(
            `ERR [task-record] ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (action === "task-run") {
        const target =
          typeof args.instruction === "string" && args.instruction.trim()
            ? args.instruction
            : typeof args.id === "string"
              ? args.id.trim()
              : "";
        if (!target) {
          return plainTextResponse(
            'ERR [task-run] Provide `instruction` (exact/near match) or `id` of a reflected task.'
          );
        }
        const runArgs = Array.isArray(args.args)
          ? args.args.filter((arg): arg is string => typeof arg === "string")
          : [];
        const res = runTask(rootDir, target, runArgs);
        return plainTextResponse(res.text);
      }

      if (action === "task-harvest") {
        const instruction = typeof args.instruction === "string" ? args.instruction : "";
        const rawSteps = Array.isArray(args.steps) ? args.steps : [];
        const steps: TaskStep[] = rawSteps.filter(
          (step): step is string => typeof step === "string" && step.trim().length > 0
        );
        try {
          if (instruction.trim() && steps.length > 0) {
            const harvested = harvestTaskInstruction(rootDir, instruction, steps);
            return plainTextResponse(
              formatHarvestReport(harvested.report, harvested.record)
            );
          }
          const report = harvestInstructionLog(rootDir);
          return plainTextResponse(formatHarvestReport(report));
        } catch (error) {
          return plainTextResponse(
            `ERR [task-harvest] ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (action === "save") {
        const id = typeof args.id === "string" ? args.id.trim() : undefined;
        const kind: MacroKind =
          args.kind === "command-pipeline"
            ? "command-pipeline"
            : args.kind === "command-template"
              ? "command-template"
              : args.kind === "edit-codemod"
                ? "edit-codemod"
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

      return plainTextResponse(
        `ERR [unknown-action] '${action}'. Use 'list', 'run', 'save', 'mine', 'mine-git', 'task-list', 'task-run', 'task-record', or 'task-harvest'.`
      );
    }

    default:
      return plainTextResponse(`ERR [unknown-v3-tool] '${name}'`);
  }
}
