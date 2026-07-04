import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveModelForRole } from "../src/routing/model-router";
import { diagnoseRoutingResult } from "../src/surfaces/cli/runtime";

/**
 * Verifies that the compression features are actually wired end-to-end
 * (config -> router -> diagnosis), not just present as dead APIs.
 */

function writeConfig(dir: string, config: unknown): string {
  const path = join(dir, "graphflow.config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

describe("M46 Compression wiring (end-to-end)", () => {
  // ── compressor role resolution ───────────────────────────────
  describe("compressor role reuses economy tier", () => {
    it("inherits economy provider/model by default", () => {
      const root = mkdtempSync(join(tmpdir(), "graphflow-comp-inherit-"));
      try {
        const configPath = writeConfig(root, {
          providers: {},
          tiers: {
            smart: { provider: "openai", model: "gpt-4.1" },
            economy: { provider: "openai", model: "gpt-4.1-mini" },
          },
          budgetPolicy: { runTokenCap: 4000 },
          graphPolicy: { enableAutoBuild: true, transport: "memory", maxContextTokens: 1500 },
          learningPolicy: {
            enableFlywheel: false,
            trainingCadence: "nightly",
            exportPath: join(root, "ds.jsonl"),
          },
        });

        const selection = resolveModelForRole("compressor", configPath);
        expect(selection.provider).toBe("openai");
        expect(selection.model).toBe("gpt-4.1-mini"); // economy model
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("uses network backend with explicit provider override", () => {
      const root = mkdtempSync(join(tmpdir(), "graphflow-comp-network-"));
      try {
        const configPath = writeConfig(root, {
          providers: {},
          tiers: {
            smart: { provider: "openai", model: "gpt-4.1" },
            economy: { provider: "openai", model: "gpt-4.1-mini" },
          },
          budgetPolicy: { runTokenCap: 4000 },
          graphPolicy: {
            enableAutoBuild: true,
            transport: "memory",
            maxContextTokens: 1500,
            compression: { backend: "network", provider: "anthropic", model: "claude-3-5-haiku-latest" },
          },
          learningPolicy: {
            enableFlywheel: false,
            trainingCadence: "nightly",
            exportPath: join(root, "ds.jsonl"),
          },
        });

        const selection = resolveModelForRole("compressor", configPath);
        expect(selection.provider).toBe("anthropic");
        expect(selection.model).toBe("claude-3-5-haiku-latest");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // ── route diagnose includes compression ───────────────────────────────
  describe("route diagnose surfaces compression backend", () => {
    it("includes compression field in diagnosis result", () => {
      const root = mkdtempSync(join(tmpdir(), "graphflow-diag-"));
      try {
        const configPath = writeConfig(root, {
          providers: {},
          tiers: {
            smart: { provider: "openai", model: "gpt-4.1" },
            economy: { provider: "openai", model: "gpt-4.1-mini" },
          },
          budgetPolicy: { runTokenCap: 4000 },
          graphPolicy: { enableAutoBuild: true, transport: "memory", maxContextTokens: 1500 },
          learningPolicy: {
            enableFlywheel: false,
            trainingCadence: "nightly",
            exportPath: join(root, "ds.jsonl"),
          },
        });

        const diagnosis = diagnoseRoutingResult(configPath);
        expect(diagnosis.compression).toBeDefined();
        expect(diagnosis.compression.backend).toBe("off");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
