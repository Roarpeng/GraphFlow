import { logger } from "../utils/logger";
import type { TaskNode, ValidationResult } from "../core/types";
import type { GraphClient } from "../graph/client-factory";
import { querySymbolGraph } from "../graph/graph-search";
import type { ModelSelection } from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";

// ───────────────────────── Acceptance criteria ─────────────────────────

/**
 * Test-runner commands acceptance suggestions may start with. Anything else
 * (`rm`, `curl`, `sh`…) is rejected as an unsafe runner. "go test" is the one
 * two-word prefix, handled separately in {@link hasSafeTestRunnerPrefix}.
 */
const SAFE_TEST_RUNNER_PREFIXES = ["npm", "npx", "vitest", "jest", "py.test", "pytest"] as const;

/**
 * Shell metacharacters that must never appear in an acceptance command
 * (suggestion strings still get hygiene-checked: no chaining, pipes,
 * redirections or command/variable substitution). Everything else — spaces,
 * dashes, colons, dots, slashes, quotes — is allowed.
 */
const SHELL_METACHAR_PATTERN = /[;&|><$`]/;

function hasSafeTestRunnerPrefix(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  if (first === "go") {
    return (tokens[1] ?? "") === "test";
  }
  return (SAFE_TEST_RUNNER_PREFIXES as readonly string[]).includes(first);
}

export interface AcceptanceValidationResult {
  ok: boolean;
  problems: string[];
}

/**
 * Validate a node's machine-checkable acceptance criterion.
 *
 * - kind "test": command non-empty, starts with a known-safe test-runner
 *   prefix, and contains no shell metacharacters (`; & | > < $ \``) beyond
 *   spaces/dashes/colons. These are suggestions, but hygiene is still
 *   enforced so a poisoned suggestion can never round-trip as "validated".
 * - kind "graph-assertion": assertion non-empty. When a GraphClient is
 *   supplied, the assertion is run through querySymbolGraph (read-only) and
 *   must hit ≥1 symbol; without a client only the structural check applies.
 * - Absence of `acceptance` is valid (backward compatibility).
 */
export async function validateAcceptance(
  node: TaskNode,
  client?: GraphClient
): Promise<AcceptanceValidationResult> {
  const problems: string[] = [];
  const acceptance = node.acceptance;
  if (!acceptance) {
    return { ok: true, problems };
  }

  if (acceptance.kind === "test") {
    const command = typeof acceptance.command === "string" ? acceptance.command.trim() : "";
    if (!command) {
      problems.push(`${node.id}: acceptance.kind="test" requires a non-empty command`);
    } else {
      if (!hasSafeTestRunnerPrefix(command)) {
        problems.push(
          `${node.id}: acceptance command must start with a known-safe test runner (npm/npx/vitest/jest/py.test/pytest/go test): ${command}`
        );
      }
      const metachars = command.match(SHELL_METACHAR_PATTERN);
      if (metachars) {
        problems.push(
          `${node.id}: acceptance command contains shell metacharacter(s) "${metachars.join(
            ""
          )}" — only spaces/dashes/colons style hygiene is allowed: ${command}`
        );
      }
    }
  } else if (acceptance.kind === "graph-assertion") {
    const assertion = typeof acceptance.assertion === "string" ? acceptance.assertion.trim() : "";
    if (!assertion) {
      problems.push(`${node.id}: acceptance.kind="graph-assertion" requires a non-empty assertion`);
    } else if (client) {
      try {
        const result = await querySymbolGraph(client, assertion);
        if (result.matches.length < 1) {
          problems.push(`${node.id}: graph assertion matched no symbols (query: ${assertion})`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`${node.id}: graph assertion query failed (treated as unverified): ${message}`);
      }
    }
    // No client → structural-only check (non-empty), by design.
  } else {
    problems.push(
      `${node.id}: unknown acceptance.kind "${String(acceptance.kind)}" (expected "test" | "graph-assertion")`
    );
  }

  return { ok: problems.length === 0, problems };
}

export interface PlanValidationResult {
  /** False only for structural plan problems; acceptance issues are warnings. */
  ok: boolean;
  /** Structural problems that make the plan invalid. */
  problems: string[];
  /** Acceptance-criterion issues: advisory, never fail the plan. */
  warnings: string[];
}

/**
 * Plan-level validation flow for TaskNode[]: structural DAG checks (ids,
 * descriptions, dependency references) as hard problems, plus per-node
 * acceptance validation via {@link validateAcceptance} as WARNINGS only —
 * nodes without an acceptance criterion stay valid for backward compat.
 * Pass a GraphClient to also resolve graph-assertion queries.
 */
export async function validatePlan(
  plan: TaskNode[],
  client?: GraphClient
): Promise<PlanValidationResult> {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(plan) || plan.length === 0) {
    problems.push("plan must contain at least one task node");
    return { ok: false, problems, warnings };
  }

  const seenIds = new Set<string>();
  for (const node of plan) {
    if (!node.id || !node.id.trim()) {
      problems.push("plan node is missing an id");
      continue;
    }
    if (seenIds.has(node.id)) {
      problems.push(`duplicate task node id: ${node.id}`);
    }
    seenIds.add(node.id);
    if (!node.description || !node.description.trim()) {
      problems.push(`node ${node.id} is missing a description`);
    }
    for (const dep of node.dependencies ?? []) {
      if (!plan.some((other) => other.id === dep)) {
        problems.push(`node ${node.id} depends on unknown id "${dep}"`);
      }
    }
  }

  for (const node of plan) {
    if (!node.acceptance) {
      continue; // Absence of acceptance stays valid (backward compat).
    }
    const acceptance = await validateAcceptance(node, client);
    if (!acceptance.ok) {
      warnings.push(...acceptance.problems);
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

// ───────────────────────── Worker-result validation ─────────────────────────

export function validateTaskResult(task: string, workerOutput: string): ValidationResult {
  if (!task.trim()) {
    return {
      passed: false,
      feedback: "[heuristic] Task cannot be empty.",
      matchedCriteria: [],
      missingCriteria: ["task"],
      riskTags: ["invalid_input", "heuristic_validation"],
    };
  }

  if (!workerOutput.trim()) {
    return {
      passed: false,
      feedback: "[heuristic] Worker output is empty.",
      matchedCriteria: [],
      missingCriteria: extractCriteria(task),
      riskTags: ["empty_output", "heuristic_validation"],
    };
  }

  // Detect placeholder/fallback output from provider adapters
  const isPlaceholder = /^\[(openai|anthropic|bailian|doubao|deepseek):[^\]]+\]/i.test(workerOutput.trim());
  if (isPlaceholder) {
    return {
      passed: false,
      feedback: "[heuristic] Worker output appears to be a provider fallback placeholder, not real execution result.",
      matchedCriteria: [],
      missingCriteria: extractCriteria(task),
      riskTags: ["placeholder_output", "heuristic_validation"],
    };
  }

  const criteria = extractCriteria(task);
  const matchedCriteria = criteria.filter((criterion) => matchesCriterion(criterion, workerOutput));
  const missingCriteria = criteria.filter((criterion) => !matchedCriteria.includes(criterion));

  if (missingCriteria.length > 0) {
    return {
      passed: false,
      feedback: `[heuristic] Validation failed: missing criteria -> ${missingCriteria.join(", ")}`,
      matchedCriteria,
      missingCriteria,
      riskTags: ["criteria_mismatch", "heuristic_validation"],
    };
  }

  return {
    passed: true,
    feedback: `[heuristic] Validation passed: matched ${matchedCriteria.length}/${criteria.length} criteria. Note: this is substring-based heuristic validation, not semantic verification.`,
    matchedCriteria,
    missingCriteria: [],
    riskTags: ["heuristic_validation"],
  };
}

function extractCriteria(task: string): string[] {
  const parts = task
    .split(/\band\b|,|;/i)
    .map((item) => item.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [task.trim()];
}

function matchesCriterion(criterion: string, output: string): boolean {
  const criterionLower = criterion.toLowerCase();
  const outputLower = output.toLowerCase();

  if (outputLower.includes(criterionLower)) {
    return true;
  }

  const tokens = criterionLower
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_/.-]/g, ""))
    .filter((token) => token.length >= 4);

  if (tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => outputLower.includes(token));
}

export async function validateTaskResultLlm(
  task: string,
  workerOutput: string,
  selection: ModelSelection,
  context?: PromptContext
): Promise<ValidationResult> {
  if (!task.trim() || !workerOutput.trim()) {
    return validateTaskResult(task, workerOutput);
  }

  const prompt = [
    "You are a strict validator. Decide if the worker output satisfies the task.",
    "Return ONLY a JSON object shaped as {passed, feedback, matchedCriteria, missingCriteria, riskTags}.",
    "- passed: boolean",
    "- feedback: short string explaining the decision",
    "- matchedCriteria, missingCriteria, riskTags: arrays of strings",
    `Task: ${task}`,
    `Worker output: ${workerOutput}`,
  ].join("\n");

  let raw = "";
  try {
    raw = await executeRolePrompt("validator", prompt, selection, context);
  } catch (error) {
    logger.error({ error }, "Caught error");
    return validateTaskResult(task, workerOutput);
  }

  const parsed = parseValidatorJson(raw);
  if (!parsed) {
    return validateTaskResult(task, workerOutput);
  }

  return parsed;
}

function parseValidatorJson(raw: string): ValidationResult | null {
  if (!raw) {
    return null;
  }

  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    logger.error({ error }, "Caught error");
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.passed !== "boolean") {
    return null;
  }

  const toStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  return {
    passed: record.passed,
    feedback: typeof record.feedback === "string" ? record.feedback : "",
    matchedCriteria: toStringArray(record.matchedCriteria),
    missingCriteria: toStringArray(record.missingCriteria),
    riskTags: toStringArray(record.riskTags),
  };
}
