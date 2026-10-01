import { logger } from "../utils/logger.js";
import { readEnvVar } from "../config/env-lookup.js";
import { resolveConfigSecret } from "../config/secrets.js";
import type { GraphFlowConfig } from "../config/schema.js";

/**
 * TypeSafe System One client (REAL API contract, per docs.typesafe.ai/api).
 *
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer <TYPESAFE_API_KEY>
 *   { "state": string|object|array,
 *     "model": "jev-latest",
 *     "questions": { <key>: { type, instructions, criteria } } }
 *
 * Answers come back typed: choice (option + probabilities + confidence),
 * score (weighted level + legend + probabilities + confidence), noul (0..1).
 * 429/529 retry with exponential backoff; 401/422 are hard failures.
 *
 * The earlier typesafe-jev worker guessed a chat-completions endpoint on a
 * fabricated domain and asked Jev for free-form command JSON — System One
 * models do not generate text; they answer typed questions. This client is
 * the correct integration surface (and what TYPESAFE_API_KEY unlocks).
 * 真实契约的 System One 客户端：Jev 以类型化问题（choice/score/noul）供
 * Layer B 判定使用，不承担文本生成。
 */

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SystemOneResult<Q extends Record<string, SystemOneQuestion>> {
  model: string;
  answers: { [K in keyof Q]: SystemOneAnswer };
  usage: SystemOneUsage;
}

export interface SystemOneClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  /** Retries on 429/529 (default 2, exponential backoff). */
  maxRetries?: number;
}

export interface SystemOneClient {
  configured: boolean;
  model: string;
  ask<Q extends Record<string, SystemOneQuestion>>(
    state: string | object | unknown[],
    questions: Q
  ): Promise<SystemOneResult<Q>>;
}

/**
 * The client appends `/v1/systemone` itself; users often paste the full
 * endpoint (the settings UI once suggested it), which produced
 * `/v1/systemone/v1/systemone` 404s.
 */
export function normalizeTypesafeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1\/systemone$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");
}

export function resolveTypesafeCredentials(options?: {
  baseUrl?: string;
  apiKey?: string;
}): { baseUrl: string; apiKey?: string } {
  const baseUrl = normalizeTypesafeBaseUrl(
    options?.baseUrl?.trim() || readEnvVar("TYPESAFE_BASE_URL") || TYPESAFE_DEFAULT_BASE_URL
  );
  const apiKey = options?.apiKey?.trim() || readEnvVar("TYPESAFE_API_KEY") || undefined;
  return { baseUrl, ...(apiKey ? { apiKey } : {} ) };
}

/**
 * Client options from the configured worker (settings page "Worker" card):
 * its API key field — a literal or an env var reference — used to be saved
 * and then never read. Only a TypeSafe worker contributes; a local-command
 * worker's fields describe a different endpoint.
 */
export function typesafeClientOptionsFromConfig(config: GraphFlowConfig): SystemOneClientOptions {
  const policy =
    config.workerPolicy ?? config.efficiencyPolicy?.workerPolicy ?? config.efficiencyPolicy?.worker;
  const worker = policy?.workerConfig;
  if (!worker) return {};
  const isTypesafe =
    policy?.workerType === "typesafe-jev" || /typesafe/i.test(worker.baseUrl ?? "");
  if (!isTypesafe) return {};
  const apiKey = resolveConfigSecret(worker.apiKey);
  const model = worker.model?.trim();
  return {
    ...(worker.baseUrl?.trim() ? { baseUrl: worker.baseUrl.trim() } : {}),
    ...(apiKey ? { apiKey } : {}),
    // "typesafe-jev" is the adapter name the UI once used as a model placeholder.
    ...(model && model !== "typesafe-jev" ? { model } : {}),
    ...(worker.timeoutMs && worker.timeoutMs > 0 ? { timeoutMs: worker.timeoutMs } : {}),
  };
}

export function createSystemOneClient(options?: SystemOneClientOptions): SystemOneClient {
  const { baseUrl, apiKey } = resolveTypesafeCredentials(options);
  const model = options?.model ?? TYPESAFE_DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const maxRetries = options?.maxRetries ?? 2;
  const doFetch = options?.fetchImpl ?? globalThis.fetch;

  return {
    configured: apiKey !== undefined,
    model,
    async ask<Q extends Record<string, SystemOneQuestion>>(
      state: string | object | unknown[],
      questions: Q
    ): Promise<SystemOneResult<Q>> {
      if (!apiKey) {
        throw new Error(
          "TypeSafe System One: no API key (set TYPESAFE_API_KEY, or the worker API key / env var name in settings)"
        );
      }
      const body = JSON.stringify({ state, model, questions });
      let lastError: Error = new Error("TypeSafe System One: request never attempted");
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await doFetch(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body,
            signal: controller.signal,
          });
          if (response.status === 429 || response.status === 529) {
            lastError = new Error(`typesafe http ${response.status} (retryable)`);
            if (attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
              continue;
            }
            throw lastError;
          }
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`typesafe http ${response.status}: ${text.slice(0, 300)}`);
          }
          const payload = (await response.json()) as {
            model?: string;
            answers?: Record<string, SystemOneAnswer>;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (!payload.answers) {
            throw new Error("typesafe response missing answers");
          }
          return {
            model: payload.model ?? model,
            answers: payload.answers as SystemOneResult<Q>["answers"],
            usage: {
              inputTokens: payload.usage?.input_tokens ?? 0,
              outputTokens: payload.usage?.output_tokens ?? 0,
            },
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // Abort/timeout and hard errors are not retried.
          if (!(error instanceof Error && /http (429|529)/.test(error.message))) {
            throw lastError;
          }
          if (attempt >= maxRetries) throw lastError;
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError;
    },
  };
}

// ───────────────── Layer B: Jev as the efficiency decision judge ─────────────────

import type { MetaReflectionInput, MetaReflectionVerdict } from "../core/meta-advisory.js";

/**
 * Build a MetaReflector backed by the REAL System One API: gray-zone reuse
 * decisions become typed questions — reuseMode as a choice over
 * REUSE/ADAPT/FRESH rubrics, confidence as a 5-level score. Deterministic
 * Layer A remains the fallback for every failure path (never throws).
 */
export function createJevMetaReflector(
  client?: SystemOneClient,
  logWarn?: (msg: string) => void
): (input: MetaReflectionInput) => Promise<MetaReflectionVerdict | undefined> {
  const active = client ?? createSystemOneClient();
  const warn: (msg: string) => void = logWarn ?? ((msg: string) => logger.warn({ msg }, "jev-meta-reflector"));
  return async (input: MetaReflectionInput) => {
    if (!active.configured) return undefined;
    try {
      const result = await active.ask(
        {
          task: input.task,
          taskComplexity: input.taskComplexity,
          executionMode: input.executionMode,
          topSimilarity: input.topSimilarity,
          topEpisode: input.topEpisode
            ? { task: input.topEpisode.task, outcomeScore: input.topEpisode.score }
            : undefined,
          similarEpisodeCount: input.similarEpisodes.length,
        },
        {
          reuseMode: {
            type: "choice",
            instructions: `Should the next run REUSE cached results, ADAPT cached context/plan with re-validation, or start FRESH? Task similarity evidence is embedded in the state.`,
            criteria: {
              REUSE: "A verified identical task exists; replaying its result is safe",
              ADAPT: "A similar task exists; reuse context/plan but re-validate the differences",
              FRESH: "No trustworthy similarity; re-derive everything",
            },
          },
          decisionConfidence: {
            type: "score",
            instructions: "How confident is the reuse verdict for this task?",
            criteria: ["Guessing", "Leaning", "Moderate", "Confident", "Certain"],
          },
        }
      );
      const reuse = result.answers.reuseMode;
      const confidenceAnswer = result.answers.decisionConfidence;
      if (reuse.type !== "choice") return undefined;
      const verdict: MetaReflectionVerdict = {
        reuseMode:
          reuse.choice === "REUSE" || reuse.choice === "ADAPT" || reuse.choice === "FRESH"
            ? reuse.choice
            : "FRESH",
        confidence:
          confidenceAnswer.type === "score"
            ? Number(Math.min(1, Math.max(0.05, confidenceAnswer.score / 4)).toFixed(2))
            : Number(Math.min(0.9, Math.max(0.1, reuse.confidence)).toFixed(2)),
        reasoning: `jev ${result.model}: choice=${reuse.choice} (p=${(reuse.probabilities[reuse.choice] ?? 0).toFixed(2)}, conf=${reuse.confidence.toFixed(2)}), tokens in=${result.usage.inputTokens}`,
      };
      return verdict;
    } catch (error) {
      warn(`Layer B Jev reflection failed, Layer A fallback: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
}
