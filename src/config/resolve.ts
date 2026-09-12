import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EfficiencyPolicyConfig, GraphFlowConfig } from "./schema";
import type { ObservationPolicy } from "../observations/types";
import { loadConfigSafe } from "./loader";
import { mergeGraphFlowConfig } from "./merge";
import { getDefaultConfig } from "./defaults";
import { resolveGlobalConfigPath } from "./scaffold";
import { bindRuntimeWorkspaceRoot } from "./workspace-root";
import { applyProviderEnvFromConfig } from "./provider-env";
import { logger } from "../utils/logger";

function isDefaultProjectConfigPath(path: string): boolean {
  const projectRootConfig = resolve("graphflow.config.json");
  return path === "graphflow.config.json" || resolve(path) === projectRootConfig;
}

/** Path used for reading settings metadata (most specific existing config). */
export function resolveConfigPath(path = "graphflow.config.json"): string {
  if (!isDefaultProjectConfigPath(path)) {
    return path;
  }

  const projectRootConfig = resolve("graphflow.config.json");
  if (existsSync(projectRootConfig)) {
    return projectRootConfig;
  }

  const globalPath = resolveGlobalConfigPath();
  if (existsSync(globalPath)) {
    return globalPath;
  }

  const overlayPath = resolve(".graphflow/config.json");
  if (existsSync(overlayPath)) {
    return overlayPath;
  }

  return path;
}

/** Path used when persisting settings; defaults to global unless a project root config already exists. */
export function resolveWritableConfigPath(path = "graphflow.config.json"): string {
  if (!isDefaultProjectConfigPath(path)) {
    return path;
  }

  const projectRootConfig = resolve("graphflow.config.json");
  if (existsSync(projectRootConfig)) {
    return projectRootConfig;
  }

  return resolveGlobalConfigPath();
}

function finalizeConfig(config: GraphFlowConfig): GraphFlowConfig {
  applyProviderEnvFromConfig(config);
  return config;
}

/**
 * Resolve the effective GraphFlow config for the current process.
 *
 * @param path Explicit config path; default resolves project/global/overlay layers.
 * @param bind Optional workspace-root override, forwarded into the internal
 *   `bindRuntimeWorkspaceRoot` so a caller-provided `rootDir` (e.g. an MCP tool
 *   argument) takes priority over `projectWorkspaceRoot` and over discovery
 *   from an unsafe `process.cwd()` (home dir / AppData), instead of throwing
 *   "Refusing to index unsafe workspace root" before the override is applied.
 */
export function resolveConfig(
  path = "graphflow.config.json",
  bind?: { rootDir?: string }
): GraphFlowConfig {
  if (!isDefaultProjectConfigPath(path)) {
    const result = loadConfigSafe(path);
    if (result.usedFallback && result.error) {
      logger.warn({ path: result.configPath, error: result.error }, "Using default config for explicit path");
    }
    const projectRoot = result.config.graphPolicy.workspaceRoot;
    return finalizeConfig(
      bindRuntimeWorkspaceRoot(
        result.config,
        mergeRuntimeWorkspaceBind(bind, projectRoot)
      )
    );
  }

  const globalPath = resolveGlobalConfigPath();
  const base = existsSync(globalPath) ? loadLayer(globalPath) : getDefaultConfig();

  const projectRoot = resolve("graphflow.config.json");
  const overlayPath = resolve(".graphflow/config.json");

  let merged: GraphFlowConfig;
  let projectWorkspaceRoot: string | undefined;

  if (existsSync(projectRoot) && existsSync(overlayPath)) {
    const projectLayer = loadLayer(projectRoot);
    const overlayLayer = loadLayer(overlayPath);
    merged = mergeGraphFlowConfig(mergeGraphFlowConfig(base, projectLayer), overlayLayer);
    projectWorkspaceRoot =
      overlayLayer.graphPolicy.workspaceRoot ?? projectLayer.graphPolicy.workspaceRoot;
  } else if (existsSync(projectRoot)) {
    const projectLayer = loadLayer(projectRoot);
    merged = mergeGraphFlowConfig(base, projectLayer);
    projectWorkspaceRoot = projectLayer.graphPolicy.workspaceRoot;
  } else if (existsSync(overlayPath)) {
    const overlayLayer = loadLayer(overlayPath);
    merged = mergeGraphFlowConfig(base, overlayLayer);
    projectWorkspaceRoot = overlayLayer.graphPolicy.workspaceRoot;
  } else {
    merged = base;
  }

  return finalizeConfig(
    bindRuntimeWorkspaceRoot(
      merged,
      mergeRuntimeWorkspaceBind(bind, projectWorkspaceRoot)
    )
  );
}

/**
 * Merge the caller-provided `rootDir` override with the project-level
 * `workspaceRoot` for the internal bind. `rootDir` is listed first so
 * `resolveRuntimeWorkspaceRoot`'s existing priority applies: explicit rootDir
 * wins over projectWorkspaceRoot. Returns undefined when neither is present
 * (equivalent to the historical no-options call).
 */
function mergeRuntimeWorkspaceBind(
  bind: { rootDir?: string } | undefined,
  projectWorkspaceRoot: string | undefined
): { rootDir?: string; projectWorkspaceRoot?: string } | undefined {
  const merged: { rootDir?: string; projectWorkspaceRoot?: string } = {
    ...(bind?.rootDir ? { rootDir: bind.rootDir } : {}),
    ...(projectWorkspaceRoot ? { projectWorkspaceRoot } : {}),
  };
  return merged.rootDir !== undefined || merged.projectWorkspaceRoot !== undefined
    ? merged
    : undefined;
}

function loadLayer(path: string): GraphFlowConfig {
  const result = loadConfigSafe(path);
  if (result.usedFallback && result.error) {
    logger.warn({ path: result.configPath, error: result.error }, "Config layer ignored due to load failure");
    return getDefaultConfig();
  }
  return result.config;
}

// ---------------------------------------------------------------------------
// SoL-Pi-style efficiency mechanisms (unified policy)
//
// Pure and deterministic: turns the optional efficiencyPolicy config section
// into fully effective policy objects. The default is the BEST configuration
// (every mechanism ON); a user can switch any mechanism off from the
// graphflow-settings page, and an explicit false in config also wins.
// These flags govern config-driven / automatic behaviour only. Explicit API
// calls (graphflow_context with content/handle, reduce:true, a caller-supplied
// executionDescriptor) remain explicit intent and are not gated here.
// ---------------------------------------------------------------------------

export interface ResolvedObservationReducePolicy {
  enabled: boolean;
  strategy: "fingerprint" | "llm";
  maxReceiptTokens: number;
  maxSourceBytes: number;
  /** Present only when strategy is "llm" (explicit remote route). */
  provider?: string;
  model?: string;
}

export interface ResolvedObservationEfficiencyPolicy {
  enabled: boolean;
  inlineThresholdBytes: number;
  headBytes: number;
  tailBytes: number;
  maxStoreBytes: number;
  ttlDays: number;
  redactOnStore: boolean;
  reduce: ResolvedObservationReducePolicy;
}

export interface ResolvedContextPressurePolicy {
  enabled: boolean;
  /** "auto" scales the default budget by observed pressure; a number pins it. */
  maxContextTokens: number | "auto";
  cacheWriteReadRatio: number;
  minSavingRatio: number;
}

export interface ResolvedEfficiencyPolicy {
  observations: ResolvedObservationEfficiencyPolicy;
  contextPressure: ResolvedContextPressurePolicy;
  actionFusion: { enabled: boolean };
}

export const DEFAULT_EFFICIENCY_POLICY: ResolvedEfficiencyPolicy = {
  observations: {
    enabled: true,
    inlineThresholdBytes: 8192,
    headBytes: 2048,
    tailBytes: 1536,
    maxStoreBytes: 268435456, // 256 MiB
    ttlDays: 14,
    redactOnStore: true,
    reduce: {
      enabled: true,
      strategy: "fingerprint",
      maxReceiptTokens: 400,
      maxSourceBytes: 2097152, // 2 MiB
    },
  },
  contextPressure: {
    enabled: true,
    maxContextTokens: "auto",
    cacheWriteReadRatio: 12.5,
    minSavingRatio: 0.2,
  },
  actionFusion: { enabled: true },
};

/** Finite number >= 0, else the fallback. Guards NaN/Infinity/negatives. */
function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Finite number > 0, else the fallback. */
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Clamp a finite number into [0, 1], else the fallback. */
function ratio01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Resolve the optional efficiency section over the disabled defaults.
 *
 * Note: reduce.strategy "llm" without both provider and model is downgraded
 * to "fingerprint" — a remote reducer route is never implied.
 */
export function resolveEfficiencyPolicy(
  config?: { efficiencyPolicy?: EfficiencyPolicyConfig } | GraphFlowConfig | undefined
): ResolvedEfficiencyPolicy {
  const section = config?.efficiencyPolicy;
  const obs = section?.observations;
  const cp = section?.contextPressure;
  const af = section?.actionFusion;
  const red = obs?.reduce;

  const strategy = red?.strategy === "llm" ? "llm" : "fingerprint";
  const provider = typeof red?.provider === "string" && red.provider.trim() ? red.provider.trim() : undefined;
  const model = typeof red?.model === "string" && red.model.trim() ? red.model.trim() : undefined;
  // A remote reducer route must be explicit: without provider + model we stay local.
  const effectiveStrategy = strategy === "llm" && provider && model ? "llm" : "fingerprint";

  const configuredMax =
    cp?.maxContextTokens === "auto"
      ? "auto"
      : typeof cp?.maxContextTokens === "number" && Number.isFinite(cp.maxContextTokens) && cp.maxContextTokens > 0
        ? Math.max(1, Math.round(cp.maxContextTokens))
        : DEFAULT_EFFICIENCY_POLICY.contextPressure.maxContextTokens;

  return {
    observations: {
      enabled: obs?.enabled ?? DEFAULT_EFFICIENCY_POLICY.observations.enabled,
      inlineThresholdBytes: positive(obs?.inlineThresholdBytes, DEFAULT_EFFICIENCY_POLICY.observations.inlineThresholdBytes),
      headBytes: positive(obs?.headBytes, DEFAULT_EFFICIENCY_POLICY.observations.headBytes),
      tailBytes: positive(obs?.tailBytes, DEFAULT_EFFICIENCY_POLICY.observations.tailBytes),
      maxStoreBytes: positive(obs?.maxStoreBytes, DEFAULT_EFFICIENCY_POLICY.observations.maxStoreBytes),
      ttlDays: nonNegative(obs?.ttlDays, DEFAULT_EFFICIENCY_POLICY.observations.ttlDays),
      redactOnStore: obs?.redactOnStore !== false,
      reduce: {
        enabled: red?.enabled ?? DEFAULT_EFFICIENCY_POLICY.observations.reduce.enabled,
        strategy: effectiveStrategy,
        maxReceiptTokens: positive(red?.maxReceiptTokens, DEFAULT_EFFICIENCY_POLICY.observations.reduce.maxReceiptTokens),
        maxSourceBytes: positive(red?.maxSourceBytes, DEFAULT_EFFICIENCY_POLICY.observations.reduce.maxSourceBytes),
        ...(effectiveStrategy === "llm" && provider ? { provider } : {}),
        ...(effectiveStrategy === "llm" && model ? { model } : {}),
      },
    },
    contextPressure: {
      enabled: cp?.enabled ?? DEFAULT_EFFICIENCY_POLICY.contextPressure.enabled,
      maxContextTokens: configuredMax,
      cacheWriteReadRatio: nonNegative(cp?.cacheWriteReadRatio, DEFAULT_EFFICIENCY_POLICY.contextPressure.cacheWriteReadRatio),
      minSavingRatio: ratio01(cp?.minSavingRatio, DEFAULT_EFFICIENCY_POLICY.contextPressure.minSavingRatio),
    },
    actionFusion: { enabled: af?.enabled ?? DEFAULT_EFFICIENCY_POLICY.actionFusion.enabled },
  };
}

/** Project the resolved efficiency policy onto the observation store's policy shape. */
export function toObservationPolicy(policy: ResolvedEfficiencyPolicy): ObservationPolicy {
  const o = policy.observations;
  return {
    enabled: o.enabled,
    inlineThresholdBytes: o.inlineThresholdBytes,
    headBytes: o.headBytes,
    tailBytes: o.tailBytes,
    maxStoreBytes: o.maxStoreBytes,
    ttlDays: o.ttlDays,
    redactOnStore: o.redactOnStore,
    reduce: {
      enabled: o.reduce.enabled,
      strategy: o.reduce.strategy,
      maxReceiptTokens: o.reduce.maxReceiptTokens,
      maxSourceBytes: o.reduce.maxSourceBytes,
    },
  };
}

