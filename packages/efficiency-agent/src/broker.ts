import type {
  BrokerPolicy,
  BrokerResult,
  ValidationOutcome,
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "./domain.js";

/**
 * P2 Execution Broker (2.x plan §16): drives a Standard Worker Adapter
 * through up to `maxRounds` rounds of prepare → execute → validate, then
 * always finalizes the worker with `stop()`.
 *
 * P2 执行中介：按 policy 驱动 worker 适配器循环（prepare → execute →
 * validate），无论以何种方式退出都会调用 worker.stop()。worker 层的
 * 任何异常（execute 抛错、validate 抛错、prepare 抛错）都不会逃逸出
 * broker——一律降级为失败观察/失败校验，保证 BrokerResult 结构确定。
 *
 * Stop conditions, checked in this order:
 *  1. validation passed && policy.stopOnValidationPass → "completed"
 *     (stopReason "validation-passed")
 *  2. rounds exhausted (rounds >= policy.maxRounds)     → "failed"
 *     (stopReason "max-rounds", last validation attached)
 *  3. wall clock already past totalBudgetMs when about to start ANOTHER
 *     round                                             → "budget-exhausted"
 *
 * The result structure is deterministic and the inputs are never mutated.
 */

export interface BrokeredExecutionInput {
  /** Validation specs handed to worker.prepare each round (unchanged). */
  validation: string[];
  policy: BrokerPolicy;
}

/** Machine-readable terminal reasons emitted by the broker loop. */
export type BrokerStopReason =
  | "validation-passed"
  | "max-rounds"
  | "budget-exhausted"
  | "no-validation-command";

/** Mirror of the worker's tail cap, applied to synthetic error observations. */
const SYNTHETIC_TAIL_CAP = 2_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syntheticObservation(stage: string, error: unknown, durationMs: number): WorkerObservation {
  return {
    stderrTail: `${stage} threw: ${messageOf(error)}`.slice(0, SYNTHETIC_TAIL_CAP),
    durationMs,
  };
}

/**
 * Run the brokered lifecycle. Resolves with a BrokerResult on every path —
 * it never rejects because of worker behavior (only truly catastrophic host
 * failures, e.g. an out-of-memory abort, can interrupt it).
 */
export async function runBrokeredExecution(
  input: BrokeredExecutionInput,
  worker: WorkerAdapter
): Promise<BrokerResult> {
  const startedAt = Date.now();
  const observations: WorkerObservation[] = [];
  let rounds = 0;
  let status: BrokerResult["status"] = "failed";
  let stopReason: BrokerStopReason = "max-rounds";
  let validation: ValidationOutcome | undefined;

  try {
    for (;;) {
      // Gate 2 — rounds exhausted (checked before budget per plan §16 order).
      if (rounds >= input.policy.maxRounds) {
        status = "failed";
        stopReason = "max-rounds";
        break;
      }
      // Gate 3 — budget, only before starting ANOTHER round (never the first).
      if (rounds > 0 && Date.now() - startedAt > input.policy.totalBudgetMs) {
        status = "budget-exhausted";
        stopReason = "budget-exhausted";
        break;
      }

      rounds += 1;
      const roundStartedAt = Date.now();

      let command: WorkerCommand | undefined;
      try {
        command = await worker.prepare(input.validation);
      } catch (error) {
        observations.push(syntheticObservation("prepare", error, Date.now() - roundStartedAt));
        validation = { passed: false, checks: [{ name: "prepare-threw", passed: false }] };
        continue;
      }

      if (command === undefined) {
        // Nothing to run: fail closed — a validation broker with no
        // validation command has no evidence of success.
        status = "failed";
        stopReason = "no-validation-command";
        validation = { passed: false, checks: [{ name: "no-validation-command", passed: false }] };
        break;
      }

      let observation: WorkerObservation;
      let executeThrew = false;
      try {
        observation = await worker.execute(command);
      } catch (error) {
        // Plan §16: an execute failure becomes a failed observation, never
        // an exception escaping the broker.
        executeThrew = true;
        observation = syntheticObservation("execute", error, Date.now() - roundStartedAt);
      }
      observations.push(observation);

      if (executeThrew) {
        // worker.validate is NOT called on a synthetic observation — the
        // worker never observed this run, so it has nothing to validate.
        validation = { passed: false, checks: [{ name: "execute-threw", passed: false }] };
      } else {
        try {
          validation = await worker.validate(observation);
        } catch {
          validation = { passed: false, checks: [{ name: "validate-threw", passed: false }] };
        }
      }

      // Gate 1 — validation pass (checked first per plan §16 order).
      if (validation.passed && input.policy.stopOnValidationPass) {
        status = "completed";
        stopReason = "validation-passed";
        break;
      }
    }
  } finally {
    // Always finalize the worker on every exit path; a failing stop() must
    // not mask the broker result.
    try {
      await worker.stop();
    } catch {
      // Finalizer error is deliberately swallowed (see above).
    }
  }

  return {
    status,
    rounds,
    totalDurationMs: Date.now() - startedAt,
    observations,
    ...(validation !== undefined ? { validation } : {}),
    stopReason,
  };
}
