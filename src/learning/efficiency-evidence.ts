/**
 * R7-h: public efficiency-evidence artifact.
 *
 * A versioned, shareable JSON file that packages the efficiency story with the
 * honesty rules the project already enforces internally:
 *  - efficiency.json paired-comparison records (capability floor enforced);
 *  - context-fidelity.json samples (anchor recall / body coverage);
 *  - token-savings stats (packaging ROI, explicitly NOT fidelity).
 * The artifact embeds the "what this number is NOT" boundary next to every
 * number so downstream quoting cannot silently mix the arms.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import {
  getEfficiencyReport,
  resolveEfficiencyReportPath,
} from "./efficiency-report";
import {
  getContextFidelityStats,
  getSavingsStats,
} from "../graph/token-savings";

export const EFFICIENCY_EVIDENCE_SCHEMA_VERSION = 1;

export interface EfficiencyEvidenceArtifact {
  schemaVersion: number;
  graphflowVersion: string;
  generatedAt: string;
  sources: {
    efficiency: string;
    contextFidelity: string;
  };
  efficiency: {
    totalComparisons: number;
    qualifying: number;
    disqualified: number;
    averageTokenSavingRatio: number;
    /** Anti-"doing less" control; null while unmeasured. */
    responseCountMeasured: number;
    averageResponseCountDeltaRatio: number | null;
    capabilityRegressions: number;
    recentRecords: unknown[];
  };
  contextFidelity: {
    sampleCount: number;
    averageAnchorRecallPercent: number;
    averageBodyCoveragePercent: number;
  };
  tokenSavings: {
    totalRuns: number;
    totalRawTokens: number;
    totalCompressedTokens: number;
    averageSavingsPercent: number;
    /** Fixed boundary text — must be quoted with the number. */
    boundary: string;
  };
}

export function resolveEfficiencyEvidencePath(config: GraphFlowConfig): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  return join(root, "graphflow-out", "efficiency-evidence.json");
}

export function buildEfficiencyEvidence(
  config: GraphFlowConfig,
  graphflowVersion: string
): EfficiencyEvidenceArtifact {
  const efficiency = getEfficiencyReport(config);
  const fidelity = getContextFidelityStats(config);
  const savings = getSavingsStats(config);
  return {
    schemaVersion: EFFICIENCY_EVIDENCE_SCHEMA_VERSION,
    graphflowVersion,
    generatedAt: new Date().toISOString(),
    sources: {
      efficiency: resolveEfficiencyReportPath(config),
      contextFidelity: "graphflow-out/context-fidelity.json",
    },
    efficiency: {
      totalComparisons: efficiency.totalComparisons,
      qualifying: efficiency.qualifying,
      disqualified: efficiency.disqualified,
      averageTokenSavingRatio: efficiency.averageTokenSavingRatio,
      responseCountMeasured: efficiency.responseCountMeasured,
      averageResponseCountDeltaRatio: efficiency.averageResponseCountDeltaRatio,
      capabilityRegressions: efficiency.capabilityRegressions,
      recentRecords: efficiency.recentRecords,
    },
    contextFidelity: {
      sampleCount: fidelity.sampleCount,
      averageAnchorRecallPercent: fidelity.averageAnchorRecallPercent,
      averageBodyCoveragePercent: fidelity.averageBodyCoveragePercent,
    },
    tokenSavings: {
      totalRuns: savings.totalRuns,
      totalRawTokens: savings.totalRawTokens,
      totalCompressedTokens: savings.totalCompressedTokens,
      averageSavingsPercent: savings.averageSavingsPercent,
      boundary:
        "Packaging ROI (tokens-not-fidelity): measures tokens saved by the compressed package vs the same evidence read in full. It is NOT retrieval Hit@k, NOT body coverage, NOT lossless-source fidelity.",
    },
  };
}

/**
 * Honesty gate (SoL-Pi capability-floor analog at the artifact level): the
 * public artifact may only carry a savings claim when no capability metric
 * regressed AND at least one comparison qualified. Otherwise the claim is
 * stripped and the reason recorded — the file stays publishable, the claim
 * does not.
 */
export function evaluateEvidenceGate(
  artifact: EfficiencyEvidenceArtifact
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (artifact.efficiency.totalComparisons === 0) {
    reasons.push("no paired comparisons recorded");
  }
  if (artifact.efficiency.qualifying === 0) {
    reasons.push("no qualifying comparison");
  }
  if (artifact.efficiency.capabilityRegressions > 0) {
    reasons.push("capability regression recorded");
  }
  return { allowed: reasons.length === 0, reasons };
}

export function writeEfficiencyEvidence(
  config: GraphFlowConfig,
  graphflowVersion: string
): { path: string; artifact: EfficiencyEvidenceArtifact; gate: ReturnType<typeof evaluateEvidenceGate> } {
  const artifact = buildEfficiencyEvidence(config, graphflowVersion);
  const gate = evaluateEvidenceGate(artifact);
  const path = resolveEfficiencyEvidencePath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...artifact, gate }, null, 2), "utf8");
  return { path, artifact, gate };
}
