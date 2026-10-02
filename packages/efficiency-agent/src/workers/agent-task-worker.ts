import { spawn, type ChildProcess } from "node:child_process";
import type {
  ValidationOutcome,
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "../domain.js";
import { killProcessTree, resolveSpawn } from "../host/spawn-command.js";
import { createLocalCommandWorker } from "./local-command-worker.js";

/**
 * Agent Task Worker (2.x plan §16): the worker that actually PERFORMS a task.
 * Each round runs an external agent CLI (Claude Code, Codex, Gemini, …) with
 * the round's prompt on stdin, then validates with real commands. The other
 * workers only run validation strings; this one is the executor.
 *
 * Success requires evidence: a zero exit from the agent AND every validation
 * command passing. With no validation commands the round is reported as
 * unverified (passed=false, `unverified()` true) — never as success.
 */

export interface AgentExecutorSpec {
  /** CLI executable, e.g. "claude", "codex", "gemini". */
  command: string;
  /** Fixed arguments; "{prompt}" is replaced only when promptVia = "arg". */
  args: string[];
  promptVia: "stdin" | "arg";
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface AgentTaskWorkerOptions {
  executor: AgentExecutorSpec;
  cwd: string;
  /** Validation commands run after each agent round (shell-free). */
  validation: string[];
  /** Builds the round prompt; `feedback` is the previous round's failure. */
  buildPrompt: (round: number, feedback?: string) => string;
  validationTimeoutMs?: number;
}

export interface AgentTaskWorker extends WorkerAdapter {
  /** The last round ran cleanly but no validation command judged it. */
  unverified(): boolean;
  /** Full (capped) stdout of the last agent round — the task's answer/output. */
  lastOutput(): string;
  /** Agent invocations actually made. */
  invocations(): number;
  /** Failure feedback (agent exit or validation output) from the last validate(). */
  lastFeedback?(): string | undefined;
}

const OUTPUT_CAP = 64_000;
const TAIL_CAP = 2_000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60_000;

function tail(text: string, cap = TAIL_CAP): string {
  return text.length > cap ? text.slice(text.length - cap) : text;
}

export function createAgentTaskWorker(options: AgentTaskWorkerOptions): AgentTaskWorker {
  const name = `agent:${options.executor.command}`;
  const validator = createLocalCommandWorker({
    name: "validator",
    defaultTimeoutMs: options.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS,
  });
  let round = 0;
  let feedback: string | undefined;
  let pendingPrompt = "";
  let lastStdout = "";
  let lastUnverified = false;
  let invocationCount = 0;
  let child: ChildProcess | undefined;

  return {
    name,

    async prepare(): Promise<WorkerCommand | undefined> {
      round += 1;
      pendingPrompt = options.buildPrompt(round, feedback);
      const args =
        options.executor.promptVia === "arg"
          ? options.executor.args.map((arg) => (arg === "{prompt}" ? pendingPrompt : arg))
          : options.executor.args;
      return { command: options.executor.command, args, cwd: options.cwd, timeoutMs: options.executor.timeoutMs };
    },

    execute(command: WorkerCommand): Promise<WorkerObservation> {
      const startedAt = Date.now();
      const spec = resolveSpawn(command.command, command.args);
      if (spec.viaCmdShim && options.executor.promptVia === "arg") {
        return Promise.resolve({
          stderrTail:
            "refusing to pass task text through cmd.exe as an argument (injection risk); use --prompt-via stdin",
          durationMs: 0,
        });
      }
      invocationCount += 1;
      return new Promise<WorkerObservation>((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (exitCode: number | undefined, extra?: string) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          child = undefined;
          lastStdout = stdout.slice(-OUTPUT_CAP);
          const err = [stderr, extra, timedOut ? `[agent] timed out after ${command.timeoutMs}ms` : undefined]
            .filter((part): part is string => Boolean(part))
            .join("\n");
          resolve({
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(stdout ? { stdoutTail: tail(stdout) } : {}),
            ...(err ? { stderrTail: tail(err) } : {}),
            durationMs: Date.now() - startedAt,
          });
        };
        let proc: ChildProcess;
        try {
          proc = spawn(spec.command, spec.args, {
            cwd: command.cwd ?? options.cwd,
            env: { ...process.env, ...options.executor.env },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          });
        } catch (error) {
          finish(undefined, error instanceof Error ? error.message : String(error));
          return;
        }
        child = proc;
        timer = setTimeout(() => {
          timedOut = true;
          killProcessTree(proc, "SIGTERM");
          setTimeout(() => {
            killProcessTree(proc, "SIGKILL");
            // A grandchild that escaped the kill may still hold the pipes.
            setTimeout(() => {
              proc.stdout?.destroy();
              proc.stderr?.destroy();
              finish(undefined);
            }, 2_000).unref();
          }, 2_000).unref();
        }, command.timeoutMs ?? options.executor.timeoutMs);
        proc.stdout?.setEncoding("utf8");
        proc.stderr?.setEncoding("utf8");
        proc.stdout?.on("data", (chunk: string) => {
          stdout = (stdout + chunk).slice(-OUTPUT_CAP * 2);
        });
        proc.stderr?.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-TAIL_CAP * 4);
        });
        proc.on("error", (error) => finish(undefined, error.message));
        proc.on("close", (code) => finish(code ?? undefined));
        if (options.executor.promptVia === "stdin") {
          proc.stdin?.on("error", () => undefined);
          proc.stdin?.end(pendingPrompt, "utf8");
        } else {
          proc.stdin?.end();
        }
      });
    },

    async validate(observation: WorkerObservation): Promise<ValidationOutcome> {
      lastUnverified = false;
      const executorOk = observation.exitCode === 0;
      const checks: ValidationOutcome["checks"] = [{ name: "agent-exit-code", passed: executorOk }];
      if (!executorOk) {
        feedback = `the agent exited with code ${observation.exitCode ?? "none"}: ${tail(observation.stderrTail ?? "", 600)}`;
        return { passed: false, checks };
      }
      if (options.validation.length === 0) {
        lastUnverified = true;
        checks.push({ name: "no-validation-commands", passed: false });
        return { passed: false, checks };
      }
      const failures: string[] = [];
      for (const spec of options.validation) {
        const command = await validator.prepare([spec]);
        if (!command) continue;
        const obs = await validator.execute({ ...command, cwd: options.cwd });
        const outcome = await validator.validate(obs);
        checks.push({ name: `validate: ${spec}`, passed: outcome.passed });
        if (!outcome.passed) {
          failures.push(`\`${spec}\` failed (exit ${obs.exitCode ?? "none"}):\n${tail(`${obs.stdoutTail ?? ""}\n${obs.stderrTail ?? ""}`, 1_500)}`);
        }
      }
      feedback = failures.length > 0 ? failures.join("\n\n") : undefined;
      return { passed: failures.length === 0, checks };
    },

    async stop(): Promise<void> {
      const proc = child;
      child = undefined;
      if (proc) killProcessTree(proc, "SIGTERM");
      await validator.stop();
    },

    unverified: () => lastUnverified,
    lastOutput: () => lastStdout,
    lastFeedback: () => feedback,
    invocations: () => invocationCount,
  };
}
