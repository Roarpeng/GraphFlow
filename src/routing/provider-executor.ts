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
}

const MAX_SUMMARY_LINES = 20;
const MAX_SKILL_HINTS = 8;
const MAX_GOAL_ANCHORS = 2;

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
  return Boolean(s || k || e || g);
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

  const skills = (context?.skillHints ?? []).filter((s) => s && s.trim().length > 0);
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
  signal?: AbortSignal
): Promise<string> {
  const config = resolveConfig();
  const request = buildProviderRequestForRole(role, prompt, selection, config, context);
  if (signal) {
    request.signal = signal;
  }
  const enableTools =
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
