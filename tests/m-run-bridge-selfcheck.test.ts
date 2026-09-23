import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";

// Keep every other export real: orchestrator-phases / state-machine import
// formatPromptContextEntries as a VALUE from this module — a factory that
// only stubs executeRolePrompt leaves it undefined, the bridge phase throws,
// and the top-level catch disguises it as HUMAN_REVIEW_REQUIRED.
vi.mock("../src/routing/provider-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routing/provider-executor")>();
  return { ...actual, executeRolePrompt: vi.fn() };
});

import { executeRolePrompt } from "../src/routing/provider-executor";
import { runTaskResult } from "../src/surfaces/cli/runtime/routing";
import { runSelfcheck } from "../src/surfaces/cli/runtime/selfcheck";

const mockedExec = vi.mocked(executeRolePrompt);

function writeTempConfig(providers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "gf-bridge-"));
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...getDefaultConfig(),
        providers,
        graphPolicy: {
          ...getDefaultConfig().graphPolicy,
          workspaceRoot: root,
          transport: "memory" as const,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          autoIndexOnSave: false,
          embeddingProvider: "fnv" as const,
        },
        embeddingPolicy: { ...getDefaultConfig().embeddingPolicy, provider: "hash" as const },
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
}

describe("run treats an unusable LLM exactly like no LLM (auto-bridge)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("a masked provider echo bridges immediately: no LLM execution attempts, visible reason", async () => {
    const configPath = writeTempConfig({ openai: { apiKey: "sk-broken", baseUrl: "https://example.invalid" } });
    try {
      mockedExec.mockResolvedValue("[openai:test-model] Reply with exactly: ok");
      const summary = await runTaskResult("do something small", configPath);
      // The full contract, now asserted under mock too (the earlier
      // mock-only HUMAN_REVIEW was the factory missing exports, not product
      // behavior): unusable LLM == no LLM — DELEGATED, zero worker calls,
      // visible reason, descriptor + episode for the bridge loop.
      expect(summary.status).toBe("DELEGATED");
      expect(summary.attempts).toBe(0);
      expect(summary.bridgeReason).toContain("worker connectivity probe failed");
      expect(summary.executionDescriptor?.action).toBe("execute");
      expect(summary.episodeId).toBeTruthy();
      const calls = mockedExec.mock.calls.map((c) => String(c[1]));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((prompt) => prompt.includes("Reply with exactly"))).toBe(true);
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  }, 30_000);

  it("a healthy probe still routes to llm execution mode", async () => {
    const configPath = writeTempConfig({ openai: { apiKey: "sk-good", baseUrl: "https://example.invalid" } });
    try {
      mockedExec.mockImplementation(async (_role, prompt) =>
        prompt.includes("Reply with exactly") ? "ok" : "final answer from worker"
      );
      const summary = await runTaskResult("do something small", configPath);
      expect(summary.bridgeReason).toBeUndefined();
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  }, 30_000);
});

describe("graphflow selfcheck", () => {
  it("no-LLM config: llm-probe is n/a, redaction ok, no hard failures", async () => {
    const configPath = writeTempConfig({});
    try {
      const result = await runSelfcheck(configPath);
      const byName = new Map(result.items.map((i) => [i.name, i]));
      expect(byName.get("config")?.status).toBe("ok");
      expect(byName.get("llm-probe")?.status).toBe("na");
      expect(byName.get("dialogue-redaction")?.status).toBe("ok");
      expect(result.summary.fail).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.items.length).toBeGreaterThanOrEqual(8);
    } finally {
      rmSync(join(configPath, ".."), { recursive: true, force: true });
    }
  });

  it("broken config fails the config check red, not green", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-selfcheck-bad-"));
    const configPath = join(root, "graphflow.config.json");
    writeFileSync(configPath, "{ broken json", "utf8");
    try {
      const result = await runSelfcheck(configPath);
      const config = result.items.find((i) => i.name === "config");
      expect(config?.status).toBe("fail");
      expect(result.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
