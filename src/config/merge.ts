import { existsSync, readFileSync } from "node:fs";
import type { GraphFlowConfig } from "./schema";
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
  value: { provider: string; model?: string }
): boolean {
  const scaffold = SCAFFOLD_TIERS[tier];
  return value.provider === scaffold.provider && value.model === scaffold.model;
}

function mergeTier(
  base: GraphFlowConfig,
  overlay: GraphFlowConfig,
  tier: "smart" | "economy"
): { provider: string; model?: string } {
  const overlayProvidersEmpty = Object.keys(overlay.providers ?? {}).length === 0;
  if (overlayProvidersEmpty && isScaffoldTier(tier, overlay.tiers[tier])) {
    return { ...base.tiers[tier] };
  }
  return { ...base.tiers[tier], ...overlay.tiers[tier] };
}

function mergedEnrichmentField(
  overlayValue: string | undefined,
  baseValue: string | undefined
): string | undefined {
  return overlayValue ?? baseValue;
}

/** Merge project overlay onto root config; overlay wins for defined fields. */
export function mergeGraphFlowConfig(base: GraphFlowConfig, overlay: GraphFlowConfig): GraphFlowConfig {
  const enrichProvider = mergedEnrichmentField(
    overlay.graphPolicy.semanticEnrichment?.provider,
    base.graphPolicy.semanticEnrichment?.provider
  );
  const enrichModel = mergedEnrichmentField(
    overlay.graphPolicy.semanticEnrichment?.model,
    base.graphPolicy.semanticEnrichment?.model
  );
  const enrichBackendRaw =
    overlay.graphPolicy.semanticEnrichment?.backend ?? base.graphPolicy.semanticEnrichment?.backend;
  const enrichBackend =
    enrichBackendRaw === "network" || enrichBackendRaw === "local" || enrichBackendRaw === "inherit"
      ? enrichBackendRaw
      : undefined;
  const enrichApiKey = mergedEnrichmentField(
    overlay.graphPolicy.semanticEnrichment?.apiKey,
    base.graphPolicy.semanticEnrichment?.apiKey
  );
  const enrichBaseUrl = mergedEnrichmentField(
    overlay.graphPolicy.semanticEnrichment?.baseUrl,
    base.graphPolicy.semanticEnrichment?.baseUrl
  );

  return validateConfig({
    providers: { ...base.providers, ...overlay.providers },
    tiers: {
      smart: mergeTier(base, overlay, "smart"),
      economy: mergeTier(base, overlay, "economy"),
    },
    budgetPolicy: { ...base.budgetPolicy, ...overlay.budgetPolicy },
    graphPolicy: {
      ...base.graphPolicy,
      ...overlay.graphPolicy,
      layerQuota: {
        l1: overlay.graphPolicy.layerQuota?.l1 ?? base.graphPolicy.layerQuota?.l1 ?? 6,
        l2: overlay.graphPolicy.layerQuota?.l2 ?? base.graphPolicy.layerQuota?.l2 ?? 4,
        l3: overlay.graphPolicy.layerQuota?.l3 ?? base.graphPolicy.layerQuota?.l3 ?? 3,
      },
      semanticEnrichment: {
        enabled:
          overlay.graphPolicy.semanticEnrichment?.enabled ??
          base.graphPolicy.semanticEnrichment?.enabled ??
          true,
        mode:
          overlay.graphPolicy.semanticEnrichment?.mode ??
          base.graphPolicy.semanticEnrichment?.mode ??
          "post-index",
        ...(enrichBackend ? { backend: enrichBackend } : {}),
        ...(enrichProvider ? { provider: enrichProvider } : {}),
        ...(enrichModel ? { model: enrichModel } : {}),
        ...(enrichApiKey ? { apiKey: enrichApiKey } : {}),
        ...(enrichBaseUrl ? { baseUrl: enrichBaseUrl } : {}),
        batchSize:
          overlay.graphPolicy.semanticEnrichment?.batchSize ??
          base.graphPolicy.semanticEnrichment?.batchSize ??
          5,
        sleepMs:
          overlay.graphPolicy.semanticEnrichment?.sleepMs ??
          base.graphPolicy.semanticEnrichment?.sleepMs ??
          0,
        timeoutMs:
          overlay.graphPolicy.semanticEnrichment?.timeoutMs ??
          base.graphPolicy.semanticEnrichment?.timeoutMs ??
          5000,
        autoRunOnIndex:
          overlay.graphPolicy.semanticEnrichment?.autoRunOnIndex ??
          base.graphPolicy.semanticEnrichment?.autoRunOnIndex ??
          true,
      },
    },
    learningPolicy: {
      ...base.learningPolicy,
      ...overlay.learningPolicy,
      skillEvolution: {
        ...base.learningPolicy.skillEvolution,
        ...overlay.learningPolicy.skillEvolution,
      },
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
  });
}
