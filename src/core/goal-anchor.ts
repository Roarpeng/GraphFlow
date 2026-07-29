import type { GraphNode } from "./types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";

/**
 * Goal anchors: turn the intent-analysis five-tuple (explicitIntent /
 * implicitIntent / coreProblem / nonGoals / successDefinition) into a
 * first-class graph node so the ORIGINAL REQUIREMENT stays visible for the
 * whole task lifecycle — not just as a transient string inside a merged plan.
 *
 * Layout (same pattern as episodes / agent-insights):
 *   - active node:  id = goal:<hash(task)>, type "Decision", metadata.kind "goal"
 *   - history:      id = goal:<hash(task)>:v<n>, status "superseded",
 *                   written when the requirement materially changes (P4 versioning)
 */

export const GOAL_NODE_PREFIX = "goal:";
export const GOAL_METADATA_KIND = "goal";

/** Work items whose JSON payload carries the intent five-tuple. */
export const INTENT_GOAL_WORK_ITEM_IDS = ["intent-analysis", "simple-plan-intent"] as const;

/** Below this intent confidence the merge refuses to finalize a plan (P3). */
export const CLARIFICATION_CONFIDENCE_THRESHOLD = 0.6;

export interface GoalAnchorFields {
  explicitIntent: string;
  implicitIntent: string;
  coreProblem: string;
  nonGoals: string[];
  successDefinition: string;
}

export interface GoalAnchorRecord extends GoalAnchorFields {
  task: string;
  version: number;
  confidence?: number;
  status: "active" | "superseded";
  supersededBy?: string;
  /** Fields that changed vs the previous version (set on the NEW version). */
  changedFields?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GoalUpsertResult {
  goalId: string;
  record: GoalAnchorRecord;
  /** True when a new version was created (requirement materially changed). */
  versioned: boolean;
  /** Field names that changed vs the previous version. */
  changedFields: string[];
  /** Pending episodes for this task marked stale because the goal moved. */
  staleEpisodes: number;
}

const GOAL_FIELD_NAMES = [
  "explicitIntent",
  "implicitIntent",
  "coreProblem",
  "nonGoals",
  "successDefinition",
] as const;

function normalizeTask(task: string): string {
  return task.trim().toLowerCase();
}

export function goalNodeIdForTask(task: string): string {
  return `${GOAL_NODE_PREFIX}${hashText(normalizeTask(task))}`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

/**
 * Extract the intent five-tuple from a submitted intent payload.
 * Returns null when the payload carries neither a coreProblem nor a
 * successDefinition — such a payload is not a usable goal anchor.
 */
export function extractGoalFromIntentPayload(
  parsed: Record<string, unknown>
): GoalAnchorFields | null {
  const coreProblem = asString(parsed.coreProblem);
  const successDefinition = asString(parsed.successDefinition);
  if (!coreProblem && !successDefinition) {
    return null;
  }
  return {
    explicitIntent: asString(parsed.explicitIntent),
    implicitIntent: asString(parsed.implicitIntent),
    coreProblem,
    nonGoals: asStringArray(parsed.nonGoals),
    successDefinition,
  };
}

function fieldsEqual(a: GoalAnchorFields, b: GoalAnchorFields): string[] {
  const changed: string[] = [];
  for (const name of GOAL_FIELD_NAMES) {
    const av = name === "nonGoals" ? a.nonGoals.join("\n") : a[name];
    const bv = name === "nonGoals" ? b.nonGoals.join("\n") : b[name];
    if (av !== bv) {
      changed.push(name);
    }
  }
  return changed;
}

function parseGoalNode(node: GraphNode): GoalAnchorRecord | undefined {
  const raw =
    typeof node.metadata?.record === "string" ? (node.metadata.record as string) : undefined;
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GoalAnchorRecord>;
    if (!parsed.task || typeof parsed.version !== "number") {
      return undefined;
    }
    return {
      task: parsed.task,
      explicitIntent: typeof parsed.explicitIntent === "string" ? parsed.explicitIntent : "",
      implicitIntent: typeof parsed.implicitIntent === "string" ? parsed.implicitIntent : "",
      coreProblem: typeof parsed.coreProblem === "string" ? parsed.coreProblem : "",
      nonGoals: Array.isArray(parsed.nonGoals)
        ? parsed.nonGoals.filter((x): x is string => typeof x === "string")
        : [],
      successDefinition:
        typeof parsed.successDefinition === "string" ? parsed.successDefinition : "",
      version: parsed.version,
      ...(typeof parsed.confidence === "number" ? { confidence: parsed.confidence } : {}),
      status: parsed.status === "superseded" ? "superseded" : "active",
      ...(typeof parsed.supersededBy === "string" ? { supersededBy: parsed.supersededBy } : {}),
      ...(Array.isArray(parsed.changedFields)
        ? { changedFields: parsed.changedFields.filter((x): x is string => typeof x === "string") }
        : {}),
      createdAt: parsed.createdAt ?? 0,
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return undefined;
  }
}

function serializeGoal(record: GoalAnchorRecord): string {
  return JSON.stringify(record);
}

function buildGoalNode(id: string, record: GoalAnchorRecord): GraphNode {
  const truncated =
    record.coreProblem.length > 140 ? `${record.coreProblem.slice(0, 137)}...` : record.coreProblem;
  return {
    id,
    type: "Decision",
    content: `goal v${record.version}: ${truncated}`,
    metadata: {
      kind: GOAL_METADATA_KIND,
      task: record.task,
      version: record.version,
      status: record.status,
      record: serializeGoal(record),
    },
  };
}

/**
 * Mark still-pending episodes for this task as stale-goal: the requirement
 * moved under them, so their plan context should not be trusted as-is.
 */
async function markStalePendingEpisodes(
  client: GraphClient,
  task: string,
  newGoalId: string
): Promise<number> {
  const nodes = await client.queryByKeyword("episode");
  const normalized = normalizeTask(task);
  const stale: GraphNode[] = [];
  for (const node of nodes) {
    if (!node.id.startsWith("episode:")) continue;
    if (node.metadata?.pruned === true) continue;
    const raw =
      typeof node.metadata?.record === "string" ? (node.metadata.record as string) : undefined;
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw) as { task?: string; outcome?: string };
      if (rec.outcome === "pending" && typeof rec.task === "string" && normalizeTask(rec.task) === normalized) {
        stale.push({
          ...node,
          metadata: { ...node.metadata, staleGoal: newGoalId },
        });
      }
    } catch {
      // ignore malformed episode record
    }
  }
  if (stale.length > 0) {
    await client.upsertNodes(stale);
  }
  return stale.length;
}

/**
 * Create or version the goal anchor for a task from an intent payload.
 *
 * Versioning rule (P4): when the five-tuple materially changes, the old record
 * is snapshotted to goal:<hash>:v<oldVersion> (status "superseded") and the
 * active node moves to the next version with a changedFields diff. Pending
 * episodes for the same task are flagged staleGoal.
 */
export async function upsertGoalAnchor(
  client: GraphClient,
  task: string,
  fields: GoalAnchorFields,
  confidence?: number
): Promise<GoalUpsertResult> {
  const goalId = goalNodeIdForTask(task);
  const now = Date.now();
  const existingNodes = client.getNodesByIds ? await client.getNodesByIds([goalId]) : [];
  const existingNode = existingNodes.find((node) => node.id === goalId);
  const existing = existingNode ? parseGoalNode(existingNode) : undefined;

  if (!existing) {
    const record: GoalAnchorRecord = {
      task,
      ...fields,
      version: 1,
      ...(confidence !== undefined ? { confidence } : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await client.upsertNodes([buildGoalNode(goalId, record)]);
    return { goalId, record, versioned: false, changedFields: [], staleEpisodes: 0 };
  }

  const changedFields = fieldsEqual(existing, fields);
  if (changedFields.length === 0) {
    // Same requirement — just refresh the timestamp / confidence.
    const record: GoalAnchorRecord = {
      ...existing,
      ...(confidence !== undefined ? { confidence } : {}),
      updatedAt: now,
    };
    await client.upsertNodes([buildGoalNode(goalId, record)]);
    return { goalId, record, versioned: false, changedFields: [], staleEpisodes: 0 };
  }

  // Requirement moved: snapshot the old version, advance the active node.
  const snapshotId = `${goalId}:v${existing.version}`;
  const snapshot: GoalAnchorRecord = {
    ...existing,
    status: "superseded",
    supersededBy: goalId,
  };
  const record: GoalAnchorRecord = {
    task,
    ...fields,
    version: existing.version + 1,
    ...(confidence !== undefined ? { confidence } : {}),
    status: "active",
    changedFields,
    createdAt: now,
    updatedAt: now,
  };
  await client.upsertNodes([buildGoalNode(snapshotId, snapshot), buildGoalNode(goalId, record)]);
  const staleEpisodes = await markStalePendingEpisodes(client, task, goalId);
  return { goalId, record, versioned: true, changedFields, staleEpisodes };
}

/** Load the ACTIVE goal anchor for a task (exact normalized-task match). */
export async function getActiveGoalAnchor(
  client: GraphClient,
  task: string
): Promise<GoalAnchorRecord | undefined> {
  if (!client.getNodesByIds) {
    return undefined;
  }
  const goalId = goalNodeIdForTask(task);
  const nodes = await client.getNodesByIds([goalId]);
  const node = nodes.find((n) => n.id === goalId);
  if (!node || node.metadata?.kind !== GOAL_METADATA_KIND) {
    return undefined;
  }
  const record = parseGoalNode(node);
  return record && record.status === "active" ? record : undefined;
}

/**
 * One-line goal anchor for prompt injection — kept deliberately compact so it
 * can ride along on EVERY packaged context without blowing the token budget.
 */
export function formatGoalAnchorForPrompt(record: GoalAnchorRecord): string {
  const nonGoals = record.nonGoals.length > 0 ? record.nonGoals.join("; ") : "none";
  const line =
    `GOAL(v${record.version}): ${record.coreProblem || record.explicitIntent}` +
    ` | DONE WHEN: ${record.successDefinition || "unspecified"}` +
    ` | DO NOT: ${nonGoals}`;
  return line.length > 260 ? `${line.slice(0, 257)}...` : line;
}
