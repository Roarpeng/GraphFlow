/**
 * GF-4 fused action descriptors (Action Fusion analog).
 *
 * Derives an ordered set of fused steps from plan nodes: an "edit"/"write"
 * step immediately followed by a "run"/"test"/"build"/"validate" step is
 * grouped into a single fusion unit (one edit step carrying the follow-up
 * command). Pure and deterministic: no I/O, no Date, no process, no
 * randomness — same input always yields the same steps with stable ids.
 */

import { splitTaskClauses } from "../agents/task-clauses.js";

/**
 * Clause split for the task-text fallback only. Broader than
 * splitTaskClauses (includes bare 并/且/，) because here a wrong split costs
 * nothing — the fragments only feed step classification, never the planner.
 */
const TASK_FALLBACK_SPLIT = /;|；|。|然后|接着|随后|最后|并且|以及|同时|\band\b|并|且|，/i;

export interface PlanNodeLike {
  id: string;
  description: string;
  dependencies?: string[];
}

export interface FusedStep {
  id: string;
  action: "edit" | "run" | "validate";
  target?: string;
  command?: string;
  dependsOn?: string[];
}

type FusedAction = FusedStep["action"];

/**
 * Keyword classes, checked in this order on ties; the earliest match position
 * in the description wins so classification follows the node's stated intent
 * ("validate the build" → validate, "build then validate" → run). Leading word
 * boundary only, so common inflections (edits, testing, building) still match.
 */
const ACTION_KEYWORDS: ReadonlyArray<{ action: FusedAction; pattern: RegExp }> = [
  // English verbs keep \b (avoid substring hits); CJK verbs match as plain
  // substrings — \b does not apply to hanzi. Without the CJK rows a Chinese
  // task's plan nodes classify to nothing and the descriptor never carries
  // fused steps, which left GF-4 dark for the project's primary language.
  { action: "edit", pattern: /\b(edit|write|modify|update|create|implement|add|change|refactor|fix|patch)|修改|编写|新增|实现|添加|更改|变更|重构|修复|写入|补丁/i },
  { action: "run", pattern: /\b(run|test|build|execute|compile)|运行|执行|构建|编译|跑一?次/i },
  { action: "validate", pattern: /\b(validate|verify|check|lint|assert)|验证|校验|检查|核对|确认|断言/i },
];

function classifyDescription(description: string): FusedAction | undefined {
  let best: { action: FusedAction; index: number } | undefined;
  for (const { action, pattern } of ACTION_KEYWORDS) {
    const index = description.search(pattern);
    if (index < 0) continue;
    if (!best || index < best.index) {
      best = { action, index };
    }
  }
  return best?.action;
}

function toStandaloneStep(id: string, action: FusedAction, text: string): FusedStep {
  if (action === "edit") {
    return { id, action, target: text };
  }
  return { id, action, command: text };
}

function contentKey(step: FusedStep): string {
  return `${step.action}|${step.target ?? ""}|${step.command ?? ""}`;
}

interface Draft {
  /** Plan node ids consumed by this step (1 standalone, 2 when fused). */
  nodeIds: string[];
  /** Union of the source nodes' dependency ids, first-seen order. */
  depNodeIds: string[];
  step: FusedStep;
}

/**
 * Derive ordered fused steps from plan nodes. Nodes are processed in input
 * order; unclassifiable nodes are skipped; identical steps (same action,
 * target, command) are deduplicated keeping the first occurrence.
 */
export function buildFusedSteps(input: { task: string; planNodes?: PlanNodeLike[] }): FusedStep[] {
  let nodes: PlanNodeLike[] = input.planNodes ?? [];
  if (nodes.length === 0 && input.task.trim()) {
    // Fallback for plan-less bridges (simple bridge tasks carry no plan
    // nodes): split the TASK TEXT itself into clauses — "修改 X 并验证" is
    // already an edit+validate pair waiting to be fused.
    const clauses = splitTaskClauses(input.task).flatMap((clause) => clause.split(TASK_FALLBACK_SPLIT));
    nodes = clauses
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0)
      .map((clause, index) => ({
        id: `task-${index + 1}`,
        description: clause,
        dependencies: index > 0 ? [`task-${index}`] : [],
      }));
  }
  const consumed = new Set<number>();
  const drafts: Draft[] = [];

  for (const [index, node] of nodes.entries()) {
    if (consumed.has(index)) continue;
    const action = classifyDescription(node.description);
    if (!action) continue;
    const text = node.description.trim();
    const depNodeIds = [...(node.dependencies ?? [])];

    const next = nodes[index + 1];
    const follow = next && !consumed.has(index + 1) ? classifyDescription(next.description) : undefined;
    if (action === "edit" && next && (follow === "run" || follow === "validate")) {
      for (const dep of next.dependencies ?? []) {
        if (!depNodeIds.includes(dep)) depNodeIds.push(dep);
      }
      drafts.push({
        nodeIds: [node.id, next.id],
        depNodeIds,
        step: { id: `step:${node.id}+${next.id}`, action: "edit", target: text, command: next.description.trim() },
      });
      consumed.add(index + 1);
      continue;
    }

    drafts.push({
      nodeIds: [node.id],
      depNodeIds,
      step: toStandaloneStep(`step:${node.id}`, action, text),
    });
  }

  // Deduplicate identical steps; map every consumed node id to the kept step id
  // so dependencies on a dropped duplicate still resolve to the emitted unit.
  const keptIdByContent = new Map<string, string>();
  const emittedStepIdByNodeId = new Map<string, string>();
  const kept: Draft[] = [];
  for (const draft of drafts) {
    const key = contentKey(draft.step);
    const keptId = keptIdByContent.get(key) ?? draft.step.id;
    if (!keptIdByContent.has(key)) {
      keptIdByContent.set(key, draft.step.id);
      kept.push(draft);
    }
    for (const nodeId of draft.nodeIds) {
      if (!emittedStepIdByNodeId.has(nodeId)) {
        emittedStepIdByNodeId.set(nodeId, keptId);
      }
    }
  }

  return kept.map((draft) => {
    const dependsOn: string[] = [];
    for (const depId of draft.depNodeIds) {
      const stepId = emittedStepIdByNodeId.get(depId);
      if (stepId !== undefined && stepId !== draft.step.id && !dependsOn.includes(stepId)) {
        dependsOn.push(stepId);
      }
    }
    if (dependsOn.length === 0) {
      return draft.step;
    }
    return { ...draft.step, dependsOn };
  });
}

/**
 * Attach fused steps to an execution descriptor. Pure: returns a new object
 * (with defensive copies of the steps) and never mutates either input.
 * `fused` is true when at least one step was derived.
 */
export function enrichExecutionDescriptor<T extends Record<string, unknown>>(
  descriptor: T,
  steps: FusedStep[],
): T & { steps: FusedStep[]; fused: boolean } {
  return {
    ...descriptor,
    steps: steps.map((step) => ({
      ...step,
      ...(step.dependsOn ? { dependsOn: [...step.dependsOn] } : {}),
    })),
    fused: steps.length > 0,
  };
}
