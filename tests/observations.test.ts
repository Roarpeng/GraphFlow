import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  packObservation,
  recallObservation,
  reduceObservation,
  type ObservationPolicy,
} from "../src/observations/index";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gfo-observations-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function indexPath(root: string): string {
  return join(root, ".graphflow", "observations", "index.jsonl");
}

function blobPath(root: string, sha: string): string {
  return join(root, ".graphflow", "observations", sha.slice(0, 2), `${sha}.txt`);
}

function mustPack(result: Awaited<ReturnType<typeof packObservation>>) {
  if (result.fallback) {
    throw new Error(`unexpected pack fallback: ${result.reason}`);
  }
  return result;
}

describe("GF-2 observations verified receipt", () => {
  it("packs content-addressed observations with dedup", async () => {
    const root = createTempRoot();
    const content = "line one\nline two\nline three\n";

    const a = mustPack(await packObservation({ rootDir: root, content }));
    expect(a.handle).toMatch(/^gfo:[0-9a-f]{16}$/);
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(a.lines).toBe(3);
    expect(a.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(a.head).toBe(content); // small content comes back whole
    expect(a.tail).toBe("");

    const b = mustPack(await packObservation({ rootDir: root, content }));
    expect(b.handle).toBe(a.handle);
    expect(b.sha).toBe(a.sha);

    const indexLines = readFileSync(indexPath(root), "utf8").trim().split("\n");
    expect(indexLines).toHaveLength(1);
    const entry = JSON.parse(indexLines[0] ?? "{}") as {
      handle: string;
      sha: string;
      sizeBytes: number;
      lines: number;
      createdAt: number;
      origin?: string;
    };
    expect(entry.handle).toBe(a.handle);
    expect(entry.sha).toBe(a.sha);
    expect(entry.sizeBytes).toBe(a.sizeBytes);
    expect(entry.lines).toBe(3);
    expect(typeof entry.createdAt).toBe("number");
    expect(existsSync(blobPath(root, a.sha))).toBe(true);

    const c = mustPack(await packObservation({ rootDir: root, content: "different\n" }));
    expect(c.handle).not.toBe(a.handle);
    const indexAfter = readFileSync(indexPath(root), "utf8").trim().split("\n");
    expect(indexAfter).toHaveLength(2);
  });

  it("records origin in the index entry when provided", async () => {
    const root = createTempRoot();
    const packed = mustPack(
      await packObservation({ rootDir: root, content: "with origin\n", origin: "bash:ls" })
    );
    const entry = JSON.parse(readFileSync(indexPath(root), "utf8").trim()) as { origin?: string };
    expect(entry.origin).toBe("bash:ls");
    expect(packed.handle).toMatch(/^gfo:/);
  });

  it("returns head/tail excerpts honoring policy byte budgets", async () => {
    const root = createTempRoot();
    const content = `start-marker\n${"x".repeat(5000)}\nend-marker\n`;
    const result = mustPack(
      await packObservation({
        rootDir: root,
        content,
        policy: { headBytes: 32, tailBytes: 16 },
      })
    );
    expect(Buffer.byteLength(result.head, "utf8")).toBeLessThanOrEqual(32);
    expect(result.head).toBe(content.slice(0, 32)); // ASCII: byte slice == char slice
    expect(Buffer.byteLength(result.tail, "utf8")).toBeLessThanOrEqual(16);
    expect(result.tail).toBe(content.slice(content.length - 16));
  });

  it("recalls exact bytes, paged slices, and inclusive 1-based ranges", async () => {
    const root = createTempRoot();
    const lines = Array.from({ length: 450 }, (_, i) => `line-${i + 1}`);
    const content = `${lines.join("\n")}\n`;
    const packed = mustPack(await packObservation({ rootDir: root, content }));

    const full = await recallObservation({ rootDir: root, handle: packed.handle });
    if (full.expired) throw new Error("unexpected expired");
    expect(full.content).toBe(content); // exact archived bytes incl. trailing newline
    expect(full.lines).toBe(450);
    expect(full.pageLines).toBe(200);
    expect(full.pageCount).toBe(3);

    const page0 = await recallObservation({ rootDir: root, handle: packed.handle, page: 0 });
    if (page0.expired) throw new Error("unexpected expired");
    expect(page0.content).toBe(lines.slice(0, 200).join("\n"));
    expect(page0.page).toBe(0);

    const page1 = await recallObservation({ rootDir: root, handle: packed.handle, page: 1 });
    if (page1.expired) throw new Error("unexpected expired");
    expect(page1.content).toBe(lines.slice(200, 400).join("\n"));
    expect(page1.content.startsWith("line-201")).toBe(true);

    const page2 = await recallObservation({ rootDir: root, handle: packed.handle, page: 2 });
    if (page2.expired) throw new Error("unexpected expired");
    expect(page2.content).toBe(lines.slice(400).join("\n"));

    const ranged = await recallObservation({ rootDir: root, handle: packed.handle, range: [5, 10] });
    if (ranged.expired) throw new Error("unexpected expired");
    expect(ranged.content).toBe(lines.slice(4, 10).join("\n"));

    const outOfRange = await recallObservation({
      rootDir: root,
      handle: packed.handle,
      range: [9990, 9999],
    });
    if (outOfRange.expired) throw new Error("unexpected expired");
    expect(outOfRange.content).toBe("");
  });

  it("preserves multibyte content byte-exactly through pack and recall", async () => {
    const root = createTempRoot();
    const content = "héllo ✓\n第二行\n";
    const packed = mustPack(await packObservation({ rootDir: root, content }));
    const recalled = await recallObservation({ rootDir: root, handle: packed.handle });
    if (recalled.expired) throw new Error("unexpected expired");
    expect(recalled.content).toBe(content);
    expect(recalled.sizeBytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("builds a deterministic fingerprint receipt capped by maxReceiptTokens", async () => {
    const root = createTempRoot();
    const body: string[] = [];
    for (let i = 1; i <= 300; i++) body.push(`routine step ${i} completed`);
    body[37] = "ERROR: compilation failed in module foo";
    body[208] = "AssertionError: expected 42 but got actual 41";
    const content = `${body.join("\n")}\n`;
    const packed = mustPack(await packObservation({ rootDir: root, content }));

    const reduced = await reduceObservation({ rootDir: root, handle: packed.handle });
    expect(reduced.fallback).toBe(false);
    expect(reduced.verified).toBe(true);
    expect(reduced.sourceHandle).toBe(packed.handle);
    expect(reduced.sourceBytes).toBe(packed.sizeBytes);
    expect(reduced.receiptTokens).toBeLessThanOrEqual(400);
    expect(reduced.receiptTokens).toBeGreaterThan(0);

    const retainedNs = reduced.retainedLines.map((line) => line.n);
    expect(retainedNs).toContain(38); // ERROR line (salient)
    expect(retainedNs).toContain(209); // AssertionError line (salient)
    expect(retainedNs).toContain(1); // edge head
    expect(retainedNs).toContain(300); // edge tail
    expect(reduced.receipt).toContain("ERROR: compilation failed in module foo");
    expect(reduced.receipt).toContain(`gfo:${packed.sha.slice(0, 16)}`);

    // deterministic: identical input yields an identical receipt
    const again = await reduceObservation({ rootDir: root, handle: packed.handle });
    expect(again.receipt).toBe(reduced.receipt);
    expect(again.retainedLines).toEqual(reduced.retainedLines);
  });

  it("falls back with quote-mismatch when the archived file is tampered", async () => {
    const root = createTempRoot();
    const content = "alpha\nERROR beta failed\ngamma\n";
    const packed = mustPack(await packObservation({ rootDir: root, content }));

    const ok = await reduceObservation({ rootDir: root, handle: packed.handle });
    expect(ok.fallback).toBe(false);
    expect(ok.verified).toBe(true);

    writeFileSync(blobPath(root, packed.sha), "alpha\nERROR beta failed TAMPERED\ngamma\n");

    const bad = await reduceObservation({ rootDir: root, handle: packed.handle });
    expect(bad.fallback).toBe(true);
    expect(bad.reason).toBe("quote-mismatch");
    expect(bad.verified).toBe(false);
    expect(bad.retainedLines).toEqual([]);
    expect(bad.receipt).not.toBe(""); // bounded excerpt instead of the receipt
    expect(bad.receipt.length).toBeLessThanOrEqual(2048 + 1536 + 128);
  });

  it("discards nonexistent line numbers returned by an llm reducer", async () => {
    const root = createTempRoot();
    const content = "one\ntwo\nthree\nfour\nfive\n";
    const packed = mustPack(await packObservation({ rootDir: root, content }));

    const seenPrompts: string[] = [];
    const reduced = await reduceObservation({
      rootDir: root,
      handle: packed.handle,
      reducer: async (prompt) => {
        seenPrompts.push(prompt);
        return "keep lines [2, 4, 9999, -3, 0]";
      },
    });
    expect(reduced.fallback).toBe(false);
    expect(reduced.verified).toBe(true);
    expect(reduced.retainedLines.map((line) => line.n)).toEqual([2, 4]);
    expect(reduced.retainedLines.map((line) => line.text)).toEqual(["two", "four"]);
    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain("L2: two");
  });

  it("fails open with a bounded excerpt when the reducer is unavailable", async () => {
    const root = createTempRoot();
    const content = `head-marker\n${"y".repeat(4000)}\ntail-marker\n`;
    const packed = mustPack(await packObservation({ rootDir: root, content }));

    const reduced = await reduceObservation({
      rootDir: root,
      handle: packed.handle,
      reducer: async () => {
        throw new Error("provider down");
      },
    });
    expect(reduced.fallback).toBe(true);
    expect(reduced.reason).toBe("reducer-unavailable");
    expect(reduced.verified).toBe(false);
    expect(reduced.sourceHandle).toBe(packed.handle);
    expect(reduced.receipt).toContain("head-marker");
    expect(reduced.receipt).toContain("tail-marker");
    expect(reduced.receipt).toContain("truncated");
  });

  it("redacts secrets at store time and in receipts, retained lines, and reducer prompts", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const content = `deploy started\naws_access_key_id = ${secret}\nERROR upload failed\ndeploy ended\n`;

    // default policy: redactOnStore=true — the archive itself never holds the secret
    const root = createTempRoot();
    const packed = mustPack(await packObservation({ rootDir: root, content }));
    const onDisk = readFileSync(blobPath(root, packed.sha), "utf8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain("[REDACTED");

    const reduced = await reduceObservation({ rootDir: root, handle: packed.handle });
    expect(reduced.fallback).toBe(false);
    expect(reduced.receipt).not.toContain(secret);
    for (const line of reduced.retainedLines) {
      expect(line.text).not.toContain(secret);
    }

    // redactOnStore=false: raw bytes are archived, but prompts and receipts stay clean
    const rawRoot = createTempRoot();
    const rawPolicy = { redactOnStore: false } satisfies ObservationPolicy;
    const rawPacked = mustPack(await packObservation({ rootDir: rawRoot, content, policy: rawPolicy }));
    const rawOnDisk = readFileSync(blobPath(rawRoot, rawPacked.sha), "utf8");
    expect(rawOnDisk).toContain(secret);

    const prompts: string[] = [];
    const rawReduced = await reduceObservation({
      rootDir: rawRoot,
      handle: rawPacked.handle,
      policy: rawPolicy,
      reducer: async (prompt) => {
        prompts.push(prompt);
        return "[2]";
      },
    });
    expect(rawReduced.fallback).toBe(false);
    expect(rawReduced.verified).toBe(true); // verification ran against raw archived bytes
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(secret);
    expect(prompts[0]).toContain("[REDACTED");
    expect(rawReduced.receipt).not.toContain(secret);
    expect(rawReduced.retainedLines[0]?.text).not.toContain(secret);
  });

  it("reduces inline content by archiving it first", async () => {
    const root = createTempRoot();
    const content = "boot\nERROR disk full\nhalt\n";
    const reduced = await reduceObservation({ rootDir: root, content });
    expect(reduced.fallback).toBe(false);
    expect(reduced.verified).toBe(true);
    expect(reduced.sourceHandle).toMatch(/^gfo:[0-9a-f]{16}$/);
    expect(reduced.sourceBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(reduced.retainedLines.map((line) => line.n)).toContain(2);
    expect(reduced.receipt).toContain("ERROR disk full");
  });

  it("reports expired for unknown, malformed, and TTL-expired handles", async () => {
    const root = createTempRoot();
    const packed = mustPack(await packObservation({ rootDir: root, content: "ephemeral\n" }));

    const missing = await recallObservation({ rootDir: root, handle: "gfo:0000000000000000" });
    expect(missing.expired).toBe(true);

    const malformed = await recallObservation({ rootDir: root, handle: "not-a-handle" });
    expect(malformed.expired).toBe(true);

    // age the index entry beyond the default 14-day ttl
    const raw = readFileSync(indexPath(root), "utf8").trim().split("\n");
    const entry = JSON.parse(raw[0] ?? "{}") as { createdAt: number };
    entry.createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeFileSync(indexPath(root), `${JSON.stringify(entry)}\n`);

    const stale = await recallObservation({ rootDir: root, handle: packed.handle });
    expect(stale.expired).toBe(true);

    const reduced = await reduceObservation({ rootDir: root, handle: packed.handle });
    expect(reduced.fallback).toBe(true);
    expect(reduced.reason).toBe("handle-expired");
  });

  it("never throws on unwritable roots (fail open)", async () => {
    const result = await packObservation({
      rootDir: join(tmpdir(), "gfo-observations-should-not-exist-\u0000bad"),
      content: "anything\n",
    });
    expect(result.fallback).toBe(true);
  });
});
