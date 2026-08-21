/**
 * GraphFlow DeepSeek Harness (dsh) glue plugin.
 *
 * DSH plugins are ESM (`type: module`); GraphFlow's package root is CJS.
 * This file is the `exports["./dsh"]` entry. Cordis loads it via
 * `name: '@roarpeng/graphflow/dsh'` in cordis.patch.yml.
 *
 * Duck-types `ctx` — no hard dependency on `@deepseek-ai/cordis`.
 * Missing `ctx.skills` / events → no-op. Never throw into the harness loop.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "graphflow-dsh";

const PLUGIN_ID = "graphflow-dsh";
const AUTO_CAPTURE_ENV = "GRAPHFLOW_AUTO_CAPTURE";
const JOURNAL_RELATIVE = join(".graphflow", "session-journal.jsonl");
const DEFAULT_SKILL_DESCRIPTION =
  "图谱上下文压缩、任务规划与知识图谱编排（10 个 MCP 工具）。任何读代码、改代码、排错、中文问题之前必须先调 graphflow_context。DeepSeek Harness 下工具名为 mcp__graphflow__graphflow_*。";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ spawn?: typeof spawn, env?: NodeJS.ProcessEnv, cwd?: string, readSkill?: () => { name: string, description: string, content: string, source: string, path?: string } }} GraphFlowDshPluginConfig */

function envOf(config) {
  return config?.env ?? process.env;
}

export function isAutoCaptureEnabled(env = process.env) {
  const raw = env[AUTO_CAPTURE_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled");
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
 * Whether a message originates from the human user rather than the harness.
 * Only `source.kind === "user"` qualifies; harness/system injections
 * (`plugin`/`tool`/`model`) must not become dialogue turns (job finished
 * notices, subagent reports, tool results, …). Unknown/missing source falls
 * back to the role check so nothing legitimate is dropped.
 * @param {object|undefined} message
 * @returns {boolean}
 */
export function isUserOriginatedMessage(message) {
  if (!message || typeof message !== "object") return false;
  const kind =
    message.source && typeof message.source === "object" ? message.source.kind : undefined;
  if (kind === "user") return true;
  if (kind === "plugin" || kind === "tool" || kind === "model") return false;
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
 * turn for `sessionId`. Spawns `graphflow dialogue record --reply "<text>"
 * [--session <sessionId>]` (reply-only mode) in the workspace; the runtime
 * fills the latest pending turn's assistantReply and safely skips when none is
 * pending. Half-written (interrupted) replies are not filled. Never throws.
 * @param {object|undefined} event - an `assistant/message` session event.
 * @param {string} [sessionId] - dialogue session name/id.
 * @param {string} [cwd]
 * @param {GraphFlowDshPluginConfig} [config]
 * @returns {{attempted: boolean, reason?: string, workspace?: string}}
 */
export function recordReplyFromTurn(event, sessionId, cwd, config = {}) {
  try {
    const text = extractMessageText(event?.message);
    if (!text) {
      return { attempted: false, reason: "no-text" };
    }
    if (event?.interrupted) {
      return { attempted: false, reason: "interrupted" };
    }
    const env = envOf(config);
    if (!isAutoCaptureEnabled(env)) {
      return { attempted: false, reason: "auto-capture-off" };
    }
    const workspace = typeof cwd === "string" && cwd.trim() ? cwd : process.cwd();
    const spawnFn = typeof config.spawn === "function" ? config.spawn : spawn;
    const cli = resolveCliCommand(config.packageRoot);
    const args = [cli, "dialogue", "record", "--reply", text];
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

function safeInjectHint(agent, cwd) {
  if (!agent || typeof agent.inject !== "function") return;
  const text = buildContextHint(cwd);
  agent.inject({
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: PLUGIN_ID, form: "instructions" },
  });
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

  const recordedReplies = new WeakSet();

  try {
    // Auto fill every assistant reply into the latest pending dialogue turn of
    // the same dsh session: closes the question→answer loop so dialogue-turn
    // nodes record a complete exchange without the agent calling
    // graphflow_context({ assistantReply }) itself. Deduped per message object;
    // interrupted (half-written) replies are skipped.
    listen(ctx, "session/event", (session, event) => {
      try {
        if (event?.type !== "assistant/message") return;
        if (event.interrupted) return;
        const message = event.message;
        if (!message || typeof message !== "object") return;
        if (recordedReplies.has(message)) return;
        recordedReplies.add(message);
        recordReplyFromTurn(event, session?.id, session?.header?.cwd, config);
      } catch {
        // reply fill is optional
      }
    });
  } catch {
    // event bus missing
  }

  try {
    listen(ctx, "agent/pre-step", (payload, next) => {
      try {
        const agent = payloadAgent(payload);
        if (agent && !hinted.has(agent)) {
          hinted.add(agent);
          safeInjectHint(agent, resolveWorkspaceCwd(payload, config.cwd));
        }
      } catch {
        // hint is optional
      }
      if (typeof next === "function") {
        return next();
      }
      return undefined;
    });
  } catch {
    // event bus missing
  }
}
