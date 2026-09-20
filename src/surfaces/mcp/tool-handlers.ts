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
import {
  packObservation,
  recallObservation,
  reduceObservation,
} from "../../observations/index";
import { discoverWorkspaceRoot } from "../../config/discover-workspace";
import type { ObservedContextUsage } from "../../graph/context-pressure";
import { resolveConfig, resolveEfficiencyPolicy, toObservationPolicy } from "../../config/resolve";
import type { ObservationPolicy } from "../../observations/types";

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

function readNumberRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  return typeof start === "number" && typeof end === "number" ? [start, end] : undefined;
}

/**
 * Parse the caller-supplied observed context window for GF-3. Returns undefined
 * when no usable field is present — GraphFlow never fabricates pressure.
 */
function readObservedContextUsage(value: unknown): ObservedContextUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const num = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) ? field : undefined;
  const usage: ObservedContextUsage = {};
  const usedTokens = num(source.usedTokens);
  const maxTokens = num(source.maxTokens);
  const pressureRatio = num(source.pressureRatio);
  const remainingTurnsEstimate = num(source.remainingTurnsEstimate);
  if (usedTokens !== undefined) usage.usedTokens = usedTokens;
  if (maxTokens !== undefined) usage.maxTokens = maxTokens;
  if (pressureRatio !== undefined) usage.pressureRatio = pressureRatio;
  if (remainingTurnsEstimate !== undefined) usage.remainingTurnsEstimate = remainingTurnsEstimate;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export async function executeToolCall(
  call: ToolCall,
  server?: McpServer,
  _hooks?: ExecutionHooks
): Promise<ToolCallResponse & { structuredContent: Record<string, unknown> }> {
  const args = call.arguments ?? {};
  const onProgress = makeProgressCallback(server, call.progressToken);
  // mcp.textCopy 策略在入口一次性注入为模块级默认：structuredResponse 的全部
  // 调用点无需逐处传参，读取失败时保持 "auto"（超阈值桩化）。
  // Inject the mcp.textCopy policy once at the entry point as the module-wide
  // default so no structuredResponse call site needs per-site threading; a
  // failed config read keeps "auto" (stub oversized responses).
  applyTextCopyConfig(readOptionalString(args.configPath));

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
      const handle = readOptionalString(args.handle);
      const content = readOptionalString(args.content);
      if (handle || content) {
        const rootDir =
          readOptionalString(args.rootDir) ?? discoverWorkspaceRoot() ?? process.cwd();
        // Observation policy (thresholds/TTL/redaction/reducer route) comes from
        // efficiencyPolicy.observations. Resolution is fail-open: an unusable
        // config leaves the store on its built-in defaults.
        let basePolicy: ObservationPolicy | undefined;
        try {
          basePolicy = toObservationPolicy(
            resolveEfficiencyPolicy(resolveConfig(readOptionalString(args.configPath), { rootDir }))
          );
        } catch {
          basePolicy = undefined;
        }
        if (args.reduce === true) {
          const maxReceiptTokens =
            typeof args.maxReceiptTokens === "number" ? args.maxReceiptTokens : undefined;
          const reducePolicy: ObservationPolicy | undefined =
            maxReceiptTokens !== undefined
              ? {
                  ...(basePolicy ?? {}),
                  reduce: { ...(basePolicy?.reduce ?? {}), maxReceiptTokens },
                }
              : basePolicy;
          return structuredResponse(
            await reduceObservation({
              rootDir,
              ...(handle ? { handle } : {}),
              ...(content ? { content } : {}),
              ...(reducePolicy !== undefined ? { policy: reducePolicy } : {}),
            })
          );
        }
        if (handle) {
          const page = typeof args.page === "number" ? args.page : undefined;
          const range = readNumberRange(args.range);
          return structuredResponse(
            await recallObservation({
              rootDir,
              handle,
              ...(page !== undefined ? { page } : {}),
              ...(range !== undefined ? { range } : {}),
              ...(basePolicy !== undefined ? { policy: basePolicy } : {}),
            })
          );
        }
        return structuredResponse(
          await packObservation({
            rootDir,
            content: content ?? "",
            ...(basePolicy !== undefined ? { policy: basePolicy } : {}),
          })
        );
      }
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
            buildDialogueOptions(args),
            readObservedContextUsage(args.contextPressure)
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
            buildDialogueOptions(args),
            readObservedContextUsage(args.contextPressure)
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
            // JSON.parse this field as a guide string. 紧凑序列化：缩进只是
            // 传输开销，guide 字符串本身的换行会被转义，不影响 parse 语义。
            // Compact serialization: the guide string's own newlines are
            // escaped, so indentation here is pure transport overhead.
            text: JSON.stringify(skillGuide),
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

/** Policy for the legacy `content[0].text` copy of a tool result. */
export type TextCopyPolicy = "full" | "auto";

/**
 * 大响应桩化阈值（UTF-8 字节）：auto 策略下紧凑 JSON 超过该值时，text 副本
 * 降级为一行桩，structuredContent 仍携带全量数据。
 * Oversized-response stub threshold (UTF-8 bytes): under the "auto" policy a
 * compact JSON larger than this degrades the text copy to a one-line stub,
 * while structuredContent still carries the full data.
 */
export const TEXT_STUB_THRESHOLD_BYTES = 4096;

/** Module-wide default policy, injected from config once per executeToolCall. */
let defaultTextCopyPolicy: TextCopyPolicy = "auto";

/**
 * 注入模块级默认 text 副本策略（来自 mcp.textCopy 配置，非法值回退 "auto"）。
 * structuredResponse 的可选参数仍可逐次覆盖。
 * Set the module-wide default text-copy policy (from the mcp.textCopy config;
 * invalid values fall back to "auto"). A structuredResponse option can still
 * override it per call.
 */
export function setDefaultTextCopyPolicy(policy: unknown): void {
  defaultTextCopyPolicy = policy === "full" ? "full" : "auto";
}

/** Fail-open config read: any failure keeps the current default policy. */
function applyTextCopyConfig(configPath?: string): void {
  try {
    setDefaultTextCopyPolicy(resolveConfig(configPath).mcp?.textCopy);
  } catch {
    setDefaultTextCopyPolicy(undefined);
  }
}

/**
 * 遗留 text 副本的桩摘要：data 对象上取首个非空 query/task/title 字符串
 * （裁到 120 字符），否则退回通用标识。
 * Stub summary for the legacy text copy: first non-empty query/task/title
 * string field on the data object (clipped to 120 chars), else a generic label.
 */
function summarizeForStub(data: unknown): string {
  if (isRecord(data)) {
    for (const field of ["query", "task", "title"] as const) {
      const value = data[field];
      if (typeof value === "string" && value.trim()) {
        return value.length > 120 ? value.slice(0, 120) : value;
      }
    }
  }
  return "graphflow response";
}

function serializeTextCopy(data: unknown, policy: TextCopyPolicy): string {
  const compact = JSON.stringify(data);
  const bytes = Buffer.byteLength(compact, "utf8");
  // 阈值内（或策略为 "full"）维持全量紧凑 JSON：老客户端 JSON.parse(text)
  // 的语义保持不变（数据与 structuredContent 同源）。
  // Within the threshold (or under the "full" policy) the text copy stays the
  // full compact JSON so legacy JSON.parse(text) clients keep working.
  if (policy !== "auto" || bytes <= TEXT_STUB_THRESHOLD_BYTES) {
    return compact;
  }
  // 大响应桩化：同时渲染 text+structuredContent 的宿主是双倍 token 开销，
  // text 降级为一行桩，全量数据只在 structuredContent 里。
  // Oversized responses are stubbed: hosts that render both text and
  // structuredContent pay twice, so text degrades to a one-line stub and the
  // full data lives only in structuredContent.
  return JSON.stringify({
    stub: true,
    summary: summarizeForStub(data),
    bytes,
    hint: "full data in structuredContent",
  });
}

interface StructuredResponseOptions {
  /** 逐次覆盖模块级 text 副本策略。 / Per-call text-copy policy override. */
  textCopy?: TextCopyPolicy;
}

export function structuredResponse(
  data: unknown,
  options?: StructuredResponseOptions
): ToolCallResponse & { structuredContent: Record<string, unknown> } {
  const response: ToolCallResponse = {
    content: [
      {
        type: "text",
        // 遗留文本副本用紧凑 JSON：美化缩进在 MCP 传输与宿主渲染里是纯开销，
        // 老客户端 JSON.parse 这份副本的语义不变（数据与 structuredContent 同源）。
        // Legacy text copy is compact JSON: pretty indentation is pure overhead
        // on the wire and in host rendering; clients that JSON.parse this copy
        // see the same data as structuredContent, byte-for-byte unindented.
        text: serializeTextCopy(data, options?.textCopy ?? defaultTextCopyPolicy),
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
  /** diagnose 的 includeOutline 透传：默认不带全量 outline，仅保留续聊指针。 */
  includeOutline?: boolean;
} {
  const nodeLimit = readOptionalNumber(args.nodeLimit);
  const edgeLimit = readOptionalNumber(args.edgeLimit);
  const rootDir = readOptionalString(args.rootDir);
  const includeOutline = readOptionalBoolean(args.includeOutline);

  return {
    ...(nodeLimit !== undefined ? { nodeLimit } : {}),
    ...(edgeLimit !== undefined ? { edgeLimit } : {}),
    ...(rootDir !== undefined ? { rootDir } : {}),
    ...(includeOutline !== undefined ? { includeOutline } : {}),
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
