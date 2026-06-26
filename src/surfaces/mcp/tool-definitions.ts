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
      description: "Plan and package a task with compressed context, returning a structured execution descriptor for external coding agents (Cursor, Claude Code) to execute. Bridge mode by default.",
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
      description: "Report the real execution outcome of a bridge-mode task back to GraphFlow. After an external coding agent executes the executionDescriptor returned by graphflow_run, it calls this tool to close the learning loop: updates the episode record and applies skill score updates that were skipped during delegation.",
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
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["episodeId", "success"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_submit_insight",
      description: "Submit a connected coding agent's answer to an agentWorkItems prompt back into the GraphFlow graph as a Decision node. Use after completing Six Hats or plan-refinement prompts from graphflow_run or graphflow_plan_insight when no external LLM API is configured.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task associated with the work item." },
          workItemId: { type: "string", description: "The agentWorkItems id (e.g. hat-1-white, plan-refinement)." },
          response: { type: "string", description: "JSON response string from the agent (fenced code blocks accepted)." },
          episodeId: { type: "string", description: "Optional episodeId from graphflow_run for traceability." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        required: ["task", "workItemId", "response"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_merge_insight",
      description: "Merge submitted agent-insight Decision nodes for a task into a unified Six Hats insight and DAG plan. Use after submitting hat and plan-refinement responses via graphflow_submit_insight.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task associated with the submitted insights." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_plan",
      description: "Generate brainstorming ideas and a DAG-style task plan for a request.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description to plan." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_preview_context",
      description: "Preview GraphFlow near-lossless context packaging for a query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Query to preview." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_expand_anchor",
      description: "Expand a context anchor to its full content. Anchors returned by graphflow_preview_context are lightweight pointers (id/type/layer). This tool resolves an anchor id back to its full GraphNode content and, for Symbol nodes, reads the surrounding source code lines from the original file.",
      inputSchema: {
        type: "object",
        properties: {
          anchorId: { type: "string", description: "The anchor id returned by graphflow_preview_context (e.g. \"symbol:src/foo.ts:abc123\")." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        required: ["anchorId"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_index",
      description: "Index a workspace path into the GraphFlow graph store.",
      inputSchema: {
        type: "object",
        properties: {
          rootDir: { type: "string", description: "Optional workspace path to index." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_index_file",
      description: "Incrementally index a single file into the graph store. Use this for file-watcher / onSave hooks to avoid full workspace re-walks. Skips unchanged files automatically.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative path to the file to index." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_rebuild",
      description: "Clear graph store and index cache, then perform a full workspace re-index.",
      inputSchema: {
        type: "object",
        properties: {
          rootDir: { type: "string", description: "Optional workspace path to index." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_enrich_graph",
      description: "Run semantic enrichment for pending Symbol nodes using configured network (cloud API) or local OpenBMB backend.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          batchSize: { type: "number", description: "Optional enrichment batch size." },
          sleepMs: { type: "number", description: "Optional delay between node enrichments." },
          timeoutMs: { type: "number", description: "Optional provider timeout per enrichment call." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_model_download",
      description: "Download MiniCPM/OpenBMB model file to local path with optional checksum verification.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          model: { type: "string", description: "Model name, default minicpm5-1b." },
          url: { type: "string", description: "Optional model URL override." },
          sha256: { type: "string", description: "Optional expected sha256 checksum." },
          targetPath: { type: "string", description: "Optional target file path." },
          force: { type: "boolean", description: "Force re-download even if file exists." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_inspect_graph",
      description: "Inspect current graph snapshot statistics and sample nodes/edges.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          nodeLimit: { type: "number", description: "Max sample nodes." },
          edgeLimit: { type: "number", description: "Max sample edges." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_skill_insights",
      description: "Return top learned skill insights from the graph store.",
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
      description: "Return provider health, routing priority, and resolved planner/worker/validator models.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_export_artifact",
      description: "Export the current graph store to a portable gzip-compressed artifact file (analogous to codebase-memory-mcp's graph.db.zst) for team sharing. The artifact can be committed to git and imported by teammates to skip full workspace indexing. Supports --no-compress for plain JSON output.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          outputPath: { type: "string", description: "Optional output path for the artifact file." },
          compression: { type: "string", description: "Compression mode: 'gzip' (default) or 'none'." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_import_artifact",
      description: "Import a graph artifact file into the current graph store. Teammates can use this after cloning a repo to skip the initial full workspace index.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          inputPath: { type: "string", description: "Optional input path for the artifact file." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_stats",
      description: "Return cumulative token savings statistics, showing how much GraphFlow has reduced token consumption across all context preview and task runs.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_plan_insight",
      description: "Analyze a task through Six Thinking Hats (White/Red/Black/Yellow/Green/Blue) with automatic 5-Why chains on low-certainty observations, then generate a DAG-style plan informed by the insights. This runs a deeper analysis than graphflow_plan — use this for complex or ambiguous tasks where root-cause analysis is needed.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description to analyze and plan." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_metrics",
      description: "Return Prometheus-compatible metrics for GraphFlow observability: token savings, graph size, compression ratio, index cache stats. Output is Prometheus text exposition format.",
      inputSchema: {
        type: "object",
        properties: {
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
          rootDir: { type: "string", description: "Optional workspace root override." },
        },
        additionalProperties: false,
      },
    },
  ];
}
