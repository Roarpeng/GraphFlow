import { execFile, type ExecFileException } from "node:child_process";
import type {
  ValidationOutcome,
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "../domain.js";

/**
 * P2 worker #1 — progressive onboarding (2.x plan §16): a LOCAL COMMAND
 * worker that turns validation strings into `execFile` invocations.
 *
 * P2 第一批 worker：本地命令 worker。把 validation 字符串解析为
 * command + args，经 node:child_process 的 execFile 执行（绝不拼 shell
 * 字符串），永不因超时/非零退出/启动失败而抛错——一切异常都以
 * WorkerObservation 的形式返回，交由 broker 决策。
 *
 * Safety rules:
 *  - `execFile(command, args)` only — a command string is never evaluated by
 *    a shell, so validation specs cannot inject shell syntax.
 *  - Timeout (default 30s) and stop() both kill via SIGTERM, through the
 *    execFile `timeout` handle plus an AbortController signal.
 *  - stdout/stderr are capped ("tails") so a chatty command cannot flood the
 *    observation record.
 */

/** Hard cap for captured stdout/stderr tails. 输出尾部截断上限。 */
const TAIL_CAP = 2_000;
/** Default per-command timeout when neither the command nor options set one. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface LocalCommandWorkerOptions {
  /** Worker name surfaced in traces. Defaults to "local-command". */
  name?: string;
  /** Default timeout per command when WorkerCommand.timeoutMs is unset. */
  defaultTimeoutMs?: number;
}

function cap(text: string): string {
  return text.length > TAIL_CAP ? text.slice(0, TAIL_CAP) : text;
}

/**
 * Tokenize one validation spec: split on whitespace, then strip one matched
 * pair of surrounding quotes from a token ("quoted arg" / 'quoted arg').
 *
 * 按空白切分，再剥掉 token 外层成对引号。纯空白切分会把
 * `node -e "process.exit(1)"` 解析成带字面引号的代码——node 求值字符串
 * 字面量后以 0 退出，验证语义直接被破坏；因此引号剥离是必需的最小解析。
 */
function tokenize(spec: string): string[] {
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
 * Translate an execFile completion into an observation. NEVER throws.
 * 将 execFile 的完成回调翻译为观察记录，任何失败路径都不抛错：
 *  - error === null               → exitCode 0
 *  - typeof error.code === number → 进程退出码（非零失败）
 *  - error.code === "ABORT_ERR"   → stop() 主动中止
 *  - 其他字符串 code（ENOENT 等）  → 启动失败，stderrTail 记错误信息
 *  - code 为 null 且 killed        → 超时被 SIGTERM 杀死
 */
function toObservation(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
  durationMs: number,
  timeoutMs: number
): WorkerObservation {
  if (error === null) {
    return {
      exitCode: 0,
      ...(stdout !== "" ? { stdoutTail: cap(stdout) } : {}),
      ...(stderr !== "" ? { stderrTail: cap(stderr) } : {}),
      durationMs,
    };
  }
  const code = error.code;
  if (typeof code === "number") {
    return {
      exitCode: code,
      ...(stdout !== "" ? { stdoutTail: cap(stdout) } : {}),
      ...(stderr !== "" ? { stderrTail: cap(stderr) } : {}),
      durationMs,
    };
  }
  if (code === "ABORT_ERR") {
    const note = "[worker] stopped by stop()";
    return {
      ...(stdout !== "" ? { stdoutTail: cap(stdout) } : {}),
      stderrTail: cap(stderr !== "" ? `${stderr}\n${note}` : note),
      durationMs,
    };
  }
  if (typeof code === "string") {
    // Spawn/exec failure (ENOENT, EACCES, ...): no process ever ran.
    return {
      ...(stdout !== "" ? { stdoutTail: cap(stdout) } : {}),
      stderrTail: cap(error.message),
      durationMs,
    };
  }
  // Killed by signal without a numeric exit: the execFile timeout handle.
  const note = `[worker] process killed by signal ${error.signal ?? "unknown"} (timeout ${timeoutMs}ms or stop())`;
  return {
    ...(stdout !== "" ? { stdoutTail: cap(stdout) } : {}),
    stderrTail: cap(stderr !== "" ? `${stderr}\n${note}` : note),
    durationMs,
  };
}

/**
 * Create the local command worker. One worker instance tracks at most one
 * in-flight child; `stop()` aborts it and is a safe no-op at any other point
 * in the lifecycle (including after completion).
 */
export function createLocalCommandWorker(
  options?: LocalCommandWorkerOptions
): WorkerAdapter {
  const name = options?.name ?? "local-command";
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Abort handle for the in-flight execute (also referenced by stop()). */
  let inFlight: AbortController | undefined;

  return {
    name,

    /**
     * Parse each validation string; the first string that yields a non-empty
     * token list defines this round's command (command = first token,
     * args = the rest). Returns undefined when there is nothing to run —
     * the broker treats that as "no validation command".
     *
     * 解析每条 validation 字符串；第一条能解析出 token 的作为本轮命令。
     * 空列表（或全部为空白）返回 undefined。
     */
    async prepare(validation: string[]): Promise<WorkerCommand | undefined> {
      for (const spec of validation) {
        const tokens = tokenize(spec);
        if (tokens.length === 0) {
          continue;
        }
        const [command = "", ...args] = tokens;
        return { command, args };
      }
      return undefined;
    },

    /**
     * Run one command with execFile (no shell). Timeout (command override →
     * worker default → 30s) kills via SIGTERM; non-zero exits, timeouts and
     * spawn errors all come back as observations, never as exceptions.
     */
    execute(command: WorkerCommand): Promise<WorkerObservation> {
      const startedAt = Date.now();
      const timeoutMs = command.timeoutMs ?? defaultTimeoutMs;
      return new Promise<WorkerObservation>((resolve) => {
        let settled = false;
        const controller = new AbortController();
        execFile(
          command.command,
          command.args,
          {
            timeout: timeoutMs,
            killSignal: "SIGTERM",
            windowsHide: true,
            signal: controller.signal,
            ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
          },
          (error, stdout, stderr) => {
            if (settled) {
              return;
            }
            settled = true;
            if (inFlight === controller) {
              inFlight = undefined;
            }
            resolve(toObservation(error, stdout, stderr, Date.now() - startedAt, timeoutMs));
          }
        );
        inFlight = controller;
      });
    },

    /**
     * Pass criterion is the exit code (commands may legitimately warn on
     * stderr — npm deprecations, lint notices — so stderr emptiness is an
     * advisory check, not a pass condition). One observation = one command,
     * hence exactly one "exit-code" check plus one "stderr-empty" check.
     */
    async validate(observation: WorkerObservation): Promise<ValidationOutcome> {
      const exitPassed = observation.exitCode === 0;
      const stderrEmpty =
        observation.stderrTail === undefined || observation.stderrTail.length === 0;
      return {
        passed: exitPassed,
        checks: [
          { name: "exit-code", passed: exitPassed },
          { name: "stderr-empty", passed: stderrEmpty },
        ],
      };
    },

    /**
     * Lifecycle finalizer: abort the in-flight child (SIGTERM through the
     * execFile signal handle). Safe no-op when nothing is running, after
     * completion, or called twice — never throws.
     */
    async stop(): Promise<void> {
      const controller = inFlight;
      if (controller === undefined) {
        return;
      }
      inFlight = undefined;
      try {
        controller.abort();
      } catch {
        // stop() must never throw regardless of the controller's state.
      }
    },
  };
}
