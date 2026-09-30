import { describe, expect, it } from "vitest";
import { runBrokeredExecution } from "../src/broker.js";
import { createLocalCommandWorker } from "../src/workers/local-command-worker.js";
import type {
  BrokerPolicy,
  ValidationOutcome,
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "../src/domain.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function policy(overrides: Partial<BrokerPolicy> = {}): BrokerPolicy {
  return { maxRounds: 1, totalBudgetMs: 10_000, stopOnValidationPass: true, ...overrides };
}

/**
 * Scriptable fake worker: pops observations from `script` (a thrown Error in
 * the script makes execute reject), records every lifecycle call, and
 * validates by exit code only.
 */
class FakeWorker implements WorkerAdapter {
  name = "fake";
  prepareCalls = 0;
  executeCalls = 0;
  validateCalls = 0;
  stopCalls = 0;
  script: Array<WorkerObservation | Error> = [];
  prepareResult: WorkerCommand | undefined = { command: "true", args: [] };
  executeDelayMs = 0;
  private cursor = 0;

  async prepare(_validation: string[]): Promise<WorkerCommand | undefined> {
    this.prepareCalls += 1;
    return this.prepareResult;
  }

  async execute(_command: WorkerCommand): Promise<WorkerObservation> {
    this.executeCalls += 1;
    if (this.executeDelayMs > 0) {
      await sleep(this.executeDelayMs);
    }
    const step = this.script[this.cursor];
    this.cursor += 1;
    if (step instanceof Error) {
      throw step;
    }
    if (step !== undefined) {
      return step;
    }
    return { exitCode: 1, durationMs: 1 };
  }

  async validate(observation: WorkerObservation): Promise<ValidationOutcome> {
    this.validateCalls += 1;
    const passed = observation.exitCode === 0;
    return {
      passed,
      checks: [
        { name: "exit-code", passed },
        { name: "stderr-empty", passed: observation.stderrTail === undefined },
      ],
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

describe("broker lifecycle with a scripted fake worker", () => {
  it("passes on the first round and stops with validation-passed", async () => {
    const worker = new FakeWorker();
    worker.script = [{ exitCode: 0, durationMs: 1 }];
    const result = await runBrokeredExecution(
      { validation: ["echo ok"], policy: policy({ maxRounds: 1 }) },
      worker
    );
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("validation-passed");
    expect(result.rounds).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(result.validation?.passed).toBe(true);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(worker.stopCalls).toBe(1);
  });

  it("fails, retries, then passes within maxRounds (rounds = 2)", async () => {
    const worker = new FakeWorker();
    worker.script = [{ exitCode: 1, durationMs: 1 }, { exitCode: 0, durationMs: 1 }];
    const result = await runBrokeredExecution(
      { validation: ["echo retry"], policy: policy({ maxRounds: 3 }) },
      worker
    );
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("validation-passed");
    expect(result.rounds).toBe(2);
    expect(result.observations).toHaveLength(2);
    expect(result.validation?.passed).toBe(true);
    expect(worker.stopCalls).toBe(1);
  });

  it("exhausts maxRounds and reports failed with the last validation attached", async () => {
    const worker = new FakeWorker();
    worker.script = [{ exitCode: 1, durationMs: 1 }, { exitCode: 2, durationMs: 1 }];
    const result = await runBrokeredExecution(
      { validation: ["echo nope"], policy: policy({ maxRounds: 2 }) },
      worker
    );
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("max-rounds");
    expect(result.rounds).toBe(2);
    expect(result.observations.map((o) => o.exitCode)).toEqual([1, 2]);
    expect(result.validation?.passed).toBe(false);
    expect(result.validation?.checks[0]).toEqual({ name: "exit-code", passed: false });
    expect(worker.stopCalls).toBe(1);
  });

  it("reports budget-exhausted when the wall clock passes the budget between rounds", async () => {
    const worker = new FakeWorker();
    worker.executeDelayMs = 50; // slow fake: round 1 alone blows the budget
    const result = await runBrokeredExecution(
      { validation: ["echo slow"], policy: policy({ maxRounds: 10, totalBudgetMs: 5 }) },
      worker
    );
    expect(result.status).toBe("budget-exhausted");
    expect(result.stopReason).toBe("budget-exhausted");
    expect(result.rounds).toBe(1);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(50);
    expect(worker.executeCalls).toBe(1);
    expect(worker.stopCalls).toBe(1);
  });

  it("catches a throwing execute as a failed observation and never calls validate on it", async () => {
    const worker = new FakeWorker();
    worker.script = [new Error("worker exploded"), new Error("worker exploded again")];
    const result = await runBrokeredExecution(
      { validation: ["echo boom"], policy: policy({ maxRounds: 2 }) },
      worker
    );
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("max-rounds");
    expect(result.rounds).toBe(2);
    expect(result.observations).toHaveLength(2);
    for (const observation of result.observations) {
      expect(observation.exitCode).toBeUndefined();
      expect("exitCode" in observation).toBe(false);
      expect(observation.stderrTail).toContain("execute threw: worker exploded");
    }
    expect(result.validation?.passed).toBe(false);
    // The worker never observed the synthetic runs, so validate is not called.
    expect(worker.validateCalls).toBe(0);
    expect(worker.stopCalls).toBe(1);
  });

  it("fail-closes when prepare yields no command (empty validation list)", async () => {
    const worker = new FakeWorker();
    worker.prepareResult = undefined;
    const result = await runBrokeredExecution(
      { validation: [], policy: policy({ maxRounds: 3 }) },
      worker
    );
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("no-validation-command");
    expect(result.rounds).toBe(1);
    expect(result.observations).toHaveLength(0);
    expect(result.validation?.passed).toBe(false);
    expect(worker.executeCalls).toBe(0);
    expect(worker.stopCalls).toBe(1);
  });

  it("never mutates its inputs", async () => {
    const worker = new FakeWorker();
    worker.script = [{ exitCode: 0, durationMs: 1 }];
    const input = {
      validation: ["echo untouched"],
      policy: policy({ maxRounds: 2 }),
    };
    const validationBefore = [...input.validation];
    const policyBefore = { ...input.policy };
    await runBrokeredExecution(input, worker);
    expect(input.validation).toEqual(validationBefore);
    expect(input.policy).toEqual(policyBefore);
  });
});

describe("local command worker — real execFile runs (safe commands only)", () => {
  it("prepares validation strings into command + args with quotes stripped", async () => {
    const worker = createLocalCommandWorker();
    const quoted = await worker.prepare(['node -e "process.exit(0)"']);
    expect(quoted).toEqual({ command: "node", args: ["-e", "process.exit(0)"] });
    const bare = await worker.prepare(["node -e process.exit(1)"]);
    expect(bare).toEqual({ command: "node", args: ["-e", "process.exit(1)"] });
    expect(await worker.prepare([])).toBeUndefined();
    expect(await worker.prepare(["   "])).toBeUndefined();
  });

  it("runs node -e \"process.exit(0)\" to completion through the broker", async () => {
    const worker = createLocalCommandWorker();
    const result = await runBrokeredExecution(
      { validation: ['node -e "process.exit(0)"'], policy: policy({ maxRounds: 1 }) },
      worker
    );
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("validation-passed");
    expect(result.rounds).toBe(1);
    expect(result.observations[0]?.exitCode).toBe(0);
    expect(result.validation?.checks).toEqual([
      { name: "exit-code", passed: true },
      { name: "stderr-empty", passed: true },
    ]);
  });

  it("reports a failing exit code for node -e \"process.exit(1)\"", async () => {
    const worker = createLocalCommandWorker();
    const observation = await worker.execute({
      command: "node",
      args: ["-e", "process.exit(1)"],
    });
    expect(observation.exitCode).toBe(1);
    expect(observation.durationMs).toBeGreaterThanOrEqual(0);
    const outcome = await worker.validate(observation);
    expect(outcome.passed).toBe(false);
    expect(outcome.checks).toContainEqual({ name: "exit-code", passed: false });

    const result = await runBrokeredExecution(
      { validation: ['node -e "process.exit(1)"'], policy: policy({ maxRounds: 1 }) },
      worker
    );
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("max-rounds");
    expect(result.observations[0]?.exitCode).toBe(1);
  });

  it("turns a timeout into a failed observation (not a throw) and kills the child", async () => {
    const worker = createLocalCommandWorker({ defaultTimeoutMs: 100 });
    const startedAt = Date.now();
    const observation = await worker.execute({
      command: "node",
      args: ["-e", "setTimeout(()=>{},10000)"],
    });
    const wall = Date.now() - startedAt;
    expect(wall).toBeLessThan(5_000);
    expect(observation.exitCode).toBeUndefined();
    expect("exitCode" in observation).toBe(false);
    expect(observation.stderrTail).toContain("timeout");
    expect(observation.durationMs).toBeGreaterThanOrEqual(80);
    const outcome = await worker.validate(observation);
    expect(outcome.passed).toBe(false);
    expect(outcome.checks).toContainEqual({ name: "stderr-empty", passed: false });
  });

  it("maps a spawn failure (ENOENT) to exitCode undefined → passed=false path", async () => {
    const worker = createLocalCommandWorker();
    const observation = await worker.execute({
      command: "definitely-not-a-real-graphflow-binary",
      args: [],
    });
    expect(observation.exitCode).toBeUndefined();
    expect("exitCode" in observation).toBe(false);
    expect(observation.stderrTail).toContain("ENOENT");
    const outcome = await worker.validate(observation);
    expect(outcome.passed).toBe(false);
    expect(outcome.checks).toEqual([
      { name: "exit-code", passed: false },
      { name: "stderr-empty", passed: false },
    ]);
  });

  it("stop() is a safe no-op before and after execution", async () => {
    const worker = createLocalCommandWorker({ name: "stop-safe" });
    expect(worker.name).toBe("stop-safe");
    await expect(worker.stop()).resolves.toBeUndefined();
    await worker.execute({ command: "node", args: ["-e", "process.exit(0)"] });
    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
