import { readFileSync } from "node:fs";
import type { GraphFlowConfig } from "./schema";

export function loadConfig(path = "graphflow.config.json"): GraphFlowConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = resolveEnvTemplates(JSON.parse(raw)) as GraphFlowConfig;
  return validateConfig(parsed);
}

function resolveEnvTemplates(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? "");
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

  return {
    ...input,
    graphPolicy: {
      ...input.graphPolicy,
      enableNearLosslessMode: input.graphPolicy.enableNearLosslessMode ?? false,
      autoIndexOnPreview: input.graphPolicy.autoIndexOnPreview ?? true,
      autoIndexOnRun: input.graphPolicy.autoIndexOnRun ?? true,
      workspaceRoot: input.graphPolicy.workspaceRoot ?? process.cwd(),
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
        model: input.graphPolicy.semanticEnrichment?.model ?? "minicpm-1b",
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
        model: input.learningPolicy.skillEvolution?.model ?? "minicpm-1b",
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
  };
}
