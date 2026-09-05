/**
 * GraphFlow DeepSeek Harness (dsh) glue plugin.
 *
 * DSH plugins are ESM (`type: module`); GraphFlow's package root is CJS.
 * This file is the `exports["./dsh"]` entry. Cordis loads it via
 * `name: '@roarpeng/graphflow/dsh'` in cordis.patch.yml.
 *
 * Duck-types `ctx` — no hard dependency on `@deepseek-ai/cordis`.
 * Missing `ctx.skills` / events → no-op. Never throw into the harness loop.
 *
 * Reply auto-fill: each agent turn ends with a durable `turn/end` session
 * event (`data.reason.kind`). The glue tracks the last non-interrupted
 * `assistant/message` text of the turn (the event's message lives at
 * `event.data.message` — session events are `{ type, seq, time, data }`), and
 * on `turn/end` backfills the pending graph dialogue turn with that final
 * reply. Backfill prefers calling the co-located GraphFlow runtime
 * (`captureAssistantReply` + `recordDialogueTurnRuntime`) in-process, and
 * falls back to spawning the local CLI (`context preview --reply` then
 * `dialogue record --reply`, both idempotent tip fills). Env switch:
 * `GRAPHFLOW_CAPTURE_REPLY=0` disables reply filling only.
 *
 * Static panel data channel: the /gf Connection RPC channel
 * (`ctx.connection.rpc.handle("/gf", handler, { authority: "trusted-host" })`)
 * serves the `nodes` method — it runs `workbench tree --json` and
 * `dialogue list --json --limit 50` in the requested workspace and returns the
 * parsed snapshots inside the mandatory RpcResult envelope for the static
 * client panel (web/client.js).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const name = "graphflow-dsh";

const PLUGIN_ID = "graphflow-dsh";
const AUTO_CAPTURE_ENV = "GRAPHFLOW_AUTO_CAPTURE";
const CAPTURE_REPLY_ENV = "GRAPHFLOW_CAPTURE_REPLY";
const JOURNAL_RELATIVE = join(".graphflow", "session-journal.jsonl");
/** Reply text is clipped before it is passed as a function arg or argv element. */
const REPLY_CLIP_MAX = 4000;
/** CLI fill children are killed after this long (detached:false + timeout). */
const REPLY_FILL_TIMEOUT_MS = 20_000;
/** One bounded retry when the fill finds no pending turn yet (record race). */
const REPLY_RETRY_DELAY_MS = 1_500;
const DEFAULT_SKILL_DESCRIPTION =
  "图谱上下文压缩、任务规划与知识图谱编排（10 个 MCP 工具）。任何读代码、改代码、排错、中文问题之前必须先调 graphflow_context。DeepSeek Harness 下工具名为 mcp__graphflow__graphflow_*。";

/** Static-panel data channel: Connection generic RPC channel for the panel. */
const NODES_CHANNEL = "/gf";
/** Panel-data CLI children are killed after this long (timeout guard). */
const CAPTURE_TIMEOUT_MS = 20_000;
/** Captured stdout/stderr per command are capped at ~4MB (runaway guard). */
const CAPTURE_OUTPUT_MAX_BYTES = 4_000_000;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ spawn?: typeof spawn, env?: NodeJS.ProcessEnv, cwd?: string, log?: { warn?: (msg: string) => void, error?: (msg: string) => void }, readSkill?: () => { name: string, description: string, content: string, source: string, path?: string } }} GraphFlowDshPluginConfig */

function envOf(config) {
  return config?.env ?? process.env;
}

export function isAutoCaptureEnabled(env = process.env) {
  const raw = env[AUTO_CAPTURE_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled");
}

/**
 * One-switch kill for the assistant-reply backfill only (the question
 * recording keeps obeying `GRAPHFLOW_AUTO_CAPTURE`). `GRAPHFLOW_CAPTURE_REPLY`
 * in {0,false,off,no,disabled} (case-insensitive) disables reply filling.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isReplyCaptureEnabled(env = process.env) {
  const raw = env[CAPTURE_REPLY_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled");
}

/**
 * Normalize and clip reply text before it crosses a process boundary (in-process
 * call arg or spawn argv). Collapses whitespace, strips NUL (illegal in argv),
 * and truncates to `max` chars with an ellipsis — mirroring the runtime's own
 * `clip` so glue and store agree. Never throws.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipReplyText(text, max = REPLY_CLIP_MAX) {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

/**
 * The assistant message carried by a `session/event` payload. Live events are
 * frozen envelopes `{ type, seq, time, data }` so the message lives at
 * `event.data.message`; a legacy/tolerant shape with `event.message` is also
 * accepted. Never throws.
 * @param {object|undefined} event
 * @returns {object|undefined}
 */
export function sessionEventMessage(event) {
  if (!event || typeof event !== "object") return undefined;
  const data = event.data;
  return data && typeof data === "object" ? data.message ?? event.message : event.message;
}

/**
 * Explicit success only — same contract as Claude Code SessionEnd `$2`.
 * Missing GRAPHFLOW_HOOK_SUCCESS leaves the episode pending.
 * @returns {boolean|undefined}
 */
export function resolveExplicitSuccess(env = process.env) {
  const raw = env.GRAPHFLOW_HOOK_SUCCESS?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return undefined;
}

export function resolveSessionJournalPath(workspaceRoot) {
  const override = process.env.GRAPHFLOW_HOOK_JOURNAL?.trim();
  if (override) return override;
  return join(workspaceRoot ?? process.cwd(), JOURNAL_RELATIVE);
}

export function latestPendingEpisodeId(journalPath) {
  if (!journalPath || !existsSync(journalPath)) return undefined;
  let text;
  try {
    text = readFileSync(journalPath, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.episodeId === "string" && parsed.episodeId) {
        return parsed.episodeId;
      }
    } catch {
      // skip damaged lines
    }
  }
  return undefined;
}

export function buildContextHint(cwd = process.cwd()) {
  return `GraphFlow: before large code reads, call mcp__graphflow__graphflow_context with rootDir=${cwd}. Do not dump SKILL.md.`;
}

/**
 * Same-step first-turn hint message. Tagged as plugin instructions so
 * `isUserOriginatedMessage` does not treat it as a user question.
 * `inject()` is the wrong primitive here — it lands in the *next* step inbox.
 * @param {string} [cwd]
 */
export function buildHintMessage(cwd = process.cwd()) {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text: buildContextHint(cwd) }],
    source: { kind: "plugin", plugin: PLUGIN_ID, form: "instructions" },
  };
}

/**
 * Extract the plain text of a user message (its text ContentBlocks joined).
 * Returns "" when the message carries no text. Never throws.
 * @param {object|undefined} message - a UserMessage (agent/inbox/inserted payload).
 * @returns {string}
 */
export function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * The local GraphFlow CLI entry (this package's own dist build). Falls back to
 * `graphflow` from PATH when dist is absent (source checkout without build).
 * @returns {string}
 */
export function resolveCliCommand(packageRoot = PACKAGE_ROOT) {
  const distCli = join(packageRoot, "dist", "surfaces", "cli", "index.js");
  return existsSync(distCli) ? distCli : "graphflow";
}

/**
 * Confirmed harness/system message-source kinds that must never become
 * dialogue turns. `MessageSource.kind` (dsh-llm) is merge-extensible: the
 * base map defines `user`/`plugin`/`tool`/`model`, and harness plugins add
 * their own kinds (verified against the running dsh 1.9.16 packages):
 * - `subagent-settled`: "Background subagent … finished/stopped/failed"
 *   settlement notices (dsh-subagent, form: notice);
 * - `subagent-report`: "Background subagent … reported:" framed reports
 *   (dsh-subagent, form: relay);
 * - `agent-instructions`: AGENTS.md/workspace instructions system-reminders
 *   (dsh-agent-instructions, form: instructions);
 * - `session-reference`: recalled content lifted from another session
 *   (dsh-session-reference, form: recall);
 * - `goal`: goal-round driver context prompts (dsh-goal-round-driver);
 * - `skill-catalog`: the `<system-reminder><available_skills>` catalog
 *   (dsh-tool-skill, form: catalog).
 * `plugin` also covers runtime-context snapshots (`@deepseek-ai/dsh-system-prompt`,
 * form: snapshot), approval-policy changes (`user-approval`),
 * Cordis run failures (`cordis-host-runner`), and this glue's own hint
 * (`graphflow-dsh`, form: instructions).
 */
const SYSTEM_MESSAGE_SOURCE_KINDS = new Set([
  "plugin",
  "tool",
  "model",
  "subagent-settled",
  "subagent-report",
  "agent-instructions",
  "session-reference",
  "goal",
  "skill-catalog",
]);

/**
 * Whether a message originates from the human user rather than the harness.
 * Whitelist: only `source.kind === "user"` (web chat, headless, slash
 * commands) qualifies. Blacklist: every confirmed harness/system kind above is
 * rejected — subagent notices/reports, AGENTS.md instructions, session recall,
 * goal-round context, skill catalogs, tool results, plugin injections and
 * runtime-context snapshots must not become dialogue turns. Unknown/missing
 * source falls back to the role check so nothing legitimate is dropped
 * (a future harness kind with role "user" would still leak — see report).
 * @param {object|undefined} message
 * @returns {boolean}
 */
export function isUserOriginatedMessage(message) {
  if (!message || typeof message !== "object") return false;
  const kind =
    message.source && typeof message.source === "object" ? message.source.kind : undefined;
  if (kind === "user") return true;
  if (typeof kind === "string" && SYSTEM_MESSAGE_SOURCE_KINDS.has(kind)) return false;
  return message.role !== "system";
}

/**
 * Best-effort auto-record of one user turn as a dialogue node.
 * Spawns `graphflow dialogue record --query "<text>" [--session <sessionId>]`
 * in the agent's workspace (cwd = session header cwd) so every web/agent
 * question becomes a dialogue-turn graph node without relying on the agent
 * calling graphflow_context itself. Only human-originated messages are
 * recorded (see isUserOriginatedMessage) — harness/system injections must not
 * pollute the dialogue graph. `sessionId` scopes the turn to one dsh session
 * (omitted → default "main" dialogue session) so question recording and reply
 * filling land in the same dialogue session. Never throws; the spawned child
 * is detached.
 * @param {object|undefined} message - a UserMessage (agent/inbox/inserted payload).
 * @param {string} [cwd]
 * @param {GraphFlowDshPluginConfig} [config]
 * @param {string} [sessionId] - dialogue session name/id; omitted → "main".
 * @returns {{attempted: boolean, reason?: string, workspace?: string}}
 */
export function recordDialogueFromInbox(message, cwd, config = {}, sessionId) {
  try {
    if (!isUserOriginatedMessage(message)) {
      return { attempted: false, reason: "not-user-message" };
    }
    const env = envOf(config);
    if (!isAutoCaptureEnabled(env)) {
      return { attempted: false, reason: "auto-capture-off" };
    }
    const text = extractMessageText(message);
    if (text.length < 4) {
      return { attempted: false, reason: "query-too-short" };
    }
    const workspace = typeof cwd === "string" && cwd.trim() ? cwd : process.cwd();
    const spawnFn = typeof config.spawn === "function" ? config.spawn : spawn;
    const cli = resolveCliCommand(config.packageRoot);
    const args = [cli, "dialogue", "record", "--query", text];
    if (typeof sessionId === "string" && sessionId.trim()) {
      args.push("--session", sessionId);
    }
    const bin = cli === "graphflow" ? (env.GRAPHFLOW_HOOK_BIN?.trim() || "npx") : process.execPath;
    const fullArgs = cli === "graphflow" ? ["-y", "--package=@roarpeng/graphflow", ...args] : args;
    spawnFn(bin, fullArgs, {
      cwd: workspace,
      env,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    })?.unref?.();
    return { attempted: true, workspace };
  } catch {
    return { attempted: false, reason: "error" };
  }
}

/**
 * Best-effort fill of one assistant reply into the latest pending dialogue
 * turn for `sessionId`. Backfill pipeline (see fillPendingReply): co-located
 * GraphFlow runtime first, CLI spawn fallback, deduped per session+turn,
 * latest-wins coalescing queue, one bounded retry for the record race. Never
 * throws.
 * @param {object|undefined} event - an `assistant/message` session event.
 * @param {string} [sessionId] - dialogue session name/id.
 * @param {string} [cwd]
 * @param {GraphFlowDshPluginConfig} [config]
 * @returns {{attempted: boolean, reason?: string, workspace?: string, queued?: boolean}}
 */
export function recordReplyFromTurn(event, sessionId, cwd, config = {}) {
  try {
    if (event?.interrupted || event?.data?.interrupted) {
      return { attempted: false, reason: "interrupted" };
    }
    const text = extractMessageText(sessionEventMessage(event));
    if (!text) {
      return { attempted: false, reason: "no-text" };
    }
    const env = envOf(config);
    if (!isAutoCaptureEnabled(env)) {
      return { attempted: false, reason: "auto-capture-off" };
    }
    return fillPendingReply(text, sessionId, cwd, config);
  } catch {
    return { attempted: false, reason: "error" };
  }
}

/**
 * Absolute path of the co-located CLI runtime module (this package's own dist
 * build) when present, else undefined. The runtime is CJS; the glue imports it
 * lazily and only ever in try/catch — any load failure falls back to the CLI.
 * @param {string} [packageRoot]
 * @returns {string|undefined}
 */
export function resolveRuntimeGraphPath(packageRoot = PACKAGE_ROOT) {
  const candidate = join(packageRoot, "dist", "surfaces", "cli", "runtime", "graph.js");
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * First existing CLI binary for reply filling, in order of preference:
 * 1. the co-located package's own dist CLI (same build the glue runs from);
 * 2. `$HOME/.dsh/profiles/<profile>/node_modules/@roarpeng/graphflow/dist/…`
 *    CLI (first hit — covers a source checkout whose own dist is absent);
 * 3. bare `graphflow` (spawned through npx/npm exec).
 * @param {string} [packageRoot]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveCliForCapture(packageRoot = PACKAGE_ROOT, home = process.env.HOME || process.env.USERPROFILE) {
  const packageCli = join(packageRoot, "dist", "surfaces", "cli", "index.js");
  if (existsSync(packageCli)) return packageCli;
  const profileCli = findProfileCli(home);
  if (profileCli) return profileCli;
  return "graphflow";
}

/** @param {string|undefined} home */
export function findProfileCli(home) {
  try {
    if (!home) return undefined;
    const profilesDir = join(home, ".dsh", "profiles");
    if (!existsSync(profilesDir)) return undefined;
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(
        profilesDir,
        entry.name,
        "node_modules",
        "@roarpeng",
        "graphflow",
        "dist",
        "surfaces",
        "cli",
        "index.js"
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // discovery is best-effort
  }
  return undefined;
}

/**
 * Parse one captured CLI result into JSON — mirrors the dynamic panel's
 * parseCliOut (web/plugin.mjs:48-58): exitCode must be 0, stdout must
 * JSON.parse, and a wrapping `{ data }` object is unwrapped. Returns null on
 * any failure so the panel renders an empty state instead of an error.
 * @param {{exitCode: number|null, stdout?: string}|undefined} result
 * @returns {unknown|null}
 */
export function parseCliOut(result) {
  if (!result || result.exitCode !== 0) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  } catch {
    return null;
  }
}

/** The workspace's own config path when it exists; passing it keeps config
 *  discovery (graphStorePath, enableDialogueThread, …) aligned with the CLI
 *  run from that workspace. The workspace root itself is always overridden by
 *  the explicit rootDir the runtime functions receive. */
function resolveWorkspaceConfigPath(workspace) {
  try {
    if (typeof workspace !== "string" || !workspace.trim()) return undefined;
    const candidate = join(workspace, "graphflow.config.json");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

let captureReplyRuntimePromise;
let dialogueRecordRuntimePromise;

function loadCaptureAssistantReply(packageRoot = PACKAGE_ROOT) {
  const runtimePath = resolveRuntimeGraphPath(packageRoot);
  if (!runtimePath) return Promise.resolve(undefined);
  if (captureReplyRuntimePromise === undefined) {
    captureReplyRuntimePromise = import(pathToFileURL(runtimePath).href)
      .then((mod) => mod?.captureAssistantReply ?? mod?.default?.captureAssistantReply)
      .catch(() => undefined);
  }
  return captureReplyRuntimePromise;
}

function loadDialogueRecordRuntime(packageRoot = PACKAGE_ROOT) {
  const runtimePath = join(packageRoot, "dist", "surfaces", "cli", "runtime", "dialogue.js");
  if (!existsSync(runtimePath)) return Promise.resolve(undefined);
  if (dialogueRecordRuntimePromise === undefined) {
    dialogueRecordRuntimePromise = import(pathToFileURL(runtimePath).href)
      .then((mod) => mod?.recordDialogueTurnRuntime ?? mod?.default?.recordDialogueTurnRuntime)
      .catch(() => undefined);
  }
  return dialogueRecordRuntimePromise;
}

/**
 * In-process backfill: `captureAssistantReply` (the `context preview --reply`
 * semantics — fills a pending workbench topic when one is active) plus, when it
 * only landed on a workbench topic, a direct dialogue-turn fill via
 * `recordDialogueTurnRuntime("", { assistantReply })` so the pending DIALOGUE
 * turn is guaranteed to close. Any failure returns a structured non-ok result
 * so the caller can fall back to the CLI. Never throws.
 * @param {string} text
 * @param {string} [sessionId]
 * @param {string} workspace
 * @param {GraphFlowDshPluginConfig} [config]
 * @returns {Promise<{attempted: boolean, ok?: boolean, filled?: boolean, reason?: string, capture?: object}>}
 */
export async function captureReplyInProcess(text, sessionId, workspace, config = {}) {
  const fn = await loadCaptureAssistantReply(config.packageRoot);
  if (typeof fn !== "function") {
    return { attempted: false, reason: "runtime-unavailable" };
  }
  const reply = clipReplyText(text);
  if (!reply) return { attempted: false, reason: "no-text" };
  const sessionOpts =
    typeof sessionId === "string" && sessionId.trim() ? { sessionId } : undefined;
  let result;
  try {
    result = await fn(reply, resolveWorkspaceConfigPath(workspace), workspace, sessionOpts);
  } catch (error) {
    return { attempted: true, ok: false, reason: "capture-failed", error: String(error) };
  }
  const ok = result?.ok === true;
  const kind = result?.capture?.kind;
  if (ok && kind === "workbench") {
    // The reply went to an active workbench topic; the pending dialogue turn
    // may still be empty — close it too so `A:` is never left "(待回复)".
    try {
      const dialogueFn = await loadDialogueRecordRuntime(config.packageRoot);
      if (typeof dialogueFn === "function") {
        await dialogueFn("", {
          rootDir: workspace,
          assistantReply: reply,
          ...(sessionOpts ? { sessionId } : {}),
        });
      } else {
        spawnCliFillArgs(["dialogue", "record", "--reply", reply, ...(sessionOpts ? ["--session", sessionId] : [])], workspace, config);
      }
    } catch {
      // dialogue follow-up is best-effort
    }
  }
  return {
    attempted: true,
    ok,
    filled: result?.filled === true,
    reason: result?.reason,
    ...(result?.capture
      ? { capture: { kind, id: result.capture.id, filled: result.capture.filled === true } }
      : {}),
  };
}

/** Spawn one CLI fill command: non-detached, timeout-killed, stderr swallowed. */
function spawnCliFillArgs(args, workspace, config) {
  try {
    const env = envOf(config);
    const spawnFn = typeof config.spawn === "function" ? config.spawn : spawn;
    const cli = resolveCliForCapture(config.packageRoot);
    const bin = cli === "graphflow" ? (env.GRAPHFLOW_HOOK_BIN?.trim() || "npx") : process.execPath;
    const fullArgs = cli === "graphflow" ? ["-y", "--package=@roarpeng/graphflow", cli, ...args] : [cli, ...args];
    const child = spawnFn(bin, fullArgs, {
      cwd: workspace,
      env,
      stdio: "ignore",
      detached: false,
      windowsHide: true,
    });
    child?.on?.("error", () => {});
    const timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        // already gone
      }
    }, REPLY_FILL_TIMEOUT_MS);
    timer.unref?.();
    child?.once?.("exit", () => clearTimeout(timer));
  } catch {
    // fill is optional — never throw into the harness
  }
}

/**
 * Spawn one CLI command and capture stdout/stderr (the static panel data
 * channel needs the JSON output, unlike the fire-and-forget reply fills).
 * Resolution order matches resolveCliForCapture: co-located dist CLI → first
 * profile install → npx `-y --package=@roarpeng/graphflow graphflow`
 * (`config.packageRoot` / `config.home` are injectable for tests). The
 * child is timeout-killed (20s) and each stream is capped (~4MB) so a runaway
 * CLI can never hang or exhaust the host; an external abort (the Connection
 * RPC request signal) kills the child too. Resolves
 * `{ exitCode, signal, stdout, stderr }` — CLI failures never reject; only
 * infrastructure errors (spawn throwing, child "error" event) reject. Never
 * throws synchronously.
 * @param {string[]} args - command words after the graphflow binary.
 * @param {string} workspace - cwd for the child.
 * @param {GraphFlowDshPluginConfig} [config]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
function spawnCliCapture(args, workspace, config, signal) {
  return new Promise((resolve, reject) => {
    const env = envOf(config);
    const spawnFn = typeof config.spawn === "function" ? config.spawn : spawn;
    let bin;
    let fullArgs;
    try {
      const cli = resolveCliForCapture(config.packageRoot, config.home);
      bin = cli === "graphflow" ? (env.GRAPHFLOW_HOOK_BIN?.trim() || "npx") : process.execPath;
      fullArgs = cli === "graphflow" ? ["-y", "--package=@roarpeng/graphflow", cli, ...args] : [cli, ...args];
    } catch (error) {
      reject(error);
      return;
    }
    let child;
    try {
      child = spawnFn(bin, fullArgs, {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (!child || typeof child !== "object") {
      reject(new Error(`spawn of ${JSON.stringify(bin)} returned no child process`));
      return;
    }

    const output = { stdout: "", stderr: "" };
    const sizes = { stdout: 0, stderr: 0 };
    let settled = false;
    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    let stdoutEnded = child.stdout === undefined;
    let stderrEnded = child.stderr === undefined;

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // ignore
        }
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, signal: exitSignal, stdout: output.stdout, stderr: output.stderr });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const maybeFinish = () => {
      if (exited && stdoutEnded && stderrEnded) finish();
    };
    const timer = setTimeout(() => {
      exitSignal = "timeout";
      try {
        child.kill?.();
      } catch {
        // already gone
      }
      finish();
    }, CAPTURE_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => {
      exitSignal = "abort";
      try {
        child.kill?.();
      } catch {
        // already gone
      }
      finish();
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const capture = (name) => (chunk) => {
      const text = typeof chunk === "string" ? chunk : String(chunk);
      if (sizes[name] >= CAPTURE_OUTPUT_MAX_BYTES) return;
      const room = CAPTURE_OUTPUT_MAX_BYTES - sizes[name];
      const kept = text.length > room ? text.slice(0, room) : text;
      output[name] += kept;
      sizes[name] += kept.length;
    };
    child.stdout?.on?.("data", capture("stdout"));
    child.stdout?.on?.("end", () => {
      stdoutEnded = true;
      maybeFinish();
    });
    child.stderr?.on?.("data", capture("stderr"));
    child.stderr?.on?.("end", () => {
      stderrEnded = true;
      maybeFinish();
    });
    child.on?.("error", fail);
    child.once?.("exit", (code, sig) => {
      exited = true;
      exitCode = code ?? null;
      exitSignal = sig ?? null;
      maybeFinish();
    });
    child.once?.("close", (code, sig) => {
      exited = true;
      exitCode = code ?? null;
      exitSignal = sig ?? null;
      maybeFinish();
    });
  });
}

/**
 * One-switch kill for the multi-agent trajectory capture (W3a), independent
 * of question/reply capture: `GRAPHFLOW_CAPTURE_TRACE` in
 * {0,false,off,no,disabled} (case-insensitive) disables trace recording.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isTraceCaptureEnabled(env = process.env) {
  const raw = env.GRAPHFLOW_CAPTURE_TRACE?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled");
}

/**
 * Best-effort in-process agent-trace write via the co-located runtime module.
 * Falls back to undefined when the runtime is absent — trace recording is
 * additive and must never throw into the harness loop. `turnSeq` is the dsh
 * turn ordinal when known (0 keeps the trace session-scoped only).
 * @param {{ sessionId?: string, turnSeq?: number, agentKind: string, label: string, status: string }} trace
 * @param {string} workspace
 * @param {GraphFlowDshPluginConfig} [config]
 * @returns {Promise<boolean>} true when the write landed
 */
async function writeAgentTraceInProcess(trace, workspace, config = {}) {
  try {
    const runtimePath = join(config.packageRoot ?? PACKAGE_ROOT, "dist", "surfaces", "cli", "runtime", "dialogue.js");
    if (!existsSync(runtimePath)) return false;
    const mod = await import(pathToFileURL(runtimePath).href);
    const fn = mod?.recordAgentTraceRuntime ?? mod?.default?.recordAgentTraceRuntime;
    if (typeof fn !== "function") return false;
    const result = await fn(trace, resolveWorkspaceConfigPath(workspace), workspace);
    return result === true;
  } catch {
    return false;
  }
}

/**
 * Normalize a `subagent/start` | `subagent/end` payload into a trace record.
 * The payload identity is `{ runId, provider, id, local, stopReason? }` and
 * the parent agent is the second event argument. Unknown shapes return
 * undefined (skipped, never recorded).
 * @param {object|undefined} payload
 * @param {object|undefined} [parent]
 * @returns {{ sessionId?: string, turnSeq: number, agentKind: string, label: string, status: string }|undefined}
 */
export function normalizeSubagentTrace(payload, parent) {
  if (!payload || typeof payload !== "object") return undefined;
  const id = typeof payload.id === "string" ? payload.id : undefined;
  const provider = typeof payload.provider === "string" ? payload.provider : "subagent";
  const stopReason = typeof payload.stopReason === "string" ? payload.stopReason : undefined;
  if (!id && !stopReason) return undefined;
  const status = stopReason ? (stopReason === "error" ? "failed" : "settled") : "start";
  const label = id ? `${provider}:${id}` : `${provider}:unknown`;
  const sessionId =
    parent && typeof parent === "object" && typeof parent.session?.id === "string"
      ? parent.session.id
      : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    turnSeq: 0,
    agentKind: "subagent",
    label,
    status,
  };
}
/**
 * Static-panel data fetch: run the read-only CLI snapshots
 * (`workbench tree --json`, `dialogue list --json --limit 50`,
 * `dialogue traces --json --limit 50`) in the given workspace and return
 * structured JSON. Pure function — `config.spawn`,
 * `config.env` and `config.packageRoot` are injectable for tests (the spawn
 * convention matches the rest of the glue); an optional `config.signal`
 * aborts the children. CLI/parse failures map to null fields with `ok: true`
 * (the panel shows an empty state); only infrastructure errors (spawn
 * throwing) yield `ok: false`.
 * @param {string} workspaceRoot
 * @param {GraphFlowDshPluginConfig & {signal?: AbortSignal}} [config]
 * @returns {Promise<{ok: boolean, workbench?: unknown, dialogues?: unknown, traces?: unknown, error?: string}>}
 */
export async function collectNodesData(workspaceRoot, config = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    return { ok: false, error: "no-workspace" };
  }
  try {
    const [wb, dl, tr] = await Promise.all([
      spawnCliCapture(["workbench", "tree", "--json"], workspaceRoot, config, config.signal),
      spawnCliCapture(["dialogue", "list", "--json", "--limit", "50"], workspaceRoot, config, config.signal),
      spawnCliCapture(["dialogue", "traces", "--json", "--limit", "50"], workspaceRoot, config, config.signal),
    ]);
    return {
      ok: true,
      workbench: parseCliOut(wb),
      dialogues: parseCliOut(dl),
      traces: parseCliOut(tr),
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/** Connection instances already wired for the /gf channel (re-apply guard). */
const wiredRpcConnections = new WeakSet();

/**
 * Thin Connection RPC handler for the static panel: wraps collectNodesData
 * into the mandatory RpcResult envelope. The envelope is validated by the
 * client `serverResponseSchema` (dsh-host-apiproxy rpc.schema.js): success is
 * `{ ok: true, value }`; failure is `{ ok: false, error: { code, message,
 * details } }` with `bad-request` requiring `details.issues` and `internal`
 * requiring `details: {}`.
 * @param {string} endpoint - path segment after /gf (e.g. "nodes").
 * @param {unknown} payload - client envelope payload (e.g. { workspaceRoot }).
 * @param {AbortSignal} [signal]
 * @param {GraphFlowDshPluginConfig} [config]
 * @returns {Promise<{ok: boolean, value?: object, error?: object}>}
 */
async function rpcNodesHandler(endpoint, payload, signal, config) {
  try {
    if (endpoint !== "nodes") {
      return {
        ok: false,
        error: { code: "bad-request", message: `unknown endpoint ${String(endpoint)}`, details: { issues: [] } },
      };
    }
    const result = await collectNodesData(
      payload && typeof payload === "object" ? payload.workspaceRoot : undefined,
      { ...config, signal }
    );
    if (result.ok !== true) {
      const code = result.error === "no-workspace" ? "bad-request" : "internal";
      const message = String(result.error ?? (code === "bad-request" ? "no-workspace" : "internal error"));
      return {
        ok: false,
        error:
          code === "bad-request"
            ? { code, message, details: { issues: [] } }
            : { code, message, details: {} },
      };
    }
    return {
      ok: true,
      value: {
        workbench: result.workbench ?? null,
        dialogues: result.dialogues ?? null,
        traces: result.traces ?? null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: "internal", message: String(error && error.message ? error.message : error), details: {} },
    };
  }
}

function logGlue(config, level, message) {
  try {
    const logger = config?.log;
    if (logger && typeof logger[level] === "function") {
      logger[level](`[graphflow-dsh] ${message}`);
      return;
    }
    const fallback = level === "error" ? console.error : console.warn;
    fallback(`[graphflow-dsh] ${message}`);
  } catch {
    // logging must never throw into the harness
  }
}

/**
 * Resolve a Connection service from a Cordis ctx, an inject fork, or the
 * connection object itself. `ctx.get("connection")` may be undefined while
 * `ctx.connection` is already set (or the reverse); try both. Never throws.
 * @param {object|undefined} source
 * @returns {object|undefined}
 */
export function resolveConnectionService(source) {
  if (!source || typeof source !== "object") return undefined;
  if (typeof source.get === "function") {
    try {
      const viaGet = source.get("connection");
      if (viaGet && typeof viaGet === "object") return viaGet;
    } catch {
      // service not ready / get threw
    }
  }
  if (source.connection && typeof source.connection === "object") return source.connection;
  if (source.rpc && typeof source.rpc.handle === "function") return source;
  return undefined;
}

function attachRpcEffect(targetCtx, dispose) {
  if (!targetCtx || typeof targetCtx.effect !== "function") return;
  try {
    targetCtx.effect(() => dispose, "graphflow-dsh: /gf nodes rpc channel");
  } catch {
    // effect bus missing — the apply return value still cleans up
  }
}

/**
 * Wire `/gf` on one connection instance. Idempotent per connection.
 * Failures are logged (not swallowed). Never throws.
 * @returns {(() => void)|undefined}
 */
function registerNodesRpcOnConnection(connection, ctx, config) {
  if (!connection || typeof connection !== "object") {
    logGlue(config, "warn", "/gf RPC: connection service unavailable");
    return undefined;
  }
  const rpc = connection.rpc;
  if (!rpc || typeof rpc.handle !== "function") {
    logGlue(config, "warn", "/gf RPC: connection.rpc.handle is missing");
    return undefined;
  }
  if (wiredRpcConnections.has(connection)) return undefined;
  wiredRpcConnections.add(connection);
  let disposer;
  try {
    disposer = rpc.handle(NODES_CHANNEL, (endpoint, payload, signal) => rpcNodesHandler(endpoint, payload, signal, config), {
      authority: "trusted-host",
    });
  } catch (error) {
    wiredRpcConnections.delete(connection);
    logGlue(
      config,
      "error",
      `/gf RPC: rpc.handle("${NODES_CHANNEL}") failed: ${error && error.message ? error.message : error}`
    );
    return undefined;
  }
  const dispose = () => {
    if (!wiredRpcConnections.has(connection)) return;
    wiredRpcConnections.delete(connection);
    if (typeof disposer === "function") {
      try {
        disposer();
      } catch {
        // teardown is best-effort
      }
    }
  };
  attachRpcEffect(ctx, dispose);
  return dispose;
}

/**
 * Best-effort registration of the /gf Connection RPC channel
 * (`ctx.connection.rpc.handle("/gf", handler, { authority: "trusted-host" })`
 * — see dsh-client-connection lib/index.js:219-258: the handler is
 * `(endpoint, payload, signal)` and `handle` returns a disposer).
 *
 * The host `connection` service is often not ready at apply() time
 * (`ctx.get("connection")` is undefined because it injects `webRuntime`).
 * Mirror DSH api-gateway: wait with `ctx.inject(["connection"], cb)` and
 * register when the service appears. Duck-typed, idempotent (one channel
 * per connection), and the returned disposer both unregisters via the
 * handle disposer and is attached to `ctx.effect` when available.
 * Registration failures are logged. Never throws.
 * @param {object} ctx
 * @param {GraphFlowDshPluginConfig} [config]
 * @returns {(() => void)|undefined}
 */
function registerNodesRpcChannel(ctx, config) {
  const disposeHolder = { current: undefined };
  let disposed = false;

  const tryRegister = (sourceCtx) => {
    if (disposed) return undefined;
    const connection = resolveConnectionService(sourceCtx) ?? resolveConnectionService(ctx);
    if (!connection) return undefined;
    const dispose = registerNodesRpcOnConnection(connection, sourceCtx ?? ctx, config);
    if (dispose) {
      disposeHolder.current = dispose;
      attachRpcEffect(ctx, dispose);
    }
    return dispose;
  };

  tryRegister(ctx);

  if (!disposeHolder.current && ctx && typeof ctx.inject === "function") {
    logGlue(config, "warn", '/gf RPC: connection not ready; waiting via ctx.inject(["connection"])');
    try {
      ctx.inject(["connection"], (injected) => {
        try {
          if (disposed) return;
          const dispose = tryRegister(injected ?? ctx);
          if (!dispose && !disposeHolder.current) {
            logGlue(config, "warn", "/gf RPC: connection inject fired but /gf channel was not registered");
          }
        } catch (error) {
          logGlue(
            config,
            "error",
            `/gf RPC: delayed registration failed: ${error && error.message ? error.message : error}`
          );
        }
      });
    } catch (error) {
      logGlue(
        config,
        "error",
        `/gf RPC: ctx.inject(["connection"]) failed: ${error && error.message ? error.message : error}`
      );
    }
  }

  return () => {
    disposed = true;
    if (typeof disposeHolder.current === "function") {
      try {
        disposeHolder.current();
      } catch {
        // teardown is best-effort
      }
      disposeHolder.current = undefined;
    }
  };
}

/**
 * CLI fallback backfill: `context preview --reply` (task-preferred "fill
 * pending" semantics) followed by `dialogue record --reply`, so the pending
 * DIALOGUE turn is closed even when the preview path only lands on a workbench
 * topic. Both are idempotent tip fills (reply-only mode never records a new
 * turn). Never throws.
 * @returns {{attempted: boolean, reason?: string, workspace?: string}}
 */
export function captureReplyViaCli(text, sessionId, workspace, config = {}) {
  try {
    const reply = clipReplyText(text);
    if (!reply) return { attempted: false, reason: "no-text" };
    const sessionArgs =
      typeof sessionId === "string" && sessionId.trim() ? ["--session", sessionId] : [];
    spawnCliFillArgs(["context", "preview", "--reply", reply, ...sessionArgs], workspace, config);
    spawnCliFillArgs(["dialogue", "record", "--reply", reply, ...sessionArgs], workspace, config);
    return { attempted: true, mode: "cli", workspace };
  } catch {
    return { attempted: false, reason: "error" };
  }
}

/**
 * Latest-wins per-session fill queue: only the most recent reply per dialogue
 * session is kept, one fill runs per session at a time, and a just-finished
 * turn's fill is never lost to a newer one. Module-level so every `apply`
 * shares the same throttle.
 */
const pendingFills = new Map();
const inflightFills = new Set();

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function runReplyFillEntry(key, entry) {
  try {
    let direct;
    try {
      direct = await captureReplyInProcess(entry.reply, entry.sessionId, entry.workspace, entry.config);
    } catch {
      direct = undefined;
    }
    if (direct?.ok === true) return;
    if (direct?.reason === "no-pending-turn" && !entry.retried) {
      // The question record (detached spawn) may not have landed yet — retry
      // once, unless a newer fill superseded this one meanwhile.
      entry.retried = true;
      await delay(REPLY_RETRY_DELAY_MS);
      if (!pendingFills.has(key)) await runReplyFillEntry(key, entry);
      return;
    }
    captureReplyViaCli(entry.reply, entry.sessionId, entry.workspace, entry.config);
  } catch {
    // never throw into the harness
  }
}

function drainReplyFills() {
  for (const [key, entry] of pendingFills) {
    if (inflightFills.has(key)) continue;
    pendingFills.delete(key);
    inflightFills.add(key);
    runReplyFillEntry(key, entry).finally(() => {
      inflightFills.delete(key);
      drainReplyFills();
    });
  }
}

/**
 * Queue one reply fill. Checks the master switch (`GRAPHFLOW_AUTO_CAPTURE`)
 * and the reply-only switch (`GRAPHFLOW_CAPTURE_REPLY`), clips the text, then
 * enqueues per dialogue session (omitted session id → "main"). Returns
 * synchronously; the fill itself runs async in the background.
 * @param {string} text
 * @param {string} [sessionId]
 * @param {string} [workspace]
 * @param {GraphFlowDshPluginConfig} [config]
 * @returns {{attempted: boolean, reason?: string, queued?: boolean, key?: string}}
 */
export function fillPendingReply(text, sessionId, workspace, config = {}) {
  try {
    const env = envOf(config);
    if (!isAutoCaptureEnabled(env)) return { attempted: false, reason: "auto-capture-off" };
    if (!isReplyCaptureEnabled(env)) return { attempted: false, reason: "reply-capture-off" };
    const reply = clipReplyText(text);
    if (!reply) return { attempted: false, reason: "no-text" };
    const key = typeof sessionId === "string" && sessionId.trim() ? sessionId : "main";
    const ws = typeof workspace === "string" && workspace.trim() ? workspace : process.cwd();
    pendingFills.set(key, {
      reply,
      sessionId: key === "main" ? undefined : key,
      workspace: ws,
      config,
      retried: false,
    });
    drainReplyFills();
    return { attempted: true, queued: true, key, workspace: ws };
  } catch {
    return { attempted: false, reason: "error" };
  }
}

export function loadGraphFlowSkillRegistration(packageRoot = PACKAGE_ROOT) {
  const skillPath = join(packageRoot, "skills", "graphflow", "SKILL.md");
  let content = "";
  let description = DEFAULT_SKILL_DESCRIPTION;
  if (existsSync(skillPath)) {
    try {
      content = readFileSync(skillPath, "utf8");
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
      const descLine = fm?.[1]?.match(/^description:\s*["']?(.+?)["']?\s*$/m);
      if (descLine?.[1]) {
        description = descLine[1].replace(/\\"/g, '"').trim();
      }
    } catch {
      content = "";
    }
  }
  return {
    name: "graphflow",
    description,
    content,
    source: "runtime",
    path: skillPath,
  };
}

function payloadAgent(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.agent && typeof payload.agent === "object") return payload.agent;
  return payload;
}

export function resolveWorkspaceCwd(payload, fallbackCwd = process.cwd()) {
  const agent = payloadAgent(payload);
  const session = payload?.session ?? agent?.session;
  const candidates = [
    payload?.cwd,
    agent?.cwd,
    session?.cwd,
    typeof fallbackCwd === "string" ? fallbackCwd : undefined,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return process.cwd();
}

function buildOutcomeArgs(episodeId, success) {
  return ["-y", "--package=@roarpeng/graphflow", "graphflow", "outcome", "report", episodeId, success ? "true" : "false"];
}

/**
 * Best-effort close of the latest pending episode for `cwd`.
 * Reuses `graphflow outcome report` (same flywheel as Claude Code SessionEnd).
 * Does not default pending episodes to success: GRAPHFLOW_HOOK_SUCCESS must be
 * an explicit true/false. Never throws.
 */
export function closePendingEpisodeForCwd(cwd, config = {}) {
  try {
    const env = envOf(config);
    if (!isAutoCaptureEnabled(env)) {
      return { attempted: false, reason: "auto-capture-off" };
    }
    const workspace = typeof cwd === "string" && cwd.trim() ? cwd : process.cwd();
    const journalPath = resolveSessionJournalPath(workspace);
    const episodeId = latestPendingEpisodeId(journalPath);
    if (!episodeId) {
      return { attempted: false, reason: "no-pending-episode" };
    }
    const success = resolveExplicitSuccess(env);
    if (success === undefined) {
      return { attempted: false, reason: "no-explicit-success", episodeId };
    }
    const spawnFn = typeof config.spawn === "function" ? config.spawn : spawn;
    const bin = env.GRAPHFLOW_HOOK_BIN?.trim() || "npx";
    spawnFn(bin, buildOutcomeArgs(episodeId, success), {
      cwd: workspace,
      env,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    })?.unref?.();
    return { attempted: true, episodeId };
  } catch {
    return { attempted: false, reason: "error" };
  }
}

function registerSkill(ctx, config) {
  const skills = ctx?.skills;
  if (!skills || typeof skills.register !== "function") return;
  const skill =
    typeof config.readSkill === "function" ? config.readSkill() : loadGraphFlowSkillRegistration();
  skills.register(skill);
}

function listen(ctx, event, handler) {
  if (!ctx || typeof ctx.on !== "function") return;
  ctx.on(event, handler);
}

/**
 * Cordis plugin entry. DSH mounts this row as `id: graphflow-dsh`.
 * @param {object} ctx duck-typed Cordis context
 * @param {GraphFlowDshPluginConfig} [config]
 */
export function apply(ctx, config = {}) {
  try {
    registerSkill(ctx, config);
  } catch {
    // missing or duplicate skill registry — ignore
  }

  // Static-panel data channel: /gf Connection RPC (registerNodesRpcChannel).
  // Registers immediately when connection is already on ctx; otherwise waits
  // via ctx.inject(["connection"]) so apply() racing webRuntime still works.
  // Failures are logged. Never throw into the harness.
  let disposeNodesRpc;
  try {
    disposeNodesRpc = registerNodesRpcChannel(ctx, config);
  } catch (error) {
    logGlue(
      config,
      "error",
      `/gf RPC: registerNodesRpcChannel threw: ${error && error.message ? error.message : error}`
    );
  }

  const hinted = new WeakSet();
  const closed = new Set();

  const closeFromPayload = (payload) => {
    try {
      const cwd = resolveWorkspaceCwd(payload, config.cwd);
      const journalPath = resolveSessionJournalPath(cwd);
      const episodeId = latestPendingEpisodeId(journalPath);
      if (episodeId && closed.has(episodeId)) {
        return { attempted: false, reason: "already-closed" };
      }
      const result = closePendingEpisodeForCwd(cwd, config);
      if (result.episodeId) closed.add(result.episodeId);
      return result;
    } catch {
      return { attempted: false, reason: "error" };
    }
  };

  try {
    // Claude Code SessionEnd analog. Do not close on session/flush — that is a
    // live durability checkpoint, not session end; reporting true there would
    // mark the flywheel successful while the agent is still working.
    listen(ctx, "agent/disposed", (payload) => {
      closeFromPayload(payload);
    });
  } catch {
    // event bus missing
  }

  const recordedInboxMessages = new WeakSet();

  try {
    // Auto record every user question as a dialogue-turn node (the dsh analog
    // of Claude Code's PostToolUse capture): each web/agent question becomes a
    // graph node with session/workspace lineage, without relying on the agent
    // calling graphflow_context itself. Turns are scoped to the dsh session id
    // so question recording and reply filling stay in the same dialogue
    // session (never crossing same-workspace sessions).
    listen(ctx, "agent/inbox/inserted", (payload) => {
      try {
        const message = payload?.message;
        if (!message || typeof message !== "object") return;
        if (recordedInboxMessages.has(message)) return;
        recordedInboxMessages.add(message);
        const agent = payloadAgent(payload);
        const cwd =
          agent?.session?.header?.cwd ??
          resolveWorkspaceCwd(payload, config.cwd);
        recordDialogueFromInbox(message, cwd, config, agent?.session?.id);
      } catch {
        // recording is optional
      }
    });
  } catch {
    // event bus missing
  }

  // Per-session tracking for the reply backfill. Session events are durable
  // envelopes `{ type, seq, time, data }`; the assistant message lives at
  // `event.data.message` (NOT `event.message` — the earlier wiring read the
  // wrong field, so every fill was a silent "no-text" no-op).
  const lastReplyBySession = new WeakMap(); // session -> { turn, text }
  const filledTurnsBySession = new WeakMap(); // session -> Set<turn>

  try {
    // Auto fill every COMPLETED turn's final assistant reply into the pending
    // dialogue turn of the same dsh session. `assistant/message` fires per
    // STEP (intermediate tool-call steps included), so it only feeds a
    // per-turn "last text" buffer; the durable `turn/end` event is the commit
    // point — one fill per (session, turn), skipped for interrupted/aborted
    // turns and for turns whose final message carried no text. Fills are
    // scoped by the subject session id, so a subagent's reply closes its own
    // dialogue session and can never overwrite the parent's pending turn.
    listen(ctx, "session/event", (session, event) => {
      try {
        if (!session || typeof session !== "object") return;
        const type = event?.type;
        if (type === "assistant/message") {
          if (event?.data?.interrupted || event?.interrupted) return;
          const text = extractMessageText(sessionEventMessage(event));
          if (!text) return;
          const turn = event?.data?.turn ?? event?.turn;
          if (typeof turn !== "number") return;
          lastReplyBySession.set(session, { turn, text });
          return;
        }
        if (type === "turn/end") {
          const reason = event?.data?.reason ?? event?.reason;
          const kind = reason && typeof reason === "object" ? reason.kind : undefined;
          if (kind === "interrupted" || kind === "aborted") return;
          const turn = event?.data?.turn ?? event?.turn;
          if (typeof turn !== "number") return;
          const entry = lastReplyBySession.get(session);
          if (!entry || entry.turn !== turn) return;
          let filled = filledTurnsBySession.get(session);
          if (filled?.has(turn)) return; // already committed
          filled ??= new Set();
          filled.add(turn);
          filledTurnsBySession.set(session, filled);
          lastReplyBySession.delete(session);
          fillPendingReply(entry.text, session?.id, session?.header?.cwd ?? config.cwd, config);
        }
      } catch {
        // reply fill is optional
      }
    });
  } catch {
    // event bus missing
  }

  try {
    // Conversation Graph W3a: multi-agent trajectory capture. Each
    // `subagent/start` / `subagent/end` becomes an agent-trace Decision node
    // in the workspace's dialogue graph (session-scoped when the parent
    // session is known), so the conversation graph carries WHO did WHAT
    // inside a turn — not just Q/A. In-process first (co-located runtime);
    // a missing runtime is a silent no-op. GRAPHFLOW_CAPTURE_TRACE=0 kills it.
    listen(ctx, "subagent/start", (payload, parent) => {
      try {
        if (!isTraceCaptureEnabled(envOf(config))) return;
        const trace = normalizeSubagentTrace(payload, parent);
        if (!trace) return;
        const workspace = resolveWorkspaceCwd(parent, config.cwd);
        writeAgentTraceInProcess(trace, workspace, config).catch(() => {});
      } catch {
        // trace capture is optional
      }
    });
    listen(ctx, "subagent/end", (payload, parent) => {
      try {
        if (!isTraceCaptureEnabled(envOf(config))) return;
        const trace = normalizeSubagentTrace(payload, parent);
        if (!trace) return;
        const workspace = resolveWorkspaceCwd(parent, config.cwd);
        writeAgentTraceInProcess(trace, workspace, config).catch(() => {});
      } catch {
        // trace capture is optional
      }
    });
  } catch {
    // event bus missing
  }

  try {
    // First-turn hint must ride in the *same* step as the user's first
    // message. `agent.inject()` from pre-step appends to the *next* step
    // inbox (and can spawn a trailing step the model refuses). Extend the
    // enter decision's `messages` after `next()` instead — same WeakSet
    // gating and source tagging, no driver wake.
    listen(ctx, "agent/pre-step", async (payload, next) => {
      let decision;
      try {
        decision = typeof next === "function" ? await next() : undefined;
      } catch {
        return undefined;
      }
      try {
        if (!decision || decision.kind !== "enter") return decision;
        const agent = payloadAgent(payload);
        if (!agent || hinted.has(agent)) return decision;
        const hint = buildHintMessage(resolveWorkspaceCwd(payload, config.cwd));
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        hinted.add(agent);
        return { ...decision, messages: [...messages, hint] };
      } catch {
        return decision;
      }
    });
  } catch {
    // event bus missing
  }

  // Cordis uses apply's return value as the plugin disposer: tear down the
  // /gf channel on unload (idempotent; the harness may also dispose it via
  // ctx.effect when available).
  return disposeNodesRpc;
}
