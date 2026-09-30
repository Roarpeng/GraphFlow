import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve";
import {
  loadEfficiencyPolicy,
  readDecisionLedger,
  resolveDecisionLedgerPath,
  resolveEfficiencyPolicyPath,
} from "../src/learning/decision-ledger";
import { runTaskResult } from "../src/surfaces/cli/runtime";
import { assertAdvisoryCompatible } from "../packages/efficiency-agent/src/contract";
import { learnPolicyFromLedger } from "../packages/efficiency-agent/src/learning/policy-from-ledger";

/**
 * §5 + §21 closure: the advisory carries the full Execution Contract block
 * (project / experience / tools / cached), a learned policy file overrides the
 * deterministic worker hints, and the decision ledger feeds
 * `eff-agent policy learn` — the whole decision → ledger → policy → next
 * decision loop on real config + real store.
 */
describe("advisory contract fields + policy closed loop", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-policy-"));
  const configPath = join(root, "graphflow.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: {},
        tiers: {
          smart: { provider: "openai", model: "gpt-5.3-codex" },
          economy: { provider: "openai", model: "gpt-4.1-mini" },
        },
        budgetPolicy: { runTokenCap: 2000 },
        graphPolicy: {
          enableAutoBuild: true,
          autoIndexOnPreview: false,
          autoIndexOnRun: false,
          workspaceRoot: root,
          includeExtensions: [".ts"],
          transport: "file",
          graphStorePath: join(root, "graph-store.json"),
          maxContextTokens: 400,
        },
        learningPolicy: {
          enableFlywheel: true,
          trainingCadence: "nightly",
          exportPath: join(root, "learning.jsonl"),
        },
      },
      null,
      2
    ),
    "utf8"
  );

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("advisory carries project/experience/tools and stays contract-clean", async () => {
    const summary = await runTaskResult("修改 axis 配置 并 验证 构建", configPath);
    expect(summary.advisory).toBeDefined();
    const advisory = summary.advisory!;
    expect(assertAdvisoryCompatible(advisory)).toEqual([]);

    // §5 project block: workspace root always present; gitHead honest-absent
    // in a non-git temp workspace.
    expect(advisory.project?.root).toBe(root);
    expect(advisory.project?.gitHead).toBeUndefined();

    // §5 experience block: episodes list (possibly empty) is well-formed.
    expect(Array.isArray(advisory.experience?.episodes)).toBe(true);

    // §5 tools: capability-based, derived from fused steps.
    const capabilities = (advisory.tools ?? []).map((t) => t.capability).sort();
    expect(capabilities).toContain("edit_symbol");
    expect(capabilities).toContain("validate");

    // Ledger records the triage category for the policy learner.
    const ledger = readDecisionLedger(resolveDecisionLedgerPath(resolveConfig(configPath)));
    const last = ledger[ledger.length - 1]!;
    expect(last.taskId).toBe(advisory.taskId);
    expect(last.taskCategory).toBeDefined();
  });

  it("a learned policy file overrides worker hints and is stamped on the advisory", async () => {
    // Learn from the ledger the previous run wrote: several "simple"
    // decisions exist → learnPolicy (via the package) yields an update; force
    // a deterministic one here to keep the test independent of hysteresis
    // thresholds — what matters is the SUBSTRATE applying whatever the file says.
    const config = resolveConfig(configPath);
    const policyPath = resolveEfficiencyPolicyPath(config);
    const policy = {
      version: 7,
      minSamples: 5,
      modelTierByCategory: { simple: "standard" },
      executionModeByCategory: { simple: "loop" },
      avoidPatterns: [],
      rationale: ["test: escalate simple to standard"],
    };
    writeFileSync(policyPath, JSON.stringify(policy), "utf8");

    expect(loadEfficiencyPolicy(config)?.version).toBe(7);

    const summary = await runTaskResult("update the config loader defaults", configPath);
    const advisory = summary.advisory!;
    // Deterministic default for a simple task is economy/one-shot — the
    // learned policy overrode both, and stamped its version.
    expect(advisory.worker.modelTier).toBe("standard");
    expect(advisory.worker.executionMode).toBe("loop");
    expect(advisory.worker.maxRounds).toBe(2);
    expect(advisory.policyApplied).toEqual({ version: 7 });
    expect(assertAdvisoryCompatible(advisory)).toEqual([]);
    // The ledger records the POST-policy tier — what was actually advised.
    const ledger = readDecisionLedger(resolveDecisionLedgerPath(config));
    expect(ledger[ledger.length - 1]!.modelTier).toBe("standard");
  });

  it("ledger → learnPolicyFromLedger closes the writer side of the loop", () => {
    const ledgerPath = resolveDecisionLedgerPath(resolveConfig(configPath));
    expect(existsSync(ledgerPath)).toBe(true);
    const raw = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const update = learnPolicyFromLedger(raw);
    // Either a real update (versioned, rationale-carrying) or an honest
    // "no change" — never a malformed policy.
    if (update !== undefined) {
      expect(update.version).toBeGreaterThan(0);
      expect(Array.isArray(update.rationale)).toBe(true);
      expect(Array.isArray(update.avoidPatterns)).toBe(true);
    }
  });
});
