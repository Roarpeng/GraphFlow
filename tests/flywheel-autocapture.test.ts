import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/config/loader";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory";
import {
  isAutoCaptureEnabled,
  maybeAutoCaptureEpisode,
  readJournalEntries,
  resolveSessionJournalPath,
} from "../src/hooks/auto-capture";
import { parseEpisodes, updateEpisodeOutcome } from "../src/learning/episodic-memory";
import {
  buildClaudeCodeHooksConfig,
  installClaudeCodeHooks,
  shellQuote,
  uninstallClaudeCodeHooks,
} from "../src/integrations/claude-code-hooks";

const REPO_ROOT = join(__dirname, "..");
const tempDirs: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeClient(): GraphClient {
  const config = validateConfig({
    providers: {},
    tiers: {
      smart: { provider: "openai", model: "gpt-4.1" },
      economy: { provider: "openai", model: "gpt-4.1-mini" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      transport: "memory",
      maxContextTokens: 200,
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly",
      exportPath: "graphflow-out/learning-dataset.jsonl",
    },
  });
  return createGraphClient(config);
}

interface BackfillModule {
  runBackfill: (options?: {
    root?: string;
    storePath?: string;
    eventsPath?: string;
    limit?: number;
    dryRun?: boolean;
  }) => { source: string; total: number; added: number; skipped: number; storePath: string };
}

async function loadBackfill(): Promise<BackfillModule> {
  const mod = (await import("../scripts/backfill-episodes.cjs")) as unknown as BackfillModule;
  return mod;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("auto-capture switch (default off)", () => {
  it("isAutoCaptureEnabled is off by default and on for accepted values", () => {
    expect(isAutoCaptureEnabled({})).toBe(false);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "0" })).toBe(false);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "false" })).toBe(false);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "1" })).toBe(true);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "true" })).toBe(true);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "on" })).toBe(true);
    expect(isAutoCaptureEnabled({ GRAPHFLOW_AUTO_CAPTURE: "YES" })).toBe(true);
  });

  it("records nothing when the flag is off (default, backward compatible)", async () => {
    vi.stubEnv("GRAPHFLOW_AUTO_CAPTURE", "");
    const client = makeClient();
    const root = makeTempRoot("gf-auto-off-");
    const result = await maybeAutoCaptureEpisode(
      client,
      { task: "fix the widget", status: "DELEGATED" },
      { workspaceRoot: root }
    );
    expect(result.enabled).toBe(false);
    expect(result.recorded).toBe(false);
    expect(result.episodeId).toBeUndefined();
    expect(existsSync(resolveSessionJournalPath(root))).toBe(false);
    const nodes = await client.queryByKeyword("episode");
    expect(nodes).toHaveLength(0);
  });
});

describe("pending auto-capture", () => {
  it("records a pending episode (never fabricates COMPLETED) and journals it", async () => {
    const client = makeClient();
    const root = makeTempRoot("gf-auto-pending-");
    const result = await maybeAutoCaptureEpisode(
      client,
      { task: "fix the widget", status: "DELEGATED" },
      { enabled: true, workspaceRoot: root, now: 1_700_000_000_000 }
    );
    expect(result.enabled).toBe(true);
    expect(result.recorded).toBe(true);
    expect(result.journaled).toBe(true);
    expect(result.episodeId).toMatch(/^episode:/);

    // pending，不伪造结局
    const nodes = await client.queryByKeyword("episode");
    const [rec] = parseEpisodes(nodes);
    expect(rec).toBeDefined();
    expect(rec?.outcome).toBe("pending");
    expect(rec?.id).toBe(result.episodeId);

    // 会话日志条目
    const entries = readJournalEntries(resolveSessionJournalPath(root));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.episodeId).toBe(result.episodeId);
    expect(entries[0]?.status).toBe("DELEGATED");
  });

  it("resolves a pending episode to a real outcome via updateEpisodeOutcome", async () => {
    const client = makeClient();
    const root = makeTempRoot("gf-auto-resolve-");
    const result = await maybeAutoCaptureEpisode(
      client,
      { task: "refactor module B", status: "DELEGATED" },
      { enabled: true, workspaceRoot: root }
    );
    expect(result.episodeId).toBeDefined();

    await updateEpisodeOutcome(client, result.episodeId!, "pass", ["lesson: extract the helper"]);

    const nodes = await client.queryByKeyword("episode");
    const [rec] = parseEpisodes(nodes);
    expect(rec?.outcome).toBe("pass");
    expect(rec?.lessons).toEqual(["lesson: extract the helper"]);
  });

  it("reuses existingEpisodeId instead of double-recording", async () => {
    const client = makeClient();
    const root = makeTempRoot("gf-auto-reuse-");
    const result = await maybeAutoCaptureEpisode(
      client,
      { task: "delegated work", status: "DELEGATED", existingEpisodeId: "episode:external" },
      { enabled: true, workspaceRoot: root }
    );
    expect(result.recorded).toBe(true);
    expect(result.episodeId).toBe("episode:external");
    // 图里没有新增节点（复用调用方已记录的 episode）
    const nodes = await client.queryByKeyword("episode");
    expect(nodes).toHaveLength(0);
    // 日志记录了复用的 id
    const entries = readJournalEntries(resolveSessionJournalPath(root));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.episodeId).toBe("episode:external");
  });

  it("dedupes repeated runs of the same task within the window", async () => {
    const client = makeClient();
    const root = makeTempRoot("gf-auto-dedupe-");
    const first = await maybeAutoCaptureEpisode(
      client,
      { task: "same task", status: "DELEGATED" },
      { enabled: true, workspaceRoot: root, now: 1_000 }
    );
    const second = await maybeAutoCaptureEpisode(
      client,
      { task: "same task", status: "DELEGATED" },
      { enabled: true, workspaceRoot: root, now: 2_000 }
    );
    expect(second.skipped).toBe("recent-pending-exists");
    expect(second.episodeId).toBe(first.episodeId);
    expect(readJournalEntries(resolveSessionJournalPath(root))).toHaveLength(1);
  });

  it("skips runs whose outcome is already known (no fabricated pending)", async () => {
    const client = makeClient();
    const root = makeTempRoot("gf-auto-known-");
    const result = await maybeAutoCaptureEpisode(
      client,
      { task: "finished task", status: "COMPLETED" },
      { enabled: true, workspaceRoot: root }
    );
    expect(result.skipped).toBe("outcome-known:COMPLETED");
    expect(result.recorded).toBe(false);
    expect(result.journaled).toBe(false);
    expect(existsSync(resolveSessionJournalPath(root))).toBe(false);
  });
});

describe("Claude Code hooks generator", () => {
  it("builds settings.json-style hooks with shell-quoted commands", () => {
    const config = buildClaudeCodeHooksConfig({
      hooksDir: "/tmp/gf hooks",
      settingsPath: "/tmp/settings.json",
    });
    expect(Object.keys(config.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "Stop"]);
    for (const entries of Object.values(config.hooks)) {
      // 带空格的脚本路径必须整体被单引号包裹（shell 安全拼接）
      expect(entries?.[0]?.command).toContain("'");
      expect(entries?.[0]?.command).toContain("bash '/tmp/gf hooks/session.sh'");
      expect(entries?.[0]?.timeout).toBeGreaterThan(0);
    }
    // SessionEnd 与 Stop 使用同一个 end 命令
    expect(config.hooks.SessionEnd?.[0]?.command).toBe(config.hooks.Stop?.[0]?.command);
  });

  it("shellQuote escapes single quotes safely", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("path with space")).toBe("'path with space'");
  });

  it("installs hooks preserving user settings, is idempotent, and uninstalls cleanly", () => {
    const dir = makeTempRoot("gf-hooks-");
    const settingsPath = join(dir, "settings.json");
    const hooksDir = join(dir, "hooks");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: "claude-sonnet-4",
          hooks: {
            PreCompact: [{ type: "command", command: "echo compact" }],
          },
        },
        null,
        2
      )
    );

    const r1 = installClaudeCodeHooks({
      hooksDir,
      settingsPath,
      journalPath: join(dir, ".graphflow", "session-journal.jsonl"),
    });
    expect(r1.status).toBe("updated");
    expect(r1.filePath).toBe(settingsPath);

    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      model: string;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(parsed.model).toBe("claude-sonnet-4"); // 用户配置被保留
    expect(parsed.hooks.PreCompact).toHaveLength(1); // 用户 hooks 被保留
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionEnd).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(existsSync(join(hooksDir, "session.sh"))).toBe(true);

    // 幂等：重复安装不改变文件内容
    const before = readFileSync(settingsPath, "utf8");
    const r2 = installClaudeCodeHooks({
      hooksDir,
      settingsPath,
      journalPath: join(dir, ".graphflow", "session-journal.jsonl"),
    });
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(["created", "updated", "skipped"]).toContain(r2.status);

    // 卸载：仅移除 graphflow 条目，保留用户 hooks
    const uninstallResult = uninstallClaudeCodeHooks(settingsPath, hooksDir);
    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ command: string }> | undefined>;
    };
    expect(uninstallResult.status).toBe("updated");
    expect(after.hooks.PreCompact).toHaveLength(1);
    expect(after.hooks.SessionStart ?? []).toHaveLength(0);
    expect(after.hooks.SessionEnd ?? []).toHaveLength(0);
    expect(after.hooks.Stop ?? []).toHaveLength(0);
  });
});

describe("backfill-episodes", () => {
  it("backfills from .graphflow/learning-events.jsonl and is idempotent", async () => {
    const mod = await loadBackfill();
    const root = makeTempRoot("gf-backfill-events-");
    const eventsPath = join(root, ".graphflow", "learning-events.jsonl");
    mkdirSync(dirname(eventsPath), { recursive: true });
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({ query: "fix bug A", passed: true, tokenCost: 100, retries: 2 }),
        JSON.stringify({ query: "refactor B", passed: false, tokenCost: 250, retries: 1 }),
      ].join("\n")
    );
    const storePath = join(root, "graphflow-out", "graphflow-graph.json");

    // dry-run 不写盘
    const dry = mod.runBackfill({ root, storePath, dryRun: true });
    expect(dry.added).toBe(2);
    expect(existsSync(storePath)).toBe(false);

    const first = mod.runBackfill({ root, storePath });
    expect(first.source).toContain("learning-events");
    expect(first.total).toBe(2);
    expect(first.added).toBe(2);

    // 幂等：第二次运行不重复写入
    const second = mod.runBackfill({ root, storePath });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(2);

    const store = JSON.parse(readFileSync(storePath, "utf8")) as {
      nodes: Array<{ id: string; type: string; metadata: { kind: string; record: string } }>;
    };
    expect(store.nodes).toHaveLength(2);
    expect(store.nodes[0]?.metadata.kind).toBe("episode");
    const records = store.nodes.map((n) => JSON.parse(n.metadata.record) as { outcome: string });
    expect(records.some((r) => r.outcome === "pass")).toBe(true);
    expect(records.some((r) => r.outcome === "fail")).toBe(true);
  });

  it("falls back to git log mining (subject/body) and stays idempotent", async () => {
    const mod = await loadBackfill();
    const root = makeTempRoot("gf-backfill-git-");
    const storePath = join(root, "graphflow-out", "graphflow-graph.json");
    // 显式指向不存在的 events 文件，强制走 git log 分支（仓库本身是 git 仓库）
    const missingEvents = join(root, ".graphflow", "learning-events.jsonl");

    const first = mod.runBackfill({ root: REPO_ROOT, storePath, eventsPath: missingEvents, limit: 10 });
    expect(first.source).toContain("git-log");
    expect(first.added).toBe(10);

    const second = mod.runBackfill({ root: REPO_ROOT, storePath, eventsPath: missingEvents, limit: 10 });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(10);
  });
});
