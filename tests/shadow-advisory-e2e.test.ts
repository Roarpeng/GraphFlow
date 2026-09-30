import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/resolve";
import { resolveDecisionLedgerPath, readDecisionLedger } from "../src/learning/decision-ledger";
import { runTaskResult } from "../src/surfaces/cli/runtime";
import { assertAdvisoryCompatible } from "../packages/efficiency-agent/src/contract";

/**
 * End-to-end shadow wiring: a bridge-mode graphflow_run returns the advisory
 * block, the advisory satisfies the Execution Contract v1 gate, and the
 * decision's own cost lands in the ledger — the whole item-4/item-5 loop on
 * real config + real store, no LLM keys required (bridge mode by design).
 */
describe("graphflow_run shadow advisory end-to-end", () => {
  const root = mkdtempSync(join(tmpdir(), "graphflow-shadow-"));
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

  it("bridge run returns a contract-clean advisory and bills the ledger", async () => {
    const summary = await runTaskResult("修改 axis 配置 并 验证 构建", configPath);

    expect(summary.status).toBe("DELEGATED");
    expect(summary.advisory).toBeDefined();
    const advisory = summary.advisory!;
    // Contract gate: the advisory riding the MCP response is v1-conformant.
    expect(assertAdvisoryCompatible(advisory)).toEqual([]);
    expect(advisory.mode).toBe("shadow");
    expect(advisory.decision.provenance).toBe("deterministic");
    expect(advisory.decision.llmCalls).toBe(0);
    expect(["REUSE", "ADAPT", "FRESH"]).toContain(advisory.reuseMode);

    // Ledger: the decision's own cost was recorded next to efficiency.json.
    const ledgerPath = resolveDecisionLedgerPath(resolveConfig(configPath));
    expect(existsSync(ledgerPath)).toBe(true);
    const records = readDecisionLedger(ledgerPath);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const last = records[records.length - 1]!;
    expect(last.taskId).toBe(advisory.taskId);
    expect(last.provenance).toBe("deterministic");
    expect(last.llmCalls).toBe(0);
    expect(last.durationMs).toBeGreaterThanOrEqual(0);
    // JSONL discipline: one record per line.
    const raw = readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(raw.length).toBe(records.length);
  });
});
