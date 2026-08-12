/**
 * Minimal ATP/IR producer helpers for third-party–compatible simple-plan work items.
 * Pure builders (no network / no GraphFlow LLM). See examples/atp-minimal-producer/.
 */

import {
  SIMPLE_PLAN_BRIDGE_REQUIRED_IDS,
  type AgentWorkItem,
} from "../core/agent-delegation.js";

export { SIMPLE_PLAN_BRIDGE_REQUIRED_IDS };

const INTENT_SCHEMA = {
  explicitIntent: "string",
  implicitIntent: "string",
  coreProblem: "string",
  nonGoals: "string[]",
  successDefinition: "string",
  confidence: "number 0.0-1.0",
} as const;

const DECOMPOSITION_SCHEMA = {
  items: {
    id: "string",
    description: "string",
    dependencies: "string[]",
    skillRefs: "string[]?",
    avoidPatterns: "string[]?",
  },
} as const;

const ALIGNMENT_SCHEMA = {
  aligned: "boolean",
  servedSuccessCriteria: "string[]",
  violatedNonGoals: "string[]",
  drift: "none|misread-requirement|scope-creep|tech-drift",
  correction: "string",
} as const;

/**
 * Build the documented simple-plan bridge work-item set (intent + decomposition
 * required; optional alignment-check). Stable machine IDs match docs/atp-ir-spec-v1.md §4.2.
 */
export function buildMinimalSimplePlanWorkItems(task: string): AgentWorkItem[] {
  const trimmed = task.trim() || "(untitled task)";
  return [
    {
      id: "simple-plan-intent",
      kind: "intent",
      prompt: [
        `Task: ${trimmed}`,
        "",
        "Before splitting into subtasks, understand the task as ONE intent.",
        "Do NOT treat colon-list evaluation dimensions as separate work items.",
        "Return ONLY a JSON object:",
        "{",
        '  "explicitIntent": "what the user explicitly asked for",',
        '  "implicitIntent": "the underlying need",',
        '  "coreProblem": "the core problem to solve",',
        '  "nonGoals": ["things out of scope"],',
        '  "successDefinition": "how to know the task is done",',
        '  "confidence": "0.0-1.0 — below 0.6 requires clarification"',
        "}",
      ].join("\n"),
      expectedFormat: "json",
      responseSchema: { ...INTENT_SCHEMA },
    },
    {
      id: "simple-plan-decomposition",
      kind: "plan-refinement",
      prompt: [
        `Task: ${trimmed}`,
        "",
        "Produce the FINAL DAG task plan using your model.",
        "Rules:",
        "- Max 8 tasks; each description must be actionable (verb + object)",
        "- Prefer sequential design → implement → verify when the request is one analytical intent",
        "- Optional fields on each node: skillRefs?: string[], avoidPatterns?: string[]",
        "",
        "Return ONLY a JSON array: [{id, description, dependencies, skillRefs?, avoidPatterns?}]",
      ].join("\n"),
      expectedFormat: "json",
      responseSchema: { ...DECOMPOSITION_SCHEMA },
    },
    {
      id: "alignment-check",
      kind: "alignment",
      optional: true,
      prompt: [
        `Task: ${trimmed}`,
        "",
        "[EXECUTION-TIME CHECK — submit after completing work]",
        "Check output against the ORIGINAL goal anchor (successDefinition / nonGoals).",
        "Return ONLY a JSON object:",
        "{",
        '  "aligned": true|false,',
        '  "servedSuccessCriteria": ["..."],',
        '  "violatedNonGoals": [],',
        '  "drift": "none|misread-requirement|scope-creep|tech-drift",',
        '  "correction": ""',
        "}",
      ].join("\n"),
      expectedFormat: "json",
      responseSchema: { ...ALIGNMENT_SCHEMA },
    },
  ];
}

/** Required simple-plan IDs only (no optional alignment-check). */
export function buildRequiredSimplePlanWorkItems(task: string): AgentWorkItem[] {
  return buildMinimalSimplePlanWorkItems(task).filter(
    (item) =>
      (SIMPLE_PLAN_BRIDGE_REQUIRED_IDS as readonly string[]).includes(item.id)
  );
}
