import { V3_TOOL_DEFINITIONS } from "../../v3/mcp-tools";
/** MCP ToolAnnotations (spec 2025-06-18+). Hints only — clients must not treat them as enforcement. */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Risk levels shared with the efficiency agent's risk policy: R0 read-only, R1 bounded-local,
 * R2 external side effect, R3 secret/escape, R4 destructive, R5 agent-spawn.
 */
export type GraphFlowToolRisk = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

/** Capability ids from packages/efficiency-agent/policies/capabilities-v1.json. */
export type GraphFlowToolCapability =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.connect"
  | "git.write"
  | "package.install"
  | "secret.read"
  | "agent.spawn";

/**
 * GraphFlow-namespaced `_meta` keys. `risk`/`capabilities` describe the
 * default configuration (no LLM key, no team server); the `conditional*`
 * keys apply only when the operator configured that provider.
 * `writeScope`: "none", "graphflow-state" (GraphFlow's own graph/memory
 * store, default graphflow-out/), or "caller-path" (a path the caller names).
 */
export interface ToolGovernanceMeta {
  "graphflow/risk": GraphFlowToolRisk;
  "graphflow/capabilities": GraphFlowToolCapability[];
  "graphflow/writeScope": "none" | "graphflow-state" | "caller-path";
  "graphflow/conditionalCapabilities"?: GraphFlowToolCapability[];
  "graphflow/conditionalRisk"?: GraphFlowToolRisk;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  $schema?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: ToolAnnotations;
  _meta?: ToolGovernanceMeta;
}

interface ToolGovernance {
  annotations: ToolAnnotations;
  _meta: ToolGovernanceMeta;
}

const TOOL_GOVERNANCE: Record<string, ToolGovernance> = {
  gf_read: {
    annotations: {
      title: "GraphFlow Surgical Read (AST Skeleton & Symbol Slice)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R0",
      "graphflow/capabilities": ["filesystem.read"],
      "graphflow/writeScope": "none",
    },
  },
  gf_edit: {
    annotations: {
      title: "GraphFlow Surgical Edit (In-Place Symbol/Line Edit & Rename)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write"],
      "graphflow/writeScope": "caller-path",
    },
  },
  gf_exec: {
    annotations: {
      title: "GraphFlow Dehydrated Command & Affected-Test Runner",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "process.exec"],
      "graphflow/writeScope": "graphflow-state",
    },
  },
  gf_macro: {
    annotations: {
      title: "GraphFlow Habit Macro & Git Co-Change Engine",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write", "process.exec"],
      "graphflow/writeScope": "graphflow-state",
    },
  },


  graphflow_context: {
    annotations: {
      title: "GraphFlow Context (preview / expand)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write"],
      "graphflow/writeScope": "graphflow-state",
    },
  },
  graphflow_plan: {
    annotations: {
      title: "GraphFlow Plan (DAG + workbench)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write"],
      "graphflow/writeScope": "graphflow-state",
      "graphflow/conditionalCapabilities": ["network.connect"],
      "graphflow/conditionalRisk": "R2",
    },
  },
  graphflow_index: {
    annotations: {
      title: "GraphFlow Index Workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write"],
      "graphflow/writeScope": "graphflow-state",
    },
  },


  graphflow_diagnose: {
    annotations: {
      title: "GraphFlow Diagnose",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R0",
      "graphflow/capabilities": ["filesystem.read"],
      "graphflow/writeScope": "none",
      "graphflow/conditionalCapabilities": ["network.connect"],
      "graphflow/conditionalRisk": "R2",
    },
  },
  graphflow_artifact: {
    annotations: {
      title: "GraphFlow Artifact (export / import)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "graphflow/risk": "R1",
      "graphflow/capabilities": ["filesystem.read", "filesystem.write"],
      "graphflow/writeScope": "caller-path",
    },
  },

};

export function getV3ToolDefinitions(): ToolDefinition[] {
  return V3_TOOL_DEFINITIONS.map((t) => {
    const governance = TOOL_GOVERNANCE[t.name];
    return {
      ...t,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...(governance
        ? {
            title: governance.annotations.title,
            annotations: { ...governance.annotations },
            _meta: {
              ...governance._meta,
              "graphflow/capabilities": [...governance._meta["graphflow/capabilities"]],
            },
          }
        : {}),
    };
  });
}

export function getToolDefinitions(options?: { profile?: "v3" | "legacy" | "all" }): ToolDefinition[] {
  const envProf = process.env.GRAPHFLOW_MCP_PROFILE?.trim().toLowerCase();
  const profile =
    options?.profile ??
    (envProf === "v3" ? "v3" : envProf === "all" ? "all" : envProf === "legacy" ? "legacy" : undefined);
  if (profile === "v3") {
    return getV3ToolDefinitions();
  }
  const tools: Array<Omit<ToolDefinition, "$schema">> = [


    {
      name: "graphflow_context",
      description:
        "[Core] Preview near-lossless context packaging OR expand a context anchor. Pass 'query' to preview; pass 'anchorId' (and no query) to expand. After you answer the user, call again with assistantReply (query optional) to write the original answer onto the pending turn/topic. The preview result includes dialogueHits: historical Q&A turns matching the query across sessions (superseded ones hidden; a correctionLine flags conclusions that were later revised). Titles on the workbench are display labels only — do not replace stored messages with an extracted abstract.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Query to preview. Be specific about what you need to understand. May be omitted when the call only backfills assistantReply onto the pending turn/topic (or when anchorId / content / handle carries the intent); required only when no other intent is given.",
          },
          anchorId: { type: "string", description: "The anchor id returned by graphflow_context preview (e.g. 'symbol:src/foo.ts:abc123'). Use this instead of query to expand an anchor." },
          content: {
            type: "string",
            description:
              "Large payload to archive as an observation handle (returns handle + head/tail excerpt). Use to avoid replaying huge tool outputs or logs.",
          },
          handle: {
            type: "string",
            description:
              "Observation handle (gfo:…) returned by content packaging. Recall exact bytes (with page/range), or pass reduce:true for a verified receipt.",
          },
          reduce: {
            type: "boolean",
            description:
              "With handle/content: return a verified receipt whose retained lines are each verbatim-checked against the archived source (fail-open to an excerpt on mismatch).",
          },
          page: {
            type: "number",
            description: "0-based page for handle recall (200 lines per page). Ignored when range is given.",
          },
          range: {
            type: "array",
            items: { type: "number" },
            description: "Inclusive 1-based [startLine, endLine] for handle recall.",
          },
          maxReceiptTokens: {
            type: "number",
            description: "Token cap for the verified receipt (default 400).",
          },
          contextPressure: {
            type: "object",
            description:
              "Optional observed host context-window usage. When efficiencyPolicy.contextPressure is enabled, this switches packaging to an observed-pressure budget and returns a compaction signal. Omit when unknown — GraphFlow never fabricates pressure.",
            properties: {
              usedTokens: { type: "number", description: "Tokens currently used in the host context window." },
              maxTokens: { type: "number", description: "Host context-window size in tokens." },
              pressureRatio: { type: "number", description: "usedTokens/maxTokens when the host reports it directly." },
              remainingTurnsEstimate: {
                type: "number",
                description: "Projected turns still to run; enables the economic compaction signal.",
              },
            },
            additionalProperties: false,
          },
          englishQuery: {
            type: "string",
            description: "Optional English code-search keywords when query is Chinese/CJK.",
          },
          topicId: {
            type: "string",
            description: "Workbench topic id to refine or return to (click a function node on the canvas). Activates that topic container and appends this query to it.",
          },
          sessionId: {
            type: "string",
            description: "Optional dialogue session name. Turns in the same session are chained on the graph (default: main).",
          },
          resumeFromTurnId: {
            type: "string",
            description: "Optional dialogue-turn id to continue from (click-to-resume). Links this question to that turn even if the topic jumped.",
          },
          assistantReply: {
            type: "string",
            description:
              "Original assistant answer to store on the pending user turn/topic (clipped). Call after answering; query may be omitted. Do not substitute an extracted 80-char abstract for the original.",
          },
          recordDialogue: {
            type: "boolean",
            description: "Record this preview as a dialogue-turn / workbench message. Default true.",
          },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_plan",
      description:
        "[Core] Generate a DAG-style task plan and seed a workbench of function-topic nodes (workbench.topics + workbench.outline). Click a topic and pass topicId to graphflow_context to refine or return to the mainline. Wake the collapsed outline later via graphflow_diagnose with includeOutline=true (graph.workbenchOutline) or CLI `graphflow workbench tree`. mode='simple' (default) for planning; mode='insight' for Six Hats + 5-Why. Without a GraphFlow LLM API key, BOTH modes bridge to you (the coding agent): simple returns mode='agent-delegated' with lightweight simple-plan-* work items plus optional suggestedNodes (heuristic, non-final); insight returns the full Six Hats work-item set. MUST answer via graphflow_insight (submit then merge). Do not treat suggested/placeholder plan as final.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description to plan. Include what you need to accomplish." },
          mode: { type: "string", enum: ["simple", "insight"], description: "Planning mode: 'simple' (default) for agent-bridged task decomposition (or local/LLM when configured), 'insight' for Six Thinking Hats + 5-Why deep analysis." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_index",
      description: "[Core] Index workspace into graph store. Use filePath for single-file, mode='full' for rebuild.",
      inputSchema: {
        type: "object",
        properties: {
          rootDir: { type: "string", description: "Optional workspace path to index." },
          filePath: { type: "string", description: "Absolute or workspace-relative path to a single file to index. When provided, only this file is indexed." },
          mode: { type: "string", enum: ["incremental", "full"], description: "Indexing mode: 'incremental' (default) for incremental re-index, 'full' for full rebuild (clear cache and re-index everything)." },
          knowledgeExtract: {
            type: "boolean",
            description: "Optional: also extract deterministic Concept/Requirement nodes from stored dialogue turns (v1.12 Engineering KG).",
          },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        additionalProperties: false,
      },
    },


    {
      name: "graphflow_diagnose",
      description:
        "[Maintenance] Return provider health, graph statistics, and token savings. The workbench outline (graph.workbenchOutline, workspace-filtered mainline DAG + side branches) is omitted by default and returned ONLY with includeOutline=true so responses stay small; a slim resume pointer (graph.workbenchResume.activeTopicId) is always present — click it and pass the topicId to graphflow_context to resume, and use CLI `graphflow workbench tree` for a standing outline view. Does not add an 11th tool.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          nodeLimit: { type: "number", description: "Max sample nodes for graph inspection." },
          edgeLimit: { type: "number", description: "Max sample edges for graph inspection." },
          rootDir: { type: "string", description: "Optional workspace root override." },
          includeOutline: {
            type: "boolean",
            description:
              "Optional: also return the workspace-filtered workbench outline (graph.workbenchOutline). Default false — the outline is on demand only (bulky); the active-topic resume pointer is always present, and CLI `graphflow workbench tree` shows the standing tree.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_artifact",
      description: "[Maintenance] Export or import graph artifact files for team sharing.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["export", "import"], description: "Operation mode: 'export' to save graph artifact, 'import' to load graph artifact." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          outputPath: { type: "string", description: "Required for mode='export'. Output path for the artifact file." },
          inputPath: { type: "string", description: "Required for mode='import'. Input path for the artifact file." },
          compression: { type: "string", description: "Compression mode for export: 'gzip' (default) or 'none'." },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },

  ];
  const mapped = tools.map((tool) => {
    const governance = TOOL_GOVERNANCE[tool.name];
    return {
      ...tool,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...(governance
        ? {
            title: governance.annotations.title,
            annotations: { ...governance.annotations },
            _meta: {
              ...governance._meta,
              "graphflow/capabilities": [...governance._meta["graphflow/capabilities"]],
              ...(governance._meta["graphflow/conditionalCapabilities"]
                ? { "graphflow/conditionalCapabilities": [...governance._meta["graphflow/conditionalCapabilities"]] }
                : {}),
            },
          }
        : {}),
    };
  });
  if (profile === "all") {
    return [...getV3ToolDefinitions(), ...mapped];
  }
  return mapped;
}
