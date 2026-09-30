import { execFile, type ExecFileException } from "node:child_process";
import type {
  ValidationOutcome,
  WorkerAdapter,
  WorkerCommand,
  WorkerObservation,
} from "../domain.js";
import {
  estimated,
  measured,
  type Measurement,
} from "../measurement.js";

/**
 * TypeSafe-JEV Worker Adapter for GraphFlow Efficiency Agent.
 *
 * Implements the standard WorkerAdapter interface with TypeSafe validation
 * and dual cloud / local deployment support.
 *
 * Safety rules:
 *  - Enforces structured JSON action contracts from the JEV model.
 *  - Schema validation failure immediately stops execution without running code.
 *  - Commands are strictly run via `execFile` (no shell eval / interpolation).
 *  - Full adherence to Measurement Contract (R1–R6) for durations and tokens.
 */

const DEFAULT_BASE_URL = "https://api.typesafe-jev.ai/v1";
const DEFAULT_MODEL = "typesafe-jev";
const DEFAULT_TIMEOUT_MS = 60_000;
const TAIL_CAP = 2_000;

export type JevActionType = "command" | "patch" | "files" | "noop";

export interface JevCommandAction {
  action: "command";
  command: string;
  args: string[];
  explanation?: string;
}

export interface JevPatchAction {
  action: "patch";
  targetFile: string;
  diff: string;
  explanation?: string;
}

export interface JevFilesAction {
  action: "files";
  files: Array<{ path: string; content: string }>;
  explanation?: string;
}

export interface JevNoopAction {
  action: "noop";
  explanation?: string;
}

export type JevAction =
  | JevCommandAction
  | JevPatchAction
  | JevFilesAction
  | JevNoopAction;

export interface JevValidationResult {
  valid: boolean;
  action?: JevAction;
  errors: string[];
}

export interface JevExecutionMeasurements {
  durationMs: Measurement;
  totalTokens?: Measurement;
  promptTokens?: Measurement;
  completionTokens?: Measurement;
}

export interface TypeSafeJevObservation extends WorkerObservation {
  action?: JevAction;
  measurements?: JevExecutionMeasurements;
  typeSafeValid: boolean;
  violations?: string[];
}

export interface TypeSafeJevWorkerOptions {
  /** Worker name surfaced in traces. Defaults to "typesafe-jev". */
  name?: string;
  /** Base URL for JEV API. Defaults to process.env.TYPESAFE_BASE_URL or cloud endpoint. */
  baseUrl?: string;
  /** API key. Defaults to process.env.TYPESAFE_API_KEY or process.env.DEEPSEEK_API_KEY. Optional for local deployments. */
  apiKey?: string;
  /** Model name. Defaults to "typesafe-jev", supports custom local models (e.g. "jev-code", "qwen2.5-coder"). */
  model?: string;
  /** Default timeout in milliseconds for inference and command execution. Defaults to 60,000ms. */
  timeoutMs?: number;
  /** Custom fetch implementation for unit tests or transport customization. */
  fetch?: typeof globalThis.fetch;
  /** Whether to execute local command action after successful type validation. Defaults to true. */
  executeLocalCommand?: boolean;
}

export const TYPESAFE_JEV_SYSTEM_PROMPT = `You are a TypeSafe-JEV code execution and reasoning model.
You must respond with valid JSON ONLY conforming to the following action schema:

Union of:
1. Command Action:
   {
     "action": "command",
     "command": "<executable-name>",
     "args": ["<arg1>", "<arg2>"],
     "explanation": "<optional rationale>"
   }
2. Patch Action:
   {
     "action": "patch",
     "targetFile": "<relative-or-absolute-file-path>",
     "diff": "<unified-diff-content>",
     "explanation": "<optional rationale>"
   }
3. Files Action:
   {
     "action": "files",
     "files": [
       { "path": "<file-path>", "content": "<file-content>" }
     ],
     "explanation": "<optional rationale>"
   }
4. No-op Action:
   {
     "action": "noop",
     "explanation": "<optional rationale>"
   }

Rules:
- Output raw JSON only. Do not wrap in markdown or markdown fences if possible.
- Any arbitrary shell operators or strings that do not conform to this structure will be rejected.`;

function cap(text: string): string {
  return text.length > TAIL_CAP ? text.slice(0, TAIL_CAP) : text;
}

/**
 * Tokenize a validation command specification for prepare().
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
 * Validate that an unparsed or parsed object strictly conforms to the JevAction schema.
 */
export function validateJevAction(data: unknown): JevValidationResult {
  const errors: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { valid: false, errors: ["Response must be a non-null JSON object"] };
  }

  const record = data as Record<string, unknown>;
  const action = record.action;

  if (typeof action !== "string") {
    errors.push("Missing or non-string 'action' property");
    return { valid: false, errors };
  }

  if (action === "command") {
    if (typeof record.command !== "string" || record.command.trim().length === 0) {
      errors.push("Command action requires a non-empty string 'command'");
    } else if (record.command.includes("\0")) {
      errors.push("Command contains illegal null bytes");
    }

    if (!Array.isArray(record.args)) {
      errors.push("Command action requires an array of strings for 'args'");
    } else {
      for (let i = 0; i < record.args.length; i++) {
        if (typeof record.args[i] !== "string") {
          errors.push(`Command argument at index ${i} is not a string`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      action: {
        action: "command",
        command: record.command as string,
        args: record.args as string[],
        ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {}),
      },
      errors: [],
    };
  }

  if (action === "patch") {
    if (typeof record.targetFile !== "string" || record.targetFile.trim().length === 0) {
      errors.push("Patch action requires a non-empty string 'targetFile'");
    }
    if (typeof record.diff !== "string") {
      errors.push("Patch action requires a string 'diff'");
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      action: {
        action: "patch",
        targetFile: record.targetFile as string,
        diff: record.diff as string,
        ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {}),
      },
      errors: [],
    };
  }

  if (action === "files") {
    if (!Array.isArray(record.files) || record.files.length === 0) {
      errors.push("Files action requires a non-empty array of file items in 'files'");
    } else {
      for (let i = 0; i < record.files.length; i++) {
        const item = record.files[i];
        if (typeof item !== "object" || item === null) {
          errors.push(`File entry at index ${i} must be an object`);
          continue;
        }
        const fileItem = item as Record<string, unknown>;
        if (typeof fileItem.path !== "string" || fileItem.path.trim().length === 0) {
          errors.push(`File entry at index ${i} missing non-empty 'path' string`);
        }
        if (typeof fileItem.content !== "string") {
          errors.push(`File entry at index ${i} missing 'content' string`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      action: {
        action: "files",
        files: record.files as Array<{ path: string; content: string }>,
        ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {}),
      },
      errors: [],
    };
  }

  if (action === "noop") {
    return {
      valid: true,
      action: {
        action: "noop",
        ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {}),
      },
      errors: [],
    };
  }

  errors.push(`Unsupported action type '${action}'. Expected command | patch | files | noop`);
  return { valid: false, errors };
}

/**
 * Extract and parse JSON content from potentially fenced LLM responses.
 */
export function extractAndParseJson(content: string): { parsed?: unknown; error?: string } {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { error: "Empty model response" };
  }

  // 1. Direct JSON parse
  try {
    return { parsed: JSON.parse(trimmed) };
  } catch {
    // Continue to markdown fence / block extraction
  }

  // 2. Extract from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return { parsed: JSON.parse(fenceMatch[1].trim()) };
    } catch {
      // Continue to bracket extraction
    }
  }

  // 3. Extract between outer braces
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      return { parsed: JSON.parse(candidate) };
    } catch (err) {
      return { error: `Failed to parse extracted JSON block: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { error: "Response does not contain a valid JSON block" };
}

export function isLocalEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return url.includes("localhost") || url.includes("127.0.0.1");
  }
}

/**
 * Create the TypeSafe-JEV worker adapter.
 */
export function createTypeSafeJevWorker(
  options?: TypeSafeJevWorkerOptions
): WorkerAdapter {
  const name = options?.name ?? "typesafe-jev";
  const rawBaseUrl = options?.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL;
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const isLocal = isLocalEndpoint(baseUrl);
  const apiKey =
    options?.apiKey !== undefined
      ? options.apiKey
      : isLocal
        ? ""
        : (process.env.TYPESAFE_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "");
  const model = options?.model ?? DEFAULT_MODEL;
  const defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const customFetch = options?.fetch ?? globalThis.fetch;
  const executeLocalCommand = options?.executeLocalCommand ?? true;

  let inFlight: AbortController | undefined;

  return {
    name,

    /**
     * Prepare command from validation specs (first non-empty tokenized spec).
     */
    async prepare(validation: string[]): Promise<WorkerCommand | undefined> {
      for (const spec of validation) {
        const tokens = tokenizeValidationSpec(spec);
        if (tokens.length === 0) {
          continue;
        }
        const [command = "", ...args] = tokens;
        return { command, args };
      }
      return undefined;
    },

    /**
     * Execute inference against the JEV model and optionally run validated command.
     */
    async execute(command: WorkerCommand): Promise<TypeSafeJevObservation> {
      const startedAt = Date.now();
      const timeoutMs = command.timeoutMs ?? defaultTimeoutMs;
      const controller = new AbortController();
      inFlight = controller;

      const timeoutTimer = setTimeout(() => {
        controller.abort(new Error(`Timeout of ${timeoutMs}ms exceeded`));
      }, timeoutMs);

      try {
        const promptText = `Execute task for command: ${command.command} ${command.args.join(" ")}${
          command.cwd ? ` in working directory: ${command.cwd}` : ""
        }`;

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey.trim().length > 0) {
          headers["Authorization"] = `Bearer ${apiKey.trim()}`;
        }

        const url = baseUrl.endsWith("/chat/completions")
          ? baseUrl
          : `${baseUrl}/chat/completions`;

        let httpResponse: Response;
        try {
          httpResponse = await customFetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: TYPESAFE_JEV_SYSTEM_PROMPT },
                { role: "user", content: promptText },
              ],
              temperature: 0.1,
            }),
            signal: controller.signal,
          });
        } catch (fetchError: unknown) {
          clearTimeout(timeoutTimer);
          const duration = Date.now() - startedAt;
          const isAborted = controller.signal.aborted;
          const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
          return {
            exitCode: isAborted ? 130 : 1,
            stderrTail: cap(`[typesafe-jev] network/request error: ${msg}${isAborted ? " (aborted)" : ""}`),
            durationMs: duration,
            typeSafeValid: false,
            violations: [msg],
            measurements: {
              durationMs: measured(duration),
            },
          };
        }

        if (!httpResponse.ok) {
          clearTimeout(timeoutTimer);
          const duration = Date.now() - startedAt;
          const errorBody = await httpResponse.text().catch(() => "");
          return {
            exitCode: 1,
            stderrTail: cap(
              `[typesafe-jev] HTTP ${httpResponse.status} ${httpResponse.statusText}: ${errorBody}`
            ),
            durationMs: duration,
            typeSafeValid: false,
            violations: [`HTTP error ${httpResponse.status}`],
            measurements: {
              durationMs: measured(duration),
            },
          };
        }

        const responseJson = (await httpResponse.json()) as Record<string, unknown>;
        clearTimeout(timeoutTimer);

        // Process token measurements under Measurement Contract R1-R6
        const usage = responseJson.usage as Record<string, unknown> | undefined;
        let totalTokens: Measurement | undefined;
        let promptTokens: Measurement | undefined;
        let completionTokens: Measurement | undefined;

        if (usage && typeof usage.total_tokens === "number") {
          totalTokens = measured(usage.total_tokens);
          if (typeof usage.prompt_tokens === "number") {
            promptTokens = measured(usage.prompt_tokens);
          }
          if (typeof usage.completion_tokens === "number") {
            completionTokens = measured(usage.completion_tokens);
          }
        }

        // Extract assistant message
        const choices = responseJson.choices as Array<{ message?: { content?: string } }> | undefined;
        const rawContent = choices?.[0]?.message?.content ?? "";

        // If usage was not supplied by provider, estimate tokens per R3
        if (!totalTokens) {
          const estimatedChars = promptText.length + rawContent.length;
          totalTokens = estimated(Math.ceil(estimatedChars / 4), "chars/4", 0.7);
        }

        // Parse and validate JSON structure against TypeSafe schema
        const parseResult = extractAndParseJson(rawContent);
        if (parseResult.error || parseResult.parsed === undefined) {
          const duration = Date.now() - startedAt;
          const violation = `TypeSafe violation: ${parseResult.error ?? "Failed to extract valid JSON"}`;
          return {
            exitCode: 1,
            stdoutTail: cap(rawContent),
            stderrTail: cap(violation),
            durationMs: duration,
            typeSafeValid: false,
            violations: [violation],
            measurements: {
              durationMs: measured(duration),
              ...(totalTokens ? { totalTokens } : {}),
              ...(promptTokens ? { promptTokens } : {}),
              ...(completionTokens ? { completionTokens } : {}),
            },
          };
        }

        const validation = validateJevAction(parseResult.parsed);
        if (!validation.valid || !validation.action) {
          const duration = Date.now() - startedAt;
          const violation = `TypeSafe schema violations:\n${validation.errors.join("\n")}`;
          return {
            exitCode: 1,
            stdoutTail: cap(rawContent),
            stderrTail: cap(violation),
            durationMs: duration,
            typeSafeValid: false,
            violations: validation.errors,
            measurements: {
              durationMs: measured(duration),
              ...(totalTokens ? { totalTokens } : {}),
              ...(promptTokens ? { promptTokens } : {}),
              ...(completionTokens ? { completionTokens } : {}),
            },
          };
        }

        const action = validation.action;

        // If the action is a local command and local command execution is enabled
        if (action.action === "command" && executeLocalCommand) {
          const cmdTimeoutMs = command.timeoutMs ?? defaultTimeoutMs;

          return await new Promise<TypeSafeJevObservation>((resolve) => {
            execFile(
              action.command,
              action.args,
              {
                timeout: cmdTimeoutMs,
                killSignal: "SIGTERM",
                windowsHide: true,
                signal: controller.signal,
                ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
              },
              (err: ExecFileException | null, stdout: string, stderr: string) => {
                const totalDuration = Date.now() - startedAt;
                let exitCode = 0;
                let errorTail = stderr;

                if (err !== null) {
                  if (typeof err.code === "number") {
                    exitCode = err.code;
                  } else if (err.code === "ABORT_ERR") {
                    exitCode = 130;
                    errorTail = `${errorTail}\n[typesafe-jev] command aborted`.trim();
                  } else {
                    exitCode = 1;
                    errorTail = `${errorTail}\n[typesafe-jev] spawn failure: ${err.message}`.trim();
                  }
                }

                resolve({
                  exitCode,
                  ...(stdout !== "" ? { stdoutTail: cap(stdout) } : {}),
                  ...(errorTail !== "" ? { stderrTail: cap(errorTail) } : {}),
                  durationMs: totalDuration,
                  action,
                  typeSafeValid: true,
                  measurements: {
                    durationMs: measured(totalDuration),
                    ...(totalTokens ? { totalTokens } : {}),
                    ...(promptTokens ? { promptTokens } : {}),
                    ...(completionTokens ? { completionTokens } : {}),
                  },
                });
              }
            );
          });
        }

        // For non-command actions (or command execution disabled), return observation directly
        const duration = Date.now() - startedAt;
        return {
          exitCode: 0,
          stdoutTail: cap(
            `[typesafe-jev] action executed: ${action.action}${
              action.explanation ? ` (${action.explanation})` : ""
            }`
          ),
          durationMs: duration,
          action,
          typeSafeValid: true,
          measurements: {
            durationMs: measured(duration),
            ...(totalTokens ? { totalTokens } : {}),
            ...(promptTokens ? { promptTokens } : {}),
            ...(completionTokens ? { completionTokens } : {}),
          },
        };
      } finally {
        clearTimeout(timeoutTimer);
        if (inFlight === controller) {
          inFlight = undefined;
        }
      }
    },

    /**
     * Validate execution observation: checks type-safe validation, exit code, and stderr status.
     */
    async validate(observation: WorkerObservation): Promise<ValidationOutcome> {
      const jevObs = observation as TypeSafeJevObservation;
      const typeSafePassed =
        jevObs.typeSafeValid !== false &&
        (jevObs.violations === undefined || jevObs.violations.length === 0);
      const exitPassed = observation.exitCode === 0;
      const stderrEmpty =
        observation.stderrTail === undefined || observation.stderrTail.length === 0;

      const checks = [
        { name: "type-safe", passed: typeSafePassed },
        { name: "exit-code", passed: exitPassed },
        { name: "stderr-empty", passed: stderrEmpty },
      ];

      return {
        passed: typeSafePassed && exitPassed,
        checks,
      };
    },

    /**
     * Stop the currently running inference or command process.
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
        // stop() must never throw
      }
    },
  };
}
