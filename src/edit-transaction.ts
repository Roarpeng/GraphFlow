/** Local, recoverable application-level edit transaction. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureGraphflowDir } from "./graphflow-dir.js";

export const contentSha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export interface ProposedWrite {
  file: string;
  before: string;
  after: string;
}

interface Proposal {
  id: string;
  createdAt: number;
  writes: ProposedWrite[];
}

export interface TransactionOutcome {
  status: "PREPARED" | "COMMITTED" | "STALE_BASELINE" | "RECOVERABLE_FAILURE" | "REJECTED";
  proposalId?: string;
  recoveryId?: string;
  changedFiles: string[];
  baseHashes?: Record<string, string>;
  diff?: string;
  message: string;
}

const TTL_MS = 30 * 60_000;

function safeTarget(rootDir: string, file: string): string | undefined {
  if (!file || isAbsolute(file)) return undefined;
  const root = realpathSync(rootDir);
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(target)) return undefined;
  const realTarget = realpathSync(target);
  const realRel = relative(root, realTarget);
  if (!realRel || realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return undefined;
  return target;
}

function transactionDir(rootDir: string): string {
  return join(ensureGraphflowDir(rootDir), "edit-transactions");
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

function proposalPath(rootDir: string, id: string): string {
  if (!/^edit:[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid proposal ID");
  return join(transactionDir(rootDir), `${id.slice(5)}.proposal.json`);
}

function journalPath(rootDir: string, id: string): string {
  return join(transactionDir(rootDir), `${id.slice(5)}.journal.json`);
}

function currentHash(rootDir: string, file: string): string | undefined {
  const path = safeTarget(rootDir, file);
  return path ? contentSha256(readFileSync(path, "utf8")) : undefined;
}

/** Recover interrupted commits only when the file still equals our proposed bytes. */
export function recoverEditTransactions(rootDir: string, ownsLock = false): string[] {
  const dir = transactionDir(rootDir);
  if (!existsSync(dir)) return [];
  if (!ownsLock && existsSync(join(dir, "commit.lock"))) return [];
  const unresolved: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".journal.json"))) {
    const path = join(dir, name);
    let journal: Proposal;
    try { journal = JSON.parse(readFileSync(path, "utf8")) as Proposal; }
    catch { unresolved.push(name); continue; }
    if (!Array.isArray(journal.writes) || !journal.writes.every((w) => safeTarget(rootDir, w.file))) {
      unresolved.push(journal.id ?? name);
      continue;
    }
    let safe = true;
    for (const write of journal.writes) {
      const hash = currentHash(rootDir, write.file);
      if (hash !== contentSha256(write.before) && hash !== contentSha256(write.after)) safe = false;
    }
    if (!safe) {
      unresolved.push(journal.id);
      continue;
    }
    let restored = true;
    for (const write of journal.writes) {
      if (currentHash(rootDir, write.file) === contentSha256(write.after)) {
        try { writeFileSync(safeTarget(rootDir, write.file)!, write.before, "utf8"); }
        catch { restored = false; }
      }
    }
    if (restored) rmSync(path);
    else unresolved.push(journal.id);
  }
  return unresolved;
}

export function prepareEditTransaction(rootDir: string, writes: ProposedWrite[]): TransactionOutcome {
  if (writes.length === 0 || new Set(writes.map((w) => w.file)).size !== writes.length ||
      writes.some((w) => !safeTarget(rootDir, w.file))) {
    return { status: "REJECTED", changedFiles: [], message: "REJECTED [unsafe-write-set] files must be unique existing workspace files." };
  }
  const id = `edit:${randomUUID()}`;
  const proposal: Proposal = { id, createdAt: Date.now(), writes };
  const baseHashes = Object.fromEntries(writes.map((w) => [w.file, contentSha256(w.before)]));
  const diff = writes.map((write) => {
    const before = write.before.split(/\r?\n/);
    const after = write.after.split(/\r?\n/);
    let first = 0;
    while (first < before.length && first < after.length && before[first] === after[first]) first++;
    let tail = 0;
    while (tail < before.length - first && tail < after.length - first &&
      before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
    const removed = before.slice(first, before.length - tail);
    const added = after.slice(first, after.length - tail);
    const show = (lines: string[], mark: string) => lines.slice(0, 40).map((line) => `${mark}${line}`).concat(lines.length > 40 ? [`${mark}... ${lines.length - 40} more line(s)`] : []);
    return [`--- ${write.file}`, `+++ ${write.file}`, `@@ L${first + 1} @@`, ...show(removed, "-"), ...show(added, "+")].join("\n");
  }).join("\n");
  writeJsonAtomic(proposalPath(rootDir, id), proposal);
  return { status: "PREPARED", proposalId: id, changedFiles: writes.map((w) => w.file), baseHashes, diff,
    message: `PREPARED [${id}] ${writes.length} file(s); commit with proposalId before expiry.` };
}

export function commitEditTransaction(rootDir: string, id: string, hooks?: { beforeWrite?: (file: string, index: number) => void }): TransactionOutcome {
  const path = proposalPath(rootDir, id);
  if (!existsSync(path)) return { status: "REJECTED", changedFiles: [], message: `REJECTED [proposal-not-found] ${id}` };
  const proposal = JSON.parse(readFileSync(path, "utf8")) as Proposal;
  if (!Array.isArray(proposal.writes) || proposal.writes.length === 0 ||
      new Set(proposal.writes.map((w) => w.file)).size !== proposal.writes.length ||
      proposal.writes.some((w) => !safeTarget(rootDir, w.file))) {
    return { status: "REJECTED", changedFiles: [], message: `REJECTED [unsafe-proposal] ${id}` };
  }
  if (Date.now() - proposal.createdAt > TTL_MS) {
    rmSync(path);
    return { status: "REJECTED", changedFiles: [], message: `REJECTED [proposal-expired] ${id}` };
  }
  const lock = join(transactionDir(rootDir), "commit.lock");
  try { mkdirSync(lock); } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 60_000) {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
      } else return { status: "REJECTED", changedFiles: [], message: "REJECTED [concurrent-commit] another edit is committing." };
    } catch { return { status: "REJECTED", changedFiles: [], message: "REJECTED [concurrent-commit] another edit is committing." }; }
  }
  try {
    const unresolved = recoverEditTransactions(rootDir, true);
    if (unresolved.length > 0) return { status: "RECOVERABLE_FAILURE", recoveryId: unresolved[0]!, changedFiles: [], message: `RECOVERABLE_FAILURE [${unresolved.join(", ")}] manual recovery needed.` };
    const stale = proposal.writes.filter((w) => currentHash(rootDir, w.file) !== contentSha256(w.before));
    if (stale.length > 0) return { status: "STALE_BASELINE", changedFiles: [], message: `STALE_BASELINE [${stale.map((w) => w.file).join(", ")}] proposal did not overwrite changed files.` };
    const journal = journalPath(rootDir, id);
    writeJsonAtomic(journal, proposal);
    try {
      for (const [index, write] of proposal.writes.entries()) {
        if (currentHash(rootDir, write.file) !== contentSha256(write.before)) throw new Error(`STALE_BASELINE ${write.file}`);
        hooks?.beforeWrite?.(write.file, index);
        writeFileSync(safeTarget(rootDir, write.file)!, write.after, "utf8");
      }
      rmSync(journal);
      rmSync(path);
      return { status: "COMMITTED", changedFiles: proposal.writes.map((w) => w.file), message: `COMMITTED [${id}] ${proposal.writes.length} file(s).` };
    } catch (error) {
      const pending = recoverEditTransactions(rootDir, true);
      return { status: "RECOVERABLE_FAILURE", recoveryId: id, changedFiles: [],
        message: `RECOVERABLE_FAILURE [${id}] ${String(error)}${pending.length ? "; recovery journal retained" : "; rolled back"}` };
    }
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function commitDirectEditTransaction(rootDir: string, writes: ProposedWrite[]): TransactionOutcome {
  const prepared = prepareEditTransaction(rootDir, writes);
  return prepared.proposalId ? commitEditTransaction(rootDir, prepared.proposalId) : prepared;
}
