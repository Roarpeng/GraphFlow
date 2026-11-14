/**
 * GraphFlow 3.1 — Ultra-Lean MCP Tool Surface (`src/mcp-tools.ts`)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkAndRecordSessionRead,
  recordTestAndCheckCircuitBreaker,
  shouldStopRepeatedFailure,
  recordFailureOverride,
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
  findCommandMacro,
  findMatchingMacroHint,
  loadMacroStore,
  mineAndCompileMacros,
  recordEditPatternAndMine,
  recordTrajectoryAndMine,
  registerCustomMacro,
  setMacroTrust,
  verifyMacroRecipe,
  runVerifiedRecipe,
  syncGitCoChangeHabits,
  type MacroKind,
} from "./macro-engine.js";
import { getAgentRegistrationStatus } from "./agent-installer.js";
import { describeBranchScope } from "./branch-scope.js";
import {
  generateCrossAgentBrief,
  generateKnowledgeGraphHtml,
  recordCrossAgentActivity,
} from "./doc-graph.js";
import {
  discoverCandidateWorkspaces,
  executeSurgicalRead,
  getWorkspaceAstIndex,
  isExplicitRootDirValid,
  recordActiveWorkspace,
  resolveSmartWorkspaceRoot,
  setSessionStickyWorkspaceRoot,
  type SmartWorkspaceResolveOptions,
} from "./slicer.js";
import { executeSurgicalEdit, type SingleEditSpec } from "./surgical-edit.js";
import {
  autoLogExecutedCommand,
  formatHarvestReport,
  formatTaskSummary,
  harvestInstructionLog,
  harvestTaskInstruction,
  listTasks,
  recordTaskUse,
  runTask,
  type TaskStep,
} from "./task-reflector.js";
import { PACKAGE_VERSION } from "./version.js";
import { appendToolEvidence, type ToolEvidence } from "./evidence-ledger.js";
import { continueReadReceipt, createReadReceipt } from "./read-receipt.js";
import { contentSha256 } from "./edit-transaction.js";
import { changedContentHash, failureFingerprint } from "./test-evidence.js";
import { escalateReadReferences } from "./lsp-escalation.js";

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
    description: "Read.",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" } },
        q: { type: "string" },
        topK: {},
        skeleton: {},
        dedup: {},
        detail: {},
        maxOutputTokens: {},
        sinceReceipt: {},
        cursor: {},
        topicId: {},
        rootDir: { type: "string" },
      },
    },
  },
  {
    name: "gf_edit",
    description: "Edit.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        symbol: { type: "string" },
        startLine: {},
        endLine: {},
        oldCode: {},
        newCode: { type: "string" },
        renameTo: {},
        edits: { type: "array", items: { type: "object" } },
        mode: { type: "string", enum: ["prepare", "commit"] },
        proposalId: { type: "string" },
        expectedSha256: { type: "string" },
        policy: { type: "string", enum: ["strict", "warn"] },
        rootDir: { type: "string" },
      },
    },
  },
  {
    name: "gf_exec",
    description: "Exec.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
        run: { type: "boolean" },
        changedFiles: { type: "array", items: { type: "string" } },
        handle: { type: "string" },
        range: { type: "array", items: { type: "number" } },
        timeoutMs: { type: "number" },
        planOnly: { type: "boolean" },
        verifyLevel: { type: "string" },
        overrideFailureStop: { type: "boolean" },
        overrideReason: { type: "string" },
        rootDir: { type: "string" },
      },
    },
  },
  {
    name: "gf_macro",
    description: "Macro.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "run", "propose", "approve", "activate", "revoke", "verify", "recipe-run", "save", "mine", "mine-git", "visualize", "brief", "task-list", "task-run", "task-record", "task-harvest"] },
        id: { type: "string" },
        dryRun: { type: "boolean" },
        autoRun: { type: "boolean" },
        kind: { type: "string" },
        steps: { type: "array", items: { type: "string" } },
        args: { type: "array", items: { type: "string" } },
        instruction: { type: "string" },
        rootDir: { type: "string" },
      },
      required: ["action"],
    },
  },
];

export interface V3ToolCallResponse {
  content: Array<{ type: "text"; text: string }>;
  /** Not part of the tools/list schema. MCP task-run uses this for exitCode. */
  structuredContent?: Record<string, unknown>;
  /** Set for protocol-level tool failures (unknown tool, unknown action). */
  isError?: boolean;
}

function plainTextResponse(text: string): V3ToolCallResponse {
  return {
    content: [{ type: "text", text }],
  };
}

function executeV3ToolCallCore(
  name: string,
  args: Record<string, unknown> = {},
  defaultRootDir: string = process.cwd(),
  resolveOpts?: SmartWorkspaceResolveOptions
): V3ToolCallResponse {
  const resolvedRoot = resolveSmartWorkspaceRoot(args, defaultRootDir, resolveOpts);
  let rootDir = resolvedRoot.rootDir;
  const sessionId =
    typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : "main";

  switch (name) {
    case "gf_read": {
      const maxOutputTokens = typeof args.maxOutputTokens === "number" && Number.isFinite(args.maxOutputTokens)
        ? Math.max(0, Math.floor(args.maxOutputTokens)) : undefined;
      if (typeof args.cursor === "string") {
        const continued = continueReadReceipt(rootDir, args.cursor, maxOutputTokens);
        return { content: [{ type: "text", text: continued.text }], structuredContent: { tool: "gf_read", ok: Boolean(continued.receiptId), ...continued } };
      }
      const detail = args.detail === "locate" || args.detail === "summary" || args.detail === "code" || args.detail === "closure" ? args.detail : "closure";
      const targets = Array.isArray(args.targets)
        ? args.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : undefined;
      const query = typeof args.q === "string" && args.q.trim() ? args.q.trim() : undefined;
      const topK =
        typeof args.topK === "number" && Number.isFinite(args.topK) && args.topK > 0
          ? Math.floor(args.topK)
          : undefined;
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

      let slice = executeSurgicalRead({
        rootDir,
        ...(targets && targets.length > 0 ? { targets } : {}),
        ...(query ? { query } : {}),
        ...(topK !== undefined ? { topK } : {}),
        includeCallers: detail === "closure",
        includeTypeClosure: detail === "closure",
        includeSkeleton,
        macroHintLookup: (keys) => findMatchingMacroHint(rootDir, keys),
      });

      if (
        query &&
        (!targets || targets.length === 0) &&
        !isExplicitRootDirValid(typeof args.rootDir === "string" ? args.rootDir : undefined) &&
        slice.matchedSymbols.length === 0
      ) {
        for (const candidate of discoverCandidateWorkspaces(defaultRootDir)) {
          const candidateSlice = executeSurgicalRead({
            rootDir: candidate,
            query,
            ...(topK !== undefined ? { topK } : {}),
            includeCallers: detail === "closure",
            includeTypeClosure: detail === "closure",
            includeSkeleton,
            macroHintLookup: (keys) => findMatchingMacroHint(candidate, keys),
          });
          if (candidateSlice.matchedSymbols.length > 0) {
            rootDir = candidate;
            slice = candidateSlice;
            setSessionStickyWorkspaceRoot(defaultRootDir, candidate);
            recordActiveWorkspace(candidate);
            break;
          }
        }
      }

      if (detail === "locate" || detail === "summary") {
        const index = getWorkspaceAstIndex(rootDir);
        slice.text = slice.matchedSymbols.length > 0
          ? slice.matchedSymbols.map((s) => {
              if (detail === "locate") return `${s.file}:${s.line}-${s.endLine} ${s.kind} ${s.name}`;
              const signature = index.getFileAnalysis(s.file)?.ast.symbols.find((item) => item.name === s.name && item.line === s.line)?.signature ?? s.name;
              return `${s.file}:${s.line}-${s.endLine} ${signature}`;
            }).join("\n") : slice.text;
      }

      if (args.dedup === true && maxOutputTokens === undefined && args.sinceReceipt === undefined && args.detail === undefined && slice.resolvedKeys.length > 0) {
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

      const finalText = (topicPrefix + slice.text + promoNote).trim();
      if (maxOutputTokens !== undefined || typeof args.sinceReceipt === "string" || args.detail !== undefined) {
        const receipt = createReadReceipt(rootDir, slice.resolvedKeys, finalText, maxOutputTokens,
          typeof args.sinceReceipt === "string" ? args.sinceReceipt : undefined);
        return { content: [{ type: "text", text: receipt.text }],
          structuredContent: { tool: "gf_read", ok: true, receiptId: receipt.receiptId, contentHash: receipt.contentHash,
            omitted: receipt.omitted, truncated: receipt.truncated, ...(receipt.nextCursor ? { nextCursor: receipt.nextCursor } : {}) } };
      }
      return plainTextResponse(finalText);
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
      const mode = args.mode === "prepare" || args.mode === "commit" ? args.mode : undefined;
      const proposalId = typeof args.proposalId === "string" ? args.proposalId : undefined;
      const expectedSha256 = typeof args.expectedSha256 === "string" || (typeof args.expectedSha256 === "object" && args.expectedSha256 !== null)
        ? args.expectedSha256 as string | Record<string, string> : undefined;
      const policy = args.policy === "warn" ? "warn" : "strict";

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
        ...(mode ? { mode } : {}),
        ...(proposalId ? { proposalId } : {}),
        ...(expectedSha256 ? { expectedSha256 } : {}),
        policy,
        habitHook: (touchedFiles) => evaluatePostEditHabits(rootDir, touchedFiles, true),
      });

      if (editRes.status !== "PREPARED") recordCrossAgentActivity(rootDir, {
        agentHint: sessionId,
        action: "edit",
        summary: `${editRes.mode} on ${(editRes.touchedFiles.length > 0 ? editRes.touchedFiles : [editRes.file]).join(", ")}${symbol ? "#" + symbol : ""}`,
        files: editRes.touchedFiles.length > 0 ? editRes.touchedFiles : [editRes.file],
        ok: editRes.ok,
      });
      if (editRes.status === "COMMITTED") for (const tf of editRes.touchedFiles) {
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
      if (editRes.status === "COMMITTED" && oldCode && newCode) {
        const cm = recordEditPatternAndMine(rootDir, file, oldCode, newCode);
        if (cm) {
          codemodNote = `\n// [Auto-Compiled Codemod] Isomorphic edit promoted to '${cm.id}': call gf_macro(action="run", id="${cm.id}", args=["file1", "file2"]) to batch-apply with 0 LLM tokens!`;
        }
      }

      const proposedFiles = Object.keys(editRes.baseHashes ?? {});
      const proposedTests = editRes.status === "PREPARED" ? resolveAffectedTests(rootDir, proposedFiles).affectedTests : [];
      const risk = editRes.mode === "rename" || editRes.diagnostics.some((d) => d.severity === "error") ? "high"
        : proposedFiles.length > 1 || editRes.diagnostics.length > 0 ? "medium" : "low";
      return { content: [{ type: "text", text: editRes.text + (editRes.diff ? `\n${editRes.diff}` : "") + codemodNote }],
        structuredContent: { tool: "gf_edit", ok: editRes.ok, status: editRes.status ?? (editRes.ok ? "COMMITTED" : "REJECTED"),
          touchedFiles: editRes.touchedFiles, ...(editRes.proposalId ? { proposalId: editRes.proposalId } : {}),
          ...(editRes.baseHashes ? { baseHashes: editRes.baseHashes } : {}),
          ...(editRes.diff ? { diff: editRes.diff } : {}),
          risk, blocking: editRes.diagnostics.filter((d) => d.severity === "error"), proposedTests,
          ...(editRes.recoveryId ? { recoveryId: editRes.recoveryId } : {}) } };
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

      if (/^(?:graphflow\s+)?(?:status|doctor)(?:\s+--[\w-]+(?:\s+\S+)?)*$/i.test(cmd)) {
        const index = getWorkspaceAstIndex(rootDir);
        const files = index.getFiles();
        let symbolCount = 0;
        for (const relPath of files) {
          const analysis = index.getFileAnalysis(relPath);
          if (analysis) symbolCount += analysis.ast.symbols.length;
        }
        const { macros, habits } = loadMacroStore(rootDir);
        const hasGraphflowDir = existsSync(join(rootDir, ".graphflow"));
        const statuses = getAgentRegistrationStatus({ workspaceRoot: rootDir });
        const mark = (ok: boolean | undefined) => (ok ? "✓" : "-");
        const agentLines = statuses.map(
          (s) =>
            `  [MCP ${mark(s.mcp)}] [Skill ${mark(s.skill)}] [Rule ${mark(s.rule)}] [Hook ${mark(s.hook)}] ${s.name} (${s.id})`
        );
        const statusText = [
          `PASS [graphflow-status] v${PACKAGE_VERSION} | rootDir: ${rootDir} (source: ${resolvedRoot.source})`,
          `Index: ${files.length} source file(s), ${symbolCount} symbol(s) | .graphflow: ${hasGraphflowDir ? "present" : "missing"} | macros: ${macros.length}, coEdits: ${habits.coEdits.length}`,
          `Graph scope: ${describeBranchScope(rootDir)}`,
          `Detected agents (${statuses.length}):`,
          ...(agentLines.length > 0 ? agentLines : ["  (no known coding agent directories detected)"]),
        ].join("\n");
        return {
          content: [{ type: "text", text: statusText }],
          structuredContent: {
            tool: "gf_exec",
            ok: true,
            exitCode: 0,
            rootDir,
            rootDirSource: resolvedRoot.source,
          },
        };
      }

      if (cmd === "affected-tests" || cmd === "run-affected-tests") {
        const { changedFiles: resolvedChanges, affectedTests } = resolveAffectedTests(
          rootDir,
          changedFiles
        );
        const verifyLevel = args.verifyLevel === "full" || args.verifyLevel === "safe" ? args.verifyLevel : "fast";
        const packagePath = join(rootDir, "package.json");
        let hasFullSuite = false;
        try { hasFullSuite = typeof JSON.parse(readFileSync(packagePath, "utf8")).scripts?.test === "string"; } catch { /* no package script */ }
        const useFull = verifyLevel === "full" || (verifyLevel === "safe" && affectedTests.length === 0 && hasFullSuite);
        const selectedTests = useFull && hasFullSuite ? ["<npm test full suite>"] : affectedTests;
        const suggestedCmd = useFull && hasFullSuite ? "npm test" : buildAffectedTestCommand(affectedTests, rootDir);
        const coverageStatus = affectedTests.length > 0 ? "TARGETED" : "UNKNOWN";
        const plan = { selectedTests, selectionReasons: selectedTests.map((test) => `${test}: ${useFull ? "full-suite verification" : "reverse import or test-name match (up to 6 hops)"}`),
          coverageStatus, uncoveredRisk: affectedTests.length === 0 ? "No matching test files found" : "Heuristic routing may miss dynamic dependencies",
          planHash: `sha256:${contentSha256(JSON.stringify([resolvedChanges, selectedTests, suggestedCmd]))}` };
        if (args.planOnly === true) return { content: [{ type: "text", text: JSON.stringify(plan) }],
          structuredContent: { tool: "gf_exec", ok: true, status: "UNKNOWN", ...plan } };
        if (affectedTests.length === 0) {
          if (!useFull || !hasFullSuite) return { content: [{ type: "text", text:
            `NONE [affected-tests] 0 test files matched ${resolvedChanges.length} changed file(s). ` +
              `If you expected hits, check the test directory/naming convention (test/, tests/, __tests__, *.test.*, *_test.*).`
          }], structuredContent: { tool: "gf_exec", ok: false, status: "NO_TESTS", ...plan } };
        }
        if (args.run === true || cmd === "run-affected-tests") {
          const patchHash = changedContentHash(rootDir, resolvedChanges);
          if (args.overrideFailureStop === true && (typeof args.overrideReason !== "string" || !args.overrideReason.trim()))
            return plainTextResponse("REJECTED [missing-override-reason] Provide overrideReason.");
          if (args.overrideFailureStop !== true && shouldStopRepeatedFailure(rootDir, sessionId, suggestedCmd, patchHash))
            return { content: [{ type: "text", text: "REJECTED [repeated-failure] Same command, patch and failure occurred 3 times; inspect the diagnostic packet or pass overrideFailureStop with a reason." }],
              structuredContent: { tool: "gf_exec", ok: false, status: "UNKNOWN", ...plan } };
          if (args.overrideFailureStop === true) recordFailureOverride(rootDir, suggestedCmd, args.overrideReason as string);
          const runRes = execAndDehydrate({
            rootDir,
            command: suggestedCmd,
            ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          });
          const instruction = typeof args.instruction === "string" ? args.instruction : undefined;
          autoLogExecutedCommand(rootDir, suggestedCmd, {
            ...(instruction ? { instruction } : {}),
          });
          const status = runRes.exitCode === 124 ? "TIMEOUT" : runRes.ok ? "PASS" : "FAIL";
          const fingerprint = runRes.ok ? undefined : failureFingerprint(rootDir, suggestedCmd, runRes.text, resolvedChanges);
          const cb = recordTestAndCheckCircuitBreaker(rootDir, sessionId, suggestedCmd, runRes.ok, 3, fingerprint, patchHash);
          return {
            content: [
              { type: "text", text: `# Affected Tests Executed (${affectedTests.join(", ")}):\n${runRes.text}` },
            ],
            structuredContent: { tool: "gf_exec", ok: runRes.ok, exitCode: runRes.exitCode, status,
              ...(fingerprint ? { failureFingerprint: fingerprint } : {}),
              ...(runRes.handle ? { rawLogHandle: runRes.handle } : {}),
              ...(cb.tripped ? { repeatedFailure: true } : {}), ...plan },
          };
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

      const currentChanges = changedFiles ?? resolveAffectedTests(rootDir).changedFiles;
      const patchHash = changedContentHash(rootDir, currentChanges);
      if (args.overrideFailureStop === true && (typeof args.overrideReason !== "string" || !args.overrideReason.trim()))
        return plainTextResponse("REJECTED [missing-override-reason] Provide overrideReason.");
      if (args.overrideFailureStop !== true && shouldStopRepeatedFailure(rootDir, sessionId, cmd, patchHash)) {
        return { content: [{ type: "text", text: "REJECTED [repeated-failure] Same command, patch and failure occurred 3 times. Review diagnostics or pass overrideFailureStop with a reason." }],
          structuredContent: { tool: "gf_exec", ok: false, status: "UNKNOWN" } };
      }
      if (args.overrideFailureStop === true) recordFailureOverride(rootDir, cmd, args.overrideReason as string);

      const execRes = execAndDehydrate({
        rootDir,
        command: cmd,
        ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
      });
      const runInstruction = typeof args.instruction === "string" ? args.instruction : undefined;
      autoLogExecutedCommand(rootDir, cmd, {
        ...(runInstruction ? { instruction: runInstruction } : {}),
      });
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
      const fingerprint = execRes.ok ? undefined : failureFingerprint(rootDir, cmd, execRes.text, currentChanges);
      const cb = recordTestAndCheckCircuitBreaker(rootDir, sessionId, cmd, execRes.ok, 3, fingerprint, patchHash);
      const cbNote = cb.tripped && cb.rescuePacket ? `\n\n${cb.rescuePacket}` : "";
      const promoNote =
        newlyCompiled.length > 0
          ? `\n// [Auto-Recorded Tool] Pattern compiled into macro '${newlyCompiled[0]!.id}' (${newlyCompiled[0]!.kind}: ${newlyCompiled[0]!.scriptPath})`
          : "";
      // A command that already has a local script should never be re-derived:
      // point the agent at the one-call local tool instead.
      const knownMacro = findCommandMacro(rootDir, cmd);
      const localToolNote = knownMacro
        ? `\n// [Local Tool Ready] '${cmd}' is already compiled as '${knownMacro.id}' (${knownMacro.kind}, used ${knownMacro.occurrences}x)` +
          ` -> gf_macro(action="run", id="${knownMacro.id}") runs it locally, no re-derivation.`
        : "";

      return {
        content: [{ type: "text", text: execRes.text + cbNote + promoNote + localToolNote }],
        structuredContent: { tool: "gf_exec", ok: execRes.ok, exitCode: execRes.exitCode,
          status: execRes.exitCode === 124 ? "TIMEOUT" : execRes.ok ? "PASS" : "FAIL",
          ...(fingerprint ? { failureFingerprint: fingerprint } : {}),
          ...(execRes.handle ? { rawLogHandle: execRes.handle } : {}) },
      };
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
              `- ${m.id} [${m.kind}, state=${m.state ?? "discovered"}, uses=${m.occurrences}${m.verifiedRecipe ? ", verified" : ""}]: ${m.description}` +
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
        return {
          ...plainTextResponse(res.text),
          structuredContent: {
            exitCode: res.exitCode,
            hit: res.hit,
            ...(res.score !== undefined ? { score: res.score } : {}),
            ...(res.taskId ? { taskId: res.taskId } : {}),
            ...(res.matchedBy ? { matchedBy: res.matchedBy } : {}),
          },
        };
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
        const res = executeMacro(rootDir, id, templateArgs, args.dryRun === true);
        return plainTextResponse(res.text);
      }

      if (action === "verify") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const command = Array.isArray(args.steps) && typeof args.steps[0] === "string" ? args.steps[0] : "";
        const result = verifyMacroRecipe(rootDir, id, command);
        return plainTextResponse(result.text);
      }
      if (action === "recipe-run") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const templateArgs = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
        return plainTextResponse(runVerifiedRecipe(rootDir, id, templateArgs).text);
      }

      if (action === "propose" || action === "approve" || action === "activate" || action === "revoke") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const macro = id ? setMacroTrust(rootDir, id, action, args.autoRun === true) : undefined;
        return plainTextResponse(macro ? `OK [macro-${action}] id=${id} state=${macro.state} permissions=${macro.permissions?.join(",") ?? "read-only"}`
          : `REJECTED [macro-${action}] id=${id || "missing"}; check current state and workspace version.`);
      }

      return {
        content: [
          {
            type: "text",
            text: `ERR [unknown-action] '${action}'. Use 'list', 'run', 'save', 'mine', 'mine-git', 'visualize', 'brief', 'task-list', 'task-run', 'task-record', or 'task-harvest'.`,
          },
        ],
        structuredContent: { tool: "gf_macro", ok: false },
        isError: true,
      };
    }

    default:
      return {
        content: [{ type: "text", text: `ERR [unknown-v3-tool] '${name}'` }],
        structuredContent: { tool: name, ok: false },
        isError: true,
      };
  }
}

export function executeV3ToolCall(
  name: string,
  args: Record<string, unknown> = {},
  defaultRootDir: string = process.cwd(),
  resolveOpts?: SmartWorkspaceResolveOptions
): V3ToolCallResponse {
  const started = Date.now();
  const result = executeV3ToolCallCore(name, args, defaultRootDir, resolveOpts);
  try {
    const rootDir = resolveSmartWorkspaceRoot(args, defaultRootDir, resolveOpts).rootDir;
    const output = result.content.map((item) => item.text).join("\n");
    let testStatus: ToolEvidence["testStatus"] = "UNKNOWN";
    if (name === "gf_exec" && args.run === true) {
      if (/^TIMEOUT\b/m.test(output)) testStatus = "TIMEOUT";
      else if (/^NONE \[affected-tests\]/m.test(output)) testStatus = "NO_TESTS";
      else if (/^PASS\b/m.test(output) || /\nPASS\b/m.test(output)) testStatus = "PASS";
      else if (/^FAIL\b/m.test(output) || /\nFAIL\b/m.test(output)) testStatus = "FAIL";
    }
    const usage = args.observedModelUsage && typeof args.observedModelUsage === "object"
      ? args.observedModelUsage as Record<string, unknown> : undefined;
    const observedModelUsage = usage ? {
      ...(typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
      ...(typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
    } : undefined;
    const receipt = appendToolEvidence(rootDir, { tool: name, output, durationMs: Date.now() - started, testStatus,
      ...(typeof args.taskId === "string" ? { taskId: args.taskId } : {}),
      ...(args.verifiedOutcome === "VERIFIED" || args.verifiedOutcome === "FAILED" ? { verifiedOutcome: args.verifiedOutcome } : {}),
      ...(observedModelUsage && Object.keys(observedModelUsage).length > 0 ? { observedModelUsage } : {}) });
    result.structuredContent = { ...result.structuredContent, evidenceId: receipt.artifactHash };
  } catch { /* Telemetry is best effort and never changes tool behavior. */ }
  return result;
}

export async function executeToolCallWithEscalation(
  name: string, args: Record<string, unknown> = {}, defaultRootDir: string = process.cwd(),
  resolveOpts?: SmartWorkspaceResolveOptions
): Promise<V3ToolCallResponse> {
  const result = executeV3ToolCall(name, args, defaultRootDir, resolveOpts);
  if (name !== "gf_read" || args.lsp === false || (args.detail !== undefined && args.detail !== "closure") ||
      args.maxOutputTokens !== undefined || !Array.isArray(args.targets) || args.targets.length !== 1 ||
      typeof args.targets[0] !== "string" || result.content[0]?.text.includes("[Blast Radius")) return result;
  try {
    const rootDir = resolveSmartWorkspaceRoot(args, defaultRootDir, resolveOpts).rootDir;
    const lsp = await escalateReadReferences(rootDir, args.targets[0]);
    if (!lsp) return result;
    const output = `${result.content[0]?.text ?? ""}\n${lsp.text}`;
    result.content = [{ type: "text", text: output }];
    const evidence = appendToolEvidence(rootDir, { tool: name, output, durationMs: 0 });
    result.structuredContent = { ...result.structuredContent, lspConfidence: "verified", evidenceId: evidence.artifactHash };
  } catch { /* An unavailable server must leave the fast AST result intact. */ }
  return result;
}
