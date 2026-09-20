import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPrivacyFacts,
  formatPrivacyFacts,
} from "../src/audit/checkers/privacy-checker";

describe("R7-d privacy audit (verifiable local-first)", () => {
  it("lists artifacts existence + endpoints with trigger conditions", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-privacy-"));
    writeFileSync(join(root, "marker.txt"), "x", "utf8");
    const facts = collectPrivacyFacts(root, {
      globalConfigPath: join(root, "no-such-config.json"),
      env: {},
    });

    // All known artifacts absent in a fresh dir — still reported (verifiable)
    expect(facts.missingPaths.length).toBeGreaterThan(0);
    expect(facts.existingPaths).toEqual([]);
    // No endpoint is required without config (local-first proof)
    expect(facts.endpoints.length).toBeGreaterThan(0);
    expect(facts.endpoints.every((e) => e.requiredWithoutConfig === false)).toBe(true);
    expect(facts.endpoints.some((e) => e.url.includes("api.deepseek.com"))).toBe(true);
    // No keys → fully offline
    expect(facts.anyKeyConfigured).toBe(false);
    expect(facts.configuredProviders).toEqual([]);
    expect(facts.globalConfig.exists).toBe(false);

    const text = formatPrivacyFacts(facts);
    expect(text).toContain("fully offline");
    expect(text).toContain("0 required without config");
  });

  it("detects present artifacts + configured providers (booleans only)", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-privacy-"));
    mkdirSync(join(root, "graphflow-out"), { recursive: true });
    writeFileSync(join(root, "graphflow-out", "learning-events.jsonl"), "{}\n", "utf8");

    const facts = collectPrivacyFacts(root, {
      globalConfigPath: join(root, "no-such-config.json"),
      env: { DEEPSEEK_API_KEY: "sk-test", OTHER: "x" } as NodeJS.ProcessEnv,
    });

    expect(facts.existingPaths).toContain("graphflow-out/learning-events.jsonl");
    expect(facts.configuredProviders).toEqual(["DEEPSEEK_API_KEY"]);
    expect(facts.anyKeyConfigured).toBe(true);
    // Values never leak into facts
    expect(JSON.stringify(facts)).not.toContain("sk-test");
  });

  // POSIX mode bits are meaningless on Windows (chmod only toggles the
  // read-only flag, so every file reads back 0666) — Windows semantics are
  // covered by the injected-platform case below.
  it.skipIf(process.platform === "win32")("flags a non-0600 global config as an invariant warning (POSIX)", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-privacy-mode-"));
    const configPath = join(root, "graphflow.config.json");
    writeFileSync(configPath, "{}\n", "utf8");
    chmodSync(configPath, 0o644);

    const facts = collectPrivacyFacts(root, { globalConfigPath: configPath, env: {} });

    expect(facts.globalConfig.exists).toBe(true);
    expect(facts.globalConfig.mode).toBe("0644");
    expect(facts.warnings).toHaveLength(1);
    expect(facts.warnings[0]).toContain("0644");
    expect(facts.warnings[0]).toContain("0600");
    expect(formatPrivacyFacts(facts)).toContain("warnings: 1");
  });

  it.skipIf(process.platform === "win32")("a compliant 0600 global config produces no mode warning", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-privacy-ok-"));
    const configPath = join(root, "graphflow.config.json");
    writeFileSync(configPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(configPath, 0o600);

    const facts = collectPrivacyFacts(root, { globalConfigPath: configPath, env: {} });

    expect(facts.globalConfig.mode).toBe("0600");
    expect(facts.warnings).toEqual([]);
    expect(formatPrivacyFacts(facts)).not.toContain("warnings:");
  });

  it("POSIX mode judgment is skipped on Windows (no owner/group/other bits)", () => {
    const root = mkdtempSync(join(tmpdir(), "gf-privacy-win-"));
    const configPath = join(root, "graphflow.config.json");
    writeFileSync(configPath, "{}\n", "utf8");
    chmodSync(configPath, 0o644);

    const facts = collectPrivacyFacts(root, {
      globalConfigPath: configPath,
      env: {},
      platform: "win32",
    });

    expect(facts.warnings).toEqual([]);
  });
});