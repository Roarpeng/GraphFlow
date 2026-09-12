/**
 * GF-4 fused action descriptors (Action Fusion analog).
 *
 * Derives an ordered set of fused steps from plan nodes: an "edit"/"write"
 * step immediately followed by a "run"/"test"/"build"/"validate" step is
 * grouped into a single fusion unit (one edit step carrying the follow-up
 * command). Pure and deterministic: no I/O, no Date, no process, no
 * randomness — same input always yields the same steps with stable ids.
 */

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
  { action: "edit", pattern: /\b(edit|write|modify|update|create|implement|add|change|refactor|fix|patch)/i },
  { action: "run", pattern: /\b(run|test|build|execute|compile)/i },
  { action: "validate", pattern: /\b(validate|verify|check|lint|assert)/i },
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
  const nodes = input.planNodes ?? [];
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
