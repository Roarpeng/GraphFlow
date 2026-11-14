import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeBranchScope } from "./branch-scope.js";
import { ensureGraphflowDir } from "./graphflow-dir.js";

interface ReadReceipt {
  id: string;
  branch: string;
  files: Record<string, string>;
  text: string;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const dir = (rootDir: string): string => join(ensureGraphflowDir(rootDir), "read-receipts");
const pathFor = (rootDir: string, id: string): string | undefined =>
  /^read:[a-f0-9]{64}$/.test(id) ? join(dir(rootDir), `${id.slice(5)}.json`) : undefined;

function fileHashes(rootDir: string, keys: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const key of keys) {
    const file = key.split(/[#:]/)[0]!;
    if (existsSync(join(rootDir, file))) files[file] = sha(readFileSync(join(rootDir, file), "utf8"));
  }
  return files;
}

function load(rootDir: string, id: string): ReadReceipt | undefined {
  const path = pathFor(rootDir, id);
  if (!path || !existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as ReadReceipt; } catch { return undefined; }
}

function valid(rootDir: string, receipt: ReadReceipt): boolean {
  if (receipt.branch !== describeBranchScope(rootDir)) return false;
  const now = fileHashes(rootDir, Object.keys(receipt.files));
  return JSON.stringify(now) === JSON.stringify(receipt.files);
}

function page(receipt: ReadReceipt, offset: number, maxOutputTokens?: number): { text: string; nextCursor?: string; truncated: boolean } {
  const limit = maxOutputTokens === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(maxOutputTokens)) * 4;
  if (limit < 160) return { text: "ERR [budget-too-small: min 40 tokens]".slice(0, limit), truncated: false };
  const header = `// [Receipt ${receipt.id}]\n`;
  const cursorReserve = 110;
  const room = Number.isFinite(limit) ? Math.max(0, limit - header.length - cursorReserve) : receipt.text.length;
  const body = receipt.text.slice(offset, offset + room);
  const next = offset + body.length < receipt.text.length ? `${receipt.id}:${offset + body.length}` : undefined;
  const tail = next ? `\n// [truncated; continue with cursor="${next}"]` : "";
  const raw = header + body + tail;
  return { text: Number.isFinite(limit) ? raw.slice(0, limit) : raw, ...(next ? { nextCursor: next } : {}), truncated: Boolean(next) };
}

export function createReadReceipt(rootDir: string, keys: string[], text: string, maxOutputTokens?: number,
  sinceReceipt?: string): { receiptId: string; contentHash: string; text: string; nextCursor?: string; truncated: boolean; omitted: string[] } {
  const branch = describeBranchScope(rootDir);
  const files = fileHashes(rootDir, keys);
  const contentHash = sha(JSON.stringify([branch, files, text]));
  const id = `read:${contentHash}`;
  const previous = sinceReceipt ? load(rootDir, sinceReceipt) : undefined;
  if (previous && valid(rootDir, previous) && previous.id === id) {
    const notice = `UNCHANGED [${id}]`;
    return { receiptId: id, contentHash: `sha256:${contentHash}`,
      text: maxOutputTokens === undefined ? notice : notice.slice(0, maxOutputTokens * 4), truncated: false, omitted: [] };
  }
  let outputText = text;
  if (previous && previous.branch === branch && previous.id !== id) {
    let first = 0;
    while (first < previous.text.length && first < text.length && previous.text[first] === text[first]) first++;
    let last = 0;
    while (last < previous.text.length - first && last < text.length - first && previous.text[previous.text.length - 1 - last] === text[text.length - 1 - last]) last++;
    outputText = `// [Delta from ${previous.id}; changed span ${first}-${text.length - last}]\n${text.slice(first, text.length - last)}`;
  }
  const receipt: ReadReceipt = { id, branch, files, text: outputText };
  mkdirSync(dir(rootDir), { recursive: true });
  writeFileSync(pathFor(rootDir, id)!, JSON.stringify(receipt), "utf8");
  const result = page(receipt, 0, maxOutputTokens);
  return { receiptId: id, contentHash: `sha256:${contentHash}`, ...result, omitted: result.truncated ? keys : [] };
}

export function continueReadReceipt(rootDir: string, cursor: string, maxOutputTokens?: number): { receiptId?: string; text: string; nextCursor?: string; truncated: boolean } {
  const match = cursor.match(/^(read:[a-f0-9]{64}):(\d+)$/);
  if (!match) return { text: "REJECTED [invalid-cursor]", truncated: false };
  const receipt = load(rootDir, match[1]!);
  if (!receipt || !valid(rootDir, receipt)) return { text: "STALE_RECEIPT [workspace changed; read again]", truncated: false };
  return { receiptId: receipt.id, ...page(receipt, Number(match[2]), maxOutputTokens) };
}
