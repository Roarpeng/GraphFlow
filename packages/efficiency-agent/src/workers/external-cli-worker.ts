import { spawn, type ChildProcess } from "node:child_process";
import type {
  ValidationOutcome,
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "../domain.js";

/**
 * P2 worker #3 — External CLI Worker Adapter (2.x plan §16).
 *
 * Adapts generic external CLI programming agents (Claude Code, Codex CLI, Cursor, etc.)
 * to the GraphFlow Efficiency Agent Standard Worker Adapter interface.
 *
 * Key guarantees:
 *  - Configurable CLI command (claude, codex, cursor), args, env, cwd, timeoutMs.
 *  - Streaming stdout/stderr capture with safety tail cap (TAIL_CAP).
 *  - Full lifecycle graceful abort via AbortController (SIGTERM -> grace period -> SIGKILL).
 *  - Never throws: process errors, timeouts, aborts, and spawn failures are mapped into
 *    structured WorkerObservation records.
 *  - Structured validation outcome analysis.
 */

/** Hard cap for captured stdout/stderr tails (characters). */
export const DEFAULT_TAIL_CAP = 2_000;
/** Default per-command timeout (60s). */
export const DEFAULT_CLI_TIMEOUT_MS = 60_000;
/** Default grace period between SIGTERM and SIGKILL (500ms). */
export const DEFAULT_GRACE_MS = 500;

export interface ExternalCliWorkerOptions {
  /** Worker name surfaced in traces. Defaults to "external-cli:{cliCommand}" or "external-cli". */
  name?: string;
  /** Primary CLI executable to launch, e.g. "claude", "codex", "cursor". Defaults to "claude". */
  cliCommand?: string;
  /** Base arguments prepended to any executed command. */
  args?: string[];
  /** Environment variables merged on top of process.env. */
  env?: Record<string, string>;
  /** Working directory for child processes. Defaults to process.cwd(). */
  cwd?: string;
  /** Timeout in milliseconds. Defaults to 60,000ms. */
  timeoutMs?: number;
  /** Grace period in milliseconds between SIGTERM and SIGKILL on abort. Defaults to 500ms. */
  graceMs?: number;
  /** Maximum length of stdout/stderr tails captured in observations. Defaults to 2,000. */
  tailCap?: number;
  /** Optional custom validation hook to inspect observation stdout/stderr. */
  validateHook?: (obs: WorkerObservation) => boolean | Promise<boolean>;
  /** Optional custom spawn function for testing. */
  spawnFn?: typeof spawn;
}

/**
 * Tokenize a validation spec string: split on whitespace while respecting quoted arguments.
 */
export function tokenizeValidationSpec(spec: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of spec.matchAll(pattern)) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    } else if (match[3] !== undefined) {
      tokens.push(match[3]);
    }
  }
  return tokens;
}

/**
 * Truncate a text string keeping only the trailing `cap` characters.
 */
function capTail(text: string, capLength: number): string {
  if (text.length <= capLength) {
    return text;
  }
  return text.slice(text.length - capLength);
}

/**
 * Standard External CLI Worker Adapter implementation.
 */
export class ExternalCliWorker implements WorkerAdapter {
  readonly name: string;
  private readonly defaultCliCommand: string;
  private readonly baseArgs: string[];
  private readonly defaultEnv?: Record<string, string> | undefined;
  private readonly defaultCwd?: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly graceMs: number;
  private readonly tailCap: number;
  private readonly validateHook?: ((obs: WorkerObservation) => boolean | Promise<boolean>) | undefined;
  private readonly spawnFn: typeof spawn;

  /** Active execution controller and child handle for abort lifecycle. */
  private currentChild?: {
    process: ChildProcess;
    controller: AbortController;
    timer?: NodeJS.Timeout | undefined;
    graceTimer?: NodeJS.Timeout | undefined;
  } | undefined;

  constructor(options: ExternalCliWorkerOptions = {}) {
    const cli = options.cliCommand ?? "claude";
    this.name = options.name ?? `external-cli:${cli}`;
    this.defaultCliCommand = cli;
    this.baseArgs = options.args ?? [];
    this.defaultEnv = options.env;
    this.defaultCwd = options.cwd;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.tailCap = options.tailCap ?? DEFAULT_TAIL_CAP;
    this.validateHook = options.validateHook;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * Parse validation specs into a WorkerCommand.
   * If validation contains executable tokens, maps the first non-empty line.
   * If the first token matches or specifies a command, combines with configured base args.
   */
  async prepare(validation: string[]): Promise<WorkerCommand | undefined> {
    for (const spec of validation) {
      const tokens = tokenizeValidationSpec(spec);
      if (tokens.length === 0) {
        continue;
      }

      const [firstToken = "", ...restTokens] = tokens;
      // If the spec begins with an explicit CLI command or executable
      if (firstToken === this.defaultCliCommand) {
        return {
          command: firstToken,
          args: [...this.baseArgs, ...restTokens],
          ...(this.defaultCwd !== undefined ? { cwd: this.defaultCwd } : {}),
          timeoutMs: this.defaultTimeoutMs,
        };
      }

      // If options.cliCommand is set, the spec tokens are passed as arguments to cliCommand
      return {
        command: this.defaultCliCommand,
        args: [...this.baseArgs, ...tokens],
        ...(this.defaultCwd !== undefined ? { cwd: this.defaultCwd } : {}),
        timeoutMs: this.defaultTimeoutMs,
      };
    }
    return undefined;
  }

  /**
   * Execute the CLI command with streaming stdout/stderr capture, timeout enforcement,
   * and two-stage graceful abort (SIGTERM -> grace period -> SIGKILL).
   * NEVER throws — all failures resolve to a WorkerObservation.
   */
  execute(command: WorkerCommand): Promise<WorkerObservation> {
    const startedAt = Date.now();
    const timeoutMs = command.timeoutMs ?? this.defaultTimeoutMs;
    const cwd = command.cwd ?? this.defaultCwd ?? process.cwd();
    const env = {
      ...process.env,
      ...this.defaultEnv,
    };

    return new Promise<WorkerObservation>((resolve) => {
      let settled = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let timedOut = false;
      let aborted = false;

      const controller = new AbortController();

      let child: ChildProcess;
      try {
        child = this.spawnFn(command.command, command.args, {
          cwd,
          env,
          signal: controller.signal,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (spawnError) {
        const durationMs = Date.now() - startedAt;
        const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
        resolve({
          stderrTail: capTail(msg, this.tailCap),
          durationMs,
        });
        return;
      }

      // Streaming output capture
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        if (stdoutBuffer.length > this.tailCap * 4) {
          stdoutBuffer = capTail(stdoutBuffer, this.tailCap * 2);
        }
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        if (stderrBuffer.length > this.tailCap * 4) {
          stderrBuffer = capTail(stderrBuffer, this.tailCap * 2);
        }
      });

      const cleanupHandles = () => {
        if (this.currentChild?.controller === controller) {
          if (this.currentChild.timer) clearTimeout(this.currentChild.timer);
          if (this.currentChild.graceTimer) clearTimeout(this.currentChild.graceTimer);
          this.currentChild = undefined;
        }
      };

      // Two-stage graceful killer (SIGTERM -> grace period -> SIGKILL)
      const triggerGracefulKill = (reason: "timeout" | "abort") => {
        if (reason === "timeout") timedOut = true;
        if (reason === "abort") aborted = true;

        try {
          child.kill("SIGTERM");
        } catch {
          // Process may have already exited
        }

        const graceTimer = setTimeout(() => {
          try {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          } catch {
            // Safe ignore
          }
        }, this.graceMs);

        if (this.currentChild && this.currentChild.controller === controller) {
          this.currentChild.graceTimer = graceTimer;
        }
      };

      // Set timeout handle
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          triggerGracefulKill("timeout");
        }, timeoutMs);
      }

      // Hook up active child tracking
      this.currentChild = {
        process: child,
        controller,
        ...(timer !== undefined ? { timer } : {}),
      };

      // Listen for external abort signal
      controller.signal.addEventListener(
        "abort",
        () => {
          triggerGracefulKill("abort");
        },
        { once: true }
      );

      const finalize = (exitCode?: number, signal?: NodeJS.Signals | null, errMessage?: string) => {
        if (settled) return;
        settled = true;
        cleanupHandles();

        const durationMs = Date.now() - startedAt;
        const stdoutTail = stdoutBuffer.length > 0 ? capTail(stdoutBuffer, this.tailCap) : undefined;

        const isAborted = aborted || controller.signal.aborted;
        let finalStderr = stderrBuffer;
        if (errMessage && !errMessage.includes("The operation was aborted")) {
          finalStderr = finalStderr ? `${finalStderr}\n${errMessage}` : errMessage;
        }
        if (timedOut) {
          const timeoutNote = `[worker] process timed out after ${timeoutMs}ms (SIGTERM -> SIGKILL)`;
          finalStderr = finalStderr ? `${finalStderr}\n${timeoutNote}` : timeoutNote;
        } else if (isAborted) {
          const abortNote = `[worker] stopped by stop() (SIGTERM -> SIGKILL)`;
          finalStderr = finalStderr ? `${finalStderr}\n${abortNote}` : abortNote;
        } else if (signal) {
          const signalNote = `[worker] process killed by signal ${signal}`;
          finalStderr = finalStderr ? `${finalStderr}\n${signalNote}` : signalNote;
        }

        const stderrTail = finalStderr.length > 0 ? capTail(finalStderr, this.tailCap) : undefined;

        resolve({
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(stdoutTail !== undefined ? { stdoutTail } : {}),
          ...(stderrTail !== undefined ? { stderrTail } : {}),
          durationMs,
        });
      };

      child.on("error", (error: Error) => {
        finalize(undefined, null, error.message);
      });

      child.on("close", (code, signal) => {
        finalize(code ?? undefined, signal);
      });
    });
  }

  /**
   * Validate observation output.
   * Checks exitCode === 0, inspects stderr, and applies optional validateHook.
   */
  async validate(observation: WorkerObservation): Promise<ValidationOutcome> {
    const exitPassed = observation.exitCode === 0;
    const stderrClean =
      observation.stderrTail === undefined ||
      (!observation.stderrTail.includes("[worker] process timed out") &&
        !observation.stderrTail.includes("[worker] stopped by stop()") &&
        !observation.stderrTail.toLowerCase().includes("fatal:"));

    const checks: Array<{ name: string; passed: boolean }> = [
      { name: "exit-code", passed: exitPassed },
      { name: "stderr-healthy", passed: stderrClean },
    ];

    let customPassed = true;
    if (this.validateHook) {
      try {
        customPassed = await this.validateHook(observation);
      } catch {
        customPassed = false;
      }
      checks.push({ name: "custom-validate-hook", passed: customPassed });
    }

    const passed = exitPassed && stderrClean && customPassed;

    return {
      passed,
      checks,
    };
  }

  /**
   * Gracefully stop any active execution.
   * Safe no-op when nothing is running, already stopped, or called multiple times.
   */
  async stop(): Promise<void> {
    const current = this.currentChild;
    if (!current) {
      return;
    }
    this.currentChild = undefined;

    try {
      current.controller.abort();
    } catch {
      // Must never throw
    }
  }
}

/**
 * Factory function to create an External CLI Worker adapter.
 */
export function createExternalCliWorker(options?: ExternalCliWorkerOptions): WorkerAdapter {
  return new ExternalCliWorker(options);
}

/**
 * Convenient preset for Claude Code CLI.
 */
export function createClaudeCodeWorker(options?: Omit<ExternalCliWorkerOptions, "cliCommand">): WorkerAdapter {
  return new ExternalCliWorker({
    name: "external-cli:claude",
    cliCommand: "claude",
    ...options,
  });
}

/**
 * Convenient preset for OpenAI Codex CLI.
 */
export function createCodexCliWorker(options?: Omit<ExternalCliWorkerOptions, "cliCommand">): WorkerAdapter {
  return new ExternalCliWorker({
    name: "external-cli:codex",
    cliCommand: "codex",
    ...options,
  });
}

/**
 * Convenient preset for Cursor CLI.
 */
export function createCursorWorker(options?: Omit<ExternalCliWorkerOptions, "cliCommand">): WorkerAdapter {
  return new ExternalCliWorker({
    name: "external-cli:cursor",
    cliCommand: "cursor",
    ...options,
  });
}
