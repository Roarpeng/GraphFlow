import {
  diagnoseRoutingResult,
  exportArtifact,
  expandAnchor,
  captureAssistantReply,
  getSkillInsights,
  getFlywheelReport,
  getTokenSavingsStats,
  importArtifact,
  indexFile,
  indexGraph,
  inspectGraph,
  planAndBrainstormResult,
  planInsightResult,
  previewContext,
  extractDialogueKnowledgeRuntime,
  rebuildGraph,
  reportOutcome,
  runTaskResult,
  submitAgentInsightResult,
  mergeAgentInsightResult,
  type PreviewDialogueOptions,
} from "../cli/runtime";
import { getRuntimeTimelineSummary } from "../../core/cancellation";
import { isDeviationKind } from "../../learning/episodic-memory";
import type { McpServer } from "./server.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  /** MCP progress token from the request's _meta, used to emit progress notifications. */
  progressToken?: string | number;
}

export type ToolCallResponse = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: unknown;
};

export interface ExecutionHooks {
}

export const MAX_STRING_FIELD_LENGTH = 100_000;

export async function executeToolCall(
  call: ToolCall,
  server?: McpServer,
  _hooks?: ExecutionHooks
): Promise<ToolCallResponse & { structuredContent: Record<string, unknown> }> {
  const args = call.arguments ?? {};
  const onProgress = makeProgressCallback(server, call.progressToken);

  switch (call.name) {
    case "graphflow_run":
      return structuredResponse(
        await runTaskResult(readRequiredString(args.task, "task"), readOptionalString(args.configPath))
      );
    case "graphflow_report_outcome": {
      const lessonsRaw = args.lessons;
      const lessons = Array.isArray(lessonsRaw)
        ? lessonsRaw.filter((l): l is string => typeof l === "string")
        : [];
      const deviationRaw = readOptionalString(args.deviation);
      const deviation = isDeviationKind(deviationRaw) ? deviationRaw : undefined;
      const requirementIds = readOptionalStringArray(args.requirementIds);
      const conceptIds = readOptionalStringArray(args.conceptIds);
      const codeHints = readOptionalStringArray(args.codeHints);
      const artifacts = readOptionalStringArray(args.artifacts) ?? [];
      const testResultRaw = readOptionalString(args.testResult);
      const commit = readOptionalString(args.commit);
      const diff = readOptionalString(args.diff);
      const testCommand = readOptionalString(args.testCommand);
      const evidenceSource = readOptionalString(args.evidenceSource);
      const repository = readOptionalString(args.repository);
      const engineeringHints = {
        ...(requirementIds ? { requirementIds } : {}),
        ...(conceptIds ? { conceptIds } : {}),
        ...(codeHints ? { codeHints } : {}),
      };
      const hasEngHints = Boolean(requirementIds || conceptIds || codeHints);
      const evidence = commit || diff || testCommand ? {
        ...(repository ? { repository } : {}),
        ...(commit ? { commit } : {}),
        ...(diff ? { diff } : {}),
        ...(testCommand ? { testCommand } : {}),
        testResult: testResultRaw === "pass" || testResultRaw === "fail" || testResultRaw === "unknown"
          ? testResultRaw
          : ("unknown" as const),
        artifacts,
        userConfirmed: args.userConfirmed === true,
        source: evidenceSource === "ci" || evidenceSource === "agent" || evidenceSource === "hook"
          ? evidenceSource
          : ("manual" as const),
      } as const : undefined;
      return structuredResponse(
        await reportOutcome(
          readRequiredString(args.episodeId, "episodeId"),
          typeof args.success === "boolean" ? args.success : false,
          lessons,
          readOptionalString(args.configPath),
          deviation,
          hasEngHints ? engineeringHints : undefined,
          evidence
        )
      );
    }
    case "graphflow_context": {
      const query = readOptionalString(args.query);
      const anchorId = readOptionalString(args.anchorId);
      const assistantReply = readOptionalString(args.assistantReply);
      if (anchorId && !query) {
        return structuredResponse(
          await expandAnchor(
            anchorId,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir)
          )
        );
      }
      if (!query && !anchorId && assistantReply) {
        return structuredResponse(
          await captureAssistantReply(
            assistantReply,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir),
            buildDialogueOptions(args)
          )
        );
      }
      if (query && !anchorId) {
        return structuredResponse(
          await previewContext(
            query,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir),
            readOptionalString(args.englishQuery),
            buildDialogueOptions(args)
          )
        );
      }
      if (query && anchorId) {
        // Both provided: default to preview behavior for backward compatibility
        return structuredResponse(
          await previewContext(
            query,
            readOptionalString(args.configPath),
            readOptionalString(args.rootDir),
            readOptionalString(args.englishQuery),
            buildDialogueOptions(args)
          )
        );
      }
      throw new Error("Either 'query', 'anchorId', or 'assistantReply' must be provided for graphflow_context.");
    }
    case "graphflow_plan": {
      const mode = readOptionalString(args.mode) || "simple";
      const task = readRequiredString(args.task, "task");
      if (mode === "insight") {
        return structuredResponse(
          await planInsightResult(task, readOptionalString(args.configPath))
        );
      }
      return structuredResponse(
        await planAndBrainstormResult(task, readOptionalString(args.configPath))
      );
    }
    case "graphflow_index": {
      const filePath = readOptionalString(args.filePath);
      const mode = readOptionalString(args.mode) || "incremental";
      const extractKnowledge = args.knowledgeExtract === true;
      if (filePath) {
        const result = await indexFile(filePath, readOptionalString(args.configPath));
        if (!extractKnowledge) return structuredResponse(result);
        return structuredResponse({
          ...result,
          knowledge: await extractDialogueKnowledgeRuntime(readOptionalString(args.configPath), {
            ...dialogueKnowledgeOptions(args),
          }),
        });
      }
      if (mode === "full") {
        const result = await rebuildGraph(
            readOptionalString(args.rootDir),
            readOptionalString(args.configPath),
            onProgress ? { onProgress } : undefined
        );
        if (!extractKnowledge) return structuredResponse(result);
        return structuredResponse({
          ...result,
          knowledge: await extractDialogueKnowledgeRuntime(readOptionalString(args.configPath), {
            ...dialogueKnowledgeOptions(args),
          }),
        });
      }

      const result = await indexGraph(
          readOptionalString(args.rootDir),
          readOptionalString(args.configPath),
          onProgress ? { onProgress } : undefined
      );
      if (!extractKnowledge) return structuredResponse(result);
      return structuredResponse({
        ...result,
        knowledge: await extractDialogueKnowledgeRuntime(readOptionalString(args.configPath), {
          ...dialogueKnowledgeOptions(args),
        }),
      });
    }
    case "graphflow_insight": {
      const mode = readRequiredString(args.mode, "mode");
      const task = readRequiredString(args.task, "task");
      if (mode === "submit") {
        return structuredResponse(
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
        return structuredResponse(
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
      return structuredResponse(
        await getSkillInsights(
          readOptionalString(args.configPath),
          readOptionalNumber(args.limit),
          readOptionalString(args.rootDir)
        )
      );
    case "graphflow_diagnose": {
      const configPath = readOptionalString(args.configPath);
      const health = diagnoseRoutingResult(configPath);
      const { probeTeamDiagnosis } = await import("../team/diagnose.js");
      health.team = await probeTeamDiagnosis(configPath);
      const graph = await inspectGraph(configPath, buildInspectOptions(args));
      const stats = getTokenSavingsStats(configPath, readOptionalString(args.rootDir));
      const flywheel = getFlywheelReport(configPath, readOptionalString(args.rootDir));
      return structuredResponse({
        health,
        graph,
        stats,
        flywheel,
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
        return structuredResponse(
          await exportArtifact(
            readOptionalString(args.configPath),
            readOptionalString(args.outputPath),
            undefined,
            compression ? { compression } : undefined
          )
        );
      }
      if (mode === "import") {
        return structuredResponse(
          await importArtifact(readOptionalString(args.configPath), readOptionalString(args.inputPath))
        );
      }
      throw new Error(`Invalid mode '${mode}' for graphflow_artifact. Use 'export' or 'import'.`);
    }
    case "graphflow_skill_guide": {
      const section = readOptionalString(args.section) || "all";
      const skillGuide = getSkillGuide(section);
      return {
        content: [
          {
            type: "text",
            // Preserve the pre-structuredContent wire shape for clients that
            // JSON.parse this field as a guide string.
            text: JSON.stringify(skillGuide, null, 2),
          },
        ],
        structuredContent: { section, guide: skillGuide },
      };
    }
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function makeProgressCallback(
  server: McpServer | undefined,
  progressToken: string | number | undefined
): ((processed: number, total: number) => void) | undefined {
  if (progressToken === undefined || !server) {
    return undefined;
  }
  return (processed: number, total: number): void => {
    server.sendProgress(progressToken, processed, total);
  };
}

function getSkillGuide(section: string): string {
  const skillPath = resolveSkillPath();
  if (!skillPath) {
    return JSON.stringify({
      error: "SKILL.md not found",
      message: "The GraphFlow SKILL.md file could not be located. This is bundled at skills/graphflow/ (Agent Plugins) or dist/surfaces/trae-skill/graphflow/.",
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
    join(process.cwd(), "skills", "graphflow", "SKILL.md"),
    join(__dirname, "..", "..", "..", "skills", "graphflow", "SKILL.md"),
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

function dialogueKnowledgeOptions(args: Record<string, unknown>) {
  const rootDir = readOptionalString(args.rootDir);
  return {
    ...(rootDir ? { rootDir } : {}),
  };
}

function structuredResponse(
  data: unknown
): ToolCallResponse & { structuredContent: Record<string, unknown> } {
  const response: ToolCallResponse = {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };

  if (data !== null && typeof data === "object") {
    response.structuredContent = data as Record<string, unknown>;
  } else {
    // Every current tool result is an object or array. Keep the invariant
    // explicit so the SDK's CallToolResult contract cannot regress silently.
    response.structuredContent = { result: data };
  }

  return response as ToolCallResponse & { structuredContent: Record<string, unknown> };
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

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
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

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function buildDialogueOptions(args: Record<string, unknown>): PreviewDialogueOptions | undefined {
  const topicId = readOptionalString(args.topicId);
  const sessionId = readOptionalString(args.sessionId);
  const resumeFromTurnId = readOptionalString(args.resumeFromTurnId);
  const assistantReply = readOptionalString(args.assistantReply);
  const recordDialogue = readOptionalBoolean(args.recordDialogue);
  if (!topicId && !sessionId && !resumeFromTurnId && !assistantReply && recordDialogue === undefined) {
    return undefined;
  }
  return {
    ...(topicId ? { topicId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(resumeFromTurnId ? { resumeFromTurnId } : {}),
    ...(assistantReply ? { assistantReply } : {}),
    ...(recordDialogue !== undefined ? { recordDialogue } : {}),
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
