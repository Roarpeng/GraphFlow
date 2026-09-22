import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../src/config/resolve";
import { loadConfigSafe, validateConfig } from "../src/config/loader";
import {
  normalizeOutcomeEvidence,
  verifyOutcomeEvidence,
} from "../src/learning/evidence";

function tempRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `gf-${tag}-`));
}

describe("explicit broken config fails fast instead of silently using defaults", () => {
  it("an existing-but-invalid explicit config throws with the real reason", () => {
    const root = tempRoot("cfg-broken");
    try {
      const configPath = join(root, "graphflow.config.json");
      // The classic Windows mistake: unescaped backslash path inside JSON.
      writeFileSync(configPath, `{"graphPolicy": {"workspaceRoot": "C:\\Users\\x"}}`, "utf8");
      expect(() => resolveConfig(configPath)).toThrow(/Failed to load config/);
      expect(() => resolveConfig(configPath)).toThrow(/forward slashes/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a merely-missing explicit config stays permissive (creation flows)", () => {
    const root = tempRoot("cfg-missing");
    try {
      const config = resolveConfig(join(root, "not-yet.config.json"));
      expect(config.graphPolicy.transport).toBeTruthy();
      const result = loadConfigSafe(join(root, "not-yet.config.json"));
      expect(result.notFound).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("minimal config without learningPolicy validates (defaults applied)", () => {
    const root = tempRoot("cfg-minimal");
    try {
      const configPath = join(root, "graphflow.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          providers: {},
          tiers: {
            smart: { provider: "openai", model: "x" },
            economy: { provider: "openai", model: "x" },
          },
          budgetPolicy: { runTokenCap: 2000 },
          graphPolicy: { transport: "file" },
        }),
        "utf8"
      );
      const config = validateConfig(JSON.parse(readFileSync(configPath, "utf8")) as object);
      expect(config.learningPolicy.trainingCadence).toBe("nightly");
      expect(config.learningPolicy.eventsPath).toContain("learning-events.jsonl");
      // And it resolves without throwing.
      const resolved = resolveConfig(configPath);
      expect(resolved.graphPolicy.transport).toBe("file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("outcome evidence is graded, never silently discarded", () => {
  it("a passing test command without commit keeps its evidence and grades honestly", () => {
    const evidence = normalizeOutcomeEvidence({
      repository: "org/repo",
      testCommand: "npm test",
      testResult: "pass",
      userConfirmed: true,
    });
    // OLD behavior: undefined (dropped) because commit was missing — the
    // caller was then told "no evidence package" although it submitted one.
    expect(evidence).toBeDefined();
    const verification = verifyOutcomeEvidence(evidence);
    expect(verification.level).toBe("unverified");
    expect(verification.reasons).toContain("missing commit or test command");
    expect(verification.reasons).not.toContain("no evidence package");
  });

  it("commit + testCommand + diff + confirmation reaches verified", () => {
    const evidence = normalizeOutcomeEvidence({
      commit: "abc123",
      diff: "+1 -1",
      testCommand: "npm test",
      testResult: "pass",
      userConfirmed: true,
    });
    expect(verifyOutcomeEvidence(evidence).level).toBe("verified");
  });

  it("an input with no substantive fields still yields no package", () => {
    expect(normalizeOutcomeEvidence({})).toBeUndefined();
    expect(normalizeOutcomeEvidence(undefined)).toBeUndefined();
  });
});
