import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractEnvPlaceholderName } from "./secrets";
import type { GraphFlowConfig } from "./schema";
import { getDefaultConfig } from "./defaults";
import { logger } from "../utils/logger";

export interface LoadConfigResult {
  config: GraphFlowConfig;
  usedFallback: boolean;
  configPath: string;
  error?: string;
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

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

  if (input.graphPolicy.transport === "mcp-http" && !input.graphPolicy.mcpEndpoint) {
    throw new Error("Invalid config: graphPolicy.mcpEndpoint is required for mcp-http.");
  }

  if (input.graphPolicy.transport === "file" && !input.graphPolicy.graphStorePath) {
    throw new Error("Invalid config: graphPolicy.graphStorePath is required for file transport.");
  }

  const allowedTransports = new Set(["memory", "mcp-http", "file", "sqlite"]);
  if (!allowedTransports.has(input.graphPolicy.transport)) {
    throw new Error(`Invalid config: graphPolicy.transport must be one of memory|mcp-http|file|sqlite.`);
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
    const allowed = new Set(["openai", "anthropic", "bailian", "doubao", "openbmb"]);
    const invalid = input.routingPolicy.providerPriority.some((provider) => !allowed.has(provider));
    if (invalid) {
      throw new Error("Invalid config: routingPolicy.providerPriority contains unknown provider.");
    }
  }

  const enrichProvider = trimOptional(input.graphPolicy.semanticEnrichment?.provider);
  const enrichModel = trimOptional(input.graphPolicy.semanticEnrichment?.model);
  const enrichBackend = input.graphPolicy.semanticEnrichment?.backend;
  const enrichApiKey = trimOptional(input.graphPolicy.semanticEnrichment?.apiKey);
  const enrichBaseUrl = trimOptional(input.graphPolicy.semanticEnrichment?.baseUrl);
  const skillEvolutionModel = trimOptional(input.learningPolicy.skillEvolution?.model);

  if (enrichBackend && enrichBackend !== "network" && enrichBackend !== "local" && enrichBackend !== "inherit") {
    throw new Error("Invalid config: graphPolicy.semanticEnrichment.backend must be network|local|inherit.");
  }

  if (enrichProvider) {
    const allowed = new Set(["openai", "anthropic", "bailian", "doubao", "openbmb"]);
    if (!allowed.has(enrichProvider)) {
      throw new Error("Invalid config: graphPolicy.semanticEnrichment.provider is unknown.");
    }
  }

  if (input.learningPolicy.canaryRatio < 0 || input.learningPolicy.canaryRatio > 100) {
    throw new Error("Invalid config: learningPolicy.canaryRatio must be 0-100.");
  }

  const openbmb = input.providers?.openbmb;
  if (openbmb?.mode) {
    const allowedModes = new Set(["embedded", "ollama", "openai-compat"]);
    if (!allowedModes.has(openbmb.mode)) {
      throw new Error("Invalid config: providers.openbmb.mode must be embedded|ollama|openai-compat.");
    }
  }

  if (openbmb?.engine) {
    const allowedEngines = new Set(["command", "node-llama-cpp"]);
    if (!allowedEngines.has(openbmb.engine)) {
      throw new Error("Invalid config: providers.openbmb.engine must be command|node-llama-cpp.");
    }
  }

  if (openbmb?.mode === "ollama" || openbmb?.mode === "openai-compat") {
    if (!openbmb.baseUrl) {
      throw new Error("Invalid config: providers.openbmb.baseUrl is required for ollama/openai-compat mode.");
    }
  }

  if ((openbmb?.mode ?? "embedded") === "embedded") {
    if (!openbmb?.commandPath && !process.env.GRAPHFLOW_MINICPM_COMMAND) {
      // Embedded mode can still run in fallback compatibility mode; keep validation soft.
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
      autoIndexOnSave: input.graphPolicy.autoIndexOnSave ?? false,
      workspaceRoot,
      graphStorePath:
        input.graphPolicy.graphStorePath ??
        (input.graphPolicy.transport === "sqlite"
          ? "tmp/graphflow-graph.sqlite"
          : "tmp/graphflow-graph.json"),
      includeExtensions: input.graphPolicy.includeExtensions ?? [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".md",
        ".json",
      ],
      layerQuota: input.graphPolicy.layerQuota ?? { l1: 6, l2: 4, l3: 3 },
      semanticEnrichment: {
        enabled: input.graphPolicy.semanticEnrichment?.enabled ?? true,
        mode: input.graphPolicy.semanticEnrichment?.mode ?? "post-index",
        ...(enrichBackend ? { backend: enrichBackend } : {}),
        ...(enrichProvider ? { provider: enrichProvider } : {}),
        ...(enrichModel ? { model: enrichModel } : {}),
        ...(enrichApiKey ? { apiKey: enrichApiKey } : {}),
        ...(enrichBaseUrl ? { baseUrl: enrichBaseUrl } : {}),
        batchSize: input.graphPolicy.semanticEnrichment?.batchSize ?? 5,
        sleepMs: input.graphPolicy.semanticEnrichment?.sleepMs ?? 0,
        timeoutMs: input.graphPolicy.semanticEnrichment?.timeoutMs ?? 5000,
        autoRunOnIndex: input.graphPolicy.semanticEnrichment?.autoRunOnIndex ?? true,
      },
    },
    learningPolicy: {
      ...input.learningPolicy,
      trainingCadence: input.learningPolicy.trainingCadence ?? "nightly",
      canaryRatio: input.learningPolicy.canaryRatio ?? 10,
      eventsPath: input.learningPolicy.eventsPath ?? "tmp/learning-events.jsonl",
      summaryPath: input.learningPolicy.summaryPath ?? "tmp/learning-summary.json",
      skillEvolution: {
        enabled: input.learningPolicy.skillEvolution?.enabled ?? true,
        ...(skillEvolutionModel ? { model: skillEvolutionModel } : {}),
        minCoOccur: input.learningPolicy.skillEvolution?.minCoOccur ?? 2,
        minSuccess: input.learningPolicy.skillEvolution?.minSuccess ?? 2,
        enableTripleFusion: input.learningPolicy.skillEvolution?.enableTripleFusion ?? true,
      },
    },
    routingPolicy: {
      enableDynamicRouting: input.routingPolicy?.enableDynamicRouting ?? true,
      requireApiKeyForHealthy: input.routingPolicy?.requireApiKeyForHealthy ?? false,
      providerPriority: input.routingPolicy?.providerPriority ?? [
        "openai",
        "anthropic",
        "bailian",
        "doubao",
        "openbmb",
      ],
    },
    skillPolicy: {
      enableSkillFlywheel: input.skillPolicy?.enableSkillFlywheel ?? true,
      maxSkillHints: input.skillPolicy?.maxSkillHints ?? 3,
    },
    embeddingPolicy: {
      enabled: input.embeddingPolicy?.enabled ?? true,
      provider: input.embeddingPolicy?.provider ?? "local",
      model: input.embeddingPolicy?.model ?? "Xenova/bge-base-zh-v1.5",
      ...(input.embeddingPolicy?.baseUrl ? { baseUrl: input.embeddingPolicy.baseUrl } : {}),
      ...(input.embeddingPolicy?.apiKey ? { apiKey: input.embeddingPolicy.apiKey } : {}),
      vectorStorePath: input.embeddingPolicy?.vectorStorePath ?? ".graphflow-cache/vectors.db",
      topK: input.embeddingPolicy?.topK ?? 8,
      minSimilarity: input.embeddingPolicy?.minSimilarity ?? 0.05,
    },
  };
}
