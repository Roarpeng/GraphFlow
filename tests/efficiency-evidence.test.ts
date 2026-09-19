import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GraphFlowConfig } from "../src/config/schema";
import {
  buildEfficiencyEvidence,
  evaluateEvidenceGate,
  resolveEfficiencyEvidencePath,
  writeEfficiencyEvidence,
  EFFICIENCY_EVIDENCE_SCHEMA_VERSION,
} from "../src/learning/efficiency-evidence";
import { recordEfficiencyComparison } from "../src/learning/efficiency-report";
import { recordContextFidelity, recordSavings } from "../src/graph/token-savings";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function newConfig(): { config: GraphFlowConfig; root: string } {
  const root = mkdtempSync(join(tmpdir(), "gf-eff-evidence-"));
  dirs.push(root);
  const config = {
    graphPolicy: { transport: "file", workspaceRoot: root },
  } as unknown as GraphFlowConfig;
  return { config, root };
}

describe("efficiency evidence artifact", () => {
  it("empty workspace yields schema v1 with gated claim", () => {
    const { config } = newConfig();
    const artifact = buildEfficiencyEvidence(config, "test");
    expect(artifact.schemaVersion).toBe(EFFICIENCY_EVIDENCE_SCHEMA_VERSION);
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.efficiency.totalComparisons).toBe(0);
    expect(artifact.contextFidelity.sampleCount).toBe(0);
    const gate = evaluateEvidenceGate(artifact);
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.length).toBeGreaterThan(0);
  });

  it("qualifying pair opens the gate; capability regression keeps it closed", () => {
    const { config } = newConfig();
    recordEfficiencyComparison(config, {
      query: "q",
      baseline: { tokens: 1000, responseCount: 4 },
      packaged: { tokens: 400, responseCount: 4 },
    });
    const good = buildEfficiencyEvidence(config, "test");
    expect(evaluateEvidenceGate(good).allowed).toBe(true);

    // Anti-"doing less": response count drop is a capability regression.
    recordEfficiencyComparison(config, {
      query: "q2",
      baseline: { tokens: 1000, responseCount: 4 },
      packaged: { tokens: 100, responseCount: 1 },
    });
    const bad = buildEfficiencyEvidence(config, "test");
    const gate = evaluateEvidenceGate(bad);
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.some((r) => r.includes("capability"))).toBe(true);
  });

  it("write persists the artifact with sources, boundary, and gate", () => {
    const { config, root } = newConfig();
    recordEfficiencyComparison(config, {
      query: "q",
      baseline: { tokens: 1000, responseCount: 4 },
      packaged: { tokens: 400, responseCount: 4 },
    });
    recordContextFidelity(config, {
      expectedAnchorIds: ["symbol:a:1"],
      returnedAnchorIds: ["symbol:a:1"],
    });
    recordSavings(config, { rawTokens: 500, compressedTokens: 100 });
    const result = writeEfficiencyEvidence(config, "1.24.0-test");
    expect(result.path).toBe(resolveEfficiencyEvidencePath(config));
    expect(result.path).toBe(join(root, "graphflow-out", "efficiency-evidence.json"));
    expect(result.gate.allowed).toBe(true);
    const onDisk = JSON.parse(readFileSync(result.path, "utf8")) as {
      schemaVersion: number;
      graphflowVersion: string;
      sources: { efficiency: string; contextFidelity: string };
      tokenSavings: { boundary: string };
      gate: { allowed: boolean };
    };
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.graphflowVersion).toBe("1.24.0-test");
    expect(onDisk.sources.efficiency).toContain("efficiency.json");
    expect(onDisk.sources.contextFidelity).toContain("context-fidelity.json");
    expect(onDisk.tokenSavings.boundary).toContain("NOT");
    expect(onDisk.gate.allowed).toBe(true);
  });
});
