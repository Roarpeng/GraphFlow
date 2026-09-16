/**
 * tests/m98-promise-ledger.test.ts — R9 承诺账本（跨会话提醒持久层）单元测试。
 *
 * 手工 stub GraphClient（内存 Map 实现 upsertNodes / queryByKeyword /
 * readSnapshot / getNodesByIds，语义对齐 m89-working-set 的 stub 风格：
 * queryByKeyword 为 id+content+metadata 的子串匹配）。账本节点夹具使用真实
 * 落库格式：type "Decision"、id `promise-ledger:<sessionId>`、
 * metadata.ledger 存完整 PromiseLedgerEntry、content 一行摘要。
 */
import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import type { PromiseLedgerEntry } from "../src/audit/types";
import {
  DEFAULT_OPEN_PROMISE_LIMIT,
  PROMISE_LEDGER_ID_PREFIX,
  formatOpenPromiseReminder,
  listOpenPromises,
  parsePromiseLedgerEntry,
  promiseLedgerNodeId,
  recordPromiseLedger,
  resolvePromisesIfClean,
} from "../src/audit/promise-ledger";

interface StubOptions {
  omitReadSnapshot?: boolean;
  failUpsert?: boolean;
  failQueryByKeyword?: boolean;
}
type StubClient = GraphClient & {
  nodes: Map<string, GraphNode>;
  keywordCalls: string[];
};

function makeStubClient(options: StubOptions = {}): StubClient {
  const nodes = new Map<string, GraphNode>();
  const keywordCalls: string[] = [];
  const client: GraphClient = {
    async upsertNodes(upserts: GraphNode[]): Promise<void> {
      if (options.failUpsert) throw new Error("store write failed");
      for (const node of upserts) nodes.set(node.id, { ...node });
    },
    async upsertEdges(): Promise<void> {},
    async queryByKeyword(query: string): Promise<GraphNode[]> {
      keywordCalls.push(query);
      if (options.failQueryByKeyword) throw new Error("keyword backend down");
      const q = query.toLowerCase();
      return [...nodes.values()].filter(
        (n) =>
          n.id.toLowerCase().includes(q) ||
          n.content.toLowerCase().includes(q) ||
          JSON.stringify(n.metadata ?? {}).toLowerCase().includes(q)
      );
    },
    async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
      return ids.map((id) => nodes.get(id)).filter((n): n is GraphNode => Boolean(n));
    },
    ...(options.omitReadSnapshot
      ? {}
      : {
          readSnapshot(): { nodes: GraphNode[]; edges: [] } {
            return { nodes: [...nodes.values()], edges: [] };
          },
        }),
  };
  return Object.assign(client, { nodes, keywordCalls });
}

function makeEntry(
  sessionId: string,
  recordedAt: string,
  findingIds: string[],
  messages: string[] = findingIds.map((id) => `义务未收尾：${id}`)
): PromiseLedgerEntry {
  return { sessionId, recordedAt, findingIds, messages, status: "open" };
}

function ledgerOf(node: GraphNode | undefined): PromiseLedgerEntry | undefined {
  return parsePromiseLedgerEntry(node?.metadata?.ledger);
}

describe("M98 promise ledger — record 幂等写入", () => {
  it("同 sessionId 覆盖更新（幂等），节点为 Decision 且 content 一行摘要", async () => {
    const client = makeStubClient();
    const first = await recordPromiseLedger(client, makeEntry("sess-a", "2026-01-01T00:00:00.000Z", ["dep:1"]));
    expect(first.status).toBe("open");
    await recordPromiseLedger(client, makeEntry("sess-a", "2026-01-02T00:00:00.000Z", ["dep:1", "orphan:2"]));

    expect(client.nodes.size).toBe(1); // 覆盖而非追加
    const node = client.nodes.get(promiseLedgerNodeId("sess-a"));
    expect(node?.type).toBe("Decision");
    expect(node?.id).toBe(`${PROMISE_LEDGER_ID_PREFIX}sess-a`);
    expect(node?.content).toContain("sess-a");
    expect(node?.content).toContain("status=open");
    expect(node?.content).toContain("findings=2");
    const stored = ledgerOf(node);
    expect(stored?.findingIds).toEqual(["dep:1", "orphan:2"]);
    expect(stored?.recordedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("findings 为空则直接 resolved（resolvedAt 回落 recordedAt）", async () => {
    const client = makeStubClient();
    const entry = await recordPromiseLedger(client, makeEntry("sess-clean", "2026-01-01T08:00:00.000Z", []));
    expect(entry.status).toBe("resolved");
    expect(entry.resolvedAt).toBe("2026-01-01T08:00:00.000Z");
    expect(ledgerOf(client.nodes.get(promiseLedgerNodeId("sess-clean")))?.status).toBe("resolved");
    await expect(listOpenPromises(client)).resolves.toEqual([]);
  });

  it("sessionId 非法字符 sanitize 为 '-'", async () => {
    const client = makeStubClient();
    await recordPromiseLedger(client, makeEntry("sess a/b:c", "2026-01-01T00:00:00.000Z", ["dep:1"]));
    expect(client.nodes.has("promise-ledger:sess-a-b-c")).toBe(true);
  });

  it("record fail-open：upsert 失败不抛错并返回（归一化后的）entry", async () => {
    const client = makeStubClient({ failUpsert: true });
    const entry = makeEntry("sess-x", "2026-01-01T00:00:00.000Z", ["dep:1"]);
    await expect(recordPromiseLedger(client, entry)).resolves.toMatchObject({
      sessionId: "sess-x",
      status: "open",
      findingIds: ["dep:1"],
    });
  });
});

describe("M98 promise ledger — listOpenPromises 读取", () => {
  it("过滤 open、按 recordedAt 倒序、默认 limit 5（最新会话在前）", async () => {
    const client = makeStubClient();
    for (let i = 1; i <= 7; i += 1) {
      await recordPromiseLedger(
        client,
        makeEntry(`sess-${i}`, `2026-01-0${i}T00:00:00.000Z`, [`dep:${i}`])
      );
    }
    await recordPromiseLedger(client, makeEntry("sess-resolved", "2026-01-08T00:00:00.000Z", [])); // resolved 不出现

    const open = await listOpenPromises(client);
    expect(open).toHaveLength(DEFAULT_OPEN_PROMISE_LIMIT);
    expect(open.map((e) => e.sessionId)).toEqual(["sess-7", "sess-6", "sess-5", "sess-4", "sess-3"]);
    expect(open.every((e) => e.status === "open")).toBe(true);

    const limited = await listOpenPromises(client, { limit: 2 });
    expect(limited.map((e) => e.sessionId)).toEqual(["sess-7", "sess-6"]);
  });

  it("损坏 / 缺失 / 形状不符的 metadata.ledger 条目被跳过，不炸读取", async () => {
    const client = makeStubClient();
    await recordPromiseLedger(client, makeEntry("sess-good", "2026-01-01T00:00:00.000Z", ["dep:1"]));
    await client.upsertNodes([
      { id: "promise-ledger:bad-json", type: "Decision", content: "x", metadata: { ledger: "{ not json" } },
      {
        id: "promise-ledger:bad-shape",
        type: "Decision",
        content: "x",
        metadata: { ledger: { sessionId: "bad-shape", recordedAt: "2026-01-01T00:00:00.000Z", findingIds: "not-array", messages: [], status: "open" } },
      },
      {
        id: "promise-ledger:bad-status",
        type: "Decision",
        content: "x",
        metadata: { ledger: { sessionId: "bad-status", recordedAt: "2026-01-01T00:00:00.000Z", findingIds: ["a"], messages: ["m"], status: "maybe" } },
      },
      { id: "promise-ledger:no-ledger", type: "Decision", content: "x", metadata: { kind: "promise-ledger" } },
      { id: "file:src/other.ts", type: "File", content: "unrelated", metadata: { ledger: { sessionId: "impostor", recordedAt: "2026-01-01T00:00:00.000Z", findingIds: [], messages: [], status: "open" } } },
    ]);

    const open = await listOpenPromises(client);
    expect(open.map((e) => e.sessionId)).toEqual(["sess-good"]);
  });

  it("无 readSnapshot 时降级 queryByKeyword；两条路都挂则 fail-open 返回 []", async () => {
    const client = makeStubClient({ omitReadSnapshot: true });
    await recordPromiseLedger(client, makeEntry("sess-kw", "2026-01-01T00:00:00.000Z", ["dep:1"]));
    const open = await listOpenPromises(client);
    expect(client.keywordCalls).toContain("promise-ledger");
    expect(open.map((e) => e.sessionId)).toEqual(["sess-kw"]);

    const dead = makeStubClient({ omitReadSnapshot: true, failQueryByKeyword: true });
    await expect(listOpenPromises(dead)).resolves.toEqual([]);
  });
});

describe("M98 promise ledger — resolvePromisesIfClean 收尾判定", () => {
  it("子集语义：条目 findingIds ⊆ 当前 findings 才 resolve，其余保持 open", async () => {
    const client = makeStubClient();
    await recordPromiseLedger(client, makeEntry("sess-a", "2026-01-01T00:00:00.000Z", ["dep:1", "orphan:2"]));
    await recordPromiseLedger(client, makeEntry("sess-b", "2026-01-02T00:00:00.000Z", ["doc:3"]));

    const now = "2026-02-01T00:00:00.000Z";
    const { resolved } = await resolvePromisesIfClean(client, ["dep:1", "orphan:2", "other:9"], now);
    expect(resolved).toEqual(["sess-a"]);

    const stored = ledgerOf(client.nodes.get(promiseLedgerNodeId("sess-a")));
    expect(stored?.status).toBe("resolved");
    expect(stored?.resolvedAt).toBe(now);
    const stillOpen = await listOpenPromises(client);
    expect(stillOpen.map((e) => e.sessionId)).toEqual(["sess-b"]);
    expect(stillOpen[0]?.resolvedAt).toBeUndefined();
  });

  it("currentFindingIds 为空 = 当前审计全清 → 所有 open 条目 resolve", async () => {
    const client = makeStubClient();
    await recordPromiseLedger(client, makeEntry("sess-a", "2026-01-01T00:00:00.000Z", ["dep:1"]));
    await recordPromiseLedger(client, makeEntry("sess-b", "2026-01-02T00:00:00.000Z", ["doc:3", "rule:4"]));

    const now = "2026-02-02T00:00:00.000Z";
    const { resolved } = await resolvePromisesIfClean(client, [], now);
    expect(resolved.sort()).toEqual(["sess-a", "sess-b"]);
    await expect(listOpenPromises(client)).resolves.toEqual([]);
    expect(ledgerOf(client.nodes.get(promiseLedgerNodeId("sess-b")))?.resolvedAt).toBe(now);
  });

  it("无覆盖关系时不 resolve、不写入（resolved 空列表，条目原样保留）", async () => {
    const client = makeStubClient();
    await recordPromiseLedger(client, makeEntry("sess-a", "2026-01-01T00:00:00.000Z", ["dep:1"]));
    const before = client.nodes.get(promiseLedgerNodeId("sess-a"));

    const { resolved } = await resolvePromisesIfClean(client, ["unrelated:9"], "2026-02-03T00:00:00.000Z");
    expect(resolved).toEqual([]);
    // 未命中 → 不改写节点（同一引用，内容原样）
    expect(client.nodes.get(promiseLedgerNodeId("sess-a"))).toBe(before);
    const open = await listOpenPromises(client);
    expect(open.map((e) => e.sessionId)).toEqual(["sess-a"]);
  });
});

describe("M98 promise ledger — formatOpenPromiseReminder 文案", () => {
  it("含 sessionId / 时间 / 每条 message / 总条数收尾问句", () => {
    const entries = [
      makeEntry("sess-a", "2026-01-01T00:00:00.000Z", ["dep:1", "orphan:2"], ["忘了吗：依赖锁未提交", "忘了吗：孤儿文件未删"]),
      makeEntry("sess-b", "2026-01-02T00:00:00.000Z", ["doc:3"], ["忘了吗：文档未同步"]),
    ];
    const text = formatOpenPromiseReminder(entries);
    expect(text).toContain("会话 sess-a，2026-01-01T00:00:00.000Z");
    expect(text).toContain("会话 sess-b");
    expect(text).toContain("- 忘了吗：依赖锁未提交");
    expect(text).toContain("- 忘了吗：文档未同步");
    expect(text).toContain("共 3 项——先收尾再继续？");
  });

  it("limitPerEntry 截断每条目的 message 数并注明剩余；空/无 open 返回 undefined", () => {
    const entry = makeEntry(
      "sess-a",
      "2026-01-01T00:00:00.000Z",
      ["f1", "f2", "f3", "f4"],
      ["m1", "m2", "m3", "m4"]
    );
    const text = formatOpenPromiseReminder([entry], 2);
    expect(text).toContain("- m1");
    expect(text).toContain("- m2");
    expect(text).not.toContain("- m3");
    expect(text).toContain("另有 2 项未列出");
    expect(text).toContain("共 4 项——先收尾再继续？");

    expect(formatOpenPromiseReminder([])).toBeUndefined();
    const resolvedOnly = makeEntry("sess-done", "2026-01-01T00:00:00.000Z", []);
    resolvedOnly.status = "resolved";
    expect(formatOpenPromiseReminder([resolvedOnly])).toBeUndefined();
  });
});
