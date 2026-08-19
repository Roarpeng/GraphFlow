import { resolveConfig } from "../../../config/resolve";
import { bindRuntimeWorkspaceRoot } from "../../../config/workspace-root";
import { createGraphClient } from "../../../graph/client-factory";
import {
  dialogueSessionIdFor,
  listDialogueTurns,
  recordDialogueTurn,
  type DialogueTurnRecord,
} from "../../../learning/dialogue-thread";

export interface DialogueListItem {
  id: string;
  sessionId: string;
  seq: number;
  userQuery: string;
  assistantReply: string;
  jumped: boolean;
  parentTurnId?: string;
  updatedAt: number;
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
  };
}
