export interface ToolDefinition {
  name: string;
  description: string;
  $schema?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export function getToolDefinitions(): ToolDefinition[] {
  const tools: Array<Omit<ToolDefinition, "$schema">> = [
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
      description: "[Core] Report the real execution outcome of a bridge-mode task back to GraphFlow. After an external coding agent executes the executionDescriptor returned by graphflow_run, it calls this tool to close the learning loop: updates the episode record (pass/fail). Skill score updates require quality lessons; a pass without lessons records the episode but does not apply skill learning. SessionEnd auto-capture does not call this unless success is an explicit argument (pending stays pending).",
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
          requirementIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional Engineering KG Requirement node ids to link from this episode via derived_from (experience↔eng provenance).",
          },
          conceptIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional Engineering KG Concept node ids to link from this episode via derived_from.",
          },
          codeHints: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional file paths, symbol names, or file:/symbol: ids resolved against the graph and linked from this episode via derived_from.",
          },
          commit: { type: "string", description: "Repository commit that produced the outcome." },
          diff: { type: "string", description: "Unified diff or concise changed-file summary." },
          testCommand: { type: "string", description: "Command used to validate the outcome." },
          testResult: { type: "string", enum: ["pass", "fail", "unknown"], description: "Actual test command result." },
          artifacts: { type: "array", items: { type: "string" }, description: "Logs, reports, or artifact paths supporting the outcome." },
          userConfirmed: { type: "boolean", description: "Whether a human explicitly confirmed the result." },
          evidenceSource: { type: "string", enum: ["manual", "ci", "agent", "hook"], description: "Origin of the evidence package." },
          configPath: { type: "string", description: "Optional path to graphflow.config.json." },
        },
        required: ["episodeId", "success"],
        additionalProperties: false,
      },
    },
    {
      name: "graphflow_context",
      description:
        "[Core] Preview near-lossless context packaging OR expand a context anchor. Pass 'query' to preview; pass 'anchorId' (and no query) to expand. After you answer the user, call again with assistantReply (query optional) to write the original answer onto the pending turn/topic. The preview result includes dialogueHits: historical Q&A turns matching the query across sessions (superseded ones hidden; a correctionLine flags conclusions that were later revised). Titles on the workbench are display labels only — do not replace stored messages with an extracted abstract.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Query to preview. Be specific about what you need to understand." },
          anchorId: { type: "string", description: "The anchor id returned by graphflow_context preview (e.g. 'symbol:src/foo.ts:abc123'). Use this instead of query to expand an anchor." },
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
        "[Core] Generate a DAG-style task plan and seed a workbench of function-topic nodes (workbench.topics + workbench.outline). Click a topic and pass topicId to graphflow_context to refine or return to the mainline. Wake the collapsed outline later via graphflow_diagnose (graph.workbenchOutline) or CLI `graphflow workbench tree`. mode='simple' (default) for planning; mode='insight' for Six Hats + 5-Why. Without a GraphFlow LLM API key, BOTH modes bridge to you (the coding agent): simple returns mode='agent-delegated' with lightweight simple-plan-* work items plus optional suggestedNodes (heuristic, non-final); insight returns the full Six Hats work-item set. MUST answer via graphflow_insight (submit then merge). Do not treat suggested/placeholder plan as final.",
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
      description:
        "[Maintenance] Return provider health, graph statistics, token savings, and the on-demand workbench outline (graph.workbenchOutline: mainline DAG + side branches). Click a topicId and pass it to graphflow_context to resume. Does not add an 11th tool.",
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
  return tools.map((tool) => ({
    ...tool,
    $schema: "https://json-schema.org/draft/2020-12/schema",
  }));
}
