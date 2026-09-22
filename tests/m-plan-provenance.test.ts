import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { recordEpisode } from "../src/learning/episodic-memory";
import {
  planAndBrainstorm,
  planAndBrainstormResult,
} from "../src/surfaces/cli/runtime/routing";
import { searchEpisodes } from "../src/surfaces/cli/runtime/memory";
import { resetProviderErrors, recordProviderError } from "../src/routing/provider-errors";

// Fake LLM provider injection (same technique as m80): mock the provider
// executor so planAndBrainstormResult exercises its probe / degrade branches
// without real network calls.
vi.mock("../src/routing/provider-executor", () => ({
  executeRolePrompt: vi.fn(),
}));

import { executeRolePrompt } from "../src/routing/provider-executor";

const mockedExec = vi.mocked(executeRolePrompt);

function writeConfig(providers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "gf-honesty-"));
  const path = join(root, "graphflow.config.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...getDefaultConfig(),
        providers,
        graphPolicy: {
          ...getDefaultConfig().graphPolicy,
          workspaceRoot: root,
          // Shared file store: the test writes episodes with one client and
          // searchEpisodes opens another — memory transport would isolate them.
          transport: "file" as const,
          graphStorePath: join(root, "graph-store.json"),
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          autoIndexOnSave: false,
          embeddingProvider: "fnv" as const,
        },
        embeddingPolicy: {
          ...getDefaultConfig().embeddingPolicy,
          provider: "hash" as const,
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return path;
}

const CONFIG_WITH_KEY = () => writeConfig({ openai: { apiKey: "sk-test", baseUrl: "https://example.invalid" } });

describe("honest plan provenance (planSource) + probe error propagation", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    resetProviderErrors();
  });

  it("a masked provider echo degrades to probe-failed-bridge with the adapter's real error", async () => {
    const configPath = CONFIG_WITH_KEY();
    try {
      recordProviderError("openai", "openai http 401: invalid key");
      mockedExec.mockResolvedValue("[openai:test-model] Reply with exactly: ok");
      const result = await planAndBrainstormResult("do something", configPath);
      expect(result.planSource).toBe("probe-failed-bridge");
      expect(result.requiresAgentBridge).toBe(true);
      expect(result.nodesStatus).toBe("suggested");
      expect(result.probe?.ok).toBe(false);
      // The REAL failure surfaces, not just "masked failure".
      expect(result.probe?.error).toContain("openai http 401: invalid key");
      expect(result.degradeReason).toContain("planner connectivity probe failed");

      const text = await planAndBrainstorm("do something", configPath);
      // CLI text output carries the provenance — a bridged plan must never
      // read the same as a model-produced final DAG.
      expect(text).toContain("source=probe-failed-bridge");
      expect(text).toContain("bridge=awaiting-agent");
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });

  it("a probe that throws (circuit open / network) degrades with the thrown reason", async () => {
    const configPath = CONFIG_WITH_KEY();
    try {
      mockedExec.mockRejectedValue(new Error("openai/test-model circuit is open"));
      const result = await planAndBrainstormResult("do something", configPath);
      expect(result.planSource).toBe("probe-failed-bridge");
      expect(result.probe?.error).toContain("circuit is open");
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });

  it("a passing probe with failing decomposition degrades to llm-failed-bridge", async () => {
    const configPath = CONFIG_WITH_KEY();
    try {
      mockedExec.mockImplementation(async (_role, prompt) => {
        if (prompt.includes("Reply with exactly")) return "ok";
        throw new Error("decomposition exploded");
      });
      const result = await planAndBrainstormResult("do something", configPath);
      expect(result.planSource).toBe("llm-failed-bridge");
      expect(result.probe?.ok).toBe(true);
      expect(result.degradeReason).toContain("failed or timed out");
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });

  it("a fully working LLM path is labeled llm and final", async () => {
    const configPath = CONFIG_WITH_KEY();
    try {
      mockedExec.mockImplementation(async (_role, prompt) => {
        if (prompt.includes("Reply with exactly")) return "ok";
        if (prompt.includes("ideas") || /brainstorm/i.test(prompt)) {
          return "idea one\nidea two";
        }
        return JSON.stringify([
          { id: "task-1", description: "step one", dependencies: [] },
        ]);
      });
      const result = await planAndBrainstormResult("do something", configPath);
      expect(result.planSource).toBe("llm");
      expect(result.nodesStatus).toBe("final");
      expect(result.requiresAgentBridge).toBe(false);
      expect(result.degradeReason).toBeUndefined();
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("memory search drops zero-evidence hits", () => {
  it("episodes with no lexical overlap are filtered; overlapping ones rank", async () => {
    const configPath = writeConfig({});
    try {
      const { createGraphClient } = await import("../src/graph/client-factory");
      const { resolveConfig } = await import("../src/config/resolve");
      const client = createGraphClient(resolveConfig(configPath));
      await recordEpisode(client, {
        task: "update readme with install steps",
        plan: [],
        outcome: "pass",
        keyDecisions: [],
        lessons: [],
        attempts: 1,
      });
      await recordEpisode(client, {
        task: "kubernetes helm chart deployment",
        plan: [],
        outcome: "pass",
        keyDecisions: [],
        lessons: [],
        attempts: 1,
      });
      const hits = await searchEpisodes("update readme install", configPath, 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => hit.task.includes("helm"))).toBe(false);
      expect(hits.every((hit) => hit.score > 0)).toBe(true);

      const none = await searchEpisodes("totally unrelated quantum physics", configPath, 5);
      expect(none).toHaveLength(0);
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });
});
