/**
 * GraphFlow 3.0 — Host `PreToolUse` & `PostToolUse` Token-Guard Interceptor (`host-interceptor.ts`)
 *
 * Enforces Token-First execution even when a host agent (Claude Code, Cursor, etc.)
 * attempts to invoke built-in `Read`, `Bash`, or `Edit` tools instead of `gf_*`:
 *
 *   1. `interceptPreToolUse`:
 *      - Intercepts unscoped native `Read` / `View` calls on large source files (>250 lines
 *        without a bounded `offset`/ `limit`) and transparently returns the AST Skeleton
 *        Folded view (saving ~75-93% tokens) with exact 1-based line numbers.
 *      - Intercepts blind full-repo test runs (`npm test`, `vitest run`, `pytest`, `go test ./...`)
 *        when `git diff` shows a small set of affected tests, surfacing the fast Diff-to-Test route.
 *
 *   2. `interceptPostToolUse`:
 *      - Intercepts verbose native `Bash` outputs and compresses them via `dehydrateCommandOutput`
 *        (stripping ANSI, `node_modules` frames, and passing-test log spam), while recording
 *        the command into `.graphflow/trajectories.jsonl` for automatic macro/template compilation.
 *      - Intercepts native `Edit` / `Write` calls to run the zero-LLM AST static syntax guard,
 *        record co-edit habits, and run learned directory auto-verify hooks.
 *
 *   3. `interceptUserPromptSubmit` (Prompt Reflex):
 *      - Intercepts the chat prompt itself at the UserPromptSubmit/BeforeAgent hook level:
 *        a SHORT command-like prompt that matches a compiled `command-pipeline` macro's
 *        triggers executes the macro locally with 0 LLM turns and BLOCKS the prompt from
 *        reaching the LLM; a long prompt that merely MENTIONS a trigger only gets a hint
 *        (context injection) so the agent can call `gf_macro` explicitly.
 */

import { extname, isAbsolute, relative } from "node:path";
import { SUPPORTED_SOURCE_EXTS } from "./ast-engine.js";
import {
  checkAndRecordSessionRead,
  markSessionFilesEdited,
  recordTestAndCheckCircuitBreaker,
} from "./circuit-breaker.js";
import { dehydrateCommandOutput, resolveAffectedTests } from "./dehydrator.js";
import {
  evaluatePostEditHabits,
  executeMacro,
  findMatchingMacroHint,
  isNoiseCommand,
  loadMacroStore,
  recordTrajectoryAndMine,
  type CompiledMacro,
} from "./macro-engine.js";
import { executeSurgicalRead, getWorkspaceAstIndex } from "./slicer.js";
import { autoLogExecutedCommand } from "./task-reflector.js";

export interface HostToolUsePayload {
  hook_event_name?: "PreToolUse" | "PostToolUse" | "preToolUse" | "postToolUse";
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_response?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    /** Host-dependent aliases tolerated at parse time (ZCode uses `exitCode`). */
    exitCode?: number;
    code?: number;
    isError?: boolean;
    output?: string;
  };
  cwd?: string;
  session_id?: string;
}

/** stdin payload of a host UserPromptSubmit / BeforeAgent hook. */
export interface HostPromptPayload {
  hook_event_name?: string;
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

/**
 * Prompt Reflex verdict:
 *   - `allow`:   pass the prompt through to the LLM untouched.
 *   - `blocked`: macro executed locally (0 LLM turns); the prompt never reaches the LLM.
 *   - `hint`:    prompt reaches the LLM, but with injected context naming a ready macro.
 */
export interface PromptReflexResult {
  action: "allow" | "blocked" | "hint";
  macroId?: string;
  /** For `blocked`: what ran + PASS/FAIL outcome (truncated to ~500 chars). */
  summary?: string;
  /** For `hint`: suggestion text naming the macro and its `gf_macro` run command. */
  hint?: string;
}

export interface PreToolInterceptOptions {
  rootDir: string;
  /** Minimum line count before an unscoped Read is automatically folded into an AST Skeleton (default: 250). */
  maxRawLines?: number;
  sessionId?: string;
  /** Enable session-level SHA-256 duplicate read interception (default: false unless sessionId is explicitly provided or enableDedup=true). */
  enableDedup?: boolean;
}

export interface PreToolInterceptResult {
  intercepted: boolean;
  action: "allow" | "fold-skeleton" | "session-dedup-hit" | "suggest-affected-tests";
  reason?: string;
  replacementContent?: string;
  rawLines?: number;
  rawEstimatedTokens?: number;
  skeletonTokens?: number;
  tokensSaved?: number;
  suggestedCommand?: string;
  /** Ready-to-serialize JSON object for Claude Code / Cursor PreToolUse stdout protocol. */
  hookProtocolOutput: Record<string, unknown>;
}

export interface PostToolInterceptResult {
  intercepted: boolean;
  action: "noop" | "dehydrate-bash" | "post-edit-guard";
  dehydratedText?: string;
  rawEstimatedTokens?: number;
  dehydratedTokens?: number;
  tokensSaved?: number;
  habitNotes?: string[];
  syntaxErrors?: Array<{ line: number; message: string }>;
  hookProtocolOutput: Record<string, unknown>;
}

function normalizeRelPath(rootDir: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (isAbsolute(trimmed)) {
    return relative(rootDir, trimmed).replace(/\\/g, "/");
  }
  return trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * PreToolUse Interceptor: catches large raw `Read` calls and blind full-suite test commands.
 */
export function interceptPreToolUse(
  payload: HostToolUsePayload,
  options: PreToolInterceptOptions
): PreToolInterceptResult {
  const rootDir = options.rootDir || payload.cwd || process.cwd();
  const maxRawLines = options.maxRawLines ?? 250;
  const toolName = (payload.tool_name || "").trim();
  const input = payload.tool_input ?? {};

  // 1. Intercept native Read / View / read_file on large source files without bounded line range
  if (/^(Read|View|read_file|view_file)$/i.test(toolName)) {
    const rawFile =
      (typeof input.file_path === "string" && input.file_path) ||
      (typeof input.path === "string" && input.path) ||
      (typeof input.target_file === "string" && input.target_file) ||
      "";
    if (!rawFile) {
      return { intercepted: false, action: "allow", hookProtocolOutput: { decision: "allow" } };
    }

    const offset =
      typeof input.offset === "number"
        ? input.offset
        : typeof input.start_line === "number"
          ? input.start_line
          : undefined;
    const limit =
      typeof input.limit === "number"
        ? input.limit
        : typeof input.end_line === "number" && offset
          ? input.end_line - offset + 1
          : undefined;

    // Allow bounded reads (<= maxRawLines)
    if (limit !== undefined && limit <= maxRawLines) {
      return { intercepted: false, action: "allow", hookProtocolOutput: { decision: "allow" } };
    }
    if (offset !== undefined && offset > 1 && limit === undefined) {
      return { intercepted: false, action: "allow", hookProtocolOutput: { decision: "allow" } };
    }

    const relPath = normalizeRelPath(rootDir, rawFile);
    const ext = extname(relPath).toLowerCase();
    if (!SUPPORTED_SOURCE_EXTS.has(ext)) {
      return { intercepted: false, action: "allow", hookProtocolOutput: { decision: "allow" } };
    }

    const index = getWorkspaceAstIndex(rootDir);
    const fileData = index.getFileAnalysis(relPath);
    if (!fileData) {
      return { intercepted: false, action: "allow", hookProtocolOutput: { decision: "allow" } };
    }

    if (options.enableDedup) {
      const dedup = checkAndRecordSessionRead(
        rootDir,
        options.sessionId ?? payload.session_id ?? "host-hook",
        relPath,
        fileData.content,
        Math.ceil(fileData.size / 4)
      );
      if (dedup.isDuplicate && dedup.dedupNotice) {
        return {
          intercepted: true,
          action: "session-dedup-hit",
          reason: dedup.dedupNotice,
          replacementContent: dedup.dedupNotice,
          rawLines: fileData.ast.totalLines,
          tokensSaved: dedup.tokensSaved,
          hookProtocolOutput: {
            decision: "block",
            reason: dedup.dedupNotice,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: dedup.dedupNotice,
            },
          },
        };
      }
    }

    if (fileData.ast.totalLines <= maxRawLines) {
      return { intercepted: false, action: "allow", hookProtocolOutput: { decision: "allow" } };
    }

    const slice = executeSurgicalRead({
      rootDir,
      targets: [relPath],
      macroHintLookup: (keys) => findMatchingMacroHint(rootDir, keys),
    });

    recordTrajectoryAndMine(rootDir, {
      sessionId: options.sessionId ?? payload.session_id ?? "host-hook",
      kind: "read",
      key: relPath,
      items: [relPath],
      ok: true,
      tokensSaved: Math.max(0, slice.rawFileTokens - slice.estimatedTokens),
    });

    const rawLines = fileData.ast.totalLines;
    const rawEstimatedTokens = slice.rawFileTokens;
    const skeletonTokens = slice.estimatedTokens;
    const tokensSaved = Math.max(0, rawEstimatedTokens - skeletonTokens);
    const pct = Math.round((tokensSaved / Math.max(1, rawEstimatedTokens)) * 100);

    const headerBanner =
      `// [GraphFlow PreToolUse Interceptor] Folded ${relPath} (${rawLines}L, ~${rawEstimatedTokens} tokens -> ${skeletonTokens} tokens, -${pct}%).\n` +
      `// Call gf_read(targets=["${relPath}#SymbolName"]) or Read with offset/limit to inspect a specific function body.`;
    const replacementContent = `${headerBanner}\n\n${slice.text}`;

    return {
      intercepted: true,
      action: "fold-skeleton",
      reason: `File ${relPath} has ${rawLines} lines (>${maxRawLines}L). Returning AST Skeleton Folded view (-${pct}% tokens).`,
      replacementContent,
      rawLines,
      rawEstimatedTokens,
      skeletonTokens,
      tokensSaved,
      hookProtocolOutput: {
        decision: "block",
        reason: replacementContent,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: replacementContent,
        },
      },
    };
  }

  // 2. Intercept blind full test suite runs in Bash when Diff-to-Test knows the exact affected tests
  if (/^(Bash|RunCommand|execute_command)$/i.test(toolName)) {
    const cmd = typeof input.command === "string" ? input.command.trim() : "";
    const isFullSuiteCmd =
      /^(npm\s+test|npx\s+vitest(\s+run)?|vitest(\s+run)?|pytest|go\s+test\s+\.\/\.\.\.|cargo\s+test|dotnet\s+test)\s*$/i.test(
        cmd
      );
    if (isFullSuiteCmd) {
      const { affectedTests } = resolveAffectedTests(rootDir);
      if (affectedTests.length > 0 && affectedTests.length <= 10) {
        const suggestedCommand = cmd.startsWith("pytest")
          ? `pytest ${affectedTests.join(" ")}`
          : cmd.startsWith("go test")
            ? `go test ${Array.from(new Set(affectedTests.map((f) => `./${f.split("/").slice(0, -1).join("/")}`))).join(" ")}`
            : `npx vitest run ${affectedTests.join(" ")}`;
        const note = `[GraphFlow Diff-to-Test Hint] Only ${affectedTests.length} test file(s) are affected by current edits: ${affectedTests.join(", ")}. Prefer running: \`${suggestedCommand}\` or \`gf_exec(cmd="affected-tests")\`.`;
        return {
          intercepted: true,
          action: "suggest-affected-tests",
          reason: note,
          suggestedCommand,
          hookProtocolOutput: {
            decision: "allow",
            additionalContext: note,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              additionalContext: note,
            },
          },
        };
      }
    }
  }

  return { intercepted: false, action: "allow", hookProtocolOutput: { decision: "allow" } };
}

/**
 * PostToolUse Interceptor: dehydrates verbose Bash outputs & enforces AST static guard + habit memory after native Edits.
 */
export function interceptPostToolUse(
  payload: HostToolUsePayload,
  options: { rootDir: string; sessionId?: string }
): PostToolInterceptResult {
  const rootDir = options.rootDir || payload.cwd || process.cwd();
  const sessionId = options.sessionId ?? payload.session_id ?? "host-hook";
  const toolName = (payload.tool_name || "").trim();
  const input = payload.tool_input ?? {};
  const resp = payload.tool_response ?? {};

  // 1. Post-Bash Dehydration & Habit Recording
  if (/^(Bash|RunCommand|execute_command)$/i.test(toolName)) {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const stdout = resp.stdout ?? resp.output ?? "";
    const stderr = resp.stderr ?? "";
    // Hosts spell the exit code differently; tolerate the common aliases and
    // treat an explicit isError flag as failure.
    const exitCode =
      typeof resp.exit_code === "number"
        ? resp.exit_code
        : typeof resp.exitCode === "number"
          ? resp.exitCode
          : typeof resp.code === "number"
            ? resp.code
            : resp.isError === true
              ? 1
              : 0;

    if (!command) {
      return { intercepted: false, action: "noop", hookProtocolOutput: {} };
    }

    // One-off inspection commands (cd/ls/git status ...) carry no habit signal;
    // skip dehydration and recording entirely so the trajectory log stays clean.
    if (isNoiseCommand(command)) {
      return { intercepted: false, action: "noop", hookProtocolOutput: {} };
    }

    const loggedInstruction =
      typeof input.instruction === "string" && input.instruction.trim()
        ? input.instruction
        : typeof input.description === "string" && input.description.trim()
          ? input.description
          : undefined;
    autoLogExecutedCommand(rootDir, command, {
      ...(loggedInstruction ? { instruction: loggedInstruction } : {}),
    });

    const dehydrated = dehydrateCommandOutput({
      rootDir,
      command,
      exitCode,
      durationMs: 0,
      stdout,
      stderr,
    });

    const tokensSaved = Math.max(0, dehydrated.rawEstimatedTokens - dehydrated.dehydratedTokens);
    recordTrajectoryAndMine(rootDir, {
      sessionId,
      kind: "exec",
      key: command,
      items: [command],
      ok: exitCode === 0,
      tokensSaved,
    });

    const cb = recordTestAndCheckCircuitBreaker(rootDir, sessionId, command, exitCode === 0);
    const finalDehydratedText = cb.tripped && cb.rescuePacket
      ? `${dehydrated.text}\n\n${cb.rescuePacket}`
      : dehydrated.text;

    const shouldReplace = cb.tripped || dehydrated.rawEstimatedTokens > dehydrated.dehydratedTokens + 25;
    return {
      intercepted: shouldReplace,
      action: "dehydrate-bash",
      dehydratedText: finalDehydratedText,
      rawEstimatedTokens: dehydrated.rawEstimatedTokens,
      dehydratedTokens: dehydrated.dehydratedTokens,
      tokensSaved,
      hookProtocolOutput: shouldReplace
        ? {
            additionalContext: finalDehydratedText,
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: finalDehydratedText,
            },
          }
        : {},
    };
  }

  // 2. Post-Edit / Write Static Guard & Habit Memory
  if (/^(Edit|Write|MultiEdit|Replace|write_to_file)$/i.test(toolName)) {
    const rawFile =
      (typeof input.file_path === "string" && input.file_path) ||
      (typeof input.path === "string" && input.path) ||
      (typeof input.TargetFile === "string" && input.TargetFile) ||
      "";
    if (!rawFile) {
      return { intercepted: false, action: "noop", hookProtocolOutput: {} };
    }

    const relPath = normalizeRelPath(rootDir, rawFile);
    const index = getWorkspaceAstIndex(rootDir);
    index.invalidateFile(relPath);
    markSessionFilesEdited(rootDir, sessionId, [relPath]);
    const fileData = index.getFileAnalysis(relPath);
    const syntaxErrors =
      fileData?.ast.syntaxErrors.map((e) => ({ line: e.line, message: e.message })) ?? [];

    recordTrajectoryAndMine(rootDir, {
      sessionId,
      kind: "edit",
      key: relPath,
      items: [relPath],
      ok: syntaxErrors.length === 0,
    });

    const habits = evaluatePostEditHabits(rootDir, [relPath]);
    const habitNotes: string[] = [];
    if (syntaxErrors.length > 0) {
      habitNotes.push(
        `[GraphFlow Static Guard] Syntax error detected in ${relPath}: ` +
          syntaxErrors.map((e) => `L${e.line}: ${e.message}`).join("; ")
      );
    }
    habitNotes.push(...habits.coEditHints);
    if (habits.autoVerifySummary) {
      habitNotes.push(habits.autoVerifySummary);
    }

    return {
      intercepted: habitNotes.length > 0,
      action: "post-edit-guard",
      habitNotes,
      syntaxErrors,
      hookProtocolOutput:
        habitNotes.length > 0
          ? {
              additionalContext: habitNotes.join("\n"),
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: habitNotes.join("\n"),
              },
            }
          : {},
    };
  }

  return { intercepted: false, action: "noop", hookProtocolOutput: {} };
}

// ─────────────────────────── UserPromptSubmit Prompt Reflex ───────────────────────────

/** Trailing sentence punctuation (full-width + ASCII) stripped before trigger matching. */
const PROMPT_REFLEX_TRAILING_PUNCT_RE = /[。．.!！?？;；]+$/;
/** CJK ideographs / kana / hangul — `\b` has no notion of these as word characters. */
const PROMPT_REFLEX_CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;

function hasCjkChar(text: string): boolean {
  PROMPT_REFLEX_CJK_RE.lastIndex = 0;
  return PROMPT_REFLEX_CJK_RE.test(text);
}

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateForHook(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * Count "words" in a prompt: whitespace-separated tokens, except CJK runs count
 * per character (1 CJK char ≈ 1 word). Plain whitespace splitting would call a
 * 30-char Chinese sentence "3 tokens", making every long CJK prompt look like a
 * short command; counting CJK chars as words keeps the short-command gate honest
 * for both scripts.
 */
function countPromptTokens(prompt: string): number {
  let tokens = 0;
  for (const chunk of prompt.split(/\s+/)) {
    if (!chunk) continue;
    PROMPT_REFLEX_CJK_RE.lastIndex = 0;
    const cjkCount = (chunk.match(PROMPT_REFLEX_CJK_RE) ?? []).length;
    tokens += cjkCount + (chunk.length - cjkCount > 0 ? 1 : 0);
  }
  return tokens;
}

function triggerMatchesPrompt(normalizedPrompt: string, normalizedTrigger: string): boolean {
  if (!normalizedTrigger) return false;
  if (normalizedPrompt === normalizedTrigger) return true;
  if (!normalizedPrompt.includes(normalizedTrigger)) return false;
  // Substring hit: CJK triggers match inline directly (no \b for CJK), latin
  // triggers must sit on word boundaries ("launch" must not fire on "relaunch").
  return (
    hasCjkChar(normalizedTrigger) ||
    new RegExp(`\\b${escapeRegExpLiteral(normalizedTrigger)}\\b`).test(normalizedPrompt)
  );
}

/** Best macro = the matched one the user has actually used the most. */
function pickMostUsedMacro(matched: CompiledMacro[]): CompiledMacro {
  return matched.reduce((best, m) => (m.occurrences > best.occurrences ? m : best));
}

/**
 * UserPromptSubmit / BeforeAgent Prompt Reflex:
 * a short command-like prompt that matches a compiled `command-pipeline` macro's
 * triggers runs the macro locally (0 LLM turns) and BLOCKS the prompt; a long
 * prompt that merely mentions a trigger gets a `gf_macro` hint injected instead.
 * Non-`command-pipeline` macros are never auto-executed from a chat prompt.
 */
export function interceptUserPromptSubmit(
  payload: HostPromptPayload,
  options: { rootDir: string; sessionId?: string }
): PromptReflexResult {
  // 1. Hard opt-out switch.
  if (process.env.GRAPHFLOW_PROMPT_REFLEX === "0") return { action: "allow" };

  // 2. Empty prompts reach the LLM untouched.
  const rawPrompt = (payload.prompt ?? "").trim();
  if (rawPrompt.length === 0) return { action: "allow" };

  // Everything below is wrapped defensively: the reflex must never break the
  // host chat flow, so any internal error fails open to a plain allow.
  try {
    // 3. Only compiled `command-pipeline` macros are prompt-executable.
    const pipelines = loadMacroStore(options.rootDir).macros.filter(
      (m) => m.kind === "command-pipeline"
    );

    // 4. Normalize both sides: lowercase; strip trailing punctuation + whitespace
    // from the prompt ("launch!" / "启动项目。" still match).
    const normalizedPrompt = rawPrompt
      .toLowerCase()
      .replace(PROMPT_REFLEX_TRAILING_PUNCT_RE, "")
      .trim();
    const matched = pipelines.filter((m) =>
      (m.triggers ?? []).some((t) =>
        triggerMatchesPrompt(normalizedPrompt, t.trim().toLowerCase())
      )
    );

    // 5. No command-pipeline trigger matched -> nothing to reflex.
    if (matched.length === 0) return { action: "allow" };

    // 6. Short-command gate: only a genuinely short command-like prompt may be
    //    executed and blocked. A longer prompt that merely MENTIONS a trigger
    //    gets a hint so the agent can call the macro explicitly.
    const isShortCommand = rawPrompt.length <= 24 || countPromptTokens(rawPrompt) <= 12;
    const best = pickMostUsedMacro(matched);
    if (!isShortCommand) {
      return {
        action: "hint",
        macroId: best.id,
        hint:
          `[GraphFlow Prompt Reflex] 本工作区有本地宏 '${best.id}' 可直接完成该意图:` +
          `调用 gf_macro(action="run", id="${best.id}") 执行,无需重新推导命令。` +
          ` (${best.description})`,
      };
    }

    // 7. Execute locally with 0 LLM turns. Failure fails soft: hand the failure
    //    text to the agent as a hint so it can see and help.
    const res = executeMacro(options.rootDir, best.id);
    if (res.ok) {
      return {
        action: "blocked",
        macroId: best.id,
        summary:
          `✅ [GraphFlow Prompt Reflex] 已本地执行宏 '${best.id}'(0 LLM):\n` +
          truncateForHook(res.text, 500),
      };
    }
    return {
      action: "hint",
      macroId: best.id,
      hint:
        `⚠️ [GraphFlow Prompt Reflex] 宏 '${best.id}' 执行失败,已回退给 LLM 处理,请协助排查:\n` +
        truncateForHook(res.text, 300),
    };
  } catch {
    return { action: "allow" };
  }
}
