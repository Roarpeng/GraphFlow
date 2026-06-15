import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader";
import { resolveModelForRole } from "../src/routing/model-router";
import { buildCliUsage, getCliVersion } from "../src/surfaces/cli/output";
import { runTask } from "../src/surfaces/cli/runtime";

describe("M17 release readiness", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGraphApiKey = process.env.GRAPHIFY_API_KEY;

  afterEach(() => {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }

    if (originalGraphApiKey === undefined) {
      delete process.env.GRAPHIFY_API_KEY;
    } else {
      process.env.GRAPHIFY_API_KEY = originalGraphApiKey;
    }
  });

  it("expands environment variable placeholders when loading config", () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-config-env-"));
    const configPath = join(root, "graphflow.config.json");
    process.env.OPENAI_API_KEY = "openai-from-env";
    process.env.GRAPHIFY_API_KEY = "graphify-from-env";

    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            providers: {
              openai: { apiKey: "${OPENAI_API_KEY}" },
            },
            tiers: {
              smart: { provider: "openai", model: "gpt-4.1" },
              economy: { provider: "openai", model: "gpt-4.1-mini" },
            },
            budgetPolicy: { runTokenCap: 2000 },
            graphPolicy: {
              enableAutoBuild: true,
              transport: "mcp-http",
              mcpEndpoint: "http://127.0.0.1:9999",
              mcpApiKey: "${GRAPHIFY_API_KEY}",
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: join(root, "learning.jsonl"),
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const config = loadConfig(configPath);
      expect(config.providers.openai?.apiKey).toBe("openai-from-env");
      expect(config.graphPolicy.mcpApiKey).toBe("graphify-from-env");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes stable help and version text for CLI users", () => {
    expect(buildCliUsage()).toContain("Usage: graphflow <command> [options]");
    expect(buildCliUsage()).toContain("run \"<task>\" [--json] [--config <path>]");
    expect(getCliVersion()).toMatch(/^0\.6\./);
  });

  it("uses supported default router model names", () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-router-defaults-"));
    const missingConfigPath = join(root, "missing.config.json");
    try {
      expect(resolveModelForRole("planner", missingConfigPath).model).toBe("gpt-4.1");
      expect(resolveModelForRole("worker", missingConfigPath).model).toBe("gpt-4.1-mini");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records failed task runs into learning events", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-failed-run-"));
    const configPath = join(root, "graphflow.config.json");
    const eventsPath = join(root, "events.jsonl");

    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            providers: {
              openai: { apiKey: "local-key" },
            },
            tiers: {
              smart: { provider: "openai", model: "gpt-4.1" },
              economy: { provider: "openai", model: "gpt-4.1-mini" },
            },
            budgetPolicy: { runTokenCap: 2000 },
            graphPolicy: {
              enableAutoBuild: true,
              enableNearLosslessMode: false,
              autoIndexOnRun: true,
              transport: "mcp-http",
              mcpEndpoint: "http://127.0.0.1:9",
              maxContextTokens: 200,
            },
            learningPolicy: {
              enableFlywheel: true,
              trainingCadence: "nightly",
              canaryRatio: 10,
              exportPath: join(root, "learning.jsonl"),
              eventsPath,
            },
          },
          null,
          2
        ),
        "utf8"
      );

      await expect(runTask("force a failure", configPath)).rejects.toThrow();

      const lines = readFileSync(eventsPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const last = JSON.parse(lines.at(-1) ?? "{}") as { query?: string; passed?: boolean; retries?: number };

      expect(last.query).toBe("force a failure");
      expect(last.passed).toBe(false);
      expect(last.retries).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
