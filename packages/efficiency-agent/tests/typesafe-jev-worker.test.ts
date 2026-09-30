import { describe, expect, it, vi } from "vitest";
import { runBrokeredExecution } from "../src/broker.js";
import {
  createTypeSafeJevWorker,
  tokenizeValidationSpec,
  type TypeSafeJevObservation,
} from "../src/workers/typesafe-jev-worker.js";
import type { WorkerObservation } from "../src/domain.js";

/**
 * TypeSafe-JEV worker against the REAL System One contract
 * (docs.typesafe.ai/api): POST {base}/v1/systemone, Bearer auth, model
 * jev-latest, typed noul judgment in validate(). The old chat-completions
 * flow (fabricated api.typesafe-jev.ai domain, model-authored commands) is
 * gone — Jev judges outcomes, it does not author commands.
 */

function systemOneFetch(answerNoul: number, usage = { input_tokens: 42, output_tokens: 0 }) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { succeeded: { type: "noul", noul: answerNoul } },
        usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

function failingFetch(status: number, body = "boom") {
  return vi.fn(async () => new Response(body, { status }));
}

describe("tokenizeValidationSpec and prepare()", () => {
  it("splits arguments and strips surrounding quotes", () => {
    expect(tokenizeValidationSpec('node -e "process.exit(0)"')).toEqual([
      "node",
      "-e",
      "process.exit(0)",
    ]);
    expect(tokenizeValidationSpec("node -e 'process.exit(0)'")).toEqual([
      "node",
      "-e",
      "process.exit(0)",
    ]);
  });

  it("prepare() extracts the first valid command or returns undefined when empty", async () => {
    const worker = createTypeSafeJevWorker();
    const cmd = await worker.prepare(["", "  ", 'node -e "process.exit(0)"', "ls -la"]);
    expect(cmd).toEqual({ command: "node", args: ["-e", "process.exit(0)"] });
    expect(await worker.prepare([])).toBeUndefined();
  });
});

describe("execute() runs the command locally with measured durations", () => {
  it("captures exit 0, stdout tails, and the command line as judgment evidence", async () => {
    const worker = createTypeSafeJevWorker({ apiKey: "" });
    const observation = (await worker.execute({
      command: "node",
      args: ["-e", "console.log('jev-ok')"],
    })) as TypeSafeJevObservation;
    expect(observation.exitCode).toBe(0);
    expect(observation.stdoutTail).toContain("jev-ok");
    expect(observation.commandLine).toContain("node -e");
    expect(observation.measurements?.durationMs.provenance).toBe("measured");
  });

  it("maps a non-zero exit to a failed observation (never throws)", async () => {
    const worker = createTypeSafeJevWorker({ apiKey: "" });
    const observation = await worker.execute({
      command: "node",
      args: ["-e", "process.exit(3)"],
    });
    expect(observation.exitCode).toBe(3);
  });

  it("maps a spawn failure (ENOENT) to a failed observation", async () => {
    const worker = createTypeSafeJevWorker({ apiKey: "" });
    const observation = await worker.execute({
      command: "definitely-not-a-real-binary-xyz",
      args: [],
    });
    expect(observation.exitCode).toBe(1);
    expect(observation.stderrTail ?? "").toContain("definitely-not-a-real-binary-xyz");
  });

  it("a timeout kills the child and reports it (not a throw)", async () => {
    const worker = createTypeSafeJevWorker({ apiKey: "", timeoutMs: 150 });
    const observation = await worker.execute({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 150,
    });
    expect([124, 130, 1]).toContain(observation.exitCode ?? -1);
    expect(observation.stderrTail ?? "").toMatch(/killed|timeout|aborted/i);
  });
});

describe("validate() asks the REAL System One endpoint", () => {
  const okObservation: WorkerObservation = {
    exitCode: 0,
    stdoutTail: "all good",
    durationMs: 12,
  };

  it("sends Bearer auth, model jev-latest, and a noul question to /v1/systemone", async () => {
    const fetchMock = systemOneFetch(0.9);
    const worker = createTypeSafeJevWorker({
      apiKey: "tsk-test",
      baseUrl: "https://api.typesafe.ai",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const outcome = await worker.validate(okObservation);
    expect(outcome.passed).toBe(true);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://api.typesafe.ai/v1/systemone");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tsk-test");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      questions: Record<string, { type: string }>;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.questions.succeeded?.type).toBe("noul");
  });

  it("a high noul passes; a low noul vetoes even a zero exit code", async () => {
    const pass = createTypeSafeJevWorker({
      apiKey: "k",
      fetch: systemOneFetch(0.95) as unknown as typeof globalThis.fetch,
    });
    expect((await pass.validate(okObservation)).passed).toBe(true);

    const veto = createTypeSafeJevWorker({
      apiKey: "k",
      fetch: systemOneFetch(0.1) as unknown as typeof globalThis.fetch,
    });
    const outcome = await veto.validate(okObservation);
    expect(outcome.passed).toBe(false);
    expect(outcome.checks.map((c) => c.name)).toContain("jev-verdict");
  });

  it("records measured judgment tokens from the System One usage block", async () => {
    const worker = createTypeSafeJevWorker({
      apiKey: "k",
      fetch: systemOneFetch(0.9) as unknown as typeof globalThis.fetch,
    });
    const observation: TypeSafeJevObservation = { ...okObservation, typeSafeValid: false };
    await worker.validate(observation);
    expect(observation.typeSafeValid).toBe(true);
    expect(observation.measurements?.judgmentTokens).toEqual({ value: 42, provenance: "measured" });
  });

  it("without a key it fails OPEN to pure exit-code semantics (no HTTP at all)", async () => {
    const fetchMock = failingFetch(500);
    const worker = createTypeSafeJevWorker({
      apiKey: "",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const outcome = await worker.validate(okObservation);
    expect(outcome.passed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unreachable/misbehaving endpoint fails OPEN to exit-code semantics", async () => {
    for (const status of [401, 422, 500, 429]) {
      const worker = createTypeSafeJevWorker({
        apiKey: "k",
        fetch: failingFetch(status) as unknown as typeof globalThis.fetch,
      });
      expect((await worker.validate(okObservation)).passed).toBe(true);
    }
    const crashed = createTypeSafeJevWorker({
      apiKey: "k",
      fetch: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof globalThis.fetch,
    });
    expect((await crashed.validate(okObservation)).passed).toBe(true);
  });

  it("stop() is a safe no-op before and after execution", async () => {
    const worker = createTypeSafeJevWorker({ apiKey: "" });
    await expect(worker.stop()).resolves.toBeUndefined();
    await worker.execute({ command: "node", args: ["-e", "process.exit(0)"] });
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});

describe("TypeSafeJevWorker integrated with runBrokeredExecution", () => {
  it("completes a full broker round: local execution + Jev validation", async () => {
    const worker = createTypeSafeJevWorker({
      apiKey: "k",
      fetch: systemOneFetch(0.99) as unknown as typeof globalThis.fetch,
    });
    const result = await runBrokeredExecution(
      {
        validation: ['node -e "process.exit(0)"'],
        policy: { maxRounds: 2, totalBudgetMs: 15_000, stopOnValidationPass: true },
      },
      worker
    );
    expect(result.status).toBe("completed");
    expect(result.validation?.passed).toBe(true);
    expect(result.validation?.checks.map((c) => c.name)).toEqual(["exit-code", "jev-verdict"]);
  });

  it("a Jev veto sends the broker into its retry rounds and ends failed", async () => {
    const worker = createTypeSafeJevWorker({
      apiKey: "k",
      fetch: systemOneFetch(0.05) as unknown as typeof globalThis.fetch,
    });
    const result = await runBrokeredExecution(
      {
        validation: ['node -e "process.exit(0)"'],
        policy: { maxRounds: 2, totalBudgetMs: 15_000, stopOnValidationPass: true },
      },
      worker
    );
    expect(result.status).toBe("failed");
    expect(result.rounds).toBe(2);
  });
});
