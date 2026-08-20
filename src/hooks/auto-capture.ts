import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskStatus } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { recordEpisode } from "../learning/episodic-memory";
import type { EmbeddingProvider } from "../learning/embeddings";
import { hashText } from "../utils/hash";
import { logger } from "../utils/logger";

/**
 * auto-capture.ts — 学习飞轮自动闭环（P0-1/P0-2）
 *
 * 背景：飞轮依赖宿主 agent 主动调用 `graphflow_report_outcome` 才回填 episode/skill。
 * 本模块在 run/context 完成路径上自动生成 `pending` episode 记录（绝不伪造 COMPLETED），
 * 并把 episodeId 写入会话日志（.graphflow/session-journal.jsonl）；由 Claude Code hooks
 * （SessionEnd / Stop，见 integrations/claude-code-hooks.ts）在会话结束时读取 pending。
 * 仅当成功值作为显式参数传入时才调用 `graphflow outcome report <episodeId> <success>`；
 * 缺省成功值时不回填，episode 保持 pending（绝不默认 success）。
 *
 * 默认开启（飞轮自证）：环境变量未设置或设置为 1/true/on/yes/enabled 时开启，
 * 设置 GRAPHFLOW_AUTO_CAPTURE=0（或 false/off/no/disabled）时显式关闭，
 * 或在调用点显式传入 enabled: false。
 */

export const AUTO_CAPTURE_ENV = "GRAPHFLOW_AUTO_CAPTURE";
export const JOURNAL_FILE = "session-journal.jsonl";
export const JOURNAL_VERSION = 1;
const JOURNAL_MAX_BYTES = 10 * 1024 * 1024; // 10MB，超出后轮转为 .1.jsonl
/** 同一任务在窗口内的重复 pending 记录去重，避免 MCP 重试/重复 run 造成日志膨胀。 */
export const DEFAULT_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

/** 会话日志条目：一条 pending episode 的证据记录（append-only）。 */
export interface SessionJournalEntry {
  version: number;
  kind: "pending-episode";
  episodeId: string;
  task: string;
  taskKey: string;
  status?: TaskStatus;
  createdAt: number;
}

export interface AutoCaptureEpisodeInput {
  task: string;
  plan?: Array<{ id: string; description: string }>;
  keyDecisions?: string[];
  attempts?: number;
  /** 调用方已知的 run 状态；结局已知（COMPLETED/FAILED 等）时不会自动生成 pending。 */
  status?: TaskStatus;
  /** 复用调用方已记录的 episode（避免重复写入同一任务的节点）。 */
  existingEpisodeId?: string;
}

export interface AutoCaptureOptions {
  /** 显式开关；缺省时读取环境变量 GRAPHFLOW_AUTO_CAPTURE。 */
  enabled?: boolean;
  /** 会话日志目录基准（默认 process.cwd()）。 */
  workspaceRoot?: string;
  /** 覆盖会话日志路径。 */
  journalPath?: string;
  embeddingProvider?: EmbeddingProvider;
  /** 测试注入的当前时间戳。 */
  now?: number;
  /** 去重窗口，默认 30 分钟。 */
  dedupeWindowMs?: number;
}

export interface AutoCaptureResult {
  enabled: boolean;
  recorded: boolean;
  episodeId?: string;
  journaled: boolean;
  /** 跳过原因（如 outcome-known:COMPLETED / recent-pending-exists / no-graph-client）。 */
  skipped?: string;
}

export function isAutoCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // 默认开启：仅当显式设置为关闭值（0/false/off/no/disabled）时才关闭。
  const raw = env[AUTO_CAPTURE_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled");
}

export function resolveSessionJournalPath(workspaceRoot?: string): string {
  return join(workspaceRoot ?? process.cwd(), ".graphflow", JOURNAL_FILE);
}

/** 追加会话日志条目（append-only，超出 10MB 轮转为 .1.jsonl，参考 learning-events）。 */
export function appendJournalEntry(journalPath: string, entry: SessionJournalEntry): void {
  mkdirSync(dirname(journalPath), { recursive: true });
  if (existsSync(journalPath)) {
    const stats = statSync(journalPath);
    if (stats.size >= JOURNAL_MAX_BYTES) {
      renameSync(journalPath, `${journalPath}.1`);
    }
  }
  appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/** 读取会话日志（容错：跳过损坏行）。 */
export function readJournalEntries(journalPath: string): SessionJournalEntry[] {
  if (!existsSync(journalPath)) {
    return [];
  }
  const out: SessionJournalEntry[] = [];
  for (const line of readFileSync(journalPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SessionJournalEntry>;
      if (
        typeof parsed.episodeId === "string" &&
        typeof parsed.task === "string" &&
        typeof parsed.createdAt === "number"
      ) {
        out.push({
          version: parsed.version ?? JOURNAL_VERSION,
          kind: "pending-episode",
          episodeId: parsed.episodeId,
          task: parsed.task,
          taskKey: typeof parsed.taskKey === "string" ? parsed.taskKey : hashText(parsed.task),
          ...(parsed.status !== undefined ? { status: parsed.status } : {}),
          createdAt: parsed.createdAt,
        });
      }
    } catch {
      // 容错：跳过损坏行
    }
  }
  return out;
}

export function latestJournalEntry(
  journalPath: string
): SessionJournalEntry | undefined {
  const entries = readJournalEntries(journalPath);
  return entries.length > 0 ? entries[entries.length - 1] : undefined;
}

/** 便捷函数：从会话日志解析出最近的 pending episodeId（hooks/脚本回填用）。 */
export function latestPendingEpisodeId(journalPath: string): string | undefined {
  return latestJournalEntry(journalPath)?.episodeId;
}

/**
 * 结局未知时才需要自动捕获：DELEGATED（外部分发，宿主 agent 执行）与
 * HUMAN_REVIEW_REQUIRED（人工复核）的真实结局在 run 返回时不可知，
 * 需要 hooks 后续回填。COMPLETED/FAILED 等已有真实结局，不伪造 pending。
 */
export function needsAutoCapture(status?: TaskStatus): boolean {
  if (!status) return true;
  return status === "DELEGATED" || status === "HUMAN_REVIEW_REQUIRED";
}

/**
 * 自动生成 pending episode 记录并写入会话日志（供 hooks 回填）。
 * 幂等：同一任务在去重窗口内的重复调用复用最近一次记录，不重复写入。
 * 所有失败不抛出 —— 自动捕获绝不能阻断编排主流程。
 */
export async function maybeAutoCaptureEpisode(
  client: GraphClient | undefined,
  input: AutoCaptureEpisodeInput,
  options: AutoCaptureOptions = {}
): Promise<AutoCaptureResult> {
  const enabled = options.enabled ?? isAutoCaptureEnabled(process.env);
  if (!enabled) {
    return { enabled: false, recorded: false, journaled: false };
  }
  if (!client) {
    return { enabled: true, recorded: false, journaled: false, skipped: "no-graph-client" };
  }
  if (!needsAutoCapture(input.status)) {
    return {
      enabled: true,
      recorded: false,
      journaled: false,
      skipped: `outcome-known:${String(input.status)}`,
    };
  }

  const now = options.now ?? Date.now();
  const journalPath = options.journalPath ?? resolveSessionJournalPath(options.workspaceRoot);
  const window = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const taskKey = hashText(input.task);

  // 去重：从日志尾部向前找同一任务的最近 pending 记录
  const entries = readJournalEntries(journalPath);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.taskKey === taskKey && now - entry.createdAt < window) {
      return {
        enabled: true,
        recorded: true,
        episodeId: entry.episodeId,
        journaled: false,
        skipped: "recent-pending-exists",
      };
    }
  }

  let episodeId = input.existingEpisodeId;
  if (!episodeId) {
    try {
      const episode = await recordEpisode(
        client,
        {
          task: input.task,
          plan: input.plan ?? [],
          outcome: "pending",
          keyDecisions: (input.keyDecisions ?? []).slice(0, 6),
          lessons: [],
          attempts: input.attempts ?? 1,
        },
        options.embeddingProvider
      );
      episodeId = episode.id;
    } catch (error) {
      logger.warn({ error }, "Auto-capture pending episode recording failed");
      return { enabled: true, recorded: false, journaled: false, skipped: "record-failed" };
    }
  }

  const entry: SessionJournalEntry = {
    version: JOURNAL_VERSION,
    kind: "pending-episode",
    episodeId,
    task: input.task,
    taskKey,
    ...(input.status !== undefined ? { status: input.status } : {}),
    createdAt: now,
  };
  try {
    appendJournalEntry(journalPath, entry);
  } catch (error) {
    logger.warn({ error }, "Auto-capture journal append failed");
    return { enabled: true, recorded: true, episodeId, journaled: false, skipped: "journal-failed" };
  }
  return { enabled: true, recorded: true, episodeId, journaled: true };
}
