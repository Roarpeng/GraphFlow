import type { GraphNode } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import type { TaskComplexity, TriageReason } from "../core/triage";
import { hashText } from "../utils/hash";

/**
 * Triage 准确率数据收集模块。
 *
 * 在 triage 决策后记录一个 learning event（Decision 节点），
 * 在任务完成后回填实际结果（实际步数、是否触发 drift replan、最终状态等），
 * 从而积累 triage 决策 vs 实际结果的数据，供未来优化 triage 启发式。
 *
 * 所有操作均不抛异常：失败时静默降级，绝不阻断编排主流程。
 */

const TRIAGE_PREFIX = "triage:";
const TRIAGE_SENTINEL = "triage";

/** triage 决策事件（记录阶段） */
export interface TriageDecisionEvent {
  id: string;
  task: string;
  decision: TaskComplexity;
  reason: TriageReason;
  status: "pending" | "resolved";
  timestamp: number;
  /** 任务完成后回填的实际结果 */
  outcome?: TriageOutcome;
}

/** triage 决策的实际结果（回填阶段） */
export interface TriageOutcome {
  /** 根据实际计划步数推断的复杂度 */
  actualMode: TaskComplexity;
  /** 实际执行/计划步数 */
  actualSteps: number;
  /** 是否触发了 drift replan */
  driftReplan: boolean;
  /** drift replan 轮数 */
  replanRounds: number;
  /** 最终任务状态 */
  finalStatus: string;
  /** 回填时间戳 */
  resolvedAt: number;
}

let triageCounter = 0;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

/**
 * 记录 triage 决策事件到图中（Decision 节点）。
 * 返回 triageId，供后续 backfillTriageOutcome 回填实际结果。
 * 失败时返回 undefined，不抛异常。
 */
export async function recordTriageDecision(
  client: GraphClient,
  task: string,
  decision: TaskComplexity,
  reason: TriageReason
): Promise<string | undefined> {
  const now = Date.now();
  triageCounter += 1;
  const id = `${TRIAGE_PREFIX}${hashText(`${task}|${now}|${triageCounter}`)}`;
  const event: TriageDecisionEvent = {
    id,
    task,
    decision,
    reason,
    status: "pending",
    timestamp: now,
  };
  const node: GraphNode = {
    id,
    type: "Decision",
    content: `${TRIAGE_SENTINEL} ${decision} ${truncate(task, 140)}`,
    metadata: { record: JSON.stringify(event), kind: TRIAGE_SENTINEL },
  };
  try {
    await client.upsertNodes([node]);
    return id;
  } catch {
    return undefined;
  }
}

/**
 * 回填 triage 决策的实际结果（任务完成后调用）。
 * 读取 triage 节点并写入 outcome 字段。不抛异常。
 */
export async function backfillTriageOutcome(
  client: GraphClient,
  triageId: string,
  outcome: TriageOutcome
): Promise<void> {
  if (!client.getNodesByIds) {
    return;
  }
  try {
    const nodes = await client.getNodesByIds([triageId]);
    const node = nodes.find((n) => n.id === triageId);
    if (!node) return;
    const raw =
      typeof node.metadata?.record === "string"
        ? (node.metadata.record as string)
        : undefined;
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<TriageDecisionEvent>;
    const updated: TriageDecisionEvent = {
      ...(parsed as TriageDecisionEvent),
      status: "resolved",
      outcome,
    };
    const updatedNode: GraphNode = {
      ...node,
      metadata: { ...node.metadata, record: JSON.stringify(updated) },
    };
    await client.upsertNodes([updatedNode]);
  } catch {
    // 回填失败不影响主流程
  }
}

/** 解析 triage 节点为决策事件（供查询/分析使用） */
export function parseTriageEvent(node: GraphNode): TriageDecisionEvent | undefined {
  if (!node.id.startsWith(TRIAGE_PREFIX)) return undefined;
  const raw =
    typeof node.metadata?.record === "string" ? (node.metadata.record as string) : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<TriageDecisionEvent>;
    if (!parsed.id || !parsed.task || !parsed.decision) return undefined;
    return {
      id: parsed.id,
      task: parsed.task,
      decision: parsed.decision,
      reason: parsed.reason ?? { matchedKeywords: [], taskLength: 0, triggeredBy: "default" },
      status: parsed.status === "resolved" ? "resolved" : "pending",
      timestamp: parsed.timestamp ?? 0,
      ...(parsed.outcome ? { outcome: parsed.outcome } : {}),
    };
  } catch {
    return undefined;
  }
}
