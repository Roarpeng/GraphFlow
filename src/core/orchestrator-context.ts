import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import { readFileSync } from "node:fs";
import { planInsight } from "../agents/insight.js";
import { resolveConfig } from "../config/resolve.js";
import { hasUsableLlmProvider } from "../config/llm-availability.js";
import { resolveRuntimeWorkspaceRoot } from "../config/workspace-root.js";
import type { LayeredContextPackage } from "../graph/context-slicer.js";
import type { GraphNode } from "./types.js";
import { suggestSkillHints } from "../learning/skill-flywheel.js";
import { formatGoalAnchorForPrompt, getActiveGoalAnchor } from "./goal-anchor.js";
import { resolveModelForRole } from "../routing/model-router.js";
import type { AnchorSourceItem, PromptContext } from "../routing/provider-executor.js";
import { buildAgentDelegatedPlanInsight, type AgentDelegatedPlanInsight } from "./agent-delegation.js";
import { triageTask } from "./triage.js";
import type { OrchestrationInput, TaskRunResult, OrchestrateOptions } from "./types.js";
import { logger } from "../utils/logger.js";

export async function maybeBuildNearLosslessContext(
  input: OrchestrationInput,
  options?: OrchestrateOptions
): Promise<LayeredContextPackage | undefined> {
  if (!options?.enableNearLosslessMode || !options.graphClient) {
    return undefined;
  }

  const query = options.nearLosslessQuery ?? input.task;
  const maxTokens = options.maxContextTokens ?? 1200;
  const packageOptions: import("../graph/context-slicer.js").LayeredPackageOptions = {
    ...(options.layerQuota ? { layerQuota: options.layerQuota } : {}),
    // Graph-structure compression is zero-cost; enable by default unless explicitly disabled.
    enableGraphCompression: options.enableGraphCompression !== false,
    // Pass through embedding/vector recall options so HNSW + vector recall are activated.
    ...(options.embeddingProvider
      ? {
          embeddingProvider: options.embeddingProvider,
          enableVectorRecall: true as const,
          ...(options.enableFullGraphVectorRecall === true
            ? { enableFullGraphVectorRecall: true as const }
            : {}),
          ...(options.hnswIndexPath ? { hnswIndexPath: options.hnswIndexPath } : {}),
        }
      : {}),
  };

  // Adaptive budget: derive task complexity from triage and let the package
  // estimator resize the token budget. Auto-enable for complex tasks unless
  // explicitly disabled via enableAdaptiveBudget: false.
  const taskMode = triageTask(input.task);
  const enableAdaptiveBudget =
    options.enableAdaptiveBudget !== false &&
    (options.enableAdaptiveBudget === true || taskMode === "complex");
  if (enableAdaptiveBudget) {
    packageOptions.taskMode = taskMode;
  }

  // RepoMap overview fallback for tight budgets (opt-in).
  if (options.enableRepoMapFallback) {
    packageOptions.enableRepoMapFallback = true;
  }

  const { buildEnhancedContextPackage } = await import("../graph/context-slicer.js");
  const pkg = await buildEnhancedContextPackage(
    options.graphClient,
    query,
    input.task,
    maxTokens,
    packageOptions
  );

  options.onContextPackage?.(pkg);
  return pkg;
}

export function appendContextFeedback(
  run: TaskRunResult,
  contextPackage?: LayeredContextPackage,
  promptContextLines = 0,
  options?: OrchestrateOptions
): TaskRunResult {
  let next = run;
  if (contextPackage) {
    next = {
      ...next,
      feedback:
        `${next.feedback}; context(summary=${contextPackage.summaryChannel.length}, ` +
        `anchors=${contextPackage.anchorChannel.length}, tokens=${contextPackage.tokenEstimate})`,
    };
  }
  if (options?.enableGraphContextInPrompt) {
    next = {
      ...next,
      feedback: `${next.feedback}; promptCtx(lines=${promptContextLines})`,
      promptContextLines,
    };
  }
  return next;
}

/** Anchor-source budgets: at most 8 excerpts, 6KB each, 24KB overall. */
const ANCHOR_SOURCE_MAX_COUNT = 8;
const ANCHOR_SOURCE_TOTAL_BUDGET = 24 * 1024;
const ANCHOR_SOURCE_SINGLE_BUDGET = 6 * 1024;
/** Stop packing further anchors once less than this remains of the total budget. */
const ANCHOR_SOURCE_MIN_REMAINING = 512;
/** Symbol anchors inline a window of this many lines starting at the symbol line. */
const SYMBOL_SOURCE_WINDOW_LINES = 80;
/** Skip disk reads for oversized files (metadata.sizeBytes); node summary remains. */
const FILE_MAX_READ_BYTES = 512 * 1024;

interface ClampedText {
  content: string;
  truncated: boolean;
}

/** Clamp text to `budget` bytes keeping head AND tail with a truncation marker. */
function clampSourceText(text: string, budget: number): ClampedText {
  if (text.length <= budget) {
    return { content: text, truncated: false };
  }
  const head = Math.floor(budget * 0.75);
  const tail = Math.floor(budget * 0.2);
  const omitted = text.length - head - tail;
  return {
    content: `${text.slice(0, head)}\n/* … ${omitted} chars truncated … */\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Repo-relative path inside `symbol:{relPath}:{hash}` (hash = last colon segment). */
function relPathFromSymbolId(id: string): string | undefined {
  const stripped = id.slice("symbol:".length);
  const lastColon = stripped.lastIndexOf(":");
  const relPath = lastColon > 0 ? stripped.slice(0, lastColon) : stripped;
  return relPath.trim() ? relPath : undefined;
}

function safeResolveWithinRoot(root: string, relPath: string): string | undefined {
  if (!relPath || relPath.includes("..") || isAbsolute(relPath)) {
    return undefined;
  }
  const abs = resolvePath(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    return undefined;
  }
  return abs;
}

function readSourceLines(root: string, relPath: string, cache: Map<string, string[]>): string[] | undefined {
  const cached = cache.get(relPath);
  if (cached) {
    return cached;
  }
  if (cache.has(relPath)) {
    return undefined;
  }
  const abs = safeResolveWithinRoot(root, relPath);
  if (!abs) {
    cache.set(relPath, []);
    return undefined;
  }
  try {
    const raw = readFileSync(abs, "utf8");
    const lines = raw.split("\n");
    cache.set(relPath, lines);
    return lines;
  } catch {
    cache.set(relPath, []);
    return undefined;
  }
}

/** File paths quoted in task text, e.g. "列出 src/foo.ts 的导出" → ["src/foo.ts"]. */
function extractQuotedFilePaths(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const pattern = /[A-Za-z0-9_][\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json)\b/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0].replace(/^[./]+/, "");
    if (!raw || raw.includes("..") || raw.startsWith("node_modules/")) {
      continue;
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out.slice(0, ANCHOR_SOURCE_MAX_COUNT);
}

function fileAnchorSource(node: GraphNode, root: string | undefined, cache: Map<string, string[]>): AnchorSourceItem | undefined {  const meta = node.metadata ?? {};
  const relPath =
    typeof meta.path === "string" && meta.path.trim() ? meta.path.trim() : node.id.slice("file:".length);
  if (!relPath) {
    return undefined;
  }
  if (root && !(typeof meta.sizeBytes === "number" && meta.sizeBytes > FILE_MAX_READ_BYTES)) {
    const lines = readSourceLines(root, relPath, cache);
    if (lines && lines.length > 0) {
      const clamped = clampSourceText(lines.join("\n"), ANCHOR_SOURCE_SINGLE_BUDGET);
      return { id: node.id, path: relPath, content: clamped.content, ...(clamped.truncated ? { truncated: true } : {}) };
    }
  }
  // Disk unavailable: the File node summary ("path # exports: …") still names
  // the exports, which is enough for trivial listing tasks.
  return node.content.trim() ? { id: node.id, path: relPath, content: node.content } : undefined;
}

function symbolAnchorSource(node: GraphNode, root: string | undefined, cache: Map<string, string[]>): AnchorSourceItem | undefined {
  const meta = node.metadata ?? {};
  const relPath =
    typeof meta.file === "string" && meta.file.trim() ? meta.file.trim() : relPathFromSymbolId(node.id);
  const line = typeof meta.line === "number" && meta.line > 0 ? Math.floor(meta.line) : 1;
  const displayPath = relPath ? `${relPath}:${line}` : node.id;
  if (root && relPath) {
    const lines = readSourceLines(root, relPath, cache);
    if (lines && lines.length > 0) {
      const start = Math.min(Math.max(line - 1, 0), Math.max(lines.length - 1, 0));
      const window = lines.slice(start, start + SYMBOL_SOURCE_WINDOW_LINES);
      const windowTruncated = start + SYMBOL_SOURCE_WINDOW_LINES < lines.length;
      const clamped = clampSourceText(window.join("\n"), ANCHOR_SOURCE_SINGLE_BUDGET);
      return {
        id: node.id,
        path: displayPath,
        content: clamped.content,
        ...(clamped.truncated || windowTruncated ? { truncated: true } : {}),
      };
    }
  }
  // Fallback: signature one-liner (+ jsdoc hint) from the node itself.
  const headline = node.content.trim();
  const parts = [headline];
  const signature = typeof meta.signature === "string" ? meta.signature.trim() : "";
  if (signature && !headline.includes(signature)) {
    parts.push(signature);
  }
  const content = parts.filter(Boolean).join("\n");
  return content ? { id: node.id, path: displayPath, content } : undefined;
}

/**
 * Resolve `contextPackage.anchorChannel` ids into inlined source excerpts for
 * the worker prompt. Bridge workers reach a provider API with no filesystem
 * access; without inlined bytes they stall on "cannot read file" and burn the
 * retry budget. Only File and Symbol anchors carry source; everything else is
 * skipped. Never throws — any failure means fewer/no excerpts, not a failed
 * orchestration.
 */
export async function resolveAnchorSources(
  contextPackage: LayeredContextPackage | undefined,
  options?: OrchestrateOptions,
  taskText?: string
): Promise<AnchorSourceItem[]> {
  if (!contextPackage || contextPackage.anchorChannel.length === 0 || !options?.graphClient?.getNodesByIds) {
    return [];
  }

  const ids = contextPackage.anchorChannel
    .map((anchor) => anchor.id)
    .filter((id) => id.startsWith("file:") || id.startsWith("symbol:"))
    .slice(0, ANCHOR_SOURCE_MAX_COUNT);

  try {
    let root: string | undefined;
    try {
      const config = resolveConfig(options.configPath);
      root = resolveRuntimeWorkspaceRoot(
        config.graphPolicy.workspaceRoot ? { projectWorkspaceRoot: config.graphPolicy.workspaceRoot } : undefined
      );
    } catch {
      root = process.cwd();
    }

    const nodes = await options.graphClient.getNodesByIds(ids);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const lineCache = new Map<string, string[]>();

    const out: AnchorSourceItem[] = [];
    let used = 0;
    for (const id of ids) {
      const remaining = ANCHOR_SOURCE_TOTAL_BUDGET - used;
      if (remaining < ANCHOR_SOURCE_MIN_REMAINING) {
        break;
      }
      const node = byId.get(id);
      if (!node) {
        continue;
      }
      const item =
        node.type === "File"
          ? fileAnchorSource(node, root, lineCache)
          : node.type === "Symbol"
            ? symbolAnchorSource(node, root, lineCache)
            : undefined;
      if (!item || !item.content.trim()) {
        continue;
      }
      if (item.content.length <= remaining) {
        out.push(item);
        used += item.content.length;
        continue;
      }
      const clamped = clampSourceText(item.content, remaining);
      if (!clamped.content.trim()) {
        break;
      }
      out.push({ ...item, content: clamped.content, truncated: true });
      used += clamped.content.length;
      break;
    }
    if (out.length > 0) {
      logger.debug(
        { anchors: out.length, bytes: used },
        "Inlined anchor sources into prompt context"
      );
      return out;
    }
    // Fallback: the retrieval head may be all metadata nodes (workbench /
    // episode / triage — a young or metadata-heavy store), yet the task text
    // itself names the file to look at ("列出 src/foo.ts 的导出"). Quote those
    // paths directly so a bridge descriptor never ships without the code the
    // task explicitly references.
    const quoted = extractQuotedFilePaths(taskText ?? "");
    for (const relPath of quoted) {
      if (ANCHOR_SOURCE_TOTAL_BUDGET - used < ANCHOR_SOURCE_MIN_REMAINING) {
        break;
      }
      const lines = root ? readSourceLines(root, relPath, lineCache) : undefined;
      if (!lines || lines.length === 0) {
        continue;
      }
      const clamped = clampSourceText(lines.join("\n"), ANCHOR_SOURCE_SINGLE_BUDGET);
      if (!clamped.content.trim()) {
        continue;
      }
      out.push({
        id: `file:${relPath}`,
        path: relPath,
        content: clamped.content,
        ...(clamped.truncated ? { truncated: true } : {}),
      });
      used += clamped.content.length;
    }
    if (out.length > 0) {
      logger.debug(
        { files: out.map((item) => item.path), bytes: used },
        "Inlined task-quoted file paths into prompt context (metadata-only anchor fallback)"
      );
    }
    return out;
  } catch (error) {
    logger.warn({ error }, "Anchor source resolution failed; continuing without inlined sources");
    return [];
  }
}

export function buildPromptContext(
  contextPackage: LayeredContextPackage | undefined,
  skillHints: string[],
  episodeSummaries: string[],
  options?: OrchestrateOptions,
  goalAnchors: string[] = [],
  anchorSources: AnchorSourceItem[] = []
): PromptContext | undefined {
  const includeGraph = options?.enableGraphContextInPrompt === true && contextPackage !== undefined;
  const includeEpisodes = options?.enableEpisodicMemory === true && episodeSummaries.length > 0;
  // Skill hints should be injected independently of graph context,
  // so that skill flywheel works even without near-lossless context.
  const includeSkillHints = skillHints.length > 0;
  // Goal anchors likewise: the original requirement must ride along whenever
  // an agent (or bridge prompt) is about to act on this task.
  const includeGoalAnchors = goalAnchors.length > 0;
  // Inlined anchor sources ride along whenever they resolved, independent of
  // enableGraphContextInPrompt: bridge workers have no filesystem access, so
  // the prompt is the only channel through which they can see the code.
  const includeAnchorSources = anchorSources.length > 0;
  if (!includeGraph && !includeEpisodes && !includeSkillHints && !includeGoalAnchors && !includeAnchorSources) {
    return undefined;
  }
  const ctx: PromptContext = {};
  if (includeGoalAnchors) {
    ctx.goalAnchors = goalAnchors;
  }
  if (includeGraph && contextPackage && contextPackage.summaryChannel.length > 0) {
    ctx.summaryChannel = contextPackage.summaryChannel;
  }
  if (includeSkillHints) {
    ctx.skillHints = skillHints;
  }
  if (includeEpisodes) {
    ctx.extraInstructions = [...episodeSummaries];
  }
  if (includeAnchorSources) {
    ctx.anchorSources = anchorSources;
  }
  if (
    !ctx.summaryChannel &&
    !ctx.skillHints &&
    !ctx.extraInstructions &&
    !ctx.goalAnchors &&
    !ctx.anchorSources
  ) {
    return undefined;
  }
  return ctx;
}

export async function maybeBuildSkillHints(task: string, options?: OrchestrateOptions): Promise<string[]> {
  if (!options?.enableSkillFlywheel || !options.graphClient) {
    return [];
  }

  return suggestSkillHints(options.graphClient, task, options.skillHintsLimit ?? 3);
}

/**
 * P0 — Load the task's active goal anchor (if an intent was ever submitted for
 * it) and format it for prompt injection. Never blocks: any failure means no
 * anchor, not a failed orchestration.
 */
export async function maybeBuildGoalAnchors(task: string, options?: OrchestrateOptions): Promise<string[]> {
  if (!options?.graphClient) {
    return [];
  }
  try {
    const goal = await getActiveGoalAnchor(options.graphClient, task);
    return goal ? [formatGoalAnchorForPrompt(goal)] : [];
  } catch {
    return [];
  }
}

const COMPLEX_KEYWORDS = [
  "refactor",
  "architecture",
  "redesign",
  "migrate",
  "restructure",
  "orchestration",
  "runtime",
];

export async function maybeRunPlanInsightForComplex(
  task: string,
  options?: OrchestrateOptions
): Promise<AgentDelegatedPlanInsight | undefined> {
  try {
    const config = resolveConfig(options?.configPath);

    if (!hasUsableLlmProvider(config)) {
      return buildAgentDelegatedPlanInsight(task);
    }

    const taskLower = task.toLowerCase();
    const hasComplexKeyword = COMPLEX_KEYWORDS.some((kw) => taskLower.includes(kw));
    if (task.length < 50 && !hasComplexKeyword) {
      logger.info({ task }, "Skipping full ATP for short simple task");
      const result = await planInsight(task, { selection: resolveModelForRole("planner") }, false);
      return {
        mode: "llm",
        insight: result.insight,
        plan: result.plan,
      };
    }

    const selection = resolveModelForRole("planner");
    const result = await planInsight(task, { selection }, true);
    const atp = (result as { atp?: unknown }).atp;
    return {
      mode: "llm",
      insight: result.insight,
      plan: result.plan,
      ...(atp !== undefined ? { atp } : {}),
    };
  } catch (error) {
    logger.warn({ error, task }, "Plan insight failed, using agent-delegated heuristic");
    return buildAgentDelegatedPlanInsight(task);
  }
}