import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";
import { deriveTurnSummary, deriveTurnTitle } from "./turn-distillation";

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
 *                  turn -supersedes-> priorTurn  (correction: this turn's
 *                                                answer replaces an earlier
 *                                                conclusion on the same topic;
 *                                                Graphiti-style temporal edge)
 *                  turn -same_topic-> turn'      (cross-session semantic link:
 *                                                both turns discuss the same
 *                                                code/topic tokens)
 *
 * Temporal semantics (Conversation Graph 2.0):
 *   - validAt:    ms epoch when the turn's conclusion became effective
 *                (defaults to createdAt; a later correction gets its own
 *                validAt so "current truth" = newest validAt on the chain)
 *   - invalidAt:  ms epoch when the turn's conclusion stopped being current
 *                (set on the superseded turn when a supersedes edge lands)
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
/** Cross-session same_topic links: minimum token-set overlap ratio. */
const SAME_TOPIC_MIN_OVERLAP = 0.34;
/** Max turns scanned per other session when linking same_topic edges. */
const SAME_TOPIC_SCAN_LIMIT = 60;
/** Supersession: how many earlier turns to link (nearest N on the chain). */
const SUPERSEDE_LINK_LIMIT = 2;

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
  /** Distilled short title (offline heuristic, no LLM). */
  title?: string;
  /** Distilled conclusion summary (offline heuristic, no LLM). */
  summary?: string;
  /**
   * Temporal edge (Conversation Graph 2.0): ids of earlier turns whose
   * conclusion this turn's answer corrects/replaces. Mirrors the
   * `supersedes` graph edge; kept on the record for O(1) reads.
   */
  supersedesTurnIds?: string[];
  /** Temporal validity: ms epoch when this turn's conclusion became effective (defaults to createdAt). */
  validAt?: number;
  /** Temporal validity: ms epoch when this turn's conclusion stopped being current (set when superseded). */
  invalidAt?: number;
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
      const summary = deriveTurnSummary(assistantReply);
      const updated: DialogueTurnRecord = {
        ...tip,
        assistantReply,
        ...(summary ? { summary } : {}),
        updatedAt: now,
      };
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
    const summary = assistantReply ? deriveTurnSummary(assistantReply) : undefined;
    const updated: DialogueTurnRecord = {
      ...tip,
      ...(assistantReply ? { assistantReply } : {}),
      ...(summary ? { summary } : {}),
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
  const title = deriveTurnTitle(userQuery);
  const summary = assistantReply.trim() ? deriveTurnSummary(assistantReply) : undefined;

  // Conversation Graph 2.0 temporal edges:
  //  - supersedes: this answer corrects an earlier conclusion on the same topic
  //  - same_topic: cross-session turns discussing the same code/topic tokens
  const supersedesTurnIds = assistantReply.trim()
    ? detectSupersession(existingTurns, userQuery, assistantReply, seq, SUPERSEDE_LINK_LIMIT)
    : [];
  const otherSessionTurns = (await listDialogueTurns(client, { limit: SAME_TOPIC_SCAN_LIMIT }))
    .filter((turn) => turn.sessionId !== sessionId);
  const sameTopicPairs = detectSameTopicLinks(
    otherSessionTurns,
    { id: dialogueTurnIdFor(sessionId, seq), userQuery },
    session.topicTokens
  );

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
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(supersedesTurnIds.length > 0 ? { supersedesTurnIds } : {}),
    ...(supersedesTurnIds.length > 0 ? { validAt: now } : {}),
  };

  const nextSession: DialogueSessionRecord = {
    ...session,
    tipTurnId: turn.id,
    turnCount: seq,
    topicTokens: mergeTopicTokens(session.topicTokens, userQuery),
    updatedAt: now,
  };

  await persistSession(client, nextSession);
  const previousTipId = jumped ? tip?.id : undefined;
  await persistTurn(client, turn, nextSession, {
    linkParent: true,
    jumped,
    ...(previousTipId ? { previousTipId } : {}),
    relatedNodeIds: turn.relatedNodeIds,
  });
  await linkTemporalEdges(client, { turn, supersedesTurnIds, sameTopicPairs, now });

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

export interface TurnDistillationPatch {
  title?: string;
  summary?: string;
}

/**
 * Backfill distilled title/summary onto an existing turn without touching its
 * graph shape. Existing non-empty fields win (never overwritten); missing
 * fields are filled from `patch`. Returns the persisted record, or `undefined`
 * when the turn (or its session hub) is missing.
 */
export async function applyTurnDistillation(
  client: GraphClient,
  turnId: string,
  patch: TurnDistillationPatch
): Promise<DialogueTurnRecord | undefined> {
  const nodes = await collectDialogueNodes(client);
  const node = nodes.find((item) => item.id === turnId);
  const turn = node ? parseDialogueTurn(node) : undefined;
  if (!turn) return undefined;

  const nextTitle = mergeDistilledField(turn.title, patch.title);
  const nextSummary = mergeDistilledField(turn.summary, patch.summary);
  if (nextTitle === turn.title && nextSummary === turn.summary) {
    return turn;
  }

  const merged: DialogueTurnRecord = {
    ...turn,
    ...(nextTitle ? { title: nextTitle } : {}),
    ...(nextSummary ? { summary: nextSummary } : {}),
  };
  const session = await loadSession(client, merged.sessionId);
  if (!session) return undefined;
  await persistTurn(client, merged, session, {
    linkParent: false,
    jumped: merged.jumped,
    relatedNodeIds: merged.relatedNodeIds,
  });
  return merged;
}

function mergeDistilledField(existing: string | undefined, incoming: string | undefined): string | undefined {
  const existingTrimmed = existing?.trim();
  const incomingTrimmed = incoming?.trim();
  if (existingTrimmed) return existingTrimmed;
  if (incomingTrimmed) return incomingTrimmed;
  return undefined;
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
      ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
      ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
      ...(Array.isArray(parsed.supersedesTurnIds)
        ? {
            supersedesTurnIds: parsed.supersedesTurnIds.filter(
              (id): id is string => typeof id === "string"
            ),
          }
        : {}),
      ...(typeof parsed.validAt === "number" ? { validAt: parsed.validAt } : {}),
      ...(typeof parsed.invalidAt === "number" ? { invalidAt: parsed.invalidAt } : {}),
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

// ─────────────────── Conversation Graph 2.0: temporal edges ───────────────────

/**
 * Correction markers that make an assistant reply a "supersession answer":
 * the turn explicitly replaces/updates an earlier conclusion rather than
 * answering an unrelated question. EN + CJK, used on the reply text.
 */
const SUPERSESSION_REPLY_MARKERS: string[] = [
  "更正",
  "更准确地说",
  "修正一下",
  "修正",
  "纠正一下",
  "纠正",
  "重新回答",
  "重新梳理",
  "不是",
  "之前说错",
  "上面说错",
  "其实",
  "实际上",
  "重新确认后",
  "correction",
  "corrected",
  "actually",
  "to be precise",
  "in fact",
  "rather than",
  "instead of",
  "updated answer",
  "supersedes the earlier",
  "revised",
];

/** Topic-overlap floor for a reply to qualify as correcting "the same topic". */
const SUPERSEDE_TOPIC_OVERLAP = 0.25;

/**
 * Offline heuristic: which earlier turns does this answer supersede?
 *
 * A turn T' supersedes T when:
 *  1. T' carries a correction marker in its reply (or its query re-asks the
 *     same topic as T), AND
 *  2. T's question/topic tokens overlap T' enough that they discuss the same
 *     subject, AND
 *  3. T already has an answer (a pending turn cannot be superseded — nothing
 *     to replace), AND
 *  4. T is not already superseded by another kept turn (nearest N win).
 *
 * Deterministic and conservative: no LLM, no I/O. Returns turn ids ordered
 * oldest-first, capped at `limit`.
 */
export function detectSupersession(
  turns: DialogueTurnRecord[],
  userQuery: string,
  assistantReply: string,
  currentSeq: number,
  limit = SUPERSEDE_LINK_LIMIT
): string[] {
  const replyMarked = SUPERSESSION_REPLY_MARKERS.some((marker) =>
    assistantReply.toLowerCase().includes(marker.toLowerCase())
  );
  if (!replyMarked) return [];

  const currentTokens = new Set(extractTokens(userQuery));
  if (currentTokens.size === 0) return [];

  const candidates: Array<{ turn: DialogueTurnRecord; overlap: number }> = [];
  for (const turn of turns) {
    if (turn.seq >= currentSeq) continue;
    if (!turn.assistantReply.trim()) continue; // pending: nothing to supersede
    if (turn.invalidAt !== undefined) continue; // already off the current chain
    const overlap = tokenOverlapRatio(currentTokens, turn.userQuery);
    if (overlap < SUPERSEDE_TOPIC_OVERLAP) continue;
    candidates.push({ turn, overlap });
  }
  if (candidates.length === 0) return [];

  // Nearest turns first (highest overlap, then latest), capped at `limit`.
  candidates.sort((a, b) => b.overlap - a.overlap || b.turn.seq - a.turn.seq);
  return candidates
    .slice(0, Math.max(1, limit))
    .map((c) => c.turn.id)
    .sort();
}

function tokenOverlapRatio(next: Set<string>, earlierQuery: string): number {
  const earlier = extractTokens(earlierQuery);
  if (earlier.length === 0) return 0;
  let hit = 0;
  for (const token of earlier) {
    if (next.has(token)) hit += 1;
  }
  return hit / earlier.length;
}

/**
 * Candidate cross-session same_topic links for a newly recorded turn:
 * other-session turns whose query tokens overlap the new query beyond
 * `SAME_TOPIC_MIN_OVERLAP` (falling back to session topicTokens when the
 * query itself is sparse). Pure — callers persist the chosen edges.
 */
export function detectSameTopicLinks(
  allTurns: DialogueTurnRecord[],
  next: { id: string; userQuery: string },
  sessionTopicTokens: string[],
  options?: { limit?: number }
): Array<{ from: string; to: string }> {
  const currentTokens = new Set([
    ...extractTokens(next.userQuery),
    ...sessionTopicTokens,
  ]);
  if (currentTokens.size === 0) return [];

  const scored: Array<{ turn: DialogueTurnRecord; overlap: number }> = [];
  for (const turn of allTurns) {
    if (turn.id === next.id) continue;
    const overlap = tokenOverlapRatio(currentTokens, turn.userQuery);
    if (overlap < SAME_TOPIC_MIN_OVERLAP) continue;
    scored.push({ turn, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap || b.turn.updatedAt - a.turn.updatedAt);
  const limit = options?.limit ?? 3;
  return scored
    .slice(0, Math.max(1, limit))
    .map((s) => ({ from: next.id, to: s.turn.id }));
}

/**
 * Persist the temporal edge set of one turn:
 *  - `supersedes` edges turn -> supersededTurn for each correction link, and
 *    the superseded turns get `invalidAt = now` (their conclusion stopped
 *    being current) while this turn's `validAt = now`.
 *  - `same_topic` edges turn -> otherTurn for cross-session semantic links
 *    (bidirectional information: one edge, both reads traverse "both").
 * Best-effort: failures degrade to a graph without temporal edges, never
 * throw into the record path.
 */
async function linkTemporalEdges(
  client: GraphClient,
  input: {
    turn: DialogueTurnRecord;
    supersedesTurnIds: string[];
    sameTopicPairs: Array<{ from: string; to: string }>;
    now: number;
  }
): Promise<void> {
  const { turn, supersedesTurnIds, sameTopicPairs, now } = input;
  try {
    const edges: GraphEdge[] = [];
    for (const targetId of supersedesTurnIds) {
      edges.push({ from: turn.id, to: targetId, relation: "supersedes" });
    }
    for (const pair of sameTopicPairs) {
      edges.push({ from: pair.from, to: pair.to, relation: "same_topic" });
    }
    if (edges.length > 0) {
      await upsertUniqueEdges(client, edges);
    }

    // Mark the superseded turns as no longer current (invalidAt) so
    // retrieval can distinguish "was true then" from "current truth".
    if (supersedesTurnIds.length > 0) {
      const nodes = await collectDialogueNodes(client);
      for (const node of nodes) {
        const record = parseDialogueTurn(node);
        if (!record) continue;
        if (!supersedesTurnIds.includes(record.id)) continue;
        if (record.invalidAt !== undefined) continue;
        const updated: DialogueTurnRecord = { ...record, invalidAt: now };
        const session = await loadSession(client, updated.sessionId);
        if (!session) continue;
        await persistTurn(client, updated, session, {
          linkParent: false,
          jumped: updated.jumped,
          relatedNodeIds: updated.relatedNodeIds,
        });
      }
    }
  } catch {
    // temporal edges are additive — never break the record path
  }
}

/**
 * Effective (current) turns of a set: drop turns carrying an `invalidAt`
 * unless the caller asks for the full history. Used by L3 packing and
 * retrieval so agents see "current truth" by default and the correction
 * chain only on request.
 */
export function effectiveTurns(
  turns: DialogueTurnRecord[],
  options?: { includeSuperseded?: boolean }
): DialogueTurnRecord[] {
  if (options?.includeSuperseded === true) return turns;
  return turns.filter((turn) => turn.invalidAt === undefined);
}

/**
 * Render a correction chain line for a superseded turn: "结论 X 已被修正为
 * Y (turn#seq)" — used by retrieval annotations and L3 packing.
 */
export function formatSupersessionLine(turn: DialogueTurnRecord, supersededBy: DialogueTurnRecord): string {
  const oldConclusion = clip(
    turn.summary?.trim() ? turn.summary : turn.assistantReply,
    60
  );
  const newConclusion = clip(
    supersededBy.summary?.trim() ? supersededBy.summary : supersededBy.assistantReply,
    60
  );
  return `Turn #${turn.seq} "${oldConclusion}" 已被修正 (Turn #${supersededBy.seq}): "${newConclusion}"`;
}

// ─────────────────── Conversation Graph W3: fork + agent traces ───────────────────

/** One hop on the replay path (dialogue list --path). */
export interface DialoguePathStep {
  id: string;
  seq: number;
  sessionId: string;
  title?: string;
  userQuery: string;
  assistantReply: string;
  jumped: boolean;
  /** True when this step is the fork boundary (session changed from the previous step). */
  forkBoundary: boolean;
  supersedesTurnIds?: string[];
  invalidAt?: number;
}

/**
 * Replay path walk (pure graph): the turn spine ending at `endTurnId`,
 * following parentTurnId links (jump targets + fork boundaries included)
 * back to the first turn. Returns steps oldest-first.
 */
export function walkDialoguePath(
  allTurns: DialogueTurnRecord[],
  endTurnId: string,
  limit = 30
): DialoguePathStep[] {
  const byId = new Map(allTurns.map((t) => [t.id, t]));
  const chain: DialogueTurnRecord[] = [];
  const seen = new Set<string>();
  let cursor: DialogueTurnRecord | undefined = byId.get(endTurnId);
  while (cursor && !seen.has(cursor.id) && chain.length < limit) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentTurnId ? byId.get(cursor.parentTurnId) : undefined;
  }
  chain.reverse();

  return chain.map((turn, index) => ({
    id: turn.id,
    seq: turn.seq,
    sessionId: turn.sessionId,
    ...(turn.title ? { title: turn.title } : {}),
    userQuery: turn.userQuery,
    assistantReply: turn.assistantReply,
    jumped: turn.jumped,
    forkBoundary: index > 0 && chain[index - 1]!.sessionId !== turn.sessionId,
    ...(turn.supersedesTurnIds && turn.supersedesTurnIds.length > 0
      ? { supersedesTurnIds: turn.supersedesTurnIds }
      : {}),
    ...(turn.invalidAt !== undefined ? { invalidAt: turn.invalidAt } : {}),
  }));
}

/** Fork result: a new session whose spine starts from the chosen turn. */
export interface ForkDialogueResult {
  forkedSessionId: string;
  forkedSessionName: string;
  sourceTurnId: string;
  /** Turns copied into the fork (source spine up to and including the fork point). */
  copiedTurns: number;
}

/**
 * Explicit dialogue fork (Conversation Graph W3a): create a NEW dialogue
 * session rooted at `fromTurnId`. The new session's first turn links
 * `parentTurnId = fromTurnId` (next_section edge), so `dialogue list
 * --path` can walk the spine across the fork boundary, and a `co_occurs`
 * edge is NOT added (a fork is deliberate, not a jump).
 *
 * The fork records the source session's spine compactly: a single seed
 * turn carrying the source question, plus fork metadata on the session hub
 * (`forkedFrom`, `forkedFromTurnId`) for panel rendering. Pure graph
 * operations; no snapshot copying.
 */
export async function forkDialogueSession(
  client: GraphClient,
  input: {
    fromTurnId: string;
    forkName?: string;
    workspaceRoot?: string;
    now?: number;
  }
): Promise<ForkDialogueResult | undefined> {
  const now = input.now ?? Date.now();
  const nodes = await collectDialogueNodes(client);
  const sourceTurn = nodes
    .map((node) => parseDialogueTurn(node))
    .find((turn) => turn?.id === input.fromTurnId);
  if (!sourceTurn) return undefined;

  const forkedSessionName =
    input.forkName?.trim() || `${sourceTurn.sessionId.slice("dialogue-session:".length)}-fork-${now.toString(36)}`;

  // Seed the fork: the source question re-asked in the new session. The seed
  // records WITHOUT resumeFrom (that flag only accepts same-session turns);
  // the cross-session spine edge is added explicitly below.
  const result = await recordDialogueTurn(client, {
    userQuery: sourceTurn.userQuery,
    ...(sourceTurn.assistantReply.trim() ? { assistantReply: sourceTurn.assistantReply } : {}),
    sessionName: forkedSessionName,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    now,
  });
  if (!result.recorded || !result.turn || !result.session) return undefined;

  // Fork spine: seed -next_section-> fork origin (cross-session) and
  // parentTurnId on the record so dialogue list --path walks the boundary.
  try {
    await upsertUniqueEdges(client, [
      { from: input.fromTurnId, to: result.turn.id, relation: "next_section" },
    ]);
    const seedWithParent: DialogueTurnRecord = { ...result.turn, parentTurnId: input.fromTurnId };
    const seedSession = await loadSession(client, result.session.id);
    if (seedSession) {
      await persistTurn(client, seedWithParent, seedSession, {
        linkParent: false,
        jumped: false,
        relatedNodeIds: seedWithParent.relatedNodeIds,
      });
    }
  } catch {
    // spine edges are additive
  }

  // Fork provenance on the session hub: read-modify-write the hub record.
  try {
    const hub = await loadSession(client, result.session.id);
    if (hub) {
      const patched: DialogueSessionRecord = {
        ...hub,
        topicTokens: mergeTopicTokens(hub.topicTokens, sourceTurn.userQuery),
      };
      await persistSession(client, patched);
      await upsertUniqueEdges(client, [
        { from: result.session.id, to: sourceTurn.sessionId, relation: "same_topic" },
      ]);
    }
  } catch {
    // provenance edges are additive
  }

  return {
    forkedSessionId: result.session.id,
    forkedSessionName,
    sourceTurnId: input.fromTurnId,
    copiedTurns: 1,
  };
}

/** Agent-trace node: one orchestrator step of a multi-agent turn (W3a). */
export interface AgentTraceRecord {
  id: string;
  sessionId: string;
  turnSeq: number;
  /** Sub-agent kind: "subagent" | "tool" | "interrupt". */
  agentKind: string;
  /** Short label: subagent description or tool name. */
  label: string;
  /** Outcome: "start" | "settled" | "failed" | "interrupted". */
  status: string;
  createdAt: number;
}

export const AGENT_TRACE_PREFIX = "agent-trace:";
export const AGENT_TRACE_KIND = "agent-trace";
const AGENT_TRACE_MAX_PER_TURN = 24;

export function isAgentTraceNode(node: GraphNode): boolean {
  return node.metadata?.kind === AGENT_TRACE_KIND || node.id.startsWith(AGENT_TRACE_PREFIX);
}

/**
 * Record one multi-agent trajectory event as a Decision node linked to the
 * session hub (part_of) and its turn spine anchor (co_occurs): dsh glue
 * listens to subagent/tool events and writes these so the conversation
 * graph carries WHO did WHAT within a turn, not just Q/A.
 * Pure single write; never throws into the caller.
 */
export async function recordAgentTrace(
  client: GraphClient,
  input: {
    sessionId: string;
    turnSeq: number;
    agentKind: string;
    label: string;
    status: string;
    now?: number;
  }
): Promise<AgentTraceRecord | undefined> {
  try {
    const now = input.now ?? Date.now();
    const sessionHash = input.sessionId.startsWith(DIALOGUE_SESSION_PREFIX)
      ? input.sessionId.slice(DIALOGUE_SESSION_PREFIX.length)
      : hashText(input.sessionId);
    // Dedupe key: kind+label+status+turn; seq suffix keeps distinct repeats.
    const dedupe = hashText(`${input.agentKind}|${input.label}|${input.status}|${input.turnSeq}`);
    const id = `${AGENT_TRACE_PREFIX}${sessionHash}:${String(input.turnSeq).padStart(4, "0")}:${dedupe.slice(0, 12)}`;

    const record: AgentTraceRecord = {
      id,
      sessionId: input.sessionId,
      turnSeq: input.turnSeq,
      agentKind: input.agentKind,
      label: clip(input.label, 120),
      status: input.status,
      createdAt: now,
    };
    const node: GraphNode = {
      id,
      type: "Decision",
      content: `agent-trace turn#${input.turnSeq} ${input.agentKind}:${input.status} ${record.label}`,
      metadata: {
        kind: AGENT_TRACE_KIND,
        record: JSON.stringify(record),
        agentKind: input.agentKind,
        status: input.status,
      },
    };
    await client.upsertNodes([node]);
    await upsertUniqueEdges(client, [
      { from: id, to: input.sessionId, relation: "part_of" },
    ]);
    return record;
  } catch {
    return undefined;
  }
}

/** List agent-trace records (optionally per session / turn), newest first. */
export async function listAgentTraces(
  client: GraphClient,
  options?: { sessionId?: string; turnSeq?: number; limit?: number }
): Promise<AgentTraceRecord[]> {
  const snapshot = client.readSnapshot?.();
  let nodes: GraphNode[];
  if (snapshot) {
    nodes = snapshot.nodes.filter((node) => isAgentTraceNode(node));
  } else {
    const byId = new Map<string, GraphNode>();
    for (const node of await client.queryByKeyword(AGENT_TRACE_PREFIX)) {
      if (isAgentTraceNode(node)) byId.set(node.id, node);
    }
    nodes = Array.from(byId.values());
  }
  const records: AgentTraceRecord[] = [];
  for (const node of nodes) {
    try {
      const parsed = JSON.parse(
        typeof node.metadata?.record === "string" ? node.metadata.record : "{}"
      ) as Partial<AgentTraceRecord>;
      if (typeof parsed.id !== "string" || typeof parsed.label !== "string") continue;
      records.push({
        id: parsed.id,
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
        turnSeq: typeof parsed.turnSeq === "number" ? parsed.turnSeq : 0,
        agentKind: typeof parsed.agentKind === "string" ? parsed.agentKind : "",
        label: parsed.label,
        status: typeof parsed.status === "string" ? parsed.status : "",
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      });
    } catch {
      // skip malformed trace payloads
    }
  }
  records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  let filtered = records;
  if (options?.sessionId) filtered = filtered.filter((r) => r.sessionId === options.sessionId);
  if (options?.turnSeq !== undefined) filtered = filtered.filter((r) => r.turnSeq === options.turnSeq);
  return filtered.slice(0, Math.min(options?.limit ?? AGENT_TRACE_MAX_PER_TURN * 4, 200));
}
