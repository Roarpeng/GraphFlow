import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJevMetaReflector,
  createSystemOneClient,
  resolveTypesafeCredentials,
  TYPESAFE_DEFAULT_BASE_URL,
  TYPESAFE_DEFAULT_MODEL,
} from "../src/routing/typesafe-systemone";

function systemOneResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("TypeSafe System One client (real contract)", () => {
  it("targets POST /v1/systemone on api.typesafe.ai with Bearer auth and jev-latest", async () => {
    const fetchMock = vi.fn(async () =>
      systemOneResponse({
        model: "jev-1.13.0",
        answers: { ok: { type: "noul", noul: 0.8 } },
        usage: { input_tokens: 12, output_tokens: 0 },
      })
    );
    const client = createSystemOneClient({
      apiKey: "tsk-x",
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });
    const result = await client.ask("state text", {
      ok: { type: "noul", instructions: "is it ok?", criteria: { true: "yes", false: "no" } },
    });
    expect(result.answers.ok?.type).toBe("noul");
    expect(result.usage.inputTokens).toBe(12);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${TYPESAFE_DEFAULT_BASE_URL}/v1/systemone`);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tsk-x");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe(TYPESAFE_DEFAULT_MODEL);
    expect(body.questions.ok.type).toBe("noul");
  });

  it("resolves credentials from TYPESAFE_BASE_URL / TYPESAFE_API_KEY env", () => {
    process.env.TYPESAFE_BASE_URL = "https://ts.example.com/";
    process.env.TYPESAFE_API_KEY = "env-key";
    try {
      const resolved = resolveTypesafeCredentials();
      expect(resolved.baseUrl).toBe("https://ts.example.com");
      expect(resolved.apiKey).toBe("env-key");
    } finally {
      delete process.env.TYPESAFE_BASE_URL;
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  it("retries 429/529 with backoff, then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return new Response("busy", { status: 429 });
      return systemOneResponse({
        model: "jev-latest",
        answers: { ok: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    });
    const client = createSystemOneClient({
      apiKey: "k",
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
      maxRetries: 2,
    });
    const result = await client.ask("s", { ok: { type: "noul", instructions: "?" } });
    expect(result.answers.ok?.type).toBe("noul");
    expect(calls).toBe(3);
  });

  it("401/422 are hard failures with status in the message", async () => {
    const fetchMock = vi.fn(async () => new Response("bad key", { status: 401 }));
    const client = createSystemOneClient({
      apiKey: "wrong",
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
      maxRetries: 2,
    });
    await expect(client.ask("s", { ok: { type: "noul", instructions: "?" } })).rejects.toThrow(
      /401/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without a key the client reports unconfigured and ask() refuses", async () => {
    const fetchMock = vi.fn();
    const client = createSystemOneClient({
      apiKey: "",
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(client.configured).toBe(false);
    await expect(client.ask("s", { ok: { type: "noul", instructions: "?" } })).rejects.toThrow(
      /no API key/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Jev meta-reflector (Layer B judge)", () => {
  const grayZoneInput = {
    task: "tune the retrieval threshold",
    taskComplexity: "simple" as const,
    executionMode: "llm" as const,
    topSimilarity: 0.5,
    topEpisode: { id: "e1", task: "tune the ranking threshold", score: 1, similarity: 0.5 },
    similarEpisodes: [{ id: "e1", task: "tune the ranking threshold", score: 1, similarity: 0.5 }],
  };

  it("maps a choice+score verdict into a MetaReflectionVerdict", async () => {
    const fetchMock = vi.fn(async () =>
      systemOneResponse({
        model: "jev-1.13.0",
        answers: {
          reuseMode: {
            type: "choice",
            choice: "ADAPT",
            probabilities: { REUSE: 0.05, ADAPT: 0.9, FRESH: 0.05 },
            confidence: 0.82,
          },
          decisionConfidence: {
            type: "score",
            score: 3.1,
            legend: { "0": "Guessing", "3": "Confident" },
            probabilities: {},
            confidence: 0.7,
          },
        },
        usage: { input_tokens: 55, output_tokens: 0 },
      })
    );
    const reflector = createJevMetaReflector(
      createSystemOneClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof globalThis.fetch }),
      () => undefined
    );
    const verdict = await reflector(grayZoneInput);
    expect(verdict?.reuseMode).toBe("ADAPT");
    expect(verdict?.confidence).toBeGreaterThan(0.5);
    expect(verdict?.reasoning).toContain("jev");
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.questions.reuseMode.type).toBe("choice");
    expect(Object.keys(body.questions.reuseMode.criteria)).toEqual(["REUSE", "ADAPT", "FRESH"]);
  });

  it("an unknown choice falls back to FRESH; failures return undefined (Layer A fallback)", async () => {
    const weird = vi.fn(async () =>
      systemOneResponse({
        answers: {
          reuseMode: { type: "choice", choice: "MAYBE", probabilities: {}, confidence: 0.5 },
          decisionConfidence: { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.5 },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      })
    );
    const reflector = createJevMetaReflector(
      createSystemOneClient({ apiKey: "k", fetchImpl: weird as unknown as typeof globalThis.fetch }),
      () => undefined
    );
    expect((await reflector(grayZoneInput))?.reuseMode).toBe("FRESH");

    const broken = vi.fn(async () => {
      throw new Error("network down");
    });
    const failing = createJevMetaReflector(
      createSystemOneClient({ apiKey: "k", fetchImpl: broken as unknown as typeof globalThis.fetch }),
      () => undefined
    );
    expect(await failing(grayZoneInput)).toBeUndefined();
  });

  it("unconfigured client returns undefined without any HTTP", async () => {
    const fetchMock = vi.fn();
    const reflector = createJevMetaReflector(
      createSystemOneClient({ apiKey: "", fetchImpl: fetchMock as unknown as typeof globalThis.fetch }),
      () => undefined
    );
    expect(await reflector(grayZoneInput)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("graphflow llm-check", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-llmcheck-"));
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: { deepseek: { apiKey: "cfg-key", baseUrl: "https://api.deepseek.com" } },
        tiers: {
          smart: { provider: "deepseek", model: "deepseek-v4-pro" },
          economy: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          transport: "file",
          graphStorePath: join(root, "store.json"),
          maxContextTokens: 400,
        },
        learningPolicy: { enableFlywheel: true, trainingCadence: "nightly", exportPath: join(root, "l.jsonl") },
      },
      null,
      2
    ),
    "utf8"
  );
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
  });

  it("names the winning source per provider and the env vars consulted", async () => {
    const { llmCheckResult } = await import("../src/surfaces/cli/runtime/routing.js");
    // Hermetic: the developer shell may genuinely export TYPESAFE_API_KEY
    // (the typesafe-ai skill does); this test controls it explicitly.
    delete process.env.TYPESAFE_API_KEY;
    // Set the env key BEFORE any config resolution: applyProviderEnvFromConfig
    // then skips the export (env already present), so the key never enters the
    // config-exported registry and later genuine-env reads stay visible. This
    // mirrors production ordering (shell env exists before configs load).
    process.env.DEEPSEEK_API_KEY = "genuine-env-deepseek";
    const report = await llmCheckResult(configPath);
    expect(report.usable).toBe(true);
    const deepseek = report.providers.find((p) => p.provider === "deepseek")!;
    expect(deepseek.source).toBe("config-key");
    expect(deepseek.usable).toBe(true);
    expect(deepseek.envVarsChecked).toContain("DEEPSEEK_API_KEY");

    process.env.DEEPSEEK_API_KEY = "genuine-env-key";
    const withEnv = await llmCheckResult(configPath);
    // Config apiKey still wins the availability verdict (branch 1)...
    expect(withEnv.providers.find((p) => p.provider === "deepseek")!.source).toBe("config-key");
    // ...but a provider with NO config entry resolves from genuine env —
    // proven with a config whose TIERS point at openai (candidates come from
    // tiers + config providers; openai has no providers entry there).
    const envConfigPath = join(root, "graphflow.env.config.json");
    writeFileSync(
      envConfigPath,
      JSON.stringify(
        {
          providers: {},
          tiers: {
            smart: { provider: "deepseek", model: "deepseek-v4-pro" },
            economy: { provider: "deepseek", model: "deepseek-v4-flash" },
          },
          budgetPolicy: { runTokenCap: 2000 },
          graphPolicy: { transport: "file", graphStorePath: join(root, "env-store.json"), maxContextTokens: 400 },
          learningPolicy: { enableFlywheel: true, trainingCadence: "nightly", exportPath: join(root, "l.jsonl") },
        },
        null,
        2
      ),
      "utf8"
    );
    const envViaTier = await llmCheckResult(envConfigPath);
    const deepseekEnv = envViaTier.providers.find((p) => p.provider === "deepseek");
    expect(deepseekEnv).toBeDefined();
    expect(deepseekEnv!.source).toBe("env:DEEPSEEK_API_KEY");
    expect(deepseekEnv!.usable).toBe(true);
    expect(deepseekEnv!.envVarsChecked).toContain("DEEPSEEK_API_KEY");
    // Documented conservative behavior: OPENAI as a bare default tier with an
    // EMPTY providers map does NOT promote a stray env key to usable — the
    // config must show a provider entry or a non-openai tier first.
    process.env.OPENAI_API_KEY = "stray";
    const openaiDefault = await llmCheckResult(envConfigPath);
    const openaiEntry = openaiDefault.providers.find((p) => p.provider === "openai");
    expect(openaiEntry).toBeUndefined();
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    expect(report.typesafe.baseUrl).toBe("https://api.typesafe.ai");
    expect(report.typesafe.model).toBe("jev-latest");
    expect(report.typesafe.envVarsChecked).toEqual(["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"]);
    expect(report.typesafe.configured).toBe(false);
    process.env.TYPESAFE_API_KEY = "tsk";
    const withTs = await llmCheckResult(configPath);
    expect(withTs.typesafe.configured).toBe(true);
  });
});
