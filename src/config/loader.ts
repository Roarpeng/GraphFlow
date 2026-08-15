import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractEnvPlaceholderName } from "./secrets";
import { validateGraphifyEndpoint } from "./graphify-endpoint";
import type { GraphFlowConfig } from "./schema";
import { getDefaultConfig, resolveMaxContextTokens, DEFAULT_OUTPUT_DIR } from "./defaults";
import { resolveIncludeExtensions } from "./include-extensions.js";
import { logger } from "../utils/logger";

export interface LoadConfigResult {
  config: GraphFlowConfig;
  usedFallback: boolean;
  configPath: string;
  error?: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  field: string;
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  configPath: string;
  issues: ValidationIssue[];
}

export function validateConfigDetailed(path = "graphflow.config.json"): ConfigValidationResult {
  const resolvedPath = resolve(path);
  const issues: ValidationIssue[] = [];

  if (!existsSync(resolvedPath)) {
    return { valid: false, configPath: resolvedPath, issues: [{ severity: "error", field: "file", message: "Config file not found" }] };
  }

  let parsed: GraphFlowConfig;
  try {
    const raw = readFileSync(resolvedPath, "utf8");
    parsed = JSON.parse(raw) as GraphFlowConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, configPath: resolvedPath, issues: [{ severity: "error", field: "file", message: `Invalid JSON: ${message}` }] };
  }

  // Check for env var placeholders without corresponding env vars
  checkEnvPlaceholders(parsed, issues);

  // Validate structure
  if (!parsed.tiers?.smart?.provider) {
    issues.push({ severity: "error", field: "tiers.smart.provider", message: "tiers.smart.provider is required" });
  }
  if (!parsed.tiers?.economy?.provider) {
    issues.push({ severity: "error", field: "tiers.economy.provider", message: "tiers.economy.provider is required" });
  }
  if (!parsed.budgetPolicy || (parsed.budgetPolicy.runTokenCap ?? 0) <= 0) {
    issues.push({ severity: "error", field: "budgetPolicy.runTokenCap", message: "budgetPolicy.runTokenCap must be positive" });
  }
  if (!parsed.graphPolicy) {
    issues.push({ severity: "error", field: "graphPolicy", message: "graphPolicy is required" });
  } else {
    const allowedTransports = new Set(["memory", "mcp-http", "file", "sqlite", "auto"]);
    if (!allowedTransports.has(parsed.graphPolicy.transport)) {
      issues.push({ severity: "error", field: "graphPolicy.transport", message: `Must be one of: memory|mcp-http|file|sqlite|auto, got "${parsed.graphPolicy.transport}"` });
    }
    if (parsed.graphPolicy.transport === "mcp-http") {
      if (!parsed.graphPolicy.mcpEndpoint) {
        issues.push({ severity: "error", field: "graphPolicy.mcpEndpoint", message: "Required for mcp-http transport" });
      } else {
        const invalid = validateGraphifyEndpoint(parsed.graphPolicy.mcpEndpoint);
        if (invalid) {
          issues.push({ severity: "error", field: "graphPolicy.mcpEndpoint", message: invalid });
        }
      }
    }
    if (parsed.graphPolicy.transport === "file" && !parsed.graphPolicy.graphStorePath) {
      issues.push({ severity: "warning", field: "graphPolicy.graphStorePath", message: "Not set for file transport; will use default" });
    }
    if (parsed.graphPolicy.layerQuota) {
      const { l1, l2, l3 } = parsed.graphPolicy.layerQuota;
      if (l1 < 0 || l2 < 0 || l3 < 0) {
        issues.push({ severity: "error", field: "graphPolicy.layerQuota", message: "layerQuota values must be >= 0" });
      }
    }
    if (parsed.graphPolicy.includeExtensions) {
      const invalid = parsed.graphPolicy.includeExtensions.some((ext) => !ext.startsWith("."));
      if (invalid) {
        issues.push({ severity: "error", field: "graphPolicy.includeExtensions", message: "Extensions must start with '.'" });
      }
    }
    if (parsed.graphPolicy.workspaceRoot) {
      issues.push({ severity: "warning", field: "graphPolicy.workspaceRoot", message: "workspaceRoot in config is deprecated; resolved from process.cwd() at runtime" });
    }
  }

  if (!parsed.learningPolicy) {
    issues.push({ severity: "error", field: "learningPolicy", message: "learningPolicy is required" });
  }

  if (parsed.routingPolicy?.providerPriority) {
    const allowed = new Set(["openai", "anthropic", "bailian", "doubao", "deepseek"]);
    const invalid = parsed.routingPolicy.providerPriority.some((p) => !allowed.has(p));
    if (invalid) {
      issues.push({ severity: "error", field: "routingPolicy.providerPriority", message: "Contains unknown provider" });
    }
  }

  // Check provider API keys
  for (const [name, cfg] of Object.entries(parsed.providers ?? {})) {
    if (!cfg.apiKey && !cfg.baseUrl) {
      issues.push({ severity: "warning", field: `providers.${name}`, message: `No apiKey or baseUrl configured for provider "${name}"` });
    }
  }

  // Try full validation
  try {
    validateConfig(resolveEnvTemplates(parsed) as GraphFlowConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!issues.some((i) => i.severity === "error")) {
      issues.push({ severity: "error", field: "config", message });
    }
  }

  const valid = !issues.some((i) => i.severity === "error");
  return { valid, configPath: resolvedPath, issues };
}

function checkEnvPlaceholders(config: GraphFlowConfig, issues: ValidationIssue[]): void {
  const envVarRegex = /\$\{([^}]+)\}/g;
  const configStr = JSON.stringify(config);
  let match: RegExpExecArray | null;
  while ((match = envVarRegex.exec(configStr)) !== null) {
    const envName = match[1];
    if (envName && !process.env[envName]) {
      issues.push({ severity: "warning", field: "env", message: `Environment variable ${envName} is not set` });
    }
  }
}

export function loadConfig(path = "graphflow.config.json"): GraphFlowConfig {
  return loadConfigSafe(path).config;
}

/** Load config with fallback to defaults when JSON is missing, invalid, or fails validation. */
export function loadConfigSafe(path = "graphflow.config.json"): LoadConfigResult {
  const resolvedPath = resolve(path);

  if (!existsSync(resolvedPath)) {
    return {
      config: getDefaultConfig(),
      usedFallback: true,
      configPath: resolvedPath,
      error: "Config file not found",
    };
  }

  try {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = resolveEnvTemplates(JSON.parse(raw)) as GraphFlowConfig;
    return {
      config: validateConfig(parsed),
      usedFallback: false,
      configPath: resolvedPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ path: resolvedPath, error: message }, "Failed to load config; using defaults");
    return {
      config: getDefaultConfig(),
      usedFallback: true,
      configPath: resolvedPath,
      error: message,
    };
  }
}

function resolveEnvTemplates(value: unknown): unknown {
  if (typeof value === "string") {
    const envName = extractEnvPlaceholderName(value);
    if (envName) {
      return process.env[envName] ?? "";
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvTemplates(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, resolveEnvTemplates(nested)])
    );
  }

  return value;
}

export function validateConfig(input: GraphFlowConfig): GraphFlowConfig {
  if (!input.tiers?.smart?.provider || !input.tiers?.economy?.provider) {
    throw new Error("Invalid config: tiers.smart and tiers.economy are required.");
  }

  if (!input.budgetPolicy || input.budgetPolicy.runTokenCap <= 0) {
    throw new Error("Invalid config: budgetPolicy.runTokenCap must be positive.");
  }

  if (!input.graphPolicy) {
    throw new Error("Invalid config: graphPolicy is required.");
  }

  if (input.graphPolicy.transport === "mcp-http") {
    if (!input.graphPolicy.mcpEndpoint) {
      throw new Error(
        "Invalid config: graphPolicy.mcpEndpoint is required for mcp-http. " +
          'Point it at a Graphify team server, e.g. "http://graphify.team.internal:8080".'
      );
    }
    const invalid = validateGraphifyEndpoint(input.graphPolicy.mcpEndpoint);
    if (invalid) {
      throw new Error(`Invalid config: ${invalid}`);
    }
  }

  if (input.graphPolicy.transport === "file" && !input.graphPolicy.graphStorePath) {
    throw new Error("Invalid config: graphPolicy.graphStorePath is required for file transport.");
  }

  const allowedTransports = new Set(["memory", "mcp-http", "file", "sqlite", "auto"]);
  if (!allowedTransports.has(input.graphPolicy.transport)) {
    throw new Error(`Invalid config: graphPolicy.transport must be one of memory|mcp-http|file|sqlite|auto.`);
  }

  if (input.graphPolicy.layerQuota) {
    const { l1, l2, l3 } = input.graphPolicy.layerQuota;
    if (l1 < 0 || l2 < 0 || l3 < 0) {
      throw new Error("Invalid config: graphPolicy.layerQuota values must be >= 0.");
    }
  }

  if (input.graphPolicy.includeExtensions) {
    const invalid = input.graphPolicy.includeExtensions.some((ext) => !ext.startsWith("."));
    if (invalid) {
      throw new Error("Invalid config: graphPolicy.includeExtensions must start with '.'.");
    }
  }

  if (!input.learningPolicy) {
    throw new Error("Invalid config: learningPolicy is required.");
  }

  if (input.routingPolicy?.providerPriority) {
    const allowed = new Set(["openai", "anthropic", "bailian", "doubao", "deepseek"]);
    const invalid = input.routingPolicy.providerPriority.some((provider) => !allowed.has(provider));
    if (invalid) {
      throw new Error("Invalid config: routingPolicy.providerPriority contains unknown provider.");
    }
  }

  const workspaceRoot = resolve(input.graphPolicy.workspaceRoot ?? process.cwd());

  return {
    ...input,
    graphPolicy: {
      ...input.graphPolicy,
      enableNearLosslessMode: input.graphPolicy.enableNearLosslessMode ?? false,
      autoIndexOnPreview: input.graphPolicy.autoIndexOnPreview ?? true,
      autoIndexOnRun: input.graphPolicy.autoIndexOnRun ?? true,
      autoIndexOnSave: input.graphPolicy.autoIndexOnSave ?? true,
      enableDialogueThread: input.graphPolicy.enableDialogueThread !== false,
      maxContextTokens: resolveMaxContextTokens(input.graphPolicy.maxContextTokens),
      workspaceRoot,
      graphStorePath:
        input.graphPolicy.graphStorePath ??
        (input.graphPolicy.transport === "sqlite" || input.graphPolicy.transport === "auto"
          ? `${DEFAULT_OUTPUT_DIR}/graphflow-graph.sqlite`
          : `${DEFAULT_OUTPUT_DIR}/graphflow-graph.json`),
      includeExtensions: resolveIncludeExtensions(input.graphPolicy.includeExtensions),
      layerQuota: input.graphPolicy.layerQuota ?? { l1: 6, l2: 4, l3: 3 },
    },
    learningPolicy: {
      ...input.learningPolicy,
      trainingCadence: input.learningPolicy.trainingCadence ?? "nightly",
      eventsPath: input.learningPolicy.eventsPath ?? `${DEFAULT_OUTPUT_DIR}/learning-events.jsonl`,
      summaryPath: input.learningPolicy.summaryPath ?? `${DEFAULT_OUTPUT_DIR}/learning-summary.json`,
    },
    routingPolicy: {
      enableDynamicRouting: input.routingPolicy?.enableDynamicRouting ?? true,
      requireApiKeyForHealthy: input.routingPolicy?.requireApiKeyForHealthy ?? false,
      enableProviderTools: input.routingPolicy?.enableProviderTools ?? true,
      providerPriority: input.routingPolicy?.providerPriority ?? [
        "openai",
        "deepseek",
        "anthropic",
        "bailian",
        "doubao",
      ],
    },
    skillPolicy: {
      enableSkillFlywheel: input.skillPolicy?.enableSkillFlywheel ?? true,
      maxSkillHints: input.skillPolicy?.maxSkillHints ?? 3,
    },
    embeddingPolicy: {
      enabled: input.embeddingPolicy?.enabled ?? true,
      provider: input.embeddingPolicy?.provider ?? "transformers",
      model: input.embeddingPolicy?.model ?? "Xenova/bge-base-zh-v1.5",
      ...(input.embeddingPolicy?.baseUrl ? { baseUrl: input.embeddingPolicy.baseUrl } : {}),
      ...(input.embeddingPolicy?.apiKey ? { apiKey: input.embeddingPolicy.apiKey } : {}),
      ...(input.embeddingPolicy?.modelCacheDir ? { modelCacheDir: input.embeddingPolicy.modelCacheDir } : {}),
      ...(input.embeddingPolicy?.transformersCachePath
        ? { transformersCachePath: input.embeddingPolicy.transformersCachePath }
        : {}),
      vectorStorePath: input.embeddingPolicy?.vectorStorePath ?? `${DEFAULT_OUTPUT_DIR}/vectors.db`,
      topK: input.embeddingPolicy?.topK ?? 8,
      minSimilarity: input.embeddingPolicy?.minSimilarity ?? 0.05,
      enableFullGraphVectorRecall: input.embeddingPolicy?.enableFullGraphVectorRecall ?? false,
    },
  };
}
