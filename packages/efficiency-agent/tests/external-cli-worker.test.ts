import { describe, expect, it } from "vitest";
import {
  createExternalCliWorker,
  createClaudeCodeWorker,
  createCodexCliWorker,
  createCursorWorker,
  tokenizeValidationSpec,
  ExternalCliWorker,
} from "../src/workers/external-cli-worker.js";
import { runBrokeredExecution } from "../src/broker.js";

describe("External CLI Worker Adapter (HTML §16)", () => {
  it("tokenizes validation specs correctly with quotes", () => {
    expect(tokenizeValidationSpec('claude run "task with spaces" --verbose')).toEqual([
      "claude",
      "run",
      "task with spaces",
      "--verbose",
    ]);
    expect(tokenizeValidationSpec("")).toEqual([]);
    expect(tokenizeValidationSpec("   ")).toEqual([]);
  });

  it("prepares command using configured CLI command and base args", async () => {
    const worker = createExternalCliWorker({
      cliCommand: "claude",
      args: ["--dangerously-skip-permissions"],
      cwd: "/tmp",
      timeoutMs: 15_000,
    });

    // 1. prepare with explicit claude token
    const cmd1 = await worker.prepare(['claude -p "explain index.ts"']);
    expect(cmd1).toEqual({
      command: "claude",
      args: ["--dangerously-skip-permissions", "-p", "explain index.ts"],
      cwd: "/tmp",
      timeoutMs: 15_000,
    });

    // 2. prepare with arbitrary validation tokens (wrapped into configured cliCommand)
    const cmd2 = await worker.prepare(['-p "analyze graph"']);
    expect(cmd2).toEqual({
      command: "claude",
      args: ["--dangerously-skip-permissions", "-p", "analyze graph"],
      cwd: "/tmp",
      timeoutMs: 15_000,
    });

    // 3. prepare with empty array
    const cmd3 = await worker.prepare([]);
    expect(cmd3).toBeUndefined();
  });

  it("presets construct adapters with appropriate names and commands", () => {
    const claude = createClaudeCodeWorker();
    expect(claude.name).toBe("external-cli:claude");

    const codex = createCodexCliWorker();
    expect(codex.name).toBe("external-cli:codex");

    const cursor = createCursorWorker();
    expect(cursor.name).toBe("external-cli:cursor");
  });

  it("executes a real command successfully and streams output", async () => {
    const worker = createExternalCliWorker({
      cliCommand: process.execPath, // node
      timeoutMs: 10_000,
    });

    const obs = await worker.execute({
      command: process.execPath,
      args: ["-e", 'console.log("hello from worker"); console.error("warning note");'],
    });

    expect(obs.exitCode).toBe(0);
    expect(obs.stdoutTail).toContain("hello from worker");
    expect(obs.stderrTail).toContain("warning note");
    expect(obs.durationMs).toBeGreaterThanOrEqual(0);

    const validation = await worker.validate(obs);
    expect(validation.passed).toBe(true);
    expect(validation.checks).toEqual([
      { name: "exit-code", passed: true },
      { name: "stderr-healthy", passed: true },
    ]);
  });

  it("captures non-zero exit codes without throwing", async () => {
    const worker = createExternalCliWorker({
      cliCommand: process.execPath,
    });

    const obs = await worker.execute({
      command: process.execPath,
      args: ["-e", 'console.error("fatal failure"); process.exit(42);'],
    });

    expect(obs.exitCode).toBe(42);
    expect(obs.stderrTail).toContain("fatal failure");

    const validation = await worker.validate(obs);
    expect(validation.passed).toBe(false);
  });

  it("enforces safety tail cap on large streaming outputs", async () => {
    const tailCap = 100;
    const worker = createExternalCliWorker({
      cliCommand: process.execPath,
      tailCap,
    });

    const obs = await worker.execute({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("A".repeat(500) + "END_OF_STDOUT"); process.stderr.write("B".repeat(500) + "END_OF_STDERR");',
      ],
    });

    expect(obs.stdoutTail?.length).toBe(tailCap);
    expect(obs.stdoutTail?.endsWith("END_OF_STDOUT")).toBe(true);
    expect(obs.stderrTail?.length).toBe(tailCap);
    expect(obs.stderrTail?.endsWith("END_OF_STDERR")).toBe(true);
  });

  it("handles graceful interruption via timeout (SIGTERM -> SIGKILL)", async () => {
    const worker = createExternalCliWorker({
      cliCommand: process.execPath,
      timeoutMs: 100,
      graceMs: 100,
    });

    const obs = await worker.execute({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
    });

    expect(obs.exitCode).not.toBe(0);
    expect(obs.stderrTail).toContain("[worker] process timed out after 100ms");

    const validation = await worker.validate(obs);
    expect(validation.passed).toBe(false);
  });

  it("handles graceful stop() invocation mid-execution", async () => {
    const worker = createExternalCliWorker({
      cliCommand: process.execPath,
      timeoutMs: 10_000,
      graceMs: 100,
    });

    const execPromise = worker.execute({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
    });

    // Wait a brief moment then call stop()
    await new Promise((r) => setTimeout(r, 50));
    await worker.stop();

    const obs = await execPromise;
    expect(obs.stderrTail).toContain("[worker] stopped by stop()");

    // Calling stop() again should be a safe no-op
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it("handles spawn error (e.g. command not found) gracefully without throwing", async () => {
    const worker = createExternalCliWorker({
      cliCommand: "non_existent_binary_xyz_12345",
      timeoutMs: 1000,
    });

    const obs = await worker.execute({
      command: "non_existent_binary_xyz_12345",
      args: [],
    });

    expect(obs.exitCode).toBeUndefined();
    expect(obs.stderrTail).toBeDefined();
    expect(obs.durationMs).toBeGreaterThanOrEqual(0);

    const validation = await worker.validate(obs);
    expect(validation.passed).toBe(false);
  });

  it("supports custom validation hooks", async () => {
    const worker = new ExternalCliWorker({
      cliCommand: process.execPath,
      validateHook: (obs) => {
        return obs.stdoutTail?.includes("READY_OK") ?? false;
      },
    });

    const obs1 = await worker.execute({
      command: process.execPath,
      args: ["-e", 'console.log("NOT_READY");'],
    });
    const val1 = await worker.validate(obs1);
    expect(val1.passed).toBe(false);
    expect(val1.checks.find((c) => c.name === "custom-validate-hook")?.passed).toBe(false);

    const obs2 = await worker.execute({
      command: process.execPath,
      args: ["-e", 'console.log("READY_OK");'],
    });
    const val2 = await worker.validate(obs2);
    expect(val2.passed).toBe(true);
    expect(val2.checks.find((c) => c.name === "custom-validate-hook")?.passed).toBe(true);
  });

  it("integrates seamlessly into runBrokeredExecution broker loop", async () => {
    const worker = createExternalCliWorker({
      cliCommand: process.execPath,
      timeoutMs: 5000,
    });

    const result = await runBrokeredExecution(
      {
        validation: [`-e 'console.log("broker step"); process.exit(0);'`],
        policy: {
          maxRounds: 2,
          totalBudgetMs: 10_000,
          stopOnValidationPass: true,
        },
      },
      worker
    );

    expect(result.status).toBe("completed");
    expect(result.rounds).toBe(1);
    expect(result.validation?.passed).toBe(true);
    expect(result.stopReason).toBe("validation-passed");
    expect(result.observations[0]?.stdoutTail).toContain("broker step");
  });
});
