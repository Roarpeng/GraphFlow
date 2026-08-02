#!/usr/bin/env node
/**
 * backfill-episodes.cjs — 一次性回填脚本（P0-2 学习飞轮自动闭环）
 *
 * 把历史学习信号回填为 episode 记录，让飞轮无需宿主 agent 主动 report_outcome 也有数据：
 *  1. 优先解析 `.graphflow/learning-events.jsonl`（真实反馈事件，含 pass/fail），
 *     不存在时回退到 `graphflow-out/learning-events.jsonl`（默认 eventsPath）；
 *  2. 否则从 `git log`（最近 200 条 commit 的 subject/body）挖掘 episode 记录。
 *
 * 写入图存储（transport=file，默认 `graphflow-out/graphflow-graph.json`）。
 * 容错、幂等、不阻断：重复执行按 node id 去重，不会重复写入；任何错误只打印不抛给宿主。
 *
 * 用法：
 *   node scripts/backfill-episodes.cjs [--root <dir>] [--store <graph.json>]
 *        [--events <events.jsonl>] [--limit N] [--dry-run]
 *
 * 核心逻辑以纯函数导出（module.exports），供 tests/flywheel-autocapture.test.ts 直接调用。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EPISODE_PREFIX = "episode:";
const BACKFILL_LIMIT = 200;

// ── 纯函数核心 ────────────────────────────────────────────────────────

/** 与 src/utils/hash.ts 的 hashText 一致（DJB2a, base36），保证 id 稳定。 */
function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/** 从 learning-events.jsonl 解析真实反馈事件 → episode 记录（内容哈希 id，天然幂等）。 */
function episodesFromEventsFile(eventsPath) {
  if (!eventsPath || !fs.existsSync(eventsPath)) {
    return [];
  }
  const out = [];
  const lines = fs
    .readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (typeof evt?.query !== "string" || typeof evt?.passed !== "boolean") {
        continue; // 容错：跳过非 FeedbackEvent 行
      }
      const tokenCost = typeof evt.tokenCost === "number" ? evt.tokenCost : 0;
      const retries = typeof evt.retries === "number" ? evt.retries : 0;
      const key = `${evt.query}|${String(evt.passed)}|${tokenCost}|${retries}`;
      out.push({
        id: `${EPISODE_PREFIX}events:${hashText(key)}`,
        task: evt.query,
        plan: [],
        outcome: evt.passed ? "pass" : "fail",
        keyDecisions: [`tokenCost=${tokenCost}`, "backfill:learning-events"],
        lessons: [],
        attempts: retries + 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: "backfill:learning-events",
      });
    } catch {
      // 容错：跳过损坏行
    }
  }
  return out;
}

/**
 * 从 git log 挖掘最近 commit（subject/body）→ episode 记录（commit hash id，幂等）。
 * 提交已合入历史，视为真实完成的证据，outcome 用 "pass"；无 git 仓库时返回空数组。
 */
function episodesFromGitLog(root, limit = BACKFILL_LIMIT) {
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["-C", root, "log", `-${limit}`, "--format=%H%x1f%ct%x1f%s%x1f%b%x1e"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }
    );
  } catch {
    return []; // 无 git / git 不可用：容错返回空，不阻断
  }
  const out = [];
  for (const block of raw.split("\x1e")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const [hash, tsRaw, subject, ...bodyParts] = trimmed.split("\x1f");
    if (!hash || !subject) continue;
    const body = (bodyParts.join("\x1f") || "").trim();
    const task = body ? `${subject} — ${truncate(body, 120)}` : subject;
    const ts = Number(tsRaw);
    out.push({
      id: `${EPISODE_PREFIX}commit:${hash}`,
      task,
      plan: [],
      outcome: "pass",
      keyDecisions: [`commit ${hash.slice(0, 12)}`],
      lessons: [],
      attempts: 1,
      createdAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
      updatedAt: Number.isFinite(ts) ? ts * 1000 : Date.now(),
      source: "backfill:git-log",
    });
  }
  return out;
}

/** 读取图存储（容错：缺失/空 → 空 store；损坏 → 抛错，绝不覆盖）。 */
function readStore(storePath) {
  if (!fs.existsSync(storePath)) {
    return { nodes: [], edges: [] };
  }
  const raw = fs.readFileSync(storePath, "utf8");
  if (!raw.trim()) {
    return { nodes: [], edges: [] };
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("graph store JSON root must be an object");
  }
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
}

/** 原子写回（temp + rename，2 空格缩进，与 GraphifyFileClient.writeStore 一致）。 */
function writeStore(storePath, store) {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  const tmp = path.join(dir, `.graphflow-backfill-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, payload, "utf8");
  try {
    fs.renameSync(tmp, storePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * 将 episode 记录合并进图存储（幂等：已存在的 node id 跳过）。
 * dryRun 时不写盘，仅计算 wouldAdd。返回 { total, added, skipped }。
 */
function mergeEpisodesIntoStore(storePath, episodes, dryRun = false) {
  if (episodes.length === 0) {
    return { total: 0, added: 0, skipped: 0 };
  }
  const store = readStore(storePath);
  const existing = new Set(store.nodes.map((node) => node?.id).filter(Boolean));
  const toAdd = [];
  for (const rec of episodes) {
    if (existing.has(rec.id)) continue;
    toAdd.push({
      id: rec.id,
      type: "Decision",
      content: `episode ${truncate(rec.task, 160)}`,
      metadata: { record: JSON.stringify(rec), kind: "episode" },
    });
    existing.add(rec.id);
  }
  if (toAdd.length > 0 && !dryRun) {
    writeStore(storePath, { ...store, nodes: [...store.nodes, ...toAdd] });
  }
  return { total: episodes.length, added: toAdd.length, skipped: episodes.length - toAdd.length };
}

/**
 * 主入口：优先 events 文件，否则 git log。
 * options: { root, storePath, eventsPath, limit }
 */
function runBackfill(options = {}) {
  const root = options.root ?? process.cwd();
  const storePath = options.storePath ?? path.join(root, "graphflow-out", "graphflow-graph.json");
  const limit = typeof options.limit === "number" ? options.limit : BACKFILL_LIMIT;

  const eventsCandidates = options.eventsPath
    ? [options.eventsPath]
    : [
        path.join(root, ".graphflow", "learning-events.jsonl"), // 任务约定位置（优先）
        path.join(root, "graphflow-out", "learning-events.jsonl"), // 默认 eventsPath
        path.join(root, "learning-events.jsonl"),
      ];
  const eventsPath = eventsCandidates.find((p) => fs.existsSync(p));

  let episodes = [];
  let source = "none";
  if (eventsPath) {
    episodes = episodesFromEventsFile(eventsPath);
    if (episodes.length > 0) {
      source = `learning-events:${eventsPath}`;
    }
  }
  if (episodes.length === 0) {
    episodes = episodesFromGitLog(root, limit);
    if (episodes.length > 0) {
      source = `git-log:${root}`;
    }
  }
  if (episodes.length === 0) {
    return { source, total: 0, added: 0, skipped: 0, storePath, root };
  }
  const merged = mergeEpisodesIntoStore(storePath, episodes, options.dryRun === true);
  return { source, storePath, root, ...merged };
}

// ── CLI 入口 ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const flagValue = (name) => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const root = flagValue("--root") ?? process.cwd();
  const storePath = flagValue("--store");
  const eventsPath = flagValue("--events");
  const limitRaw = flagValue("--limit");
  const limit = limitRaw ? Number(limitRaw) : BACKFILL_LIMIT;
  const dryRun = args.includes("--dry-run");

  try {
    const result = runBackfill({ root, storePath, eventsPath, limit, dryRun });
    if (dryRun) {
      console.log(
        `[graphflow] dry-run source=${result.source} episodes=${result.total} ` +
          `wouldAdd=${result.added} store=${result.storePath}`
      );
      process.exit(0);
    }
    console.log(
      `[graphflow] backfill complete source=${result.source} total=${result.total} ` +
        `added=${result.added} skipped=${result.skipped} store=${result.storePath}`
    );
  } catch (error) {
    console.error(
      `[graphflow] backfill failed (no changes written): ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  hashText,
  episodesFromEventsFile,
  episodesFromGitLog,
  readStore,
  writeStore,
  mergeEpisodesIntoStore,
  runBackfill,
};
