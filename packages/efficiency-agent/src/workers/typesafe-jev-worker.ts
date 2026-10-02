import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ValidationOutcome,
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "../domain.js";
import { readCredentialEnv, type CredentialEnvOptions } from "../host/credential-env.js";
import { measured, type Measurement } from "../measurement.js";

/**
 * TypeSafe-JEV Worker Adapter — REAL API contract (docs.typesafe.ai/api).
 *
 * Jev is a System One model: it answers TYPED questions (choice/score/noul)
 * with probabilities and confidence — it does not generate text, so it can
 * never author commands or patches. The previous implementation chatted with
 * a fabricated `api.typesafe-jev.ai/v1/chat/completions` endpoint and asked
 * for free-form JSON actions: wrong protocol, wrong domain, and the direct
 * cause of "key configured but cannot connect".
 *
 * Correct capability mapping:
 *  - prepare: deterministic tokenization (Layer A — no model involved);
 *  - execute: the command runs LOCALLY via execFile (no shell interpolation);
 *  - validate: Jev judges the OUTCOME over the real System One endpoint —
 *    a `noul` question over {command, exitCode, output tails}. Jev may veto
 *    a zero-exit run (warning-laden output); when Jev is unreachable the
 *    validator fails OPEN to exit-code semantics (identical to the local
 *    command worker — no key required for local validation);
 *  - stop: aborts in-flight execution and any pending judgment.
 *
 * All cost-bearing numbers follow the Measurement Contract (R1–R6): wall
 * time and System One usage tokens are measured(); nothing is invented.
 */

const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const TYPESAFE_DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 60_000;
const TAIL_CAP = 2_000;
/** noul >= 0.5 counts as "the judgment says this run succeeded". */
const NOUL_PASS_THRESHOLD = 0.5;

const execFileAsync = promisify(execFile);

export interface TypeSafeJevWorkerOptions {
  /** Worker name surfaced in traces. Defaults to "typesafe-jev". */
  name?: string;
  /** System One base URL. Defaults to TYPESAFE_BASE_URL or https://api.typesafe.ai. */
  baseUrl?: string;
  /**
   * Bearer key. Defaults to TYPESAFE_API_KEY from process.env, then (Windows)
   * the persisted user/machine environment. Absent => local-only validation.
   */
  apiKey?: string;
  /** Lookup options for the default key source (tests inject platform/exec). */
  credentialEnv?: CredentialEnvOptions;
  /** System One model id. Defaults to "jev-latest". */
  model?: string;
  /** Default timeout for command execution and judgment calls. */
  timeoutMs?: number;
  /** Custom fetch for tests. */
  fetch?: typeof globalThis.fetch;
}

export interface TypeSafeJevObservation extends WorkerObservation {
  /** The command this observation came from (judgment state evidence). */
  commandLine?: string;
  /** True when the Jev judgment round-tripped and was applied. */
  typeSafeValid: boolean;
  violations?: string[];
  measurements?: {
    durationMs: Measurement;
    judgmentTokens?: Measurement;
  };
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, { type: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function cap(text: string): string {
  return text.length > TAIL_CAP ? text.slice(0, TAIL_CAP) : text;
}

/**
 * Tokenize a validation command specification (quotes respected).
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

interface JudgmentOutcome {
  ok: boolean;
  noul?: number;
  confidenceNote: string;
  judgmentTokens?: Measurement;
}

/**
 * Ask the REAL System One endpoint whether this execution succeeded.
 * Never throws — every failure is reported as "unavailable" so validate()
 * can fail open to exit-code semantics.
 */
async function judgeOutcome(
  state: Record<string, unknown>,
  opts: { baseUrl: string; apiKey: string; model: string; fetchImpl: typeof globalThis.fetch; timeoutMs: number; signal?: AbortSignal }
): Promise<JudgmentOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const response = await opts.fetchImpl(`${opts.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        state,
        model: opts.model,
        questions: {
          succeeded: {
            type: "noul",
            instructions:
              "Did this command execution succeed at what it was supposed to validate? Judge from the exit code and output evidence in the state.",
            criteria: {
              true: "Completed the intended check; output supports success",
              false: "Failed, errored, or the output contradicts success",
            },
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        confidenceNote: `jev-unavailable: http ${response.status} ${body.slice(0, 120)}`,
      };
    }
    const payload = (await response.json()) as SystemOneResponse;
    const answer = payload.answers?.["succeeded"];
    if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") {
      return { ok: false, confidenceNote: "jev-unavailable: malformed answer" };
    }
    return {
      ok: true,
      noul: answer.noul,
      confidenceNote: `jev ${payload.model ?? opts.model}: noul=${answer.noul.toFixed(2)}`,
      ...(payload.usage && typeof payload.usage.input_tokens === "number"
        ? {
            judgmentTokens: measured(
              payload.usage.input_tokens + (payload.usage.output_tokens ?? 0)
            ),
          }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, confidenceNote: `jev-unavailable: ${message.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export function createTypeSafeJevWorker(options?: TypeSafeJevWorkerOptions): WorkerAdapter {
  const name = options?.name ?? "typesafe-jev";
  const baseUrl = (
    options?.baseUrl ??
    process.env.TYPESAFE_BASE_URL ??
    TYPESAFE_DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  // Explicit option wins, then env (registry fallback on Windows), resolved
  // lazily so prepare/execute never touch the registry. NOTE: DEEPSEEK_API_KEY
  // is deliberately NOT a fallback — api.typesafe.ai and api.deepseek.com are
  // different services with different keys (the old cross-fallback produced 401s).
  const resolveApiKey = (): string =>
    options?.apiKey !== undefined
      ? options.apiKey
      : (readCredentialEnv("TYPESAFE_API_KEY", options?.credentialEnv) ?? "");
  const model = options?.model ?? TYPESAFE_DEFAULT_MODEL;
  const defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options?.fetch ?? globalThis.fetch;

  let inFlight: AbortController | undefined;

  return {
    name,

    /** Deterministic Layer A prep — Jev never authors commands. */
    async prepare(validation: string[]): Promise<WorkerCommand | undefined> {
      for (const spec of validation) {
        const tokens = tokenizeValidationSpec(spec);
        if (tokens.length === 0) continue;
        const [command = "", ...args] = tokens;
        return { command, args };
      }
      return undefined;
    },

    /** The command runs LOCALLY; the Jev judgment happens in validate(). */
    async execute(command: WorkerCommand): Promise<TypeSafeJevObservation> {
      const startedAt = Date.now();
      const timeoutMs = command.timeoutMs ?? defaultTimeoutMs;
      const controller = new AbortController();
      inFlight = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { stdout, stderr } = await execFileAsync(command.command, command.args, {
          ...(command.cwd ? { cwd: command.cwd } : {}),
          timeout: timeoutMs,
          signal: controller.signal,
          maxBuffer: 4 * 1024 * 1024,
        });
        return {
          exitCode: 0,
          stdoutTail: cap(stdout),
          ...(stderr ? { stderrTail: cap(stderr) } : {}),
          durationMs: Date.now() - startedAt,
          commandLine: `${command.command} ${command.args.join(" ")}`.trim(),
          typeSafeValid: false,
          measurements: { durationMs: measured(Date.now() - startedAt) },
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
        const aborted = controller.signal.aborted || err.killed === true;
        const exitCode: number =
          typeof err.code === "number" ? err.code : aborted ? 130 : 1;
        return {
          exitCode,
          ...(err.stdout ? { stdoutTail: cap(String(err.stdout)) } : {}),
          stderrTail: cap(
            aborted
              ? `[typesafe-jev] process killed (timeout ${timeoutMs}ms or stop())`
              : err.message
          ),
          durationMs: Date.now() - startedAt,
          commandLine: `${command.command} ${command.args.join(" ")}`.trim(),
          typeSafeValid: false,
          measurements: { durationMs: measured(Date.now() - startedAt) },
        };
      } finally {
        clearTimeout(timer);
        if (inFlight === controller) inFlight = undefined;
      }
    },

    /**
     * Jev judges the outcome over the real System One endpoint (noul).
     * No key / unreachable => fail open to pure exit-code semantics.
     */
    async validate(observation: WorkerObservation): Promise<ValidationOutcome> {
      const exitOk = observation.exitCode === 0;
      const apiKey = resolveApiKey();
      if (!apiKey) {
        return {
          passed: exitOk,
          checks: [
            { name: "exit-code", passed: exitOk },
            { name: "jev-verdict", passed: exitOk },
          ],
        };
      }
      const judgment = await judgeOutcome(
        {
          commandLine: (observation as TypeSafeJevObservation).commandLine ?? "",
          exitCode: observation.exitCode ?? null,
          stdoutTail: observation.stdoutTail ?? "",
          stderrTail: observation.stderrTail ?? "",
        },
        { baseUrl, apiKey, model, fetchImpl, timeoutMs: defaultTimeoutMs }
      );
      if (!judgment.ok) {
        return {
          passed: exitOk,
          checks: [
            { name: "exit-code", passed: exitOk },
            { name: "jev-verdict", passed: exitOk },
          ],
        };
      }
      const jevSaysPass = (judgment.noul ?? 0) >= NOUL_PASS_THRESHOLD;
      const finalObservation = observation as TypeSafeJevObservation;
      finalObservation.typeSafeValid = true;
      finalObservation.violations = jevSaysPass ? [] : [judgment.confidenceNote];
      if (judgment.judgmentTokens) {
        finalObservation.measurements = {
          durationMs: finalObservation.measurements?.durationMs ?? measured(0),
          judgmentTokens: judgment.judgmentTokens,
        };
      }
      return {
        passed: exitOk && jevSaysPass,
        checks: [
          { name: "exit-code", passed: exitOk },
          { name: "jev-verdict", passed: jevSaysPass },
        ],
      };
    },

    async stop(): Promise<void> {
      inFlight?.abort();
      inFlight = undefined;
    },
  };
}
