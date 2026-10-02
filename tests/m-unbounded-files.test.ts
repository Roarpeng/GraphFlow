import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve";
import {
  getSavingsStats,
  MAX_SAVINGS_RECORDS,
  recordSavings,
  type SavingsRecord,
} from "../src/graph/token-savings";
import {
  appendGovernanceAudit,
  readAuditEvents,
  resetAuditTailCache,
  verifyAuditChain,
  type GovernanceAuditEvent,
} from "../src/learning/evidence";

/**
 * T3 unbounded-growth file governance / 两个无界增长文件的治理.
 *
 * ① token-savings.json `records` ring cap (P1-5): the detail log keeps only
 *    the newest MAX_SAVINGS_RECORDS entries; cumulative aggregates stay
 *    authoritative because dropped detail is folded into `truncatedPrefix`.
 * ② evidence audit JSONL tail cache (P1-7): appendGovernanceAudit no longer
 *    re-reads and re-parses the whole audit file on every append — an
 *    unchanged file size reuses the cached tail, and the hash-chain
 *    semantics are byte-for-byte unchanged.
 */

const ROOTS: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  ROOTS.push(root);
  return root;
}

function writeTempConfig(root: string): string {
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: false,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          autoIndexOnSave: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: join(root, "graph-store.json"),
          maxContextTokens: 400,
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
}

function makeConfig(root: string) {
  // rootDir bind: config-file workspaceRoot alone is not honored by
  // resolveConfig — without the bind the stats would land in this repo's
  // own graphflow-out instead of the isolated temp workspace.
  return resolveConfig(writeTempConfig(root), { rootDir: root });
}

function countedRecord(overrides: Partial<SavingsRecord>): SavingsRecord {
  return {
    timestamp: "2026-09-20T10:00:00.000Z",
    query: "counted query",
    rawTokens: 2000,
    compressedTokens: 1000,
    savingsPercent: 50,
    source: "preview_context",
    ...overrides,
  };
}

interface PersistedSavingsFile {
  records: SavingsRecord[];
  totalRuns?: number;
  totalRawTokens?: number;
  totalCompressedTokens?: number;
  totalSavedTokens?: number;
  firstRunAt?: string | null;
  lastRunAt?: string | null;
  truncatedPrefix?: { totalRuns?: number; totalRawTokens?: number };
}

function readPersistedSavings(root: string): PersistedSavingsFile {
  return JSON.parse(
    readFileSync(join(root, "graphflow-out", "token-savings.json"), "utf8")
  );
}

describe("token-savings records ring cap (P1-5)", () => {
  it("plain appends stay under the cap and keep full aggregates", () => {
    const root = makeRoot("gf-t3-savings-cap-");
    const config = makeConfig(root);

    recordSavings(config, countedRecord({ timestamp: "2026-09-20T10:00:00.000Z", query: "q1" }));
    recordSavings(config, countedRecord({ timestamp: "2026-09-20T11:00:00.000Z", query: "q2" }));
    recordSavings(config, countedRecord({ timestamp: "2026-09-20T12:00:00.000Z", query: "q3" }));

    const persisted = readPersistedSavings(root);
    expect(MAX_SAVINGS_RECORDS).toBe(2000);
    expect(persisted.records).toHaveLength(3);
    expect(persisted.records.length).toBeLessThanOrEqual(MAX_SAVINGS_RECORDS);
    // No truncation yet → no prefix summary persisted.
    expect(persisted.truncatedPrefix).toBeUndefined();

    const stats = getSavingsStats(config);
    expect(stats.totalRuns).toBe(3);
    expect(stats.totalRawTokens).toBe(6000);
    expect(stats.totalSavedTokens).toBe(3000);
    expect(stats.firstRunAt).toBe("2026-09-20T10:00:00.000Z");
    expect(stats.lastRunAt).toBe("2026-09-20T12:00:00.000Z");
    expect(stats.recentRecords.map((record) => record.query)).toEqual(["q3", "q2", "q1"]);
  });

  it("a legacy over-cap file (2500 records) truncates to 2000 on the next write while aggregates cover the full history", () => {
    const root = makeRoot("gf-t3-savings-legacy-");
    const config = makeConfig(root);
    const outDir = join(root, "graphflow-out");
    mkdirSync(outDir, { recursive: true });

    const stamp = (index: number): string =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000).toISOString();
    // 2500 counted legacy records (rawTokens 2000 each), oldest first — the
    // shape 8823 accumulated previews produced in this repo.
    const legacyRecords: SavingsRecord[] = Array.from({ length: 2500 }, (_, index) =>
      countedRecord({
        timestamp: stamp(index),
        query: `legacy ${index}`,
        rawTokens: 2000,
        compressedTokens: 1000,
      })
    );
    writeFileSync(
      join(outDir, "token-savings.json"),
      JSON.stringify({ records: legacyRecords }),
      "utf8"
    );

    recordSavings(
      config,
      countedRecord({
        timestamp: "2027-01-01T00:00:00.000Z",
        query: "post-cap new record",
        rawTokens: 4000,
        compressedTokens: 1000,
      })
    );

    const persisted = readPersistedSavings(root);
    // Ring window: exactly the cap, newest records kept.
    expect(persisted.records).toHaveLength(MAX_SAVINGS_RECORDS);
    // Load dropped legacy 0..499, the append then dropped legacy 500 → the
    // window starts at legacy 501 and ends with the new record.
    expect(persisted.records[0]!.timestamp).toBe(stamp(501));
    expect(persisted.records.at(-1)!.query).toBe("post-cap new record");

    // Aggregates remain authoritative across the truncation: they still
    // cover all 2500 legacy records PLUS the new one.
    expect(persisted.totalRuns).toBe(2501);
    expect(persisted.totalRawTokens).toBe(2500 * 2000 + 4000);
    expect(persisted.totalCompressedTokens).toBe(2501 * 1000);
    expect(persisted.totalSavedTokens).toBe(2500 * 2000 + 4000 - 2501 * 1000);
    expect(persisted.firstRunAt).toBe(stamp(0));
    expect(persisted.lastRunAt).toBe("2027-01-01T00:00:00.000Z");

    // The dropped detail (501 records: legacy 0..499 at load + legacy 500 at
    // append) is folded into the persisted prefix summary.
    expect(persisted.truncatedPrefix?.totalRuns).toBe(501);
    expect(persisted.truncatedPrefix?.totalRawTokens).toBe(501 * 2000);

    // Read side reports the same authoritative totals.
    const stats = getSavingsStats(config);
    expect(stats.totalRuns).toBe(2501);
    expect(stats.totalRawTokens).toBe(2500 * 2000 + 4000);
    expect(stats.firstRunAt).toBe(stamp(0));
    expect(stats.recentRecords[0]!.query).toBe("post-cap new record");
    expect(stats.recentRecords.length).toBeLessThanOrEqual(50);
  });
});

function auditInput(overrides: { actor?: string; action?: string } = {}): Omit<
  GovernanceAuditEvent,
  "seq" | "at" | "prevHash" | "hash"
> {
  return {
    actor: overrides.actor ?? "tester",
    action: overrides.action ?? "tool-call",
    subject: "graphflow_run",
    tenant: "local",
  };
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("governance audit tail cache (P1-7)", () => {
  it("an unchanged-size file is served from the cached tail; resetAuditTailCache forces a full re-read", () => {
    resetAuditTailCache();
    const dir = makeRoot("gf-t3-audit-cache-");
    const path = join(dir, "evidence-audit.jsonl");

    const first = appendGovernanceAudit(path, auditInput());
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe("genesis");

    // Black-box probe for "no full re-read on unchanged size": overwrite the
    // audit bytes with SAME-SIZE garbage. The size-keyed tail cache must treat
    // the file as unchanged (documented assumption: the audit log is
    // append-only, so equal size == equal content) and serve the cached tail;
    // an implementation that re-reads and JSON.parses the whole log on every
    // append would throw on the garbage line.
    const original = readFileSync(path, "utf8");
    writeFileSync(path, "#".repeat(original.length), "utf8");

    const second = appendGovernanceAudit(path, auditInput({ action: "report" }));
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);

    // resetAuditTailCache drops the cached tail (fresh-process simulation):
    // the next append must full-read the file — which now throws on the
    // garbage line. Proves the reset actually clears the cache and that the
    // full-read path is still the fallback.
    resetAuditTailCache();
    expect(() => appendGovernanceAudit(path, auditInput({ action: "plan" }))).toThrow();

    // Repair the log and continue: the chain semantics are identical to the
    // uncached implementation (contiguous seq, linked prevHash, valid chain).
    writeFileSync(
      path,
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      "utf8"
    );
    resetAuditTailCache();
    const third = appendGovernanceAudit(path, auditInput({ action: "plan" }));
    expect(third.seq).toBe(3);
    expect(third.prevHash).toBe(second.hash);

    const events = readAuditEvents(path);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events[1]!.prevHash).toBe(events[0]!.hash);
    expect(events[2]!.prevHash).toBe(events[1]!.hash);
    expect(verifyAuditChain(events)).toBe(true);
  });

  it("an external append (size change) invalidates the cache and the chain continues from it", () => {
    resetAuditTailCache();
    const dir = makeRoot("gf-t3-audit-external-");
    const path = join(dir, "evidence-audit.jsonl");

    appendGovernanceAudit(path, auditInput());
    const second = appendGovernanceAudit(path, auditInput({ action: "report" }));

    // Another process appends a valid event behind this process's back.
    const externalWithoutHash = {
      seq: 3,
      at: "2026-10-02T00:00:00.000Z",
      actor: "other-process",
      action: "append",
      subject: "audit",
      tenant: "local",
      prevHash: second.hash,
    };
    const external = { ...externalWithoutHash, hash: sha256Json(externalWithoutHash) };
    appendFileSync(path, `${JSON.stringify(external)}\n`, "utf8");

    // Size changed → the cache must invalidate and the next append builds on
    // the external tail (this is the multi-process correctness case).
    const fourth = appendGovernanceAudit(path, auditInput({ action: "plan" }));
    expect(fourth.seq).toBe(4);
    expect(fourth.prevHash).toBe(external.hash);

    const events = readAuditEvents(path);
    expect(events).toHaveLength(4);
    expect(events[2]!.actor).toBe("other-process");
    expect(verifyAuditChain(events)).toBe(true);
  });
});

afterAll(() => {
  for (const root of ROOTS) {
    // Windows: an open default-path sqlite handle makes an immediate unlink
    // EBUSY. Retry, then treat a lingering lock as non-fatal (CI is ephemeral).
    try {
      rmSync(root, {
        recursive: true,
        force: true,
        ...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 100 } : {}),
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});
