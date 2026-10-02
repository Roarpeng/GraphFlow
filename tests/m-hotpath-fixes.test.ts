/**
 * 热路径修复回归测试 / Hot-path fix regressions (P0-1a, P0-1b, P0-2).
 *
 * - P0-1a: readGitVisibleFiles 进程内 TTL 缓存 —— 同 rootDir 的连续读取只
 *   spawn 一次 `git ls-files`(此前每次 preview 新鲜度检查都要 spawn git,
 *   256MB maxBuffer)。
 * - P0-1b: loadCacheStateCached 按 (mtimeMs, size) 记忆化 manifest 解析,
 *   indexedStoreIsIncomplete / hasPendingGraphIndexWork 共用同一份解析结果。
 * - P0-2: previewContext / indexFile 在 finally 中关闭自有 graph client;
 *   watcher 增量索引失败走 logger.warn 而不是无声吞掉。
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readGitVisibleFiles, resetGitVisibleCache } from "../src/graph/file-indexer-walker";
import { loadCacheStateCached } from "../src/graph/file-indexer-cache";
import { indexSingleFile } from "../src/graph/file-indexer";
import * as loggerModule from "../src/utils/logger";
import * as clientFactoryModule from "../src/graph/client-factory";
import { resolveConfig } from "../src/config/resolve";
import type { GraphFlowConfig } from "../src/config/schema";
import type { GraphFileWatcher } from "../src/graph/file-watcher";
import { indexFile, previewContext, startFileWatcherIfEnabled } from "../src/surfaces/cli/runtime/graph";
import { createNoLlmConfigPath } from "./helpers/no-llm-config";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

// logger 模块 mock:其余方法沿原型链保持原行为,只有 warn 换成可断言的 vi.fn
// (对 pino 实例直接 spyOn 依赖其内部属性定义方式,这里用 Object.create 保证稳)。
vi.mock("../src/utils/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/logger")>();
  const warn = vi.fn();
  const loggerWithWarnMock = Object.create(actual.logger) as typeof actual.logger;
  Object.defineProperty(loggerWithWarnMock, "warn", { value: warn });
  return { ...actual, logger: loggerWithWarnMock, __mockWarn: warn };
});

// client-factory mock:跟踪 createGraphClient 创建的连接数与 close 次数,
// 用于断言 previewContext / indexFile 不再泄漏自有连接。
vi.mock("../src/graph/client-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/graph/client-factory")>();
  const tracker = { created: 0, closed: 0 };
  const createGraphClient = (config: GraphFlowConfig) => {
    tracker.created += 1;
    const client = actual.createGraphClient(config);
    const originalClose = client.close?.bind(client);
    client.close = () => {
      tracker.closed += 1;
      return originalClose?.();
    };
    return client;
  };
  return { ...actual, createGraphClient, __clientTracker: tracker };
});

// indexSingleFile 可按测试注入失败(watcher 日志测试)。
vi.mock("../src/graph/file-indexer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/graph/file-indexer")>();
  return { ...actual, indexSingleFile: vi.fn(actual.indexSingleFile) };
});

const warnMock = (): Mock =>
  (loggerModule as unknown as { __mockWarn: Mock }).__mockWarn;
const clientTracker = (): { created: number; closed: number } =>
  (clientFactoryModule as unknown as { __clientTracker: { created: number; closed: number } }).__clientTracker;

function gitLsFilesSpawnCount(): number {
  return (spawnSync as unknown as Mock).mock.calls.filter(
    (call) => call[0] === "git" && Array.isArray(call[1]) && call[1].includes("ls-files")
  ).length;
}

function makeWorkspaceConfigPath(root: string, extra?: Record<string, unknown>): string {
  return createNoLlmConfigPath({
    graphPolicy: {
      transport: "memory",
      autoIndexOnRun: false,
      autoIndexOnPreview: false,
      autoIndexOnSave: false,
      workspaceRoot: root,
      ...extra,
    },
  });
}

describe("P0-1a git-visible in-process cache", () => {
  it("reuses the spawn result within TTL; reset and TTL expiry re-spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-hotpath-gitvisible-"));
    const spawnMock = spawnSync as unknown as Mock;
    const delegate = spawnMock.getMockImplementation();
    try {
      mkdirSync(join(root, ".git"));
      spawnMock.mockImplementation(() => ({
        status: 0,
        stdout: Buffer.from("src/a.ts\u0000src/b.ts\u0000"),
      }));

      resetGitVisibleCache();
      const before = gitLsFilesSpawnCount();

      const first = readGitVisibleFiles(root);
      expect(first).toEqual(new Set(["src/a.ts", "src/b.ts"]));
      const second = readGitVisibleFiles(root);
      expect(second).toBe(first); // 命中缓存:同一个 Set 实例
      expect(gitLsFilesSpawnCount()).toBe(before + 1); // 两次读取只 spawn 一次

      resetGitVisibleCache();
      readGitVisibleFiles(root);
      expect(gitLsFilesSpawnCount()).toBe(before + 2); // 测试钩子强制失效

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(Date.now() + 6000));
        readGitVisibleFiles(root);
        expect(gitLsFilesSpawnCount()).toBe(before + 3); // TTL(5s)过期后重查
      } finally {
        vi.useRealTimers();
      }
    } finally {
      if (delegate) spawnMock.mockImplementation(delegate);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P0-1b loadCacheStateCached manifest memoization", () => {
  it("shares the parse until (mtimeMs, size) changes, then re-reads", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-hotpath-manifest-"));
    try {
      const manifest = join(root, "index-state.json");
      writeFileSync(
        manifest,
        JSON.stringify({ version: 2, state: { "a.ts": { mtimeMs: 1, hash: "x", numNodes: 1 } } })
      );

      const first = loadCacheStateCached(manifest);
      const second = loadCacheStateCached(manifest);
      expect(second).toBe(first); // 未变化:同一份解析结果,不重复 JSON.parse
      expect(Object.keys(first)).toEqual(["a.ts"]);

      // 重写(内容/大小/时间变化)→ 立即失效重读。
      writeFileSync(
        manifest,
        JSON.stringify({
          version: 2,
          state: {
            "a.ts": { mtimeMs: 2, hash: "y", numNodes: 2 },
            "b.ts": { mtimeMs: 3, hash: "z", numNodes: 3 },
          },
        })
      );
      const rewritten = loadCacheStateCached(manifest);
      expect(rewritten).not.toBe(first);
      expect(Object.keys(rewritten).sort()).toEqual(["a.ts", "b.ts"]);

      // 大小不变、仅 mtime 变化 → 指纹仍变化 → 重新解析。
      const sameContent = loadCacheStateCached(manifest);
      utimesSync(manifest, new Date(), new Date(Date.now() + 5000));
      const bumped = loadCacheStateCached(manifest);
      expect(bumped).not.toBe(sameContent);
      expect(bumped).toEqual(sameContent);

      // manifest 被删除:不记忆失败结果,回落到空 state。
      rmSync(manifest);
      expect(loadCacheStateCached(manifest)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P0-2 indexFile closes its graph client", () => {
  it("closes the connection on success and on skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-hotpath-indexfile-"));
    const configPath = makeWorkspaceConfigPath(root);
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const source = join(root, "src", "feature.ts");
      writeFileSync(source, "export function hotpathFix(): number {\n  return 42;\n}\n");

      const tracker = clientTracker();
      const closedBefore = tracker.closed;
      const indexed = await indexFile(source, configPath);
      expect(indexed.indexedFiles).toBe(1);
      expect(tracker.closed).toBe(closedBefore + 1); // 连接已释放,不再泄漏

      // 跳过路径(工作区外文件)也必须经过 finally close。
      const outside = join(tmpdir(), "gf-hotpath-outside.ts");
      writeFileSync(outside, "export const x = 1;\n");
      try {
        const skipped = await indexFile(outside, configPath);
        expect(skipped.skipped).toBe(true);
        expect(tracker.closed).toBe(closedBefore + 2);
      } finally {
        rmSync(outside, { force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  }, 30000);
});

describe("P0-2 previewContext closes its graph client", () => {
  it("releases the handle on both the uncached main path and the cached branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-hotpath-preview-"));
    const configPath = makeWorkspaceConfigPath(root);
    try {
      writeFileSync(join(root, "readme.md"), "# hotpath preview workspace\n");
      const tracker = clientTracker();

      const closedBeforeFirst = tracker.closed;
      const first = await previewContext("hotpath preview query", configPath);
      expect(first.anchorCount).toBeGreaterThanOrEqual(0);
      expect(tracker.closed).toBeGreaterThanOrEqual(closedBeforeFirst + 1); // 主路径释放

      const closedBeforeSecond = tracker.closed;
      await previewContext("hotpath preview query", configPath); // 同 query+root → 缓存命中分支
      expect(tracker.closed).toBeGreaterThanOrEqual(closedBeforeSecond + 1); // cached 分支释放
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  }, 60000);
});

describe("P0-2 watcher incremental index failure is logged", () => {
  it("routes indexFile rejection to logger.warn instead of swallowing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-hotpath-watcher-"));
    const configPath = makeWorkspaceConfigPath(root, { autoIndexOnSave: true });
    const singleFileMock = indexSingleFile as unknown as Mock;
    const delegate = singleFileMock.getMockImplementation();
    singleFileMock.mockRejectedValueOnce(new Error("boom: watcher incremental failure"));
    const warn = warnMock();
    warn.mockClear();

    let watcher: GraphFileWatcher | null = null;
    try {
      const config = resolveConfig(configPath, { rootDir: root }) as GraphFlowConfig;
      watcher = startFileWatcherIfEnabled(config, configPath);
      expect(watcher).not.toBeNull();

      // 直接驱动注册的 onChange 回调(绕过 2s debounce,保证确定性)。
      const callbacks = (watcher as unknown as {
        changeCallbacks: Array<(files: string[]) => void>;
      }).changeCallbacks;
      expect(callbacks.length).toBeGreaterThan(0);
      callbacks[0](["src/feature.ts"]);

      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ file: "src/feature.ts" }),
          "Incremental file index failed"
        );
      });
    } finally {
      watcher?.stop();
      if (delegate) singleFileMock.mockImplementation(delegate);
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  }, 30000);
});
