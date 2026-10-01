import { existsSync, readFileSync } from "node:fs";
import type { GraphFlowConfig, GraphFlowConfigLayer } from "./schema";
import { validateConfig } from "./loader";
import { SCAFFOLD_TIERS } from "./defaults";

function collectOverlayDiffKeys(base: unknown, overlay: unknown, prefix = ""): string[] {
  if (overlay === null || overlay === undefined) {
    return [];
  }

  if (typeof overlay !== "object" || Array.isArray(overlay)) {
    return JSON.stringify(base) !== JSON.stringify(overlay) ? [prefix || "root"] : [];
  }

  const result: string[] = [];
  for (const [key, overlayValue] of Object.entries(overlay as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const baseValue = (base as Record<string, unknown> | undefined)?.[key];
    if (overlayValue && typeof overlayValue === "object" && !Array.isArray(overlayValue)) {
      result.push(...collectOverlayDiffKeys(baseValue, overlayValue, path));
      continue;
    }
    if (JSON.stringify(baseValue) !== JSON.stringify(overlayValue)) {
      result.push(path);
    }
  }
  return result;
}

/** List dotted paths where project overlay differs from root graphflow.config.json. */
export function listConfigOverlayKeys(
  rootPath = "graphflow.config.json",
  overlayPath = ".graphflow/config.json"
): string[] {
  if (!existsSync(rootPath) || !existsSync(overlayPath)) {
    return [];
  }

  try {
    const base = JSON.parse(readFileSync(rootPath, "utf8")) as unknown;
    const overlay = JSON.parse(readFileSync(overlayPath, "utf8")) as unknown;
    return collectOverlayDiffKeys(base, overlay);
  } catch {
    return [];
  }
}

function isScaffoldTier(
  tier: "smart" | "economy",
  value: { provider?: string; model?: string }
): boolean {
  const scaffold = SCAFFOLD_TIERS[tier];
  return value.provider === scaffold.provider && value.model === scaffold.model;
}

function mergeTier(
  base: GraphFlowConfig,
  overlay: GraphFlowConfigLayer,
  tier: "smart" | "economy"
): { provider: string; model?: string } {
  const overlayTier = overlay.tiers?.[tier];
  if (!overlayTier) {
    return { ...base.tiers[tier] };
  }
  const overlayProvidersEmpty = Object.keys(overlay.providers ?? {}).length === 0;
  if (overlayProvidersEmpty && isScaffoldTier(tier, overlayTier)) {
    return { ...base.tiers[tier] };
  }
  return { ...base.tiers[tier], ...overlayTier };
}

/**
 * Merge a project/overlay layer onto the config below it; the layer wins for
 * the fields it defines and may omit any section.
 */
export function mergeGraphFlowConfig(base: GraphFlowConfig, overlay: GraphFlowConfigLayer): GraphFlowConfig {
  return validateConfig({
    providers: { ...base.providers, ...(overlay.providers as GraphFlowConfig["providers"] | undefined) },
    tiers: {
      smart: mergeTier(base, overlay, "smart"),
      economy: mergeTier(base, overlay, "economy"),
    },
    budgetPolicy: { ...base.budgetPolicy, ...overlay.budgetPolicy },
    graphPolicy: {
      ...base.graphPolicy,
      ...overlay.graphPolicy,
      layerQuota: {
        l1: overlay.graphPolicy?.layerQuota?.l1 ?? base.graphPolicy.layerQuota?.l1 ?? 6,
        l2: overlay.graphPolicy?.layerQuota?.l2 ?? base.graphPolicy.layerQuota?.l2 ?? 4,
        l3: overlay.graphPolicy?.layerQuota?.l3 ?? base.graphPolicy.layerQuota?.l3 ?? 3,
      },
    },
    learningPolicy: {
      ...base.learningPolicy,
      ...overlay.learningPolicy,
    },
    routingPolicy: {
      ...base.routingPolicy,
      ...overlay.routingPolicy,
    },
    skillPolicy: {
      ...base.skillPolicy,
      ...overlay.skillPolicy,
    },
    embeddingPolicy: {
      ...base.embeddingPolicy,
      ...overlay.embeddingPolicy,
    },
    // mcp / efficiencyPolicy 此前不在白名单里，双层 config 合并时会被静默丢弃
    // （efficiencyPolicy 是既有丢失，mcp.textCopy 随 m106+ 桩化引入）——补齐合并。
    // mcp / efficiencyPolicy were previously dropped by this whitelist merge
    // (efficiencyPolicy pre-existing, mcp.textCopy new): merge them too.
    mcp: { ...base.mcp, ...overlay.mcp },
    efficiencyPolicy: { ...base.efficiencyPolicy, ...overlay.efficiencyPolicy },
    ...(base.reconcilePolicy || overlay.reconcilePolicy
      ? { reconcilePolicy: { ...base.reconcilePolicy, ...overlay.reconcilePolicy } }
      : {}),
    ...(base.workerPolicy || overlay.workerPolicy
      ? { workerPolicy: overlay.workerPolicy ?? base.workerPolicy }
      : {}),
  });
}
