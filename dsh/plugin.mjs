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
 * Never throws.
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
    const spawnFn = typeof config.spawn === "function" ? config.spawn : spawn;
    const bin = env.GRAPHFLOW_HOOK_BIN?.trim() || "npx";
    spawnFn(bin, buildOutcomeArgs(episodeId, true), {
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
