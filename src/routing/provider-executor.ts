import type { AgentRole } from "../core/types";
import type { ModelSelection } from "./model-router";
import { anthropicGenerateText } from "./provider-adapters/anthropic";
import { bailianGenerateText } from "./provider-adapters/bailian";
import { doubaoGenerateText } from "./provider-adapters/doubao";
import { openaiGenerateText } from "./provider-adapters/openai";
import { openbmbGenerateText } from "./provider-adapters/openbmb";

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
}

const MAX_SUMMARY_LINES = 20;
const MAX_SKILL_HINTS = 8;

function hasAnyContext(context?: PromptContext): boolean {
  if (!context) {
    return false;
  }
  const s = context.summaryChannel?.some((x) => x && x.trim().length > 0);
  const k = context.skillHints?.some((x) => x && x.trim().length > 0);
  const e = context.extraInstructions?.some((x) => x && x.trim().length > 0);
  return Boolean(s || k || e);
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly fillPerSecond: number;

  constructor(capacity: number, fillPerSecond: number) {
    this.capacity = capacity;
    this.fillPerSecond = fillPerSecond;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error("Rate limit timeout (429)");
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  private refill() {
    const now = Date.now();
    const delta = (now - this.lastRefill) * this.fillPerSecond / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + delta);
    this.lastRefill = now;
  }
}

const providerRateLimiters = new Map<string, TokenBucket>();

function getRateLimiter(provider: string): TokenBucket {
  let limiter = providerRateLimiters.get(provider);
  if (!limiter) {
    limiter = new TokenBucket(60, 1);
    providerRateLimiters.set(provider, limiter);
  }
  return limiter;
}

export async function executeRolePrompt(
  role: AgentRole,
  prompt: string,
  selection: ModelSelection,
  context?: PromptContext
): Promise<string> {
  const finalPrompt = formatPromptWithContext(role, prompt, context);
  const request = {
    prompt: finalPrompt,
    model: selection.model,
  };

  const timeoutMsRaw = Number(process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS ?? 15000);
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

  const execute = async (): Promise<string> => {
    if (selection.provider === "anthropic") {
      return anthropicGenerateText(request);
    }

    if (selection.provider === "bailian") {
      return bailianGenerateText(request);
    }

    if (selection.provider === "doubao") {
      return doubaoGenerateText(request);
    }

    if (selection.provider === "openbmb") {
      return openbmbGenerateText(request);
    }

    return openaiGenerateText(request);
  };

  const retryBudget = getRetryBudget();
  const circuitThreshold = getCircuitThreshold();
  const circuitOpenMs = getCircuitOpenMs();

  let attempt = 0;
  while (attempt <= retryBudget) {
    try {
      if (selection.provider !== "openbmb") {
        await getRateLimiter(selection.provider).acquire(timeoutMs);
      }
      const value = await withTimeout(execute(), timeoutMs, `${selection.provider}/${selection.model}`);
      circuitState.failures = 0;
      delete circuitState.openedUntil;
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !/invalid|unauthorized|forbidden|404|not found/i.test(message);
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

      console.warn(`[provider-executor] Request failed for ${selection.provider}/${selection.model} (attempt ${attempt}/${retryBudget}): ${message}`);

      if (!retryable || attempt >= retryBudget) {
        console.error(`[provider-executor] Final failure for ${selection.provider}/${selection.model}: ${message}`);
        throw wrapped;
      }

      attempt += 1;
      let backoffMs = Math.min(1500, 100 * 2 ** attempt);
      
      if (isRateLimit) {
        const jitter = Math.random() * 1000;
        backoffMs = Math.pow(2, attempt) * 1000 + jitter;
        console.warn(`[provider-executor] Rate limit hit. Backing off for ${Math.round(backoffMs)}ms...`);
      } else {
        console.warn(`[provider-executor] Retrying in ${backoffMs}ms...`);
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
