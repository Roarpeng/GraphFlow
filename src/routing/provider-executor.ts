import type { AgentRole } from "../core/types";
import { isAbortError, runAbortable } from "../core/cancellation";
import { resolveConfig } from "../config/resolve";
import { logger } from "../utils/logger";
import type { ModelSelection } from "./model-router";
import { anthropicGenerateText } from "./provider-adapters/anthropic";
import { bailianGenerateText } from "./provider-adapters/bailian";
import { deepseekGenerateText, deepseekGenerateTextDetailed } from "./provider-adapters/deepseek";
import { doubaoGenerateText } from "./provider-adapters/doubao";
import { openaiGenerateText } from "./provider-adapters/openai";
import type { ProviderChatMessage, ProviderTextRequest, ProviderUsageStats } from "./provider-adapters/types";
import { buildProviderRequestForRole, shouldEnableProviderTools } from "./role-capabilities";
import { runDeepseekToolLoop } from "./deepseek-tools";

export class ProviderError extends Error {
  provider: ModelSelection["provider"];
  model: string;
  retryable: boolean;

  constructor(params: {
    provider: ModelSelection["provider"];
    model: string;
    message: string;
    retryable: boolean;
  }) {
    super(params.message);
    this.name = "ProviderError";
    this.provider = params.provider;
    this.model = params.model;
    this.retryable = params.retryable;
  }
}

interface CircuitState {
  failures: number;
  openedUntil?: number;
}

const circuitByProvider = new Map<string, CircuitState>();
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
const DEFAULT_CIRCUIT_OPEN_MS = 60_000;

/**
 * One inlined source excerpt attached to a prompt. Bridge-mode workers talk to
 * a provider API with NO filesystem access, so the only way they can see the
 * code an anchor points at is if the bytes ride inside the prompt itself.
 */
export interface AnchorSourceItem {
  /** Anchor id from the context package (e.g. `file:src/x.ts`, `symbol:src/x.ts:<hash>`). */
  id: string;
  /** Repo-relative path (Symbols carry `path:line` for precise location). */
  path: string;
  /** Source text, already clamped to the anchor-source budgets. */
  content: string;
  /** True when the excerpt was head/tail truncated to fit the budget. */
  truncated?: boolean;
}

export interface PromptContext {
  summaryChannel?: string[];
  skillHints?: string[];
  extraInstructions?: string[];
  /**
   * Goal anchor lines (P0): the ORIGINAL requirement — coreProblem,
   * successDefinition, nonGoals — rendered FIRST so every agent role sees
   * what the task is ultimately for before any other context.
   */
  goalAnchors?: string[];
  /**
   * Inlined anchor source excerpts (see AnchorSourceItem). Rendered as fenced
   * code blocks with an explicit "already inlined — do not request files"
   * instruction so remote workers answer from the prompt instead of stalling
   * on "cannot read file" replies.
   */
  anchorSources?: AnchorSourceItem[];
}

/**
 * Fixed instruction shipped with every inlined source block. Workers without
 * filesystem access otherwise refuse trivial tasks ("provide the file
 * content"); this line tells them everything they need is already here.
 */
export const ANCHOR_SOURCE_INLINE_NOTE =
  "以下源码已内联提供，直接基于它作答，不要请求或等待文件内容 " +
  "(the source excerpts below are already inlined — answer directly from them, do not request or wait for file content).";

const MAX_SUMMARY_LINES = 20;
const MAX_SKILL_HINTS = 8;
const MAX_GOAL_ANCHORS = 2;
/** Defensive cap in the renderer; the resolver enforces the same budget. */
const MAX_ANCHOR_SOURCES = 8;

let lastProviderUsage: ProviderUsageStats | undefined;

export function getLastProviderUsage(): ProviderUsageStats | undefined {
  return lastProviderUsage;
}

function hasAnyContext(context?: PromptContext): boolean {
  if (!context) {
    return false;
  }
  const s = context.summaryChannel?.some((x) => x && x.trim().length > 0);
  const k = context.skillHints?.some((x) => x && x.trim().length > 0);
  const e = context.extraInstructions?.some((x) => x && x.trim().length > 0);
  const g = context.goalAnchors?.some((x) => x && x.trim().length > 0);
  const a = context.anchorSources?.some((x) => x && x.content && x.content.trim().length > 0);
  return Boolean(s || k || e || g || a);
}

function fenceLanguageFor(path: string): string {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
  return /^[a-z0-9]{1,10}$/i.test(ext) ? ext.toLowerCase() : "";
}

/**
 * Render inlined anchor sources as a readable block: the fixed inline
 * instruction followed by one titled fenced code block per excerpt. Four
 * backticks fence the block because TypeScript source frequently contains
 * triple-backtick template literals.
 */
export function formatAnchorSourcesBlock(anchorSources?: AnchorSourceItem[]): string {
  const items = (anchorSources ?? [])
    .filter((item) => item && typeof item.content === "string" && item.content.trim().length > 0)
    .slice(0, MAX_ANCHOR_SOURCES);
  if (items.length === 0) {
    return "";
  }
  const lines: string[] = [ANCHOR_SOURCE_INLINE_NOTE];
  for (const item of items) {
    const title = `${item.path}${item.truncated ? " (truncated)" : ""} [anchor ${item.id}]`;
    lines.push("", `### ${title}`, "````" + fenceLanguageFor(item.path), item.content, "````");
  }
  return lines.join("\n");
}

/**
 * Append the inlined source block to a raw task prompt. `executeRolePrompt`
 * routes the result into the provider request messages, so provider-side
 * workers receive the source bytes even though the message builder in
 * role-capabilities does not know about anchorSources yet.
 */
export function augmentPromptWithAnchorSources(prompt: string, context?: PromptContext): string {
  const block = formatAnchorSourcesBlock(context?.anchorSources);
  return block ? `${prompt}\n\n${block}` : prompt;
}

/**
 * Flatten a PromptContext into the single-line `; `-joined form used by bridge
 * executionDescriptor.context strings. Anchor sources are excluded from the
 * JSON blob (a 24KB single-line JSON.stringify of source is unreadable) and
 * appended as the readable fenced block instead.
 */
export function formatPromptContextEntries(context?: PromptContext): string {
  if (!context) {
    return "";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (key === "anchorSources") {
      continue;
    }
    parts.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  const anchorBlock = formatAnchorSourcesBlock(context.anchorSources);
  if (anchorBlock) {
    parts.push(anchorBlock);
  }
  return parts.join("; ");
}

export function formatPromptWithContext(
  role: AgentRole,
  prompt: string,
  context?: PromptContext
): string {
  const rolePrefix = `[role:${role}]`;
  if (!hasAnyContext(context)) {
    return `${rolePrefix} ${prompt}`;
  }

  const lines: string[] = [rolePrefix];

  const goals = (context?.goalAnchors ?? []).filter((line) => line && line.trim().length > 0);
  if (goals.length > 0) {
    lines.push("Goal anchor (original requirement — stay aligned):");
    for (const item of goals.slice(0, MAX_GOAL_ANCHORS)) {
      lines.push(`- ${item}`);
    }
  }

  const summaries = (context?.summaryChannel ?? []).filter((line) => line && line.trim().length > 0);
  if (summaries.length > 0) {
    lines.push("Knowledge graph context:");
    for (const item of summaries.slice(0, MAX_SUMMARY_LINES)) {
      lines.push(`- ${item}`);
    }
  }

  const skills = Array.from(
    new Set(
      (context?.skillHints ?? []).filter((s) => s && s.trim().length > 0)
    )
  );
  if (skills.length > 0) {
    lines.push(`Skills to apply: ${skills.slice(0, MAX_SKILL_HINTS).join(", ")}`);
  }

  const notes = (context?.extraInstructions ?? []).filter((n) => n && n.trim().length > 0);
  if (notes.length > 0) {
    lines.push("Notes:");
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  const anchorBlock = formatAnchorSourcesBlock(context?.anchorSources);
  if (anchorBlock) {
    lines.push("");
    lines.push(anchorBlock);
  }

  lines.push("Task:");
  lines.push(prompt);
  return lines.join("\n");
}

function getCircuitState(key: string): CircuitState {
  const found = circuitByProvider.get(key);
  if (found) {
    return found;
  }
  const created: CircuitState = { failures: 0 };
  circuitByProvider.set(key, created);
  return created;
}

function getRetryBudget(): number {
  const envRaw = Number(process.env.GRAPHFLOW_PROVIDER_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
  if (!Number.isFinite(envRaw)) {
    return DEFAULT_MAX_RETRIES;
  }
  return Math.max(0, Math.floor(envRaw));
}

function getCircuitThreshold(): number {
  const envRaw = Number(process.env.GRAPHFLOW_PROVIDER_CIRCUIT_FAILURES ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD);
  if (!Number.isFinite(envRaw)) {
    return DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
  }
  return Math.max(1, Math.floor(envRaw));
}

function getCircuitOpenMs(): number {
  const envRaw = Number(process.env.GRAPHFLOW_PROVIDER_CIRCUIT_OPEN_MS ?? DEFAULT_CIRCUIT_OPEN_MS);
  if (!Number.isFinite(envRaw)) {
    return DEFAULT_CIRCUIT_OPEN_MS;
  }
  return Math.max(1000, Math.floor(envRaw));
}

function shouldUseCircuit(state: CircuitState): boolean {
  if (!state.openedUntil) {
    return false;
  }
  if (Date.now() >= state.openedUntil) {
    delete state.openedUntil;
    state.failures = 0;
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchProvider(
  request: ProviderTextRequest,
  selection: ModelSelection,
  enableTools: boolean
): Promise<string> {
  if (selection.provider === "anthropic") {
    return anthropicGenerateText(request);
  }
  if (selection.provider === "bailian") {
    return bailianGenerateText(request);
  }
  if (selection.provider === "doubao") {
    return doubaoGenerateText(request);
  }
  if (selection.provider === "deepseek") {
    if (enableTools) {
      const result = await runDeepseekToolLoop(request);
      lastProviderUsage = result.usage;
      if (result.usage?.promptCacheHitTokens !== undefined) {
        logger.info(
          {
            provider: "deepseek",
            cacheHit: result.usage.promptCacheHitTokens,
            cacheMiss: result.usage.promptCacheMissTokens,
          },
          "DeepSeek cache usage"
        );
      }
      return result.content;
    }
    const detailed = await deepseekGenerateTextDetailed(request);
    lastProviderUsage = detailed.usage;
    return detailed.content || (await deepseekGenerateText(request));
  }
  return openaiGenerateText(request);
}

export async function executeRolePrompt(
  role: AgentRole,
  prompt: string,
  selection: ModelSelection,
  context?: PromptContext,
  signal?: AbortSignal,
  opts?: { disableTools?: boolean }
): Promise<string> {
  const config = resolveConfig();
  // Anchor sources are inlined into the prompt itself (not just carried on the
  // context object) so the message builder in role-capabilities — which does
  // not know about anchorSources — still delivers the source bytes to the
  // provider. Without this, remote workers correctly report they cannot read
  // files and trivial tasks burn the whole retry budget.
  const effectivePrompt = augmentPromptWithAnchorSources(prompt, context);
  const request = buildProviderRequestForRole(role, effectivePrompt, selection, config, context);
  if (signal) {
    request.signal = signal;
  }
  const enableTools =
    !opts?.disableTools &&
    role === "planner" &&
    !/^\s*Reply with exactly:\s*ok\s*$/i.test(prompt.trim()) &&
    shouldEnableProviderTools(selection, config);
  const label = `${selection.provider}/${selection.model}`;

  const timeoutMsRaw = Number(process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS ?? (selection.provider === "deepseek" ? 60000 : 15000));
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 15000;
  const circuitKey = `${selection.provider}:${selection.model}`;
  const circuitState = getCircuitState(circuitKey);
  if (shouldUseCircuit(circuitState)) {
    throw new ProviderError({
      provider: selection.provider,
      model: selection.model,
      message: `${selection.provider}/${selection.model} circuit is open`,
      retryable: true,
    });
  }

  const execute = async (abortSignal: AbortSignal): Promise<string> => {
    const req: ProviderTextRequest = { ...request, signal: abortSignal };
    return dispatchProvider(req, selection, enableTools);
  };

  const retryBudget = getRetryBudget();
  const circuitThreshold = getCircuitThreshold();
  const circuitOpenMs = getCircuitOpenMs();

  let attempt = 0;
  while (attempt <= retryBudget) {
    if (signal?.aborted) {
      throw new ProviderError({
        provider: selection.provider,
        model: selection.model,
        message: `${label} aborted`,
        retryable: false,
      });
    }
    try {
      const value = await runAbortable(label, timeoutMs, signal, execute, "provider.fetch");
      circuitState.failures = 0;
      delete circuitState.openedUntil;
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = isAbortError(error) || signal?.aborted || /timed out|aborted/i.test(message);
      const retryable =
        !aborted && !/invalid|unauthorized|forbidden|404|not found/i.test(message);
      const wrapped = new ProviderError({
        provider: selection.provider,
        model: selection.model,
        message,
        retryable,
      });

      circuitState.failures += 1;
      if (circuitState.failures >= circuitThreshold) {
        circuitState.openedUntil = Date.now() + circuitOpenMs;
      }

      const isRateLimit = /429|too many requests|rate limit/i.test(message);

      logger.warn(
        { provider: selection.provider, model: selection.model, attempt, retryBudget, message },
        "Provider request failed",
      );

      if (!retryable || attempt >= retryBudget) {
        logger.error(
          { provider: selection.provider, model: selection.model, message },
          "Provider request final failure",
        );
        throw wrapped;
      }

      attempt += 1;
      let backoffMs = Math.min(1500, 100 * 2 ** attempt);

      if (isRateLimit) {
        const jitter = Math.random() * 1000;
        backoffMs = Math.pow(2, attempt) * 1000 + jitter;
        logger.warn(
          { provider: selection.provider, model: selection.model, backoffMs: Math.round(backoffMs) },
          "Rate limit hit, backing off",
        );
      } else {
        logger.warn(
          { provider: selection.provider, model: selection.model, backoffMs },
          "Retrying provider request",
        );
      }

      await sleep(backoffMs);
    }
  }

  throw new ProviderError({
    provider: selection.provider,
    model: selection.model,
    message: `${selection.provider}/${selection.model} exhausted retries`,
    retryable: true,
  });
}

/** @internal test helper */
export function __resetProviderCircuitsForTests(): void {
  circuitByProvider.clear();
  lastProviderUsage = undefined;
}

export type { ProviderChatMessage };
