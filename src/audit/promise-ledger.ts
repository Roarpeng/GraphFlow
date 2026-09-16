/**
 * R9 Promise Ledger — cross-session reminder backing store.
 *
 * When a session ends with unresolved obligations (audit findings), one
 * ledger node per session is written to the graph; the NEXT session's first
 * graphflow_context reads the open entries back as a "上次会话有 N 项未收尾"
 * reminder. A later audit whose findings no longer cover an entry's finding
 * ids marks that entry resolved. Persistence rides the same pattern as
 * src/learning/mechanism-research.ts: a Decision node whose payload lives in
 * metadata (here metadata.ledger carries the full PromiseLedgerEntry), with a
 * one-line human-readable summary in content.
 *
 * Delivery stance is fail-open: no read or write here may throw — a broken
 * graph store degrades to "no reminder", never to a crashed session.
 */
import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import type { PromiseLedgerEntry } from "./types";

export const PROMISE_LEDGER_ID_PREFIX = "promise-ledger:";

/** Default number of open entries surfaced by listOpenPromises. */
export const DEFAULT_OPEN_PROMISE_LIMIT = 5;

/** Node id for a session's ledger entry (illegal id characters become "-"). */
export function promiseLedgerNodeId(sessionId: string): string {
  return PROMISE_LEDGER_ID_PREFIX + sessionId.replace(/[^A-Za-z0-9_\-.]+/g, "-");
}

function summarizeEntry(entry: PromiseLedgerEntry): string {
  // One line: sessionId + status + count. The literal prefix keeps the node
  // discoverable by queryByKeyword("promise-ledger") on tokenizing backends,
  // where the Decision node id itself is not part of the searchable text.
  return (
    `promise-ledger: session=${entry.sessionId} status=${entry.status} ` +
    `findings=${entry.findingIds.length}`
  );
}

function writeLedgerNode(client: GraphClient, entry: PromiseLedgerEntry): Promise<void> {
  return client.upsertNodes([
    {
      id: promiseLedgerNodeId(entry.sessionId),
      type: "Decision",
      content: summarizeEntry(entry),
      metadata: { kind: "promise-ledger", ledger: entry },
    },
  ]);
}

/**
 * Normalize an incoming entry: defensive-copy the arrays, keep status honest.
 * An entry with no findings is trivially clean and is stored resolved
 * (resolvedAt defaults to the audit timestamp that produced it); a resolved
 * entry always carries a resolvedAt.
 */
function normalizeEntry(entry: PromiseLedgerEntry): PromiseLedgerEntry {
  const findingIds = entry.findingIds.filter((id): id is string => typeof id === "string");
  const messages = entry.messages.filter((m): m is string => typeof m === "string");
  const status: PromiseLedgerEntry["status"] =
    findingIds.length === 0 ? "resolved" : entry.status === "resolved" ? "resolved" : "open";
  const resolvedAt =
    status === "resolved" ? (entry.resolvedAt ?? entry.recordedAt) : entry.resolvedAt;
  return {
    sessionId: entry.sessionId,
    recordedAt: entry.recordedAt,
    findingIds,
    messages,
    status,
    ...(typeof resolvedAt === "string" ? { resolvedAt } : {}),
  };
}

/**
 * Parse + shape-validate a stored ledger payload. Accepts both the object form
 * (written by writeLedgerNode through a JSON store) and a JSON string; returns
 * undefined for anything malformed — corrupted entries are skipped, not fatal.
 */
export function parsePromiseLedgerEntry(raw: unknown): PromiseLedgerEntry | undefined {
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const c = candidate as Record<string, unknown>;
  if (typeof c.sessionId !== "string" || !c.sessionId) return undefined;
  if (typeof c.recordedAt !== "string") return undefined;
  if (!Array.isArray(c.findingIds) || c.findingIds.some((id) => typeof id !== "string")) {
    return undefined;
  }
  if (!Array.isArray(c.messages) || c.messages.some((m) => typeof m !== "string")) {
    return undefined;
  }
  if (c.status !== "open" && c.status !== "resolved") return undefined;
  if (c.resolvedAt !== undefined && typeof c.resolvedAt !== "string") return undefined;
  return {
    sessionId: c.sessionId,
    recordedAt: c.recordedAt,
    findingIds: [...c.findingIds],
    messages: [...c.messages],
    status: c.status,
    ...(typeof c.resolvedAt === "string" ? { resolvedAt: c.resolvedAt } : {}),
  };
}

/**
 * Collect every ledger node id-prefixed node, most robust path first:
 * readSnapshot (sees the whole store, no tokenization loss), falling back to
 * queryByKeyword("promise-ledger"). Any failure degrades to [] (fail-open).
 */
async function collectLedgerNodes(client: GraphClient): Promise<GraphNode[]> {
  if (typeof client.readSnapshot === "function") {
    try {
      const snapshot = client.readSnapshot();
      const nodes = new Map<string, GraphNode>();
      for (const node of snapshot.nodes) {
        if (node.id.startsWith(PROMISE_LEDGER_ID_PREFIX)) nodes.set(node.id, node);
      }
      return [...nodes.values()];
    } catch {
      // fall through to the keyword path
    }
  }
  try {
    const matched = await client.queryByKeyword("promise-ledger");
    const nodes = new Map<string, GraphNode>();
    for (const node of matched) {
      if (node.id.startsWith(PROMISE_LEDGER_ID_PREFIX)) nodes.set(node.id, node);
    }
    return [...nodes.values()];
  } catch {
    return [];
  }
}

/** All open entries, parsed + validated, newest session first. */
async function collectOpenEntries(client: GraphClient): Promise<PromiseLedgerEntry[]> {
  const nodes = await collectLedgerNodes(client);
  const bySession = new Map<string, PromiseLedgerEntry>();
  for (const node of nodes) {
    const entry = parsePromiseLedgerEntry(node.metadata?.ledger);
    if (!entry || entry.status !== "open") continue;
    const existing = bySession.get(entry.sessionId);
    if (!existing || entry.recordedAt > existing.recordedAt) {
      bySession.set(entry.sessionId, entry);
    }
  }
  return [...bySession.values()].sort(
    (a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.sessionId.localeCompare(b.sessionId)
  );
}

/**
 * Idempotently record one ledger entry (same sessionId overwrites its node).
 * Findings-empty entries are stored resolved. Write failures are fail-open:
 * the normalized entry is returned without throwing so the caller decides.
 */
export async function recordPromiseLedger(
  client: GraphClient,
  entry: PromiseLedgerEntry
): Promise<PromiseLedgerEntry> {
  const normalized = normalizeEntry(entry);
  try {
    await writeLedgerNode(client, normalized);
  } catch {
    // fail-open: the graph store being down must not crash session teardown.
  }
  return normalized;
}

/** Open entries, newest session first (recordedAt desc). limit defaults to 5. */
export async function listOpenPromises(
  client: GraphClient,
  options?: { limit?: number }
): Promise<PromiseLedgerEntry[]> {
  const limit = Math.max(0, options?.limit ?? DEFAULT_OPEN_PROMISE_LIMIT);
  const open = await collectOpenEntries(client);
  return open.slice(0, limit);
}

/**
 * Resolve open entries whose obligations are gone: an entry resolves when its
 * findingIds are a subset of currentFindingIds — and an empty currentFindingIds
 * means the audit found NOTHING outstanding, so every open entry resolves.
 * Only entries whose resolved state was actually persisted are reported.
 */
export async function resolvePromisesIfClean(
  client: GraphClient,
  currentFindingIds: string[],
  now?: string
): Promise<{ resolved: string[] }> {
  const open = await collectOpenEntries(client);
  if (open.length === 0) return { resolved: [] };
  const current = new Set(currentFindingIds);
  const resolvedAt = now ?? new Date().toISOString();
  const resolved: string[] = [];
  for (const entry of open) {
    const covered =
      currentFindingIds.length === 0 || entry.findingIds.every((id) => current.has(id));
    if (!covered) continue;
    try {
      await writeLedgerNode(client, { ...entry, status: "resolved", resolvedAt });
      resolved.push(entry.sessionId);
    } catch {
      // fail-open: a failed write leaves the entry open; do not report it.
    }
  }
  return { resolved };
}

/**
 * Assemble the cross-session reminder copy. Each open entry contributes a
 * header line plus its first limitPerEntry (default 3) messages; the closing
 * line states the total open obligations. Returns undefined when nothing is
 * open so callers can skip the reminder entirely.
 */
export function formatOpenPromiseReminder(
  entries: PromiseLedgerEntry[],
  limitPerEntry = 3
): string | undefined {
  const open = entries.filter((entry) => entry.status === "open");
  if (open.length === 0) return undefined;
  const per = Math.max(0, limitPerEntry);
  const lines: string[] = [];
  for (const entry of open) {
    lines.push(`上次会话有未收尾工作（会话 ${entry.sessionId}，${entry.recordedAt}）：`);
    const shown = entry.messages.slice(0, per);
    if (shown.length === 0) {
      lines.push(`- （${entry.findingIds.length} 项待收尾，详情见 audit）`);
    }
    for (const message of shown) {
      lines.push(`- ${message}`);
    }
    if (entry.messages.length > shown.length) {
      lines.push(`- …另有 ${entry.messages.length - shown.length} 项未列出`);
    }
  }
  const total = open.reduce(
    (acc, entry) => acc + (entry.findingIds.length > 0 ? entry.findingIds.length : entry.messages.length),
    0
  );
  lines.push(`共 ${total} 项——先收尾再继续？`);
  return lines.join("\n");
}
