export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "graphflow_run",
      description: "[Core] Plan and package a task with compressed context, returning a structured execution descriptor for external coding agents (Cursor, Claude Code) to execute. Bridge mode by default. CALL graphflow_report_outcome AFTER executing the plan to close the learning loop.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description to plan and package." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_report_outcome",
      description: "[Core] Report the real execution outcome of a bridge-mode task back to GraphFlow. After an external coding agent executes the executionDescriptor returned by graphflow_run, it calls this tool to close the learning loop: updates the episode record and applies skill score updates that were skipped during delegation.",
      inputSchema: {
        type: "object",
        properties: {
          episodeId: { type: "string", description: "The episodeId returned by graphflow_run." },
          success: { type: "boolean", description: "Whether the external agent completed the task successfully." },
          lessons: {
            type: "array",
            items: { type: "string" },
            description: "Optional lessons learned (max 4).",
          },
          deviation: {
            type: "string",
            enum: ["none", "misread-requirement", "scope-creep", "tech-drift"],
            description:
              "Optional drift classification vs the original goal anchor: did the work deviate because the requirement was misread, the scope crept, or the technical approach drifted? Use 'none' when it stayed aligned.",
          },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["episodeId", "success"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_context",
      description: "[Core] Preview near-lossless context packaging OR expand a context anchor to full content. Pass 'query' to preview context for a question; pass 'anchorId' (and no query) to expand a specific anchor returned by a previous preview call.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Query to preview. Be specific about what you need to understand." },
          anchorId: { type: "string", description: "The anchor id returned by graphflow_context preview (e.g. 'symbol:src/foo.ts:abc123'). Use this instead of query to expand an anchor." },
          englishQuery: {
            type: "string",
            description: "Optional English code-search keywords when query is Chinese/CJK.",
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
        "[Core] Generate a DAG-style task plan. mode='simple' (default) for planning; mode='insight' for Six Hats + 5-Why. Without a GraphFlow LLM API key, BOTH modes bridge to you (the coding agent): simple returns mode='agent-delegated' with lightweight simple-plan-* work items plus optional suggestedNodes (heuristic, non-final); insight returns the full Six Hats work-item set. MUST answer via graphflow_insight (submit then merge). Do not treat suggested/placeholder plan as final.",
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
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_insight",
      description: "[Advanced] Submit or merge agent insights. Mode 'submit' for individual work items, 'merge' to consolidate all submitted insights.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task associated with the insight operation." },
          mode: { type: "string", enum: ["submit", "merge"], description: "Operation mode: 'submit' to submit an agent response, 'merge' to merge all submitted insights." },
          workItemId: { type: "string", description: "Required for mode='submit'. The agentWorkItems id (e.g. hat-1-white, plan-refinement)." },
          response: { type: "string", description: "Required for mode='submit'. JSON response string from the agent (fenced code blocks accepted)." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
          episodeId: { type: "string", description: "Optional episodeId from graphflow_run for traceability." },
        },
        required: ["task", "mode"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_skill_insights",
      description: "[Advanced] Return top learned skill insights from the graph store.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          limit: { type: "number", description: "Maximum skills to return." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_diagnose",
      description: "[Maintenance] Return provider health, graph statistics, and token savings.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          nodeLimit: { type: "number", description: "Max sample nodes for graph inspection." },
          edgeLimit: { type: "number", description: "Max sample edges for graph inspection." },
          rootDir: { type: "string", description: "Optional workspace root override." },
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
    {
      name: "graphflow_skill_guide",
      description: "[Core] Return the full GraphFlow Skill guide, including tool inventory, standard workflows, and best practices. This guide helps you understand WHEN and HOW to use each GraphFlow tool. Call this when you need guidance on using GraphFlow effectively, especially when the SKILL.md file cannot be installed to your C: drive. ALWAYS call graphflow_context BEFORE multi-step edits, large refactors, or codebase-wide questions.",
      inputSchema: {
        type: "object",
        properties: {
          section: { type: "string", description: "Optional section filter: 'workflows', 'tools', 'best-practices', 'decision-tree', or 'all' (default)." },
        },
        additionalProperties: false,
      },
    },
  ];
}
