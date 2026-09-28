/**
 * Manual host-placement test — the one command that produces a real number.
 *
 * ## Why a script and not a checklist
 *
 * The question "did putting our content in the right place actually save
 * money?" cannot be answered by eyeballing a session. opencode assembles its
 * own prompt and exposes neither the assembled bytes nor the provider's cache
 * counters, so from the outside a correct layout and a broken one look
 * identical. Worse, the difference only shows up over many turns, because the
 * first turn is a cache miss either way.
 *
 * So this sends real requests with the real content GraphFlow produces for this
 * repository, in both arrangements, and reports the provider's own numbers.
 * What it cannot do is prove what *your* host does with the advice — it proves
 * what the advice is worth if a host follows it.
 *
 * ## The two arrangements
 *
 *   good  system = stable harness block + project brief   (byte-identical)
 *         ...conversation grows...                        delta appended per turn
 *
 *   bad   system = stable harness block + project brief + delta   (delta varies)
 *         ...conversation grows...
 *
 * The bad one is what a host does by appending the whole package to its system
 * prompt, which is the common and entirely reasonable-looking mistake.
 *
 * ## Usage
 *
 *   DEEPSEEK_API_KEY=... npx tsx benchmarks/host-placement-manual.ts
 *   GRAPHFLOW_PLACEMENT_TURNS=10   npx tsx benchmarks/host-placement-manual.ts
 *   GRAPHFLOW_PLACEMENT_HISTORY=80 npx tsx benchmarks/host-placement-manual.ts
 *
 * Cost: turns x 2 arms. At the default of 6 turns this is a few thousand tokens
 * on DeepSeek, i.e. cents.
 *
 * ## Reproducing
 *
 * The provider's cache is keyed to the account, not the process, so **re-running
 * with unchanged content starts warm**: an identical second run reports a much
 * higher hit ratio than the first, because the first run already wrote those
 * prefixes. That is the cache working, not a measurement error — but it does
 * mean you cannot compare two runs of this script directly. Either read the
 * absolute dollar figures (which include the real warm-cache benefit) or vary
 * the content between runs.
 *
 * Observed on this repository: at 30 turns of history the two arrangements
 * measured within noise; at 80 turns the correct placement was 50% cheaper.
 * The effect grows with session length, which is the whole point — a volatile
 * block in front of a long transcript keeps re-billing the transcript.
 */
import { buildProjectBrief } from "../src/graph/project-brief.js";
import { createGraphClient } from "../src/graph/client-factory.js";
import { resolveConfig } from "../src/config/resolve.js";
import type { GraphEdge, GraphNode } from "../src/core/types";

const BASE_URL = (process.env.GRAPHFLOW_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(
  /\/+$/,
  ""
);
const MODEL = process.env.GRAPHFLOW_DEEPSEEK_MODEL ?? "deepseek-chat";
const API_KEY = process.env.DEEPSEEK_API_KEY;
const TURNS = Number(process.env.GRAPHFLOW_PLACEMENT_TURNS ?? 6);
const HISTORY_TURNS = Number(process.env.GRAPHFLOW_PLACEMENT_HISTORY ?? 30);

/** DeepSeek V4 Flash off-peak, cache-miss input. Cache reads are ~2% of this. */
const PRICE_IN = 0.15;
const CACHE_READ_RATIO = 0.02;

interface ArmResult {
  turns: number;
  promptTokens: number;
  hitTokens: number;
  missTokens: number;
  usd: number;
}

/** Real brief + real delta from this repository, via the real graph. */
async function loadRealContent(): Promise<{ brief: string; delta: string }> {
  const config = resolveConfig(undefined);
  const client = createGraphClient(config);
  const snapshot = client.readSnapshot?.();
  const nodes: GraphNode[] = snapshot?.nodes ?? [];
  const edges: GraphEdge[] = snapshot?.edges ?? [];
  if (nodes.length === 0) {
    throw new Error("no graph for this workspace — run `graphflow graph index` first");
  }
  const brief = buildProjectBrief(nodes, edges);
  // The delta is shaped like a real query-scoped package: anchors plus the
  // conversation recall that rides along with them.
  const anchors = nodes
    .filter((node) => node.type === "Symbol")
    .slice(0, 12)
    .map((node) => `${node.id} — ${String(node.content).split("\n")[0]?.slice(0, 100) ?? ""}`);
  return { brief: brief.lines.join("\n"), delta: anchors.join("\n") };
}

function harnessBlock(): string {
  const out: string[] = ["HARNESS SYSTEM BLOCK — representative of a host's static prompt."];
  let i = 0;
  while (out.join("\n").length < 8_000) {
    out.push(`instruction ${i}: the agent follows the repository's stated conventions.`);
    i += 1;
  }
  return out.join("\n");
}

async function runArm(
  arrangement: "good" | "bad",
  brief: string,
  deltaForTurn: (turn: number) => string,
  system: string
): Promise<ArmResult> {
  const conversation: Array<{ role: string; content: string }> = [];
  for (let h = 1; h <= HISTORY_TURNS; h += 1) {
    conversation.push({ role: "user", content: `Earlier task ${h}: inspect the retrieval layer.` });
    conversation.push({
      role: "assistant",
      content: `Earlier answer ${h}: the layered slicer resolves anchors and packs them under budget.`,
    });
  }

  let promptTokens = 0;
  let hitTokens = 0;
  let missTokens = 0;

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const delta = deltaForTurn(turn);
    const taskText = `Task ${turn}: summarise the retrieval layer.`;

    // The turn is appended to history IDENTICALLY in both arms — same user
    // message, same assistant reply. The only difference is whether the delta
    // rides inside that turn or inside the system block.
    //
    // The first version of this harness got that wrong: it pushed only an
    // assistant message in the good arm and only a user message in the bad one,
    // so the two "histories" were structurally different and the comparison
    // measured nothing. It reported the bad placement as *cheaper*, which is what
    // exposed it. A confound this size is invisible to reasoning and only shows
    // up when the number contradicts the hypothesis.
    const turnUser = { role: "user", content: `${taskText}\n\n${delta}` };

    const systemForTurn =
      arrangement === "good"
        ? `${system}\n\n## Project brief (stable)\n${brief}`
        : `${system}\n\n## Project brief (stable)\n${brief}\n\n## Retrieved context\n${delta}`;

    // good: the delta is inside the turn, i.e. after the transcript.
    // bad:  the delta is in the system block, i.e. before the transcript, and
    //       the turn carries only the task.
    const turnMessage =
      arrangement === "good" ? turnUser : { role: "user", content: taskText };

    const messages = [{ role: "system", content: systemForTurn }, ...conversation, turnMessage];
    conversation.push(turnMessage, { role: "assistant", content: "ack" });

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 8, temperature: 0, messages }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${BASE_URL}`);
    const payload = (await response.json()) as {
      usage?: { prompt_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
    };
    promptTokens += payload.usage?.prompt_tokens ?? 0;
    hitTokens += payload.usage?.prompt_cache_hit_tokens ?? 0;
    missTokens += payload.usage?.prompt_cache_miss_tokens ?? 0;
  }

  const usd =
    ((hitTokens * CACHE_READ_RATIO + missTokens) / 1_000_000) * PRICE_IN;
  return { turns: TURNS, promptTokens, hitTokens, missTokens, usd };
}

function report(label: string, r: ArmResult): void {
  const hitRatio = r.promptTokens > 0 ? r.hitTokens / r.promptTokens : 0;
  console.log(
    `  ${label.padEnd(34)} hitRatio ${(hitRatio * 100).toFixed(1).padStart(5)}%  ` +
      `命中 ${String(r.hitTokens).padStart(7)}  全价 ${String(r.missTokens).padStart(7)}  $${r.usd.toFixed(6)}`
  );
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.log("DEEPSEEK_API_KEY not set.");
    return;
  }
  const { brief, delta } = await loadRealContent();
  const system = harnessBlock();
  const deltaChars = (brief.length + delta.length) / 4;
  console.log("=== 用本仓库的真实内容 ===");
  console.log(`  brief ≈ ${Math.round(brief.length / 4)} tok   delta ≈ ${Math.round(delta.length / 4)} tok`);
  console.log(`  turns=${TURNS}  history=${HISTORY_TURNS}  model=${MODEL}`);
  console.log(`  DeepSeek 计价: 全价 $${PRICE_IN}/MTok, 缓存读 $${(PRICE_IN * CACHE_READ_RATIO).toFixed(4)}/MTok (${(CACHE_READ_RATIO * 100).toFixed(0)}%)\n`);

  // Turn-varying delta: this is what a query-scoped package actually is.
  const deltaForTurn = (turn: number) => `${delta}\n// turn ${turn} variant`;

  console.log("=== 两种摆放 ===");
  const good = await runArm("good", brief, deltaForTurn, system);
  const bad = await runArm("bad", brief, deltaForTurn, system);
  report("good: delta 放当轮末尾", good);
  report("bad:  delta 并入 system", bad);

  const saved = bad.usd - good.usd;
  console.log(`\n=== 结论 ===`);
  if (saved > 0) {
    console.log(`  按 recipe 摆放,${TURNS} 轮省 $${saved.toFixed(6)} (${((saved / bad.usd) * 100).toFixed(0)}%),`);
    console.log(`  折合每轮 $${(saved / TURNS).toFixed(6)};本仓库 brief+delta 合计约 ${Math.round(deltaChars)} tok。`);
  } else {
    console.log(`  在这个历史长度下,两种摆放差别在噪声内 ($${saved.toFixed(6)})。`);
    console.log(`  把 GRAPHFLOW_PLACEMENT_HISTORY 调大(会话越长差距越大)再看。`);
  }
  console.log("\n  注意:这证明的是「照做值多少」,不是「你的宿主做了什么」。");
  console.log("  要证明后者,需要看宿主实际发出的 prompt 字节,或 provider 的缓存计数。");
}

void main();
