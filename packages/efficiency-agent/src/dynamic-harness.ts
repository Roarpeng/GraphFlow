import type { ExecutionContractV1 } from "./contract.js";
import type {
  ValidationOutcome,
  WorkerAdapter,
  WorkerObservation,
} from "./domain.js";

/**
 * Harness Complexity levels aligned with HTML §11 & Efficiency Harness roadmap:
 * - trivial: Deterministic fast-path (0 LLM, pure cache/rules, <=1 round, minimal overhead)
 * - simple: Single worker one-shot execution with validation (no retry)
 * - medium: Worker + specialist tool + retry policy (maxRounds > 1, recovery flow)
 * - complex: Task-specific temporary harness with context planning, dynamic sub-agents,
 *            tool bindings, strict budget cap, multi-stage validation, and stop conditions.
 */
export type HarnessComplexity = "trivial" | "simple" | "medium" | "complex";

/** Disposable resource that may have asynchronous or synchronous cleanup. */
export interface DisposableResource {
  dispose?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

/** Specialist tool that can be bound to the harness. */
export interface SpecialistTool extends DisposableResource {
  name: string;
  execute: (input: unknown) => Promise<unknown> | unknown;
}

/** Dynamic sub-agent for complex tasks. */
export interface DynamicSubAgent extends DisposableResource {
  id: string;
  role: string;
  run: (input: unknown) => Promise<unknown> | unknown;
}

/** Context planning function for complex workflows. */
export type ContextPlanner = (task: string) => Promise<{
  requiredAnchors?: string[];
  maxTokens?: number;
  dynamicDirectives?: string[];
}>;

export interface RetryPolicy {
  maxRetries: number;
  backoffMs?: number;
}

export interface HarnessRunContext {
  contract: ExecutionContractV1;
  complexity: HarnessComplexity;
  rounds: number;
  elapsedMs: number;
  observations: WorkerObservation[];
  validation?: ValidationOutcome | undefined;
  subAgentResults?: Array<{ id: string; role: string; output: unknown }>;
}

export interface TemporaryHarnessOptions {
  /** Hard cap on total runtime budget in milliseconds. Default varies by complexity. */
  budgetCapMs?: number;
  /** Maximum execution rounds override. */
  maxRounds?: number;
  /** Specialist tools bound to this sandbox instance. */
  specialistTools?: SpecialistTool[];
  /** Dynamic sub-agents spawned for this task. */
  subAgents?: DynamicSubAgent[];
  /** Optional context planning routine (typically for complex tasks). */
  contextPlanner?: ContextPlanner;
  /** Retry policy for medium/complex tasks. */
  retryPolicy?: RetryPolicy;
  /** Custom stop conditions evaluated between rounds. */
  stopConditions?: Array<(context: HarnessRunContext) => boolean>;
  /** Optional custom resource teardown hook. */
  onDispose?: () => Promise<void> | void;
}

export interface HarnessExecutionResult {
  status: "completed" | "failed" | "budget-exhausted" | "stopped";
  complexity: HarnessComplexity;
  rounds: number;
  durationMs: number;
  observations: WorkerObservation[];
  validation?: ValidationOutcome | undefined;
  stopReason?: string | undefined;
  contextPlan?: {
    requiredAnchors?: string[];
    maxTokens?: number;
    dynamicDirectives?: string[];
  } | undefined;
  subAgentOutputs?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TemporaryHarness {
  readonly id: string;
  readonly complexity: HarnessComplexity;
  readonly isDisposed: boolean;
  readonly options: Readonly<TemporaryHarnessOptions>;
  run(contract: ExecutionContractV1, worker?: WorkerAdapter): Promise<HarnessExecutionResult>;
  dispose(): Promise<void>;
}

/** Default budget caps per complexity tier (HTML §11). */
const DEFAULT_BUDGET_CAPS: Record<HarnessComplexity, number> = {
  trivial: 1_000,
  simple: 10_000,
  medium: 30_000,
  complex: 120_000,
};

let harnessCounter = 0;

/**
 * Creates a Dynamic Temporary Harness configured for the required task complexity.
 *
 * Provides isolated lifecycle:
 *   1. Assemble task-specific components based on complexity tier.
 *   2. Execute with `harness.run(contract, worker)`.
 *   3. Guaranteed teardown with `harness.dispose()`.
 */
export function createTemporaryHarness(
  complexity: HarnessComplexity,
  options: TemporaryHarnessOptions = {}
): TemporaryHarness {
  const harnessId = `harness-${complexity}-${++harnessCounter}-${Date.now().toString(36)}`;
  let disposed = false;

  const budgetCapMs = options.budgetCapMs ?? DEFAULT_BUDGET_CAPS[complexity];

  const harness: TemporaryHarness = {
    get id() {
      return harnessId;
    },
    get complexity() {
      return complexity;
    },
    get isDisposed() {
      return disposed;
    },
    get options() {
      return options;
    },

    async run(contract: ExecutionContractV1, worker?: WorkerAdapter): Promise<HarnessExecutionResult> {
      if (disposed) {
        throw new Error(`Cannot run disposed harness: ${harnessId}`);
      }

      const startedAt = Date.now();
      const observations: WorkerObservation[] = [];
      let rounds = 0;
      let status: HarnessExecutionResult["status"] = "failed";
      let stopReason = "unknown";
      let validation: ValidationOutcome | undefined;
      let contextPlan: HarnessExecutionResult["contextPlan"];
      const subAgentOutputs: Record<string, unknown> = {};

      try {
        // ── 1. TRIVIAL COMPLEXITY: Deterministic fast-path (Zero-LLM) ──
        if (complexity === "trivial") {
          // Only a REUSE verdict (a validated cached result) completes without
          // running anything; a missing worker is not evidence of success.
          if (contract.reuseMode === "REUSE") {
            return {
              status: "completed",
              complexity,
              rounds: 0,
              durationMs: Date.now() - startedAt,
              observations: [],
              validation: { passed: true, checks: [{ name: "deterministic-cache-hit", passed: true }] },
              stopReason: "trivial-fast-path",
            };
          }
          if (!worker) {
            return {
              status: "failed",
              complexity,
              rounds: 0,
              durationMs: Date.now() - startedAt,
              observations: [],
              validation: { passed: false, checks: [{ name: "no-worker", passed: false }] },
              stopReason: "no-worker",
            };
          }

          // Single fast execution step with zero retries
          rounds = 1;
          const cmd = await worker.prepare(contract.validation);
          if (!cmd) {
            return {
              status: "failed",
              complexity,
              rounds,
              durationMs: Date.now() - startedAt,
              observations,
              validation: { passed: false, checks: [{ name: "no-command", passed: false }] },
              stopReason: "no-validation-command",
            };
          }

          const obs = await worker.execute(cmd);
          observations.push(obs);
          validation = await worker.validate(obs);
          status = validation.passed ? "completed" : "failed";
          stopReason = validation.passed ? "validation-passed" : "validation-failed";

          return {
            status,
            complexity,
            rounds,
            durationMs: Date.now() - startedAt,
            observations,
            validation,
            stopReason,
          };
        }

        // ── 2. SIMPLE COMPLEXITY: Single worker one-shot + validation ──
        if (complexity === "simple") {
          if (!worker) {
            throw new Error("WorkerAdapter is required for simple harness execution");
          }

          rounds = 1;
          const cmd = await worker.prepare(contract.validation);
          if (!cmd) {
            return {
              status: "failed",
              complexity,
              rounds,
              durationMs: Date.now() - startedAt,
              observations,
              validation: { passed: false, checks: [{ name: "no-command", passed: false }] },
              stopReason: "no-validation-command",
            };
          }

          const obs = await worker.execute(cmd);
          observations.push(obs);
          validation = await worker.validate(obs);
          status = validation.passed ? "completed" : "failed";
          stopReason = validation.passed ? "validation-passed" : "one-shot-failed";

          return {
            status,
            complexity,
            rounds,
            durationMs: Date.now() - startedAt,
            observations,
            validation,
            stopReason,
          };
        }

        // ── 3. MEDIUM COMPLEXITY: Worker + specialist tool + retry policy ──
        if (complexity === "medium") {
          if (!worker) {
            throw new Error("WorkerAdapter is required for medium harness execution");
          }

          const maxRetries = options.retryPolicy?.maxRetries ?? 2;
          const maxRounds = options.maxRounds ?? (maxRetries + 1);

          for (let r = 0; r < maxRounds; r++) {
            if (Date.now() - startedAt > budgetCapMs) {
              status = "budget-exhausted";
              stopReason = "budget-exhausted";
              break;
            }

            rounds += 1;
            const cmd = await worker.prepare(contract.validation);
            if (!cmd) {
              status = "failed";
              stopReason = "no-validation-command";
              validation = { passed: false, checks: [{ name: "no-command", passed: false }] };
              break;
            }

            // If specialist tools are present, they are available in this harness
            if (options.specialistTools && options.specialistTools.length > 0) {
              for (const tool of options.specialistTools) {
                try {
                  await tool.execute({ round: rounds, command: cmd });
                } catch {
                  // Tool observation failure should not kill the loop
                }
              }
            }

            let obs: WorkerObservation;
            try {
              obs = await worker.execute(cmd);
            } catch (err) {
              obs = {
                stderrTail: `Worker threw in round ${rounds}: ${err instanceof Error ? err.message : String(err)}`,
                durationMs: 0,
              };
            }
            observations.push(obs);

            try {
              validation = await worker.validate(obs);
            } catch {
              validation = { passed: false, checks: [{ name: "validation-threw", passed: false }] };
            }

            if (validation.passed) {
              status = "completed";
              stopReason = "validation-passed";
              break;
            }

            if (Date.now() - startedAt > budgetCapMs) {
              status = "budget-exhausted";
              stopReason = "budget-exhausted";
              break;
            }

            // If retry backoff requested
            if (options.retryPolicy?.backoffMs && r < maxRounds - 1) {
              await new Promise((resolve) => setTimeout(resolve, options.retryPolicy!.backoffMs));
            }
          }

          if (status !== "completed" && status !== "budget-exhausted") {
            if (Date.now() - startedAt > budgetCapMs) {
              status = "budget-exhausted";
              stopReason = "budget-exhausted";
            } else {
              status = "failed";
              stopReason = "max-retries-exhausted";
            }
          }

          return {
            status,
            complexity,
            rounds,
            durationMs: Date.now() - startedAt,
            observations,
            ...(validation !== undefined ? { validation } : {}),
            stopReason,
          };
        }

        // ── 4. COMPLEX COMPLEXITY: Task-specific Temporary Harness ──
        // (Context planning + tool binding + dynamic sub-agents + strict budget cap + stop conditions)
        if (complexity === "complex") {
          // A. Context Planning
          if (options.contextPlanner) {
            try {
              contextPlan = await options.contextPlanner(contract.taskId);
            } catch {
              contextPlan = { dynamicDirectives: ["context-planner-failed"] };
            }
          }

          // B. Dynamic Sub-agents execution (parallel / sequential)
          if (options.subAgents && options.subAgents.length > 0) {
            for (const subAgent of options.subAgents) {
              if (Date.now() - startedAt > budgetCapMs) {
                status = "budget-exhausted";
                stopReason = "budget-exhausted";
                return {
                  status,
                  complexity,
                  rounds,
                  durationMs: Date.now() - startedAt,
                  observations,
                  contextPlan,
                  subAgentOutputs,
                  stopReason,
                };
              }
              try {
                const out = await subAgent.run({ taskId: contract.taskId, plan: contextPlan });
                subAgentOutputs[subAgent.id] = out;
              } catch (subErr) {
                subAgentOutputs[subAgent.id] = {
                  error: subErr instanceof Error ? subErr.message : String(subErr),
                };
              }
            }
          }

          const maxRounds = options.maxRounds ?? contract.worker.maxRounds ?? 3;

          // C. Worker loop with strict budget cap & stop conditions
          if (worker) {
            for (let r = 0; r < maxRounds; r++) {
              if (Date.now() - startedAt > budgetCapMs) {
                status = "budget-exhausted";
                stopReason = "budget-exhausted";
                break;
              }

              // Evaluate stop conditions before round
              const currentContext: HarnessRunContext = {
                contract,
                complexity,
                rounds,
                elapsedMs: Date.now() - startedAt,
                observations,
                validation,
                subAgentResults: Object.entries(subAgentOutputs).map(([id, output]) => ({
                  id,
                  role: options.subAgents?.find((s) => s.id === id)?.role ?? "specialist",
                  output,
                })),
              };

              if (options.stopConditions?.some((sc) => sc(currentContext))) {
                status = "stopped";
                stopReason = "stop-condition-triggered";
                break;
              }

              rounds += 1;

              // Specialist tool invocation
              if (options.specialistTools) {
                for (const tool of options.specialistTools) {
                  try {
                    await tool.execute({ taskId: contract.taskId, round: rounds });
                  } catch {
                    // Ignore tool internal error
                  }
                }
              }

              const cmd = await worker.prepare(contract.validation);
              if (!cmd) {
                status = "failed";
                stopReason = "no-validation-command";
                validation = { passed: false, checks: [{ name: "no-command", passed: false }] };
                break;
              }

              let obs: WorkerObservation;
              try {
                obs = await worker.execute(cmd);
              } catch (err) {
                obs = {
                  stderrTail: `Worker threw in complex round ${rounds}: ${err instanceof Error ? err.message : String(err)}`,
                  durationMs: 0,
                };
              }
              observations.push(obs);

              try {
                validation = await worker.validate(obs);
              } catch {
                validation = { passed: false, checks: [{ name: "validation-threw", passed: false }] };
              }

              // Evaluate stop conditions after round
              currentContext.rounds = rounds;
              currentContext.elapsedMs = Date.now() - startedAt;
              currentContext.validation = validation;

              if (validation.passed) {
                status = "completed";
                stopReason = "validation-passed";
                break;
              }

              if (Date.now() - startedAt > budgetCapMs) {
                status = "budget-exhausted";
                stopReason = "budget-exhausted";
                break;
              }

              if (options.stopConditions?.some((sc) => sc(currentContext))) {
                status = "stopped";
                stopReason = "stop-condition-triggered";
                break;
              }

              if (options.retryPolicy?.backoffMs && r < maxRounds - 1) {
                await new Promise((resolve) => setTimeout(resolve, options.retryPolicy!.backoffMs));
              }
            }

            if (status !== "completed" && status !== "stopped" && status !== "budget-exhausted") {
              if (Date.now() - startedAt > budgetCapMs) {
                status = "budget-exhausted";
                stopReason = "budget-exhausted";
              } else {
                status = "failed";
                stopReason = "max-rounds-exhausted";
              }
            }
          } else {
            // Sub-agents ran but nothing validated their output.
            status = "failed";
            stopReason = "no-worker-validation";
          }

          return {
            status,
            complexity,
            rounds,
            durationMs: Date.now() - startedAt,
            observations,
            ...(validation !== undefined ? { validation } : {}),
            contextPlan,
            subAgentOutputs,
            stopReason,
          };
        }

        throw new Error(`Unsupported complexity tier: ${complexity}`);
      } finally {
        if (worker) {
          try {
            await worker.stop();
          } catch {
            // Worker stop error swallowed to preserve outcome
          }
        }
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Clean up specialist tools
      if (options.specialistTools) {
        for (const tool of options.specialistTools) {
          try {
            if (tool.dispose) await tool.dispose();
            else if (tool.stop) await tool.stop();
          } catch {
            // Swallowed for safe cleanup
          }
        }
      }

      // Clean up dynamic sub-agents
      if (options.subAgents) {
        for (const subAgent of options.subAgents) {
          try {
            if (subAgent.dispose) await subAgent.dispose();
            else if (subAgent.stop) await subAgent.stop();
          } catch {
            // Swallowed for safe cleanup
          }
        }
      }

      // Execute custom onDispose hook
      if (options.onDispose) {
        try {
          await options.onDispose();
        } catch {
          // Swallowed for safe cleanup
        }
      }
    },
  };

  return harness;
}
