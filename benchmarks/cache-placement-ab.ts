/**
 * End-to-end cache-placement A/B against a real provider.
 *
 * ## Why this exists
 *
 * The economics engine (src/graph/context-economics.ts) claims that where
 * GraphFlow's content lands in the request matters more than how much of it
 * there is, and that a volatile injection placed *before* the conversation
 * forces the host to rewrite everything downstream. That claim was derived from
 * published cache multipliers and then measured against a model of a prefix
 * match. It has never been checked against a real provider's cache.
 *
 * This is that check. It sends real requests and reads the provider's own
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` back.
 *
 * ## The three arms
 *
 * Modelled on how a harness actually assembles a request: a stable system layer
 * (system prompt + tool schemas), then a growing conversation.
 *
 *   C  baseline        system = stable harness block only
 *   A  volatile inject system = stable block + per-turn-varying context
 *   B  stable brief    system = stable block + byte-identical project brief
 *
 * A is how a plugin poisons the cache; B is what the Prefix Cache Planner asks a
 * host to do. If the claim holds, C and B accumulate cache hits turn over turn
 * and A resets to (near) zero every turn.
 *
 * ## Cost
 *
 * DeepSeek prices cache reads at ~3% of input, so this stays in cents. Number of
 * turns is fixed and small by design: the point is a controlled comparison, not
 * volume. Nothing here prints the API key.
 */
const BASE_URL = (process.env.GRAPHFLOW_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(
  /\/+$/,
  ""
);
const MODEL = process.env.GRAPHFLOW_DEEPSEEK_MODEL ?? "deepseek-chat";
const API_KEY = process.env.DEEPSEEK_API_KEY;
const TURNS = Number(process.env.GRAPHFLOW_CACHE_AB_TURNS ?? 3);
const STABLE_BLOCK_TOKENS = Number(process.env.GRAPHFLOW_CACHE_AB_STABLE_TOKENS ?? 2500);
const INJECT_TOKENS = Number(process.env.GRAPHFLOW_CACHE_AB_INJECT_TOKENS ?? 700);

type Arm = "C-baseline" | "A-volatile-inject" | "B-stable-brief";

interface TurnResult {
  turn: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  hitRatio: number;
  error?: string;
}

/** Roughly four characters per token for English; good enough to size a block. */
function padToTokens(seed: string, targetTokens: number): string {
  const targetChars = targetTokens * 4;
  const out: string[] = [];
  let i = 0;
  while (out.join("").length < targetChars) {
    out.push(`[ctx ${i % 97}] deterministic stable content block for prefix-cache measurement.`);
    i += 1;
  }
  const text = out.join("\n");
  return `${seed}\n${text}`.slice(0, targetChars + seed.length + 1);
}

/**
 * The volatile half: different every turn, which is the whole point. A real
 * query-scoped context package looks like this — anchors that move with the
 * question.
 */
function volatileBlock(turn: number, seed: string): string {
  const out: string[] = [`retrieved context for turn ${turn} (${seed})`];
  let i = 0;
  while (out.join("\n").length < INJECT_TOKENS * 4) {
    out.push(`anchor ${turn}.${i}: symbol:src/module${turn}/file${i}.ts:hash${i} — query-scoped excerpt`);
    i += 1;
  }
  return out.join("\n");
}

/** Byte-identical every turn, which is what the brief is. */
function stableBrief(): string {
  return padToTokens("PROJECT BRIEF — cross-turn stable", INJECT_TOKENS);
}

function systemFor(arm: Arm, turn: number, stableBlock: string): string {
  if (arm === "C-baseline") return stableBlock;
  if (arm === "A-volatile-inject") return `${stableBlock}\n\n## Retrieved context\n${volatileBlock(turn, "varying")}`;
  return `${stableBlock}\n\n## Project brief\n${stableBrief()}`;
}

/**
 * Per-arm stable block.
 *
 * The first run of this benchmark had every arm share one system block, and the
 * provider's cache is global to the key. Arm A's first turn therefore inherited
 * 1792 hit tokens that arm C had just written, which flattered exactly the arm
 * we are trying to indict. Each arm now writes its own prefix so the measurement
 * starts cold.
 */
function stableBlockFor(arm: Arm): string {
  return padToTokens(`HARNESS SYSTEM BLOCK [${arm}] — stable across turns`, STABLE_BLOCK_TOKENS);
}

async function runArm(arm: Arm, historyTurns: number): Promise<TurnResult[]> {
  const stableBlock = stableBlockFor(arm);
  const results: TurnResult[] = [];
  const conversation: Array<{ role: string; content: string }> = [];

  // A real agent session arrives with history already on the books. Seeding it
  // is what makes the measurement honest: the volatile block sits BEFORE the
  // history, so with a short conversation the damage looks small, and with a
  // long one the entire history is re-charged every turn. The first run used
  // three empty turns and therefore understated the effect by construction.
  for (let h = 1; h <= historyTurns; h += 1) {
    conversation.push({ role: "user", content: `Earlier task ${h}: inspect the retrieval layer.` });
    conversation.push({
      role: "assistant",
      content: `Earlier answer ${h}: the retrieval layer resolves anchors through the layered slicer and packs them under budget.`,
    });
  }

  for (let turn = 1; turn <= TURNS; turn += 1) {
    conversation.push({ role: "user", content: `Task ${turn}: summarise the retrieval layer.` });
    const body = {
      model: MODEL,
      // Capped so the experiment cannot accidentally become an expensive one.
      max_tokens: 16,
      temperature: 0,
      messages: [
        { role: "system", content: systemFor(arm, turn, stableBlock) },
        ...conversation,
      ],
    };
    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        results.push({ turn, promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, hitRatio: 0, error: `HTTP ${response.status}` });
        continue;
      }
      const payload = (await response.json()) as {
        usage?: {
          prompt_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        };
      };
      const promptTokens = payload.usage?.prompt_tokens ?? 0;
      const cacheHitTokens = payload.usage?.prompt_cache_hit_tokens ?? 0;
      const cacheMissTokens = payload.usage?.prompt_cache_miss_tokens ?? 0;
      results.push({
        turn,
        promptTokens,
        cacheHitTokens,
        cacheMissTokens,
        hitRatio: promptTokens > 0 ? cacheHitTokens / promptTokens : 0,
      });
      conversation.push({ role: "assistant", content: `ack ${turn}` });
    } catch (error) {
      results.push({
        turn,
        promptTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        hitRatio: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return results;
}

function summarise(arm: Arm, turns: TurnResult[]): void {
  const ok = turns.filter((t) => !t.error);
  const last = ok[ok.length - 1];
  const totalMiss = ok.reduce((sum, t) => sum + t.cacheMissTokens, 0);
  console.log(`\n=== ${arm} ===`);
  for (const t of turns) {
    if (t.error) {
      console.log(`  turn ${t.turn}: ERROR ${t.error}`);
      continue;
    }
    console.log(
      `  turn ${t.turn}: prompt=${String(t.promptTokens).padStart(6)}  hit=${String(t.cacheHitTokens).padStart(6)}  miss=${String(t.cacheMissTokens).padStart(6)}  hitRatio=${(t.hitRatio * 100).toFixed(1)}%`
    );
  }
  if (!last) return;
  console.log(
    `  -> final hitRatio ${(last.hitRatio * 100).toFixed(1)}%  |  total miss tokens charged at full rate: ${totalMiss}`
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("DEEPSEEK_API_KEY not set — cannot run the real-provider A/B.");
    return;
  }
  const historyTurns = Number(process.env.GRAPHFLOW_CACHE_AB_HISTORY ?? 40);
  console.log(
    `model=${MODEL}  turns=${TURNS}  historyTurns=${historyTurns}  stableBlock~${STABLE_BLOCK_TOKENS}tok  inject~${INJECT_TOKENS}tok`
  );
  console.log("Per-arm system block (no cross-arm cache carryover).");
  console.log("Reading the provider's own cache counters, not our estimate of them.");

  const results = new Map<Arm, TurnResult[]>();
  for (const arm of ["C-baseline", "A-volatile-inject", "B-stable-brief"] as Arm[]) {
    const turns = await runArm(arm, historyTurns);
    results.set(arm, turns);
    summarise(arm, turns);
  }

  const stats = (arm: Arm): { final: number; totalMiss: number; totalPrompt: number } => {
    const ok = results.get(arm)!.filter((t) => !t.error);
    if (ok.length === 0) return { final: Number.NaN, totalMiss: 0, totalPrompt: 0 };
    return {
      final: ok[ok.length - 1]!.hitRatio,
      totalMiss: ok.reduce((s, t) => s + t.cacheMissTokens, 0),
      totalPrompt: ok.reduce((s, t) => s + t.promptTokens, 0),
    };
  };

  const c = stats("C-baseline");
  const a = stats("A-volatile-inject");
  const b = stats("B-stable-brief");

  console.log("\n=== verdict ===");
  if (![c.final, a.final, b.final].every(Number.isFinite)) {
    console.log("  Inconclusive: at least one arm errored. See per-turn output above.");
    return;
  }
  console.log(`  baseline (no injection)      final hitRatio ${(c.final * 100).toFixed(1)}%  full-rate tokens: ${c.totalMiss}`);
  console.log(`  volatile injection          final hitRatio ${(a.final * 100).toFixed(1)}%  full-rate tokens: ${a.totalMiss}`);
  console.log(`  stable brief                final hitRatio ${(b.final * 100).toFixed(1)}%  full-rate tokens: ${b.totalMiss}`);

  if (a.final < c.final - 0.05) {
    const extra = a.totalMiss - c.totalMiss;
    console.log(
      `  CONFIRMED: volatile injection costs ${((c.final - a.final) * 100).toFixed(1)} points of hit ratio and ${extra} extra full-rate tokens over ${TURNS} turns.`
    );
  } else {
    console.log("  NOT REPRODUCED on this provider: the volatile arm held its cache.");
  }
  if (b.final >= c.final - 0.05) {
    console.log("  A byte-stable brief is free to place before the breakpoint — no cache cost, only its own tokens once.");
  } else {
    console.log(`  UNEXPECTED: the stable brief itself cost ${((c.final - b.final) * 100).toFixed(1)} points.`);
  }
  const volatilePenalty = a.totalMiss - c.totalMiss;
  if (Number.isFinite(volatilePenalty) && volatilePenalty > 0) {
    console.log(
      `  Per-turn penalty of volatile placement: ${(volatilePenalty / TURNS).toFixed(0)} full-rate tokens/turn at this history size.`
    );
  }
}

void main();
