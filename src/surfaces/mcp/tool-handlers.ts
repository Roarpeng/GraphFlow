import {
  diagnoseRoutingResult,
  exportArtifact,
  expandAnchor,
  getSkillInsights,
  getTokenSavingsStats,
  importArtifact,
  indexFile,
  indexGraph,
  inspectGraph,
  planAndBrainstormResult,
  planInsightResult,
  previewContext,
  rebuildGraph,
  reportOutcome,
  runTaskResult,
  submitAgentInsightResult,
  mergeAgentInsightResult,
} from "../cli/runtime";
import { getRuntimeTimelineSummary } from "../../core/cancellation";
import type { McpServer } from "./server.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResponse {
  content: Array<{
    type: "text";
    text: string;
  }>;
}

export interface ExecutionHooks {
}

export const MAX_STRING_FIELD_LENGTH = 100_000;

export async function executeToolCall(
  call: ToolCall,
  _server?: McpServer,
  _hooks?: ExecutionHooks
): Promise<ToolCallResponse> {
  const args = call.arguments ?? {};

  switch (call.name) {
    case "graphflow_run":
      return textResponse(
        await runTaskResult(readRequiredString(args.task, "task"), readOptionalString(args.configPath))
      );
    case "graphflow_report_outcome": {
      const lessonsRaw = args.lessons;
      const lessons = Array.isArray(lessonsRaw)
        ? lessonsRaw.filter((l): l is string => typeof l === "string")
        : [];
      return textResponse(
        await reportOutcome(
          readRequiredString(args.episodeId, "episodeId"),
          typeof args.success === "boolean" ? args.success : false,
          lessons,
          readOptionalString(args.configPath)
        )
      );
    }
    case "graphflow_context": {
      const query = readOptionalString(args.query);
      const anchorId = readOptionalString(args.anchorId);
      if (anchorId && !query) {
        return textResponse(
          await expandAnchor(
            anchorId,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir)
          )
        );
      }
      if (query && !anchorId) {
        return textResponse(
          await previewContext(
            query,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir),
            readOptionalString(args.englishQuery)
          )
        );
      }
      if (query && anchorId) {
        // Both provided: default to preview behavior for backward compatibility
        return textResponse(
          await previewContext(
            query,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir),
            readOptionalString(args.englishQuery)
          )
        );
      }
      throw new Error("Either 'query' or 'anchorId' must be provided for graphflow_context.");
    }
    case "graphflow_plan": {
      const mode = readOptionalString(args.mode) || "simple";
      const task = readRequiredString(args.task, "task");
      if (mode === "insight") {
        return textResponse(
          await planInsightResult(task, readOptionalString(args.configPath))
        );
      }
      return textResponse(
        planAndBrainstormResult(task, readOptionalString(args.configPath))
      );
    }
    case "graphflow_index": {
      const filePath = readOptionalString(args.filePath);
      const mode = readOptionalString(args.mode) || "incremental";
      if (filePath) {
        return textResponse(
          await indexFile(filePath, readOptionalString(args.configPath))
        );
      }
      if (mode === "full") {
        return textResponse(
          await rebuildGraph(readOptionalString(args.rootDir), readOptionalString(args.configPath))
        );
      }
      return textResponse(
        await indexGraph(readOptionalString(args.rootDir), readOptionalString(args.configPath))
      );
    }
    case "graphflow_insight": {
      const mode = readRequiredString(args.mode, "mode");
      const task = readRequiredString(args.task, "task");
      if (mode === "submit") {
        return textResponse(
          await submitAgentInsightResult(
            task,
            readRequiredString(args.workItemId, "workItemId"),
            readRequiredString(args.response, "response"),
            readOptionalString(args.configPath),
            readOptionalString(args.episodeId),
            readOptionalString(args.rootDir)
          )
        );
      }
      if (mode === "merge") {
        return textResponse(
          await mergeAgentInsightResult(
            task,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir)
          )
        );
      }
      throw new Error(`Invalid mode '${mode}' for graphflow_insight. Use 'submit' or 'merge'.`);
    }
    case "graphflow_skill_insights":
      return textResponse(
        await getSkillInsights(
          readOptionalString(args.configPath),
          readOptionalNumber(args.limit),
          readOptionalString(args.rootDir)
        )
      );
    case "graphflow_diagnose": {
      const configPath = readOptionalString(args.configPath);
      const health = diagnoseRoutingResult(configPath);
      const graph = await inspectGraph(configPath, buildInspectOptions(args));
      const stats = getTokenSavingsStats(configPath, readOptionalString(args.rootDir));
      return textResponse({
        health,
        graph,
        stats,
        runtimeTimeline: getRuntimeTimelineSummary(),
      });
    }
    case "graphflow_artifact": {
      const mode = readRequiredString(args.mode, "mode");
      if (mode === "export") {
        const compressionRaw = readOptionalString(args.compression);
        const compression = compressionRaw === "none" || compressionRaw === "gzip"
          ? compressionRaw
          : undefined;
        return textResponse(
          await exportArtifact(
            readOptionalString(args.configPath),
            readOptionalString(args.outputPath),
            undefined,
            compression ? { compression } : undefined
          )
        );
      }
      if (mode === "import") {
        return textResponse(
          await importArtifact(readOptionalString(args.configPath), readOptionalString(args.inputPath))
        );
      }
      throw new Error(`Invalid mode '${mode}' for graphflow_artifact. Use 'export' or 'import'.`);
    }
    case "graphflow_skill_guide": {
      const section = readOptionalString(args.section) || "all";
      const skillGuide = getSkillGuide(section);
      return textResponse(skillGuide);
    }
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function getSkillGuide(section: string): string {
  const skillPath = resolveSkillPath();
  if (!skillPath) {
    return JSON.stringify({
      error: "SKILL.md not found",
      message: "The GraphFlow SKILL.md file could not be located. This is bundled in the dist/surfaces/trae-skill/graphflow/ directory.",
      guide: getBuiltInSkillGuide(),
    }, null, 2);
  }

  try {
    const content = readFileSync(skillPath, "utf8");
    return filterSkillSection(content, section);
  } catch {
    return JSON.stringify({
      error: "Failed to read SKILL.md",
      guide: getBuiltInSkillGuide(),
    }, null, 2);
  }
}

function resolveSkillPath(): string | undefined {
  const candidates = [
    join(__dirname, "..", "..", "surfaces", "trae-skill", "graphflow", "SKILL.md"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "trae-skill", "graphflow", "SKILL.md"),
    join(process.cwd(), "src", "surfaces", "trae-skill", "graphflow", "SKILL.md"),
    join(process.cwd(), "dist", "surfaces", "trae-skill", "graphflow", "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function filterSkillSection(content: string, section: string): string {
  if (section === "all") {
    return content;
  }

  const sections: Record<string, { start: string; end?: string }> = {
    "workflows": { start: "## Standard Workflows", end: "## Tool Selection" },
    "tools": { start: "## Tool Inventory", end: "## Standard Workflows" },
    "best-practices": { start: "## Best Practices", end: "## Troubleshooting" },
    "decision-tree": { start: "## Tool Selection Decision Tree", end: "## Output Interpretation" },
  };

  const config = sections[section];
  if (!config) {
    return content;
  }

  const startIdx = content.indexOf(config.start);
  if (startIdx === -1) {
    return content;
  }

  if (config.end) {
    const endIdx = content.indexOf(config.end, startIdx);
    if (endIdx !== -1) {
      return content.substring(startIdx, endIdx).trim();
    }
  }

  return content.substring(startIdx).trim();
}

function getBuiltInSkillGuide(): string {
  return `## GraphFlow Quick Skill Guide

### Core Workflow: Context First
ALWAYS call \`graphflow_context(query)\` BEFORE:
- Multi-step edits, refactors, or architecture changes
- Large codebase-wide questions or exploration
- Debugging across multiple files
- Any task where you would otherwise read many files

### Key Tools
| Tool | Purpose |
|------|---------|
| \`graphflow_context\` | Preview compressed context or expand an anchor |
| \`graphflow_plan\` | Multi-step task decomposition & DAG |
| \`graphflow_index\` | Incremental workspace re-index or full rebuild |
| \`graphflow_diagnose\` | Check provider health, graph stats, and token savings |

### Best Practices
1. Start EVERY task with \`graphflow_context\`
2. Only read full files when compressed context is insufficient
3. Use \`graphflow_plan\` for tasks beyond 2-3 files
4. Call \`graphflow_index\` after significant changes
5. Always report token savings to the user

### Tool Selection Decision Tree
- Code question/exploration? -> \`graphflow_context\`
- Need more detail? -> \`graphflow_context\` with anchorId
- Multi-step coding task? -> \`graphflow_context\` -> \`graphflow_plan\` -> implement
- File changes made? -> \`graphflow_index\` (single file via filePath, or incremental)
- Graph giving bad results? -> \`graphflow_diagnose\` -> \`graphflow_index\` with mode='full'

Call \`graphflow_skill_guide(section: "all")\` for the complete guide.`;
}

function textResponse(data: unknown): ToolCallResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Field '${field}' must be a non-empty string.`);
  }
  if (value.length > MAX_STRING_FIELD_LENGTH) {
    throw new Error(
      `Field '${field}' exceeds maximum length of ${MAX_STRING_FIELD_LENGTH} characters.`,
    );
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildInspectOptions(args: Record<string, unknown>): {
  nodeLimit?: number;
  edgeLimit?: number;
  rootDir?: string;
} {
  const nodeLimit = readOptionalNumber(args.nodeLimit);
  const edgeLimit = readOptionalNumber(args.edgeLimit);
  const rootDir = readOptionalString(args.rootDir);

  return {
    ...(nodeLimit !== undefined ? { nodeLimit } : {}),
    ...(edgeLimit !== undefined ? { edgeLimit } : {}),
    ...(rootDir !== undefined ? { rootDir } : {}),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readProgressToken(params: Record<string, unknown>): string | number | undefined {
  const direct = params.progressToken;
  if (typeof direct === "string" || typeof direct === "number") {
    return direct;
  }
  const meta = params._meta;
  if (!isRecord(meta)) {
    return undefined;
  }
  const token = meta.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}
