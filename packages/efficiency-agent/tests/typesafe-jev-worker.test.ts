import { describe, expect, it } from "vitest";
import {
  createTypeSafeJevWorker,
  extractAndParseJson,
  tokenizeValidationSpec,
  validateJevAction,
  type TypeSafeJevObservation,
} from "../src/workers/typesafe-jev-worker.js";
import { validateMeasurement } from "../src/measurement.js";
import { runBrokeredExecution } from "../src/broker.js";
import type { WorkerCommand } from "../src/domain.js";

describe("tokenizeValidationSpec and prepare()", () => {
  it("splits arguments and strips surrounding quotes", () => {
    expect(tokenizeValidationSpec('echo "hello world" test')).toEqual([
      "echo",
      "hello world",
      "test",
    ]);
    expect(tokenizeValidationSpec("node -e 'process.exit(0)'")).toEqual([
      "node",
      "-e",
      "process.exit(0)",
    ]);
  });

  it("prepare() extracts first valid command or returns undefined when empty", async () => {
    const worker = createTypeSafeJevWorker();
    const cmd = await worker.prepare(["", "  ", 'node -e "process.exit(0)"', "ls -la"]);
    expect(cmd).toEqual({
      command: "node",
      args: ["-e", "process.exit(0)"],
    });

    const emptyCmd = await worker.prepare(["", "   "]);
    expect(emptyCmd).toBeUndefined();
  });
});

describe("extractAndParseJson", () => {
  it("parses pure JSON directly", () => {
    const res = extractAndParseJson('{"action": "noop"}');
    expect(res.parsed).toEqual({ action: "noop" });
    expect(res.error).toBeUndefined();
  });

  it("extracts JSON wrapped in markdown code fence", () => {
    const markdown = "Here is the result:\n```json\n{\n  \"action\": \"command\",\n  \"command\": \"echo\",\n  \"args\": [\"hi\"]\n}\n```\nEnjoy!";
    const res = extractAndParseJson(markdown);
    expect(res.parsed).toEqual({
      action: "command",
      command: "echo",
      args: ["hi"],
    });
  });

  it("extracts JSON enclosed by outer curly braces", () => {
    const text = 'Prefix note {"action": "noop", "explanation": "all done"} trailing text';
    const res = extractAndParseJson(text);
    expect(res.parsed).toEqual({
      action: "noop",
      explanation: "all done",
    });
  });

  it("returns error on completely invalid non-JSON strings", () => {
    const res = extractAndParseJson("not a json at all");
    expect(res.error).toBeDefined();
    expect(res.parsed).toBeUndefined();
  });
});

describe("validateJevAction TypeSafe schema defenses", () => {
  it("validates a compliant command action", () => {
    const res = validateJevAction({
      action: "command",
      command: "echo",
      args: ["hello"],
      explanation: "test",
    });
    expect(res.valid).toBe(true);
    expect(res.action?.action).toBe("command");
    expect(res.errors).toHaveLength(0);
  });

  it("validates compliant patch and files actions", () => {
    const patchRes = validateJevAction({
      action: "patch",
      targetFile: "src/foo.ts",
      diff: "--- a\n+++ b",
    });
    expect(patchRes.valid).toBe(true);
    expect(patchRes.action?.action).toBe("patch");

    const filesRes = validateJevAction({
      action: "files",
      files: [{ path: "src/bar.ts", content: "export const x = 1;" }],
    });
    expect(filesRes.valid).toBe(true);
    expect(filesRes.action?.action).toBe("files");
  });

  it("defends against non-object input", () => {
    expect(validateJevAction("hello").valid).toBe(false);
    expect(validateJevAction(null).valid).toBe(false);
    expect(validateJevAction([1, 2, 3]).valid).toBe(false);
  });

  it("defends against unknown action type", () => {
    const res = validateJevAction({ action: "malicious_eval", code: "rm -rf /" });
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("Unsupported action type");
  });

  it("defends against command action missing command or args", () => {
    const res1 = validateJevAction({ action: "command", command: "" });
    expect(res1.valid).toBe(false);

    const res2 = validateJevAction({ action: "command", command: "ls", args: "not-array" });
    expect(res2.valid).toBe(false);

    const res3 = validateJevAction({ action: "command", command: "ls\0injection", args: [] });
    expect(res3.valid).toBe(false);
    expect(res3.errors).toContain("Command contains illegal null bytes");
  });

  it("defends against patch/files schema violations", () => {
    const patchRes = validateJevAction({ action: "patch", targetFile: "" });
    expect(patchRes.valid).toBe(false);

    const filesRes = validateJevAction({ action: "files", files: [] });
    expect(filesRes.valid).toBe(false);
  });
});

describe("createTypeSafeJevWorker execution and local deployment support", () => {
  it("successfully calls local JEV endpoint, validates action, and runs local command", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body));

      const mockResponse = {
        id: "chatcmpl-test-1",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "command",
                command: process.execPath,
                args: ["-e", "process.stdout.write('jev-hello')"],
                explanation: "test execution",
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 18,
          total_tokens: 60,
        },
      };

      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const worker = createTypeSafeJevWorker({
      baseUrl: "http://localhost:8000/v1",
      model: "jev-code",
      fetch: mockFetch,
    });

    expect(worker.name).toBe("typesafe-jev");

    const cmd: WorkerCommand = {
      command: "test",
      args: ["run"],
    };

    const obs = (await worker.execute(cmd)) as TypeSafeJevObservation;

    // Verify endpoint and request structure
    expect(capturedUrl).toBe("http://localhost:8000/v1/chat/completions");
    expect(capturedHeaders["Authorization"]).toBeUndefined(); // Local deployment without apiKey requires no Bearer header
    expect(capturedBody.model).toBe("jev-code");

    // Verify successful execution and type safety
    expect(obs.typeSafeValid).toBe(true);
    expect(obs.exitCode).toBe(0);
    expect(obs.stdoutTail).toContain("jev-hello");
    expect(obs.durationMs).toBeGreaterThanOrEqual(0);

    // Verify Measurement Contract adherence (R1-R6)
    expect(obs.measurements).toBeDefined();
    if (obs.measurements) {
      expect(obs.measurements.durationMs.provenance).toBe("measured");
      expect(validateMeasurement("durationMs", obs.measurements.durationMs)).toEqual([]);

      expect(obs.measurements.totalTokens?.provenance).toBe("measured");
      expect(obs.measurements.totalTokens?.value).toBe(60);
      expect(validateMeasurement("totalTokens", obs.measurements.totalTokens!)).toEqual([]);

      expect(obs.measurements.promptTokens?.value).toBe(42);
      expect(obs.measurements.completionTokens?.value).toBe(18);
    }

    // Verify validate()
    const validation = await worker.validate(obs);
    expect(validation.passed).toBe(true);
    expect(validation.checks).toEqual([
      { name: "type-safe", passed: true },
      { name: "exit-code", passed: true },
      { name: "stderr-empty", passed: true },
    ]);
  });

  it("supports cloud deployment with apiKey and custom model", async () => {
    let capturedHeaders: Record<string, string> = {};

    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;

      const mockResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"action": "noop", "explanation": "nothing to do"}',
            },
          },
        ],
      };

      return new Response(JSON.stringify(mockResponse), { status: 200 });
    };

    const worker = createTypeSafeJevWorker({
      baseUrl: "https://api.typesafe-jev.ai/v1",
      apiKey: "sk-test-token-12345",
      model: "qwen2.5-coder",
      fetch: mockFetch,
    });

    const obs = (await worker.execute({ command: "dummy", args: [] })) as TypeSafeJevObservation;

    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-test-token-12345");
    expect(obs.typeSafeValid).toBe(true);
    expect(obs.action?.action).toBe("noop");

    // Token estimation fallback per R3 when usage not provided
    expect(obs.measurements?.totalTokens?.provenance).toBe("estimated");
    expect(obs.measurements?.totalTokens?.method).toBe("chars/4");
    expect(validateMeasurement("totalTokens", obs.measurements!.totalTokens!)).toEqual([]);
  });

  it("intercepts and halts when schema is violated or malicious action returned", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will not return JSON, here is plain text instead!",
            },
          },
        ],
      };
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    };

    const worker = createTypeSafeJevWorker({ fetch: mockFetch });
    const obs = (await worker.execute({ command: "check", args: [] })) as TypeSafeJevObservation;

    // Defensively caught
    expect(obs.typeSafeValid).toBe(false);
    expect(obs.exitCode).toBe(1);
    expect(obs.stderrTail).toContain("TypeSafe violation");

    const validation = await worker.validate(obs);
    expect(validation.passed).toBe(false);
    expect(validation.checks).toEqual([
      { name: "type-safe", passed: false },
      { name: "exit-code", passed: false },
      { name: "stderr-empty", passed: false },
    ]);
  });

  it("intercepts invalid schema action (missing args in command action)", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({ action: "command", command: "rm" }), // missing args
            },
          },
        ],
      };
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    };

    const worker = createTypeSafeJevWorker({ fetch: mockFetch });
    const obs = (await worker.execute({ command: "check", args: [] })) as TypeSafeJevObservation;

    expect(obs.typeSafeValid).toBe(false);
    expect(obs.exitCode).toBe(1);
    expect(obs.stderrTail).toContain("Command action requires an array of strings for 'args'");

    const validation = await worker.validate(obs);
    expect(validation.passed).toBe(false);
  });

  it("handles HTTP error status safely", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500, statusText: "Internal Error" });
    };

    const worker = createTypeSafeJevWorker({ fetch: mockFetch });
    const obs = await worker.execute({ command: "check", args: [] });

    expect(obs.exitCode).toBe(1);
    expect(obs.stderrTail).toContain("HTTP 500 Internal Error");
  });

  it("aborts in-flight execution when stop() is invoked", async () => {
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    };

    const worker = createTypeSafeJevWorker({ fetch: mockFetch });
    const execPromise = worker.execute({ command: "sleep", args: ["10"] });

    // Stop execution midway
    await worker.stop();

    const obs = await execPromise;
    expect(obs.exitCode).toBe(130);
    expect(obs.stderrTail).toContain("aborted");

    // Multiple stop() calls should be safe no-op
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});

describe("TypeSafeJevWorker integrated with runBrokeredExecution", () => {
  it("completes full broker round with TypeSafeJevWorker", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "command",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    };

    const worker = createTypeSafeJevWorker({ fetch: mockFetch });

    const result = await runBrokeredExecution(
      {
        validation: ['node -e "process.exit(0)"'],
        policy: { maxRounds: 1, totalBudgetMs: 5000, stopOnValidationPass: true },
      },
      worker
    );

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("validation-passed");
    expect(result.rounds).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(result.validation?.passed).toBe(true);
  });
});
