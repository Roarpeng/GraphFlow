import { resolveConfig } from "../../../config/resolve";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import { hasUsableLlmProvider } from "../../../config/llm-availability";
import { createGraphClient } from "../../../graph/client-factory";
import {
  applyTurnDistillation,
  dialogueSessionIdFor,
  forkDialogueSession,
  listAgentTraces,
  listDialogueTurns,
  recordAgentTrace,
  recordDialogueTurn,
  walkDialoguePath,
  type AgentTraceRecord,
  type DialoguePathStep,
  type DialogueTurnRecord,
} from "../../../learning/dialogue-thread";
import { deriveTurnSummary, deriveTurnTitle, distillTurnWithLlm } from "../../../learning/turn-distillation";
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
    resolveConfig(configPath, options?.rootDir ? { rootDir: options.rootDir } : undefined),
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
    resolveConfig(options?.configPath, options?.rootDir ? { rootDir: options.rootDir } : undefined),
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
 *
 * Conversation Graph W1b: with `useLlm: true` (and a usable provider), each
 * missing distillation runs the optional LLM path via `distillTurnWithLlm`;
 * missing/failed generation transparently falls back per turn to the
 * deterministic heuristic — the sweep never fails because the model did.
 */
export async function distillDialogueTurnsRuntime(
  configPath?: string,
  options?: { sessionId?: string; rootDir?: string; all?: boolean; useLlm?: boolean }
): Promise<DistillDialogueResult> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath, options?.rootDir ? { rootDir: options.rootDir } : undefined),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const client = createGraphClient(config);
  const sessionId = options?.all
    ? undefined
    : resolveSessionId(options?.sessionId ?? "main", config.graphPolicy.workspaceRoot);
  const turns = await listDialogueTurns(client, {
    ...(sessionId ? { sessionId } : {}),
  });

  const wantLlm = options?.useLlm === true && hasUsableLlmProvider(config);
  let generate: ((prompt: string) => Promise<string>) | undefined;
  if (wantLlm) {
    try {
      const { executeRolePrompt } = await import("../../../routing/provider-executor.js");
      const { resolveModelForRole } = await import("../../../routing/model-router.js");
      const selection = resolveModelForRole("compressor", configPath);
      generate = (prompt: string) => executeRolePrompt("compressor", prompt, selection);
    } catch {
      generate = undefined; // fall back to heuristic wholesale
    }
  }

  let updated = 0;
  let unchanged = 0;
  for (const turn of turns) {
    let title: string | undefined;
    let summary: string | undefined;
    if (generate) {
      // LLM path only for turns actually missing a field; existing values win.
      const missingTitle = !turn.title?.trim();
      const missingSummary = !turn.summary?.trim() && turn.assistantReply.trim().length > 0;
      if (missingTitle || missingSummary) {
        const distilled = await distillTurnWithLlm(turn.userQuery, turn.assistantReply, generate);
        title = missingTitle ? distilled.title : undefined;
        summary = missingSummary ? distilled.summary : undefined;
      }
    } else {
      title = turn.title?.trim() ? undefined : deriveTurnTitle(turn.userQuery);
      summary = turn.summary?.trim()
        ? undefined
        : turn.assistantReply.trim()
          ? deriveTurnSummary(turn.assistantReply)
          : undefined;
    }
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

// ───────────────── Conversation Graph W3: fork, replay path, agent traces ─────────────────

/** Fork a dialogue session from a turn: new session rooted at the fork point. */
export async function forkDialogueSessionRuntime(
  fromTurnId: string,
  options?: { configPath?: string; rootDir?: string; forkName?: string }
): Promise<ForkDialogueListItem | undefined> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(options?.configPath, options?.rootDir ? { rootDir: options.rootDir } : undefined),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const client = createGraphClient(config);
  const result = await forkDialogueSession(client, {
    fromTurnId,
    ...(options?.forkName ? { forkName: options.forkName } : {}),
    ...(config.graphPolicy.workspaceRoot ? { workspaceRoot: config.graphPolicy.workspaceRoot } : {}),
  });
  if (!result) return undefined;
  return {
    forkedSessionId: result.forkedSessionId,
    forkedSessionName: result.forkedSessionName,
    sourceTurnId: result.sourceTurnId,
    copiedTurns: result.copiedTurns,
  };
}

export interface ForkDialogueListItem {
  forkedSessionId: string;
  forkedSessionName: string;
  sourceTurnId: string;
  copiedTurns: number;
}

/** One hop on the replay path (dialogue list --path). */
export type { DialoguePathStep } from "../../../learning/dialogue-thread";

/**
 * Replay path (Conversation Graph W3b): walk the turn spine ending at
 * `endTurnId` — following `parentTurnId` links (which include jump targets
 * and fork boundaries) back to the session's first turn. Returns steps
 * oldest-first. `--path` on `dialogue list` renders exactly this chain so an
 * agent can restore "how did we get here" context.
 */
export async function dialoguePathRuntime(
  endTurnId: string,
  options?: { configPath?: string; rootDir?: string; limit?: number }
): Promise<DialoguePathStep[]> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(options?.configPath, options?.rootDir ? { rootDir: options.rootDir } : undefined),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const client = createGraphClient(config);
  const all = await listDialogueTurns(client, { limit: 500 });
  return walkDialoguePath(all, endTurnId, options?.limit ?? 30);
}

/** Record one multi-agent trajectory event (dsh glue → agent-trace node). */
export async function recordAgentTraceRuntime(
  trace: { sessionId?: string; turnSeq?: number; agentKind: string; label: string; status: string },
  configPath?: string,
  rootDir?: string
): Promise<boolean> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath, rootDir ? { rootDir } : undefined),
    rootDir ? { rootDir } : undefined
  );
  const client = createGraphClient(config);
  const sessionId = trace.sessionId?.trim()
    ? resolveSessionId(trace.sessionId, config.graphPolicy.workspaceRoot)
    : dialogueSessionIdFor("main", config.graphPolicy.workspaceRoot);
  if (!sessionId) return false;
  const record = await recordAgentTrace(client, {
    sessionId,
    turnSeq: typeof trace.turnSeq === "number" ? trace.turnSeq : 0,
    agentKind: trace.agentKind,
    label: trace.label,
    status: trace.status,
  });
  return record !== undefined;
}

/** List agent-trace records (panel data channel). */
export async function listDialogueTracesRuntime(
  configPath?: string,
  options?: { sessionId?: string; limit?: number; rootDir?: string }
): Promise<AgentTraceRecord[]> {
  const config = bindRuntimeWorkspaceRoot(
    resolveConfig(configPath, options?.rootDir ? { rootDir: options.rootDir } : undefined),
    options?.rootDir ? { rootDir: options.rootDir } : undefined
  );
  const client = createGraphClient(config);
  const sessionId = options?.sessionId
    ? resolveSessionId(options.sessionId, config.graphPolicy.workspaceRoot)
    : undefined;
  return listAgentTraces(client, {
    ...(sessionId ? { sessionId } : {}),
    ...(options?.limit !== undefined ? { limit: options.limit } : {}),
  });
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
