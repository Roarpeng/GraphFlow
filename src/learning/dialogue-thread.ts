import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";

/**
 * Dialogue threads: each user question (+ optional LLM reply) becomes a
 * Decision node so a conversation stays a connected graph — sequential turns
 * AND topic jumps. Clicking a turn means "resume from this node".
 *
 * Layout (same Decision + metadata.kind pattern as episodes / goals):
 *   - session hub: id = dialogue-session:<hash>, kind "dialogue-session"
 *   - turn:        id = dialogue:<sessionHash>:<seq>, kind "dialogue-turn"
 *   - edges:       turn -part_of-> session
 *                  parent -next_section-> turn   (resumeFrom or previous tip)
 *                  prevTip -co_occurs-> turn     (when the click is a jump)
 *                  turn -references-> code       (optional L1 anchors)
 */

export const DIALOGUE_TURN_PREFIX = "dialogue:";
export const DIALOGUE_SESSION_PREFIX = "dialogue-session:";
export const DIALOGUE_TURN_KIND = "dialogue-turn";
export const DIALOGUE_SESSION_KIND = "dialogue-session";
export const DIALOGUE_TURN_SENTINEL = "dialogue-turn";

const DEFAULT_SESSION_NAME = "main";
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const MAX_QUERY_CHARS = 4_000;
const MAX_REPLY_CHARS = 4_000;
const MAX_RELATED_CODE = 6;
const MAX_THREAD_PROMPT_TURNS = 6;
const MIN_QUERY_CHARS = 4;

export interface DialogueTurnRecord {
  id: string;
  sessionId: string;
  seq: number;
  userQuery: string;
  assistantReply: string;
  parentTurnId?: string;
  /** True when this turn did not continue the previous tip (user clicked an older node, or the topic jumped). */
  jumped: boolean;
  relatedNodeIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface DialogueSessionRecord {
  id: string;
  name: string;
  tipTurnId?: string;
  turnCount: number;
  topicTokens: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RecordDialogueTurnInput {
  userQuery: string;
  assistantReply?: string;
  sessionName?: string;
  workspaceRoot?: string;
  resumeFromTurnId?: string;
  relatedNodeIds?: string[];
  now?: number;
}

export interface RecordDialogueTurnResult {
  recorded: boolean;
  reused: boolean;
  jumped: boolean;
  turn?: DialogueTurnRecord;
  session?: DialogueSessionRecord;
  skipped?: string;
}

export interface DialogueThreadView {
  sessionId: string;
  sessionName: string;
  tipTurnId?: string;
  jumped: boolean;
  overlap: number;
  turns: DialogueTurnRecord[];
  promptLines: string[];
}

export function dialogueSessionIdFor(sessionName: string, workspaceRoot?: string): string {
  const key = `${normalizeSessionName(sessionName)}|${(workspaceRoot ?? "").trim().toLowerCase()}`;
  return `${DIALOGUE_SESSION_PREFIX}${hashText(key)}`;
}

export function dialogueTurnIdFor(sessionId: string, seq: number): string {
  const sessionHash = sessionId.startsWith(DIALOGUE_SESSION_PREFIX)
    ? sessionId.slice(DIALOGUE_SESSION_PREFIX.length)
    : hashText(sessionId);
  return `${DIALOGUE_TURN_PREFIX}${sessionHash}:${String(seq).padStart(4, "0")}`;
}

export function isDialogueTurnNode(node: GraphNode): boolean {
  return node.metadata?.kind === DIALOGUE_TURN_KIND || node.id.startsWith(DIALOGUE_TURN_PREFIX);
}

export function isDialogueSessionNode(node: GraphNode): boolean {
  return node.metadata?.kind === DIALOGUE_SESSION_KIND || node.id.startsWith(DIALOGUE_SESSION_PREFIX);
}

export function parseDialogueTurn(node: GraphNode): DialogueTurnRecord | undefined {
  if (!isDialogueTurnNode(node)) return undefined;
  return deserializeTurn(node);
}

export function parseDialogueSession(node: GraphNode): DialogueSessionRecord | undefined {
  if (!isDialogueSessionNode(node)) return undefined;
  return deserializeSession(node);
}

export async function recordDialogueTurn(
  client: GraphClient,
  input: RecordDialogueTurnInput
): Promise<RecordDialogueTurnResult> {
  const userQuery = clip(input.userQuery, MAX_QUERY_CHARS);
  const now = input.now ?? Date.now();
  const sessionName = normalizeSessionName(input.sessionName);
  const sessionId = dialogueSessionIdFor(sessionName, input.workspaceRoot);
  const assistantReply = clip(input.assistantReply ?? "", MAX_REPLY_CHARS);

  const session = (await loadSession(client, sessionId)) ?? {
    id: sessionId,
    name: sessionName,
    turnCount: 0,
    topicTokens: [],
    createdAt: now,
    updatedAt: now,
  };

  const existingTurns = await listDialogueTurns(client, { sessionId, limit: 500 });
  const tip = existingTurns.find((turn) => turn.id === session.tipTurnId) ?? existingTurns[existingTurns.length - 1];

  if (userQuery.trim().length < MIN_QUERY_CHARS) {
    if (assistantReply && tip) {
      const updated: DialogueTurnRecord = { ...tip, assistantReply, updatedAt: now };
      await persistTurn(client, updated, session, {
        linkParent: false,
        jumped: tip.jumped,
        relatedNodeIds: mergeRelated(tip.relatedNodeIds, input.relatedNodeIds),
      });
      const nextSession: DialogueSessionRecord = { ...session, tipTurnId: updated.id, updatedAt: now };
      await persistSession(client, nextSession);
      return { recorded: true, reused: true, jumped: updated.jumped, turn: updated, session: nextSession };
    }
    return { recorded: false, reused: false, jumped: false, skipped: "query-too-short" };
  }

  if (tip && shouldReuseTurn(tip, userQuery, now)) {
    const updated: DialogueTurnRecord = {
      ...tip,
      ...(assistantReply ? { assistantReply } : {}),
      updatedAt: now,
    };
    await persistTurn(client, updated, session, {
      linkParent: false,
      jumped: tip.jumped,
      relatedNodeIds: mergeRelated(tip.relatedNodeIds, input.relatedNodeIds),
    });
    const nextSession: DialogueSessionRecord = {
      ...session,
      tipTurnId: updated.id,
      updatedAt: now,
      topicTokens: mergeTopicTokens(session.topicTokens, userQuery),
    };
    await persistSession(client, nextSession);
    return { recorded: true, reused: true, jumped: updated.jumped, turn: updated, session: nextSession };
  }

  const resumeFrom = input.resumeFromTurnId?.trim() || undefined;
  const parentTurnId = resumeFrom && existingTurns.some((turn) => turn.id === resumeFrom) ? resumeFrom : tip?.id;
  const jumped = Boolean(parentTurnId && tip && parentTurnId !== tip.id);
  const seq = session.turnCount + 1;
  const turn: DialogueTurnRecord = {
    id: dialogueTurnIdFor(sessionId, seq),
    sessionId,
    seq,
    userQuery,
    assistantReply,
    ...(parentTurnId ? { parentTurnId } : {}),
    jumped,
    relatedNodeIds: uniqueIds(input.relatedNodeIds).slice(0, MAX_RELATED_CODE),
    createdAt: now,
    updatedAt: now,
  };

  const nextSession: DialogueSessionRecord = {
    ...session,
    tipTurnId: turn.id,
    turnCount: seq,
    topicTokens: mergeTopicTokens(session.topicTokens, userQuery),
    updatedAt: now,
  };

  await persistSession(client, nextSession);
  await persistTurn(client, turn, nextSession, {
    linkParent: true,
    jumped,
    previousTipId: jumped ? tip?.id : undefined,
    relatedNodeIds: turn.relatedNodeIds,
  });

  return { recorded: true, reused: false, jumped, turn, session: nextSession };
}

export async function listDialogueTurns(
  client: GraphClient,
  options?: { sessionId?: string; limit?: number }
): Promise<DialogueTurnRecord[]> {
  const nodes = await collectDialogueNodes(client);
  const turns: DialogueTurnRecord[] = [];
  for (const node of nodes) {
    const rec = parseDialogueTurn(node);
    if (!rec) continue;
    if (options?.sessionId && rec.sessionId !== options.sessionId) continue;
    turns.push(rec);
  }
  if (options?.sessionId) {
    turns.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  } else {
    turns.sort((a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq || a.id.localeCompare(b.id));
  }
  const limit = options?.limit;
  if (limit === undefined) {
    return turns;
  }
  const bounded = Math.max(1, limit);
  if (options?.sessionId) {
    return turns.slice(Math.max(0, turns.length - bounded));
  }
  return turns.slice(0, bounded);
}

export async function loadDialogueThread(
  client: GraphClient,
  options?: { sessionName?: string; workspaceRoot?: string; sessionId?: string; limit?: number }
): Promise<DialogueThreadView | undefined> {
  const sessionId =
    options?.sessionId ?? dialogueSessionIdFor(normalizeSessionName(options?.sessionName), options?.workspaceRoot);
  const session = await loadSession(client, sessionId);
  if (!session) {
    return undefined;
  }
  const turns = await listDialogueTurns(client, {
    sessionId,
    limit: options?.limit ?? MAX_THREAD_PROMPT_TURNS,
  });
  if (turns.length === 0) {
    return undefined;
  }
  return {
    sessionId,
    sessionName: session.name,
    ...(session.tipTurnId ? { tipTurnId: session.tipTurnId } : {}),
    jumped: turns[turns.length - 1]?.jumped === true,
    overlap: 1,
    turns,
    promptLines: formatDialogueThreadLines({
      sessionId,
      sessionName: session.name,
      ...(session.tipTurnId ? { tipTurnId: session.tipTurnId } : {}),
      jumped: turns[turns.length - 1]?.jumped === true,
      overlap: 1,
      turns,
      promptLines: [],
    }),
  };
}

export function formatDialogueThreadLines(thread: DialogueThreadView): string[] {
  const lines: string[] = [
    `Thread: ${thread.sessionName} turns=${thread.turns.length}` +
      (thread.tipTurnId ? ` tip=${thread.tipTurnId}` : "") +
      (thread.jumped ? " jumped" : " mainline"),
  ];
  for (const turn of thread.turns.slice(-MAX_THREAD_PROMPT_TURNS)) {
    const jumpMark = turn.jumped ? ` jump←${turn.parentTurnId ?? "?"}` : "";
    const answer = turn.assistantReply.trim() ? clip(turn.assistantReply, 120) : "(pending)";
    lines.push(`Turn #${turn.seq}${jumpMark} Q: ${clip(turn.userQuery, 80)} | A: ${answer}`);
  }
  lines.push(`Resume: graphflow_context({ resumeFromTurnId: "<dialogue turn id>" }) to continue from a clicked turn.`);
  return lines;
}

export function scoreTopicOverlap(previousTokens: string[], query: string): number {
  const next = extractTokens(query);
  if (previousTokens.length === 0 || next.length === 0) {
    return 1;
  }
  const prev = new Set(previousTokens);
  let hit = 0;
  for (const token of next) {
    if (prev.has(token)) hit += 1;
  }
  return hit / next.length;
}

async function persistTurn(
  client: GraphClient,
  turn: DialogueTurnRecord,
  session: DialogueSessionRecord,
  options: {
    linkParent: boolean;
    jumped: boolean;
    previousTipId?: string;
    relatedNodeIds?: string[];
  }
): Promise<void> {
  const related = uniqueIds(options.relatedNodeIds ?? turn.relatedNodeIds).slice(0, MAX_RELATED_CODE);
  const stored: DialogueTurnRecord = { ...turn, relatedNodeIds: related };
  const node: GraphNode = {
    id: stored.id,
    type: "Decision",
    content: compactTurnContent(stored),
    metadata: {
      kind: DIALOGUE_TURN_KIND,
      record: JSON.stringify(stored),
      seq: stored.seq,
      sessionId: stored.sessionId,
      jumped: stored.jumped,
    },
  };
  await client.upsertNodes([node]);

  const edges: GraphEdge[] = [{ from: stored.id, to: session.id, relation: "part_of" }];
  if (options.linkParent && stored.parentTurnId) {
    edges.push({ from: stored.parentTurnId, to: stored.id, relation: "next_section" });
  }
  if (options.jumped && options.previousTipId && options.previousTipId !== stored.parentTurnId) {
    edges.push({ from: options.previousTipId, to: stored.id, relation: "co_occurs" });
  }
  for (const relatedId of related) {
    edges.push({ from: stored.id, to: relatedId, relation: "references" });
  }
  await upsertUniqueEdges(client, edges);
}

async function persistSession(client: GraphClient, session: DialogueSessionRecord): Promise<void> {
  const node: GraphNode = {
    id: session.id,
    type: "Decision",
    content: `dialogue-session ${session.name} turns=${session.turnCount}` +
      (session.tipTurnId ? ` tip=${session.tipTurnId}` : ""),
    metadata: {
      kind: DIALOGUE_SESSION_KIND,
      record: JSON.stringify(session),
      name: session.name,
    },
  };
  await client.upsertNodes([node]);
}

async function loadSession(
  client: GraphClient,
  sessionId: string
): Promise<DialogueSessionRecord | undefined> {
  if (typeof client.getNodesByIds === "function") {
    const nodes = await client.getNodesByIds([sessionId]);
    const node = nodes.find((item) => item.id === sessionId);
    if (node) {
      return parseDialogueSession(node);
    }
  }
  const nodes = await collectDialogueNodes(client);
  const node = nodes.find((item) => item.id === sessionId);
  return node ? parseDialogueSession(node) : undefined;
}

async function collectDialogueNodes(client: GraphClient): Promise<GraphNode[]> {
  const snapshot = client.readSnapshot?.();
  if (snapshot) {
    return snapshot.nodes.filter((node) => isDialogueTurnNode(node) || isDialogueSessionNode(node));
  }
  const byId = new Map<string, GraphNode>();
  for (const query of [DIALOGUE_TURN_SENTINEL, "dialogue-session", DIALOGUE_TURN_PREFIX]) {
    for (const node of await client.queryByKeyword(query)) {
      if (isDialogueTurnNode(node) || isDialogueSessionNode(node)) {
        byId.set(node.id, node);
      }
    }
  }
  return Array.from(byId.values());
}

async function upsertUniqueEdges(client: GraphClient, edges: GraphEdge[]): Promise<void> {
  if (edges.length === 0) return;
  const snapshot = client.readSnapshot?.();
  const existing = new Set(
    (snapshot?.edges ?? []).map((edge) => `${edge.from}|${edge.relation}|${edge.to}`)
  );
  const fresh = edges.filter((edge) => !existing.has(`${edge.from}|${edge.relation}|${edge.to}`));
  if (fresh.length === 0) return;
  await client.upsertEdges(fresh);
}

function shouldReuseTurn(turn: DialogueTurnRecord, userQuery: string, now: number): boolean {
  if (now - turn.updatedAt > DEDUPE_WINDOW_MS) return false;
  return normalizeQuery(turn.userQuery) === normalizeQuery(userQuery);
}

function compactTurnContent(turn: DialogueTurnRecord): string {
  const answer = turn.assistantReply.trim() ? clip(turn.assistantReply, 160) : "(pending)";
  return `${DIALOGUE_TURN_SENTINEL} #${turn.seq} Q: ${clip(turn.userQuery, 160)} | A: ${answer}`;
}

function deserializeTurn(node: GraphNode): DialogueTurnRecord | undefined {
  const raw = typeof node.metadata?.record === "string" ? node.metadata.record : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DialogueTurnRecord>;
    if (typeof parsed.id !== "string" || typeof parsed.userQuery !== "string") return undefined;
    return {
      id: parsed.id,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      userQuery: parsed.userQuery,
      assistantReply: typeof parsed.assistantReply === "string" ? parsed.assistantReply : "",
      ...(typeof parsed.parentTurnId === "string" ? { parentTurnId: parsed.parentTurnId } : {}),
      jumped: parsed.jumped === true,
      relatedNodeIds: Array.isArray(parsed.relatedNodeIds)
        ? parsed.relatedNodeIds.filter((id): id is string => typeof id === "string")
        : [],
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

function deserializeSession(node: GraphNode): DialogueSessionRecord | undefined {
  const raw = typeof node.metadata?.record === "string" ? node.metadata.record : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DialogueSessionRecord>;
    if (typeof parsed.id !== "string") return undefined;
    return {
      id: parsed.id,
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_SESSION_NAME,
      ...(typeof parsed.tipTurnId === "string" ? { tipTurnId: parsed.tipTurnId } : {}),
      turnCount: typeof parsed.turnCount === "number" ? parsed.turnCount : 0,
      topicTokens: Array.isArray(parsed.topicTokens)
        ? parsed.topicTokens.filter((token): token is string => typeof token === "string")
        : [],
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

function normalizeSessionName(name?: string): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.slice(0, 64) : DEFAULT_SESSION_NAME;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function extractTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (raw.length >= 2) out.add(raw);
  }
  return Array.from(out);
}

function mergeTopicTokens(existing: string[], query: string): string[] {
  const merged = new Set(existing);
  for (const token of extractTokens(query)) {
    merged.add(token);
  }
  return Array.from(merged).sort().slice(0, 48);
}

function uniqueIds(ids?: string[]): string[] {
  if (!ids) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function mergeRelated(current: string[], incoming?: string[]): string[] {
  return uniqueIds([...current, ...(incoming ?? [])]).slice(0, MAX_RELATED_CODE);
}
