import {
  diagnoseRoutingResult,
  downloadOpenBmbModel,
  enrichSemanticsSilent,
  exportArtifact,
  expandAnchor,
  getMetrics,
  getSkillInsights,
  getTokenSavingsStats,
  importArtifact,
  indexFile,
  indexGraph,
  type ModelDownloadProgress,
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
import type { McpServer } from "./server.js";

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
  onModelDownloadProgress?: (progress: ModelDownloadProgress) => void;
}

export const MAX_STRING_FIELD_LENGTH = 100_000;

export async function executeToolCall(
  call: ToolCall,
  _server?: McpServer,
  hooks?: ExecutionHooks
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
    case "graphflow_submit_insight":
      return textResponse(
        await submitAgentInsightResult(
          readRequiredString(args.task, "task"),
          readRequiredString(args.workItemId, "workItemId"),
          readRequiredString(args.response, "response"),
          readOptionalString(args.configPath),
          readOptionalString(args.episodeId),
          readOptionalString(args.rootDir)
        )
      );
    case "graphflow_merge_insight":
      return textResponse(
        await mergeAgentInsightResult(
          readRequiredString(args.task, "task"),
          readOptionalString(args.configPath),
          readOptionalString(args.rootDir)
        )
      );
    case "graphflow_plan":
      return textResponse(planAndBrainstormResult(readRequiredString(args.task, "task")));
    case "graphflow_plan_insight":
      return textResponse(
        await planInsightResult(readRequiredString(args.task, "task"), readOptionalString(args.configPath))
      );
    case "graphflow_preview_context":
      return textResponse(
        await previewContext(
          readRequiredString(args.query, "query"),
          readOptionalString(args.configPath),
          readOptionalString(args.rootDir)
        )
      );
    case "graphflow_expand_anchor":
      return textResponse(
        await expandAnchor(
          readRequiredString(args.anchorId, "anchorId"),
          readOptionalString(args.configPath),
          readOptionalString(args.rootDir)
        )
      );
    case "graphflow_index":
      return textResponse(
        await indexGraph(readOptionalString(args.rootDir), readOptionalString(args.configPath))
      );
    case "graphflow_index_file":
      return textResponse(
        await indexFile(readRequiredString(args.filePath, "filePath"), readOptionalString(args.configPath))
      );
    case "graphflow_rebuild":
      return textResponse(
        await rebuildGraph(readOptionalString(args.rootDir), readOptionalString(args.configPath))
      );
    case "graphflow_enrich_graph":
      {
        const enrichOptions: { batchSize?: number; sleepMs?: number; timeoutMs?: number } = {};
        const batchSize = readOptionalNumber(args.batchSize);
        if (batchSize !== undefined) {
          enrichOptions.batchSize = batchSize;
        }
        const sleepMs = readOptionalNumber(args.sleepMs);
        if (sleepMs !== undefined) {
          enrichOptions.sleepMs = sleepMs;
        }
        const timeoutMs = readOptionalNumber(args.timeoutMs);
        if (timeoutMs !== undefined) {
          enrichOptions.timeoutMs = timeoutMs;
        }

      return textResponse(
        await enrichSemanticsSilent(readOptionalString(args.configPath), enrichOptions)
      );
      }
    case "graphflow_model_download":
      {
        const downloadOptions: {
          model?: string;
          url?: string;
          sha256?: string;
          targetPath?: string;
          force?: boolean;
        } = {};
        const model = readOptionalString(args.model);
        if (model) {
          downloadOptions.model = model;
        }
        const url = readOptionalString(args.url);
        if (url) {
          downloadOptions.url = url;
        }
        const sha256 = readOptionalString(args.sha256);
        if (sha256) {
          downloadOptions.sha256 = sha256;
        }
        const targetPath = readOptionalString(args.targetPath);
        if (targetPath) {
          downloadOptions.targetPath = targetPath;
        }
        if (typeof args.force === "boolean") {
          downloadOptions.force = args.force;
        }

      return textResponse(
        await downloadOpenBmbModel(readOptionalString(args.configPath), {
          ...downloadOptions,
          ...(hooks?.onModelDownloadProgress ? { onProgress: hooks.onModelDownloadProgress } : {}),
        })
      );
      }
    case "graphflow_inspect_graph":
      return textResponse(
        await inspectGraph(readOptionalString(args.configPath), buildInspectOptions(args))
      );
    case "graphflow_skill_insights":
      return textResponse(
        await getSkillInsights(
          readOptionalString(args.configPath),
          readOptionalNumber(args.limit),
          readOptionalString(args.rootDir)
        )
      );
    case "graphflow_diagnose":
      return textResponse(diagnoseRoutingResult(readOptionalString(args.configPath)));
    case "graphflow_export_artifact": {
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
    case "graphflow_import_artifact":
      return textResponse(
        await importArtifact(readOptionalString(args.configPath), readOptionalString(args.inputPath))
      );
    case "graphflow_stats":
      return textResponse(
        getTokenSavingsStats(readOptionalString(args.configPath), readOptionalString(args.rootDir))
      );
    case "graphflow_metrics":
      return textResponse(
        getMetrics(readOptionalString(args.configPath), readOptionalString(args.rootDir))
      );
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
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

export function formatProgressMessage(progress: ModelDownloadProgress): string {
  const current = formatBytes(progress.downloadedBytes);
  const total = progress.totalBytes !== undefined ? formatBytes(progress.totalBytes) : "unknown";
  const percent = progress.percent !== undefined ? `${progress.percent.toFixed(1)}%` : "...";
  return `${percent} ${current}/${total}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
