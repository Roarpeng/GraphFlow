import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";

vi.mock("../src/routing/provider-executor", () => ({
  executeRolePrompt: vi.fn(),
}));

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
      // The essential contract: an unusable LLM is treated exactly like no
      // LLM — bridged with a visible reason, never a faked COMPLETED, and
      // the worker is never asked to execute (only the probe round-tripped).
      expect(summary.status).not.toBe("COMPLETED");
      expect(summary.bridgeReason).toContain("worker connectivity probe failed");
      const calls = mockedExec.mock.calls.map((c) => String(c[1]));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((prompt) => prompt.includes("Reply with exactly"))).toBe(true);
      // Attempts reflect LLM worker rounds, not the probe. (The full DELEGATED
      // + descriptor + episode shape is verified against a REAL unreachable
      // endpoint in the live acceptance log; under the vi.mock the
      // orchestrator's episode finalize differs, so this test pins the core
      // contract: no LLM execution, honest reason, never COMPLETED.)
      expect(summary.status).not.toBe("COMPLETED");
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
