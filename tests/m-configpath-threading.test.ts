import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/routing/provider-executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routing/provider-executor")>();
  return { ...actual, executeRolePrompt: vi.fn() };
});

import { executeRolePrompt } from "../src/routing/provider-executor";
import { planAndBrainstormResult, runTaskResult } from "../src/surfaces/cli/runtime/routing";
import { diagnoseRoutingResult } from "../src/surfaces/cli/runtime/routing";

const mockedExec = vi.mocked(executeRolePrompt);

/**
 * configPath must thread through the WHOLE role/probe chain. Live incident:
 * a probe invoked with --config for project B (run from a checkout of project
 * A) resolved models from A's cwd layers — the endpoint received
 * gpt-4.1-mini (A's default) instead of B's configured models. Two leaks:
 * diagnoseRoutingResult's resolve closure dropped configPath, and
 * executeRolePrompt's internal bare resolveConfig() read the cwd layers.
 */
function writeProjectConfig(root: string, model: string): string {
  const path = join(root, "graphflow.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: { openai: { apiKey: "sk-test", baseUrl: "https://example.invalid" } },
      tiers: { smart: { provider: "openai", model }, economy: { provider: "openai", model } },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        workspaceRoot: root,
        transport: "memory" as const,
        autoIndexOnPreview: false,
        autoIndexOnRun: false,
        autoIndexOnSave: false,
      },
    }),
    "utf8"
  );
  return path;
}

describe("configPath threads through role/probe resolution", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("diagnoseRoutingResult resolves roles from the CALLER's config, not the cwd layers", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-thread-diag-"));
    try {
      const path = writeProjectConfig(root, "custom-model-x");
      const diagnosis = diagnoseRoutingResult(path);
      // Before the fix these resolved from the process-cwd layers and could
      // land on default models (gpt-4.1-mini); now they carry the caller's.
      expect(diagnosis.planner.model).toBe("custom-model-x");
      expect(diagnosis.worker.model).toBe("custom-model-x");
      expect(diagnosis.validator.model).toBe("custom-model-x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plan's pre-flight probe forwards configPath into executeRolePrompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-thread-plan-"));
    try {
      const path = writeProjectConfig(root, "custom-model-x");
      mockedExec.mockResolvedValue("ok");
      const result = await planAndBrainstormResult("do something", path);
      expect(result.probe?.ok).toBe(true);
      const opts = mockedExec.mock.calls[0]?.[5] as { configPath?: string } | undefined;
      expect(opts?.configPath).toBe(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("run's pre-flight probe forwards configPath into executeRolePrompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "gf-thread-run-"));
    try {
      const path = writeProjectConfig(root, "custom-model-x");
      mockedExec.mockResolvedValue("[openai:custom-model-x] Reply with exactly: ok");
      const summary = await runTaskResult("tiny task", path);
      expect(summary.bridgeReason).toContain("probe failed");
      const opts = mockedExec.mock.calls[0]?.[5] as { configPath?: string } | undefined;
      expect(opts?.configPath).toBe(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
