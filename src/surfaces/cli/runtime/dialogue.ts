import { resolveConfig } from "../../../config/resolve";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import { createGraphClient } from "../../../graph/client-factory";
import {
  applyTurnDistillation,
  dialogueSessionIdFor,
  listDialogueTurns,
  recordDialogueTurn,
  type DialogueTurnRecord,
} from "../../../learning/dialogue-thread";
import { deriveTurnSummary, deriveTurnTitle } from "../../../learning/turn-distillation";
import { readCliFlagValue } from "../output";

export interface DialogueListItem {
  id: string;
  sessionId: string;
  seq: number;
  userQuery: string;
  assistantReply: string;
  jumped: boolean;
  parentTurnId?: string;
  updatedAt: number;
  title?: string;
  summary?: string;
}

export interface DistillDialogueResult {
  updated: number;
  unchanged: number;
  total: number;
}

export interface DialogueRecordInput {
  query?: string;
  reply?: string;
  sessionId?: string;
  resumeFrom?: string;
}

/**
 * Resolve `dialogue record` CLI arguments into a structured input.
 *
 * Precedence:
 * - `--query <text>` wins as the query; otherwise the reply-only mode
 *   (`--reply` alone) records no query, and only when NO dialogue flag at all
 *   is present do bare positional tokens form the query (the
 *   `graphflow dialogue record "<question>"` shorthand).
 * - Flag values (e.g. `--reply`'s text) are never picked up as bare query
 *   tokens — a regression that made reply-only filling create a new turn with
 *   the reply text as its query.
 */
export function resolveDialogueRecordInput(args: string[]): DialogueRecordInput {
  let tokens = args;
  if (tokens[0] === "dialogue") tokens = tokens.slice(1);
  if (tokens[0] === "record") tokens = tokens.slice(1);
  const query = readCliFlagValue(tokens, "--query");
  const reply = readCliFlagValue(tokens, "--reply");
  const sessionId = readCliFlagValue(tokens, "--session");
  const resumeFrom = readCliFlagValue(tokens, "--resume-from");
  const anyFlag = Boolean(query || reply || sessionId || resumeFrom);
  const bareQuery = anyFlag
    ? undefined
    : tokens.filter((part) => !part.startsWith("--")).join(" ").trim();
  return {
    ...(query !== undefined && query !== "" ? { query } : {}),
    ...(bareQuery ? { query: bareQuery } : {}),
    ...(reply ? { reply } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

export async function listDialogueTurnsRuntime(
  configPath?: string,
  options?: { sessionId?: string; limit?: number; rootDir?: string }
): Promise<DialogueListItem[]> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const client = createGraphClient(config);
  const sessionId = resolveSessionId(options?.sessionId, config.graphPolicy.workspaceRoot);
  const turns = await listDialogueTurns(client, {
    ...(sessionId ? { sessionId } : {}),
    ...(options?.limit !== undefined ? { limit: options.limit } : { limit: 20 }),
  });
  return turns.map(toListItem);
}

export async function recordDialogueTurnRuntime(
  userQuery: string,
  options?: {
    configPath?: string;
    rootDir?: string;
    assistantReply?: string;
    sessionId?: string;
    resumeFromTurnId?: string;
  }
): Promise<DialogueListItem | undefined> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(options?.configPath),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const client = createGraphClient(config);
  const result = await recordDialogueTurn(client, {
    userQuery,
    ...(config.graphPolicy.workspaceRoot ? { workspaceRoot: config.graphPolicy.workspaceRoot } : {}),
    ...(options?.assistantReply ? { assistantReply: options.assistantReply } : {}),
    ...(options?.sessionId ? { sessionName: options.sessionId } : {}),
    ...(options?.resumeFromTurnId ? { resumeFromTurnId: options.resumeFromTurnId } : {}),
  });
  return result.turn ? toListItem(result.turn) : undefined;
}

/**
 * Backfill distilled title/summary for turns that are still missing them.
 * Defaults to the "main" session; pass `all: true` to sweep every turn in the
 * workspace. Existing values are never overwritten.
 */
export async function distillDialogueTurnsRuntime(
  configPath?: string,
  options?: { sessionId?: string; rootDir?: string; all?: boolean }
): Promise<DistillDialogueResult> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const client = createGraphClient(config);
  const sessionId = options?.all
    ? undefined
    : resolveSessionId(options?.sessionId ?? "main", config.graphPolicy.workspaceRoot);
  const turns = await listDialogueTurns(client, {
    ...(sessionId ? { sessionId } : {}),
  });

  let updated = 0;
  let unchanged = 0;
  for (const turn of turns) {
    const title = turn.title?.trim() ? undefined : deriveTurnTitle(turn.userQuery);
    const summary = turn.summary?.trim()
      ? undefined
      : turn.assistantReply.trim()
        ? deriveTurnSummary(turn.assistantReply)
        : undefined;
    if (!title && !summary) {
      unchanged += 1;
      continue;
    }
    const result = await applyTurnDistillation(client, turn.id, {
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
    });
    if (result) updated += 1;
    else unchanged += 1;
  }
  return { updated, unchanged, total: turns.length };
}

function resolveSessionId(raw: string | undefined, workspaceRoot?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  if (raw.startsWith("dialogue-session:")) return raw;
  return dialogueSessionIdFor(raw, workspaceRoot);
}

function toListItem(turn: DialogueTurnRecord): DialogueListItem {
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    seq: turn.seq,
    userQuery: turn.userQuery,
    assistantReply: turn.assistantReply,
    jumped: turn.jumped,
    ...(turn.parentTurnId ? { parentTurnId: turn.parentTurnId } : {}),
    updatedAt: turn.updatedAt,
    ...(turn.title ? { title: turn.title } : {}),
    ...(turn.summary ? { summary: turn.summary } : {}),
  };
}
