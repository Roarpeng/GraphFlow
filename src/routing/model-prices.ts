/**
 * U1 cost ledger — model price table.
 *
 * Prices are CNY (元) per million tokens, aligned with DeepSeek's official
 * RMB price sheet so the ledger speaks the same currency as the primary
 * provider. Non-DeepSeek prices are public-listing approximations converted
 * to CNY; every entry can be overridden via environment variables so users
 * are never stuck with a stale approximation:
 *
 *   GRAPHFLOW_PRICE_<PROVIDER>=promptPerM,completionPerM
 *   GRAPHFLOW_PRICE_<PROVIDER>_<MODELPREFIX>=promptPerM,completionPerM   (more specific)
 *
 * Example: GRAPHFLOW_PRICE_DEEPSEEK_DEEPSEEK_V4_PRO=4,16
 */

export interface ModelPrice {
  /** 元 / million prompt tokens. */
  promptPerM: number;
  /** 元 / million completion tokens. */
  completionPerM: number;
}

/**
 * Cache-read billing factor: providers charge a cached prompt token at ~10%
 * of the fresh prompt price (DeepSeek charges cache-hit input at 1/10th).
 */
export const CACHE_READ_FACTOR = 0.1;

/** Cost precision: estimates are rounded to 0.0001 元 (0.01 分). */
const COST_PRECISION = 0.0001;

/**
 * 近似值，可用 env 覆盖（见文件头）。Prices in 元/百万 token.
 * Keyed by `provider/model-prefix`; a longer model prefix wins over a shorter
 * one (deepseek-v4-pro beats deepseek-v4 beats deepseek when both exist).
 * DeepSeek entries follow the official RMB list price; OpenAI/Anthropic are
 * USD list prices converted at ~7.2 CNY/USD.
 */
const PRICE_TABLE: Record<string, ModelPrice> = {
  // DeepSeek (official RMB pricing, aligned with deepseek.com list prices)
  "deepseek/deepseek-v4-pro": { promptPerM: 4, completionPerM: 16 },
  "deepseek/deepseek-v4-flash": { promptPerM: 1, completionPerM: 4 },
  "deepseek/deepseek-chat": { promptPerM: 2, completionPerM: 8 },
  "deepseek/deepseek-reasoner": { promptPerM: 4, completionPerM: 16 },
  // OpenAI (USD list × ~7.2, 近似值)
  "openai/gpt-4.1": { promptPerM: 14.4, completionPerM: 57.6 },
  "openai/gpt-4.1-mini": { promptPerM: 2.88, completionPerM: 11.52 },
  "openai/gpt-4.1-nano": { promptPerM: 0.72, completionPerM: 2.88 },
  "openai/gpt-4o": { promptPerM: 18, completionPerM: 72 },
  "openai/gpt-4o-mini": { promptPerM: 1.08, completionPerM: 4.32 },
  // Anthropic (USD list × ~7.2, 近似值)
  "anthropic/claude-3-5-sonnet": { promptPerM: 21.6, completionPerM: 108 },
  "anthropic/claude-3-5-haiku": { promptPerM: 5.76, completionPerM: 28.8 },
  "anthropic/claude-3-7-sonnet": { promptPerM: 21.6, completionPerM: 108 },
};

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    // Bare host[:port] without a scheme — new URL() needs an origin. Treat a
    // leading localhost/127.0.0.1 as local rather than silently mispricing.
    return /^localhost(:|$)/i.test(baseUrl.trim()) || /^127\.0\.0\.1(:|$)/.test(baseUrl.trim());
  }
}

/** `deepseek-v4-pro` → `DEEPSEEK_V4_PRO` (env var safe). */
function toEnvSegment(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseEnvPrice(raw: string | undefined): ModelPrice | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2) return undefined;
  const [promptPerM, completionPerM] = parts;
  if (
    promptPerM === undefined ||
    completionPerM === undefined ||
    !Number.isFinite(promptPerM) ||
    !Number.isFinite(completionPerM) ||
    promptPerM < 0 ||
    completionPerM < 0
  ) {
    return undefined;
  }
  return { promptPerM, completionPerM };
}

/**
 * Model-prefix candidates, most specific first: for `deepseek-v4-pro` yields
 * `deepseek-v4-pro`, `deepseek-v4`, `deepseek`. Dots are preserved (gpt-4.1
 * stays gpt-4.1), so a table entry or env override keyed by any leading
 * substring of the model id matches the full id.
 */
function modelPrefixes(model: string): string[] {
  const trimmed = model.trim();
  const prefixes: string[] = [];
  let current = trimmed;
  while (current.length > 0) {
    prefixes.push(current);
    const dash = current.lastIndexOf("-");
    if (dash <= 0) break;
    current = current.slice(0, dash);
  }
  return prefixes;
}

/**
 * Resolve the price for one provider/model call.
 *
 * Precedence: env model-prefix override > env provider override > built-in
 * table (longest model prefix first). A localhost/127.0.0.1 baseUrl means a
 * local gateway/proxy layer — the judgment layer itself is free, so price 0.
 */
export function lookupPrice(provider: string, model: string, baseUrl?: string): ModelPrice | undefined {
  if (baseUrl && isLocalBaseUrl(baseUrl)) {
    return { promptPerM: 0, completionPerM: 0 };
  }

  const providerKey = toEnvSegment(provider);
  if (providerKey.length > 0) {
    for (const prefix of modelPrefixes(model)) {
      const segment = toEnvSegment(prefix);
      if (segment.length === 0) continue;
      const fromEnv = parseEnvPrice(process.env[`GRAPHFLOW_PRICE_${providerKey}_${segment}`]);
      if (fromEnv) return fromEnv;
    }
    const providerEnv = parseEnvPrice(process.env[`GRAPHFLOW_PRICE_${providerKey}`]);
    if (providerEnv) return providerEnv;
  }

  const normalizedProvider = provider.toLowerCase();
  let best: { prefixLength: number; price: ModelPrice } | undefined;
  for (const prefix of modelPrefixes(model)) {
    const price = PRICE_TABLE[`${normalizedProvider}/${prefix}`];
    if (price && (!best || prefix.length > best.prefixLength)) {
      best = { prefixLength: prefix.length, price };
    }
  }
  return best?.price;
}

/**
 * Estimate the RMB cost (元, Mgc = the ledger's 元-denominated estimate) of
 * one LLM call. Cache-hit prompt tokens are billed at
 * `promptPerM * CACHE_READ_FACTOR` (10%); the remaining prompt tokens and all
 * completion tokens at full price. Result rounded to 0.0001 元.
 */
export function estimateCostMgc(
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens: number,
  price: ModelPrice
): number {
  const hits = Math.max(0, Math.min(cacheHitTokens, Math.max(0, promptTokens)));
  const misses = Math.max(0, promptTokens) - hits;
  const costMgc =
    (misses * price.promptPerM +
      hits * price.promptPerM * CACHE_READ_FACTOR +
      Math.max(0, completionTokens) * price.completionPerM) /
    1_000_000;
  return Math.round(costMgc / COST_PRECISION) * COST_PRECISION;
}

/** @internal test helper: expose the table copy for assertions. */
export function getPriceTableSnapshot(): Record<string, ModelPrice> {
  return { ...PRICE_TABLE };
}
