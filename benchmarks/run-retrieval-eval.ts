/**
 * run-retrieval-eval.ts — 检索质量评估脚本
 *
 * 在 GraphFlow 自身 src/ 上建图，对 132 条 golden 查询计算标准 IR 指标：
 *   - Hit-rate@K（K=1,3,5,10）
 *   - MRR（Mean Reciprocal Rank）
 *   - NDCG@K
 *   - 每域细分
 *   - 负样本精确度（decoy 不出现）
 *
 * 用法：npm run benchmark:retrieval
 *
 * 输出：
 *   - benchmarks/RETRIEVAL-EVAL-RESULTS.md（人类可读）
 *   - benchmarks/.cache/retrieval-eval-results.json（机器可读）
 */

import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { validateConfig } from "../src/config/loader.js";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory.js";
import { indexWorkspaceFiles } from "../src/graph/file-indexer.js";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer.js";
import { GOLDEN_SET } from "./retrieval-golden-data.js";

const SRC_DIR = join(process.cwd(), "src");
const CONTEXT_TOKEN_BUDGET = 800;

const GOLDEN_CONFIG = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 3000,
  },
  learningPolicy: {
    enableFlywheel: false,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

/** 负样本：查询 + 不应出现的 decoy */
const NEGATIVE_SAMPLES: ReadonlyArray<{ query: string; mustNotContain: string[] }> = [
  { query: "plcopen xml pou variables", mustNotContain: ["agent-profiles", "provider-adapters"] },
  { query: "cli init scaffold", mustNotContain: ["plcopen", "language-indexers"] },
  { query: "anthropic provider adapter", mustNotContain: ["language-indexers", "surfaces/mcp"] },
  { query: "skill store persistence", mustNotContain: ["model-router"] },
  { query: "config secrets redact", mustNotContain: ["dag-engine", "plcopen"] },
  { query: "mcp tool handlers", mustNotContain: ["agent-profiles"] },
  { query: "java indexer classes", mustNotContain: ["surfaces/mcp", "model-router"] },
  { query: "goal anchor alignment deviation", mustNotContain: ["plcopen", "surfaces/mcp"] },
  { query: "windsurf agent profile", mustNotContain: ["context-slicer", "sqlite"] },
  { query: "provider executor calls", mustNotContain: ["skill-flywheel", "language-indexers"] },
  { query: "config schema validation", mustNotContain: ["plcopen"] },
  { query: "atp protocol schema", mustNotContain: ["language-indexers"] },
];

interface PerQueryResult {
  query: string;
  domain: string;
  /** 首个命中 anchor 的位置（0-based），-1 表示未命中 */
  firstHitPosition: number;
  /** 所有命中 anchor 的位置列表 */
  hitPositions: number[];
  /** 总 anchor 数 */
  totalAnchors: number;
  /** 是否在 summary+anchor 文本中命中 */
  textHit: boolean;
  /** 命中的 expectAny 子串 */
  matchedExpect: string[];
}

interface DomainStats {
  domain: string;
  queryCount: number;
  hitRateAt1: number;
  hitRateAt3: number;
  hitRateAt5: number;
  hitRateAt10: number;
  mrr: number;
  ndcgAt5: number;
  ndcgAt10: number;
}

interface EvalResults {
  timestamp: string;
  nodeVersion: string;
  platform: string;
  totalNodes: number;
  totalEdges: number;
  queryCount: number;
  /** 全局指标 */
  overall: {
    hitRateAt1: number;
    hitRateAt3: number;
    hitRateAt5: number;
    hitRateAt10: number;
    mrr: number;
    ndcgAt5: number;
    ndcgAt10: number;
    textHitRate: number;
    negativePrecision: number;
  };
  /** 每域细分 */
  perDomain: DomainStats[];
  /** 每查询明细 */
  perQuery: PerQueryResult[];
  /** 负样本明细 */
  negativeSamples: Array<{ query: string; clean: boolean; violations: string[] }>;
  wallClockMs: number;
}

/** 计算 DCG@K */
function dcgAtK(relevanceScores: number[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, relevanceScores.length); i++) {
    sum += relevanceScores[i] / Math.log2(i + 2); // i+2 因为 log2(1)=0
  }
  return sum;
}

/** 计算 NDCG@K */
function ndcgAtK(relevanceScores: number[], k: number): number {
  const actual = dcgAtK(relevanceScores, k);
  // 理想排序：所有相关项排前面
  const ideal = [...relevanceScores].sort((a, b) => b - a);
  const idealDcg = dcgAtK(ideal, k);
  return idealDcg === 0 ? 0 : actual / idealDcg;
}

async function main() {
  const startTime = Date.now();
  console.log("[retrieval-eval] Building in-memory graph...");

  const client: GraphClient = createGraphClient(GOLDEN_CONFIG);
  await indexWorkspaceFiles(client, SRC_DIR, {
    ...GOLDEN_CONFIG.graphPolicy,
    embeddingProvider: undefined,
  } as any);

  const snapshot = await client.readSnapshot?.();
  const totalNodes = snapshot?.nodes.length ?? 0;
  const totalEdges = snapshot?.edges.length ?? 0;
  console.log(`[retrieval-eval] Graph: ${totalNodes} nodes, ${totalEdges} edges`);

  // ── 逐查询评估 ──
  const perQuery: PerQueryResult[] = [];
  console.log(`[retrieval-eval] Evaluating ${GOLDEN_SET.length} queries...`);

  for (const entry of GOLDEN_SET) {
    const pkg = await buildEnhancedContextPackage(
      client,
      entry.query,
      entry.query,
      CONTEXT_TOKEN_BUDGET,
      { enableGraphCompression: true }
    );

    const text = [...pkg.summaryChannel, ...pkg.anchorChannel.map((a) => a.id)]
      .join("\n")
      .toLowerCase();
    const anchors = pkg.anchorChannel.map((a) => a.id);

    // 查找首个命中位置
    const hitPositions: number[] = [];
    const matchedExpect: string[] = [];
    for (let i = 0; i < anchors.length; i++) {
      const anchorId = anchors[i].toLowerCase();
      for (const needle of entry.expectAny) {
        if (anchorId.includes(needle.toLowerCase())) {
          hitPositions.push(i);
          if (!matchedExpect.includes(needle)) matchedExpect.push(needle);
          break;
        }
      }
    }

    const firstHitPosition = hitPositions.length > 0 ? hitPositions[0] : -1;
    const textHit = entry.expectAny.some((needle: string) => text.includes(needle.toLowerCase()));

    perQuery.push({
      query: entry.query,
      domain: entry.domain,
      firstHitPosition,
      hitPositions,
      totalAnchors: anchors.length,
      textHit,
      matchedExpect,
    });
  }

  // ── 负样本评估 ──
  const negativeSamples: Array<{ query: string; clean: boolean; violations: string[] }> = [];
  for (const { query, mustNotContain } of NEGATIVE_SAMPLES) {
    const pkg = await buildEnhancedContextPackage(
      client,
      query,
      query,
      CONTEXT_TOKEN_BUDGET,
      { enableGraphCompression: true }
    );
    const text = [...pkg.summaryChannel, ...pkg.anchorChannel.map((a) => a.id)]
      .join("\n")
      .toLowerCase();
    const violations = mustNotContain.filter((decoy) => text.includes(decoy.toLowerCase()));
    negativeSamples.push({ query, clean: violations.length === 0, violations });
  }

  // ── 计算指标 ──
  function computeMetrics(queries: PerQueryResult[]): Omit<DomainStats, "domain" | "queryCount"> {
    const n = queries.length;
    if (n === 0) return { hitRateAt1: 0, hitRateAt3: 0, hitRateAt5: 0, hitRateAt10: 0, mrr: 0, ndcgAt5: 0, ndcgAt10: 0 };

    let hit1 = 0, hit3 = 0, hit5 = 0, hit10 = 0;
    let rrSum = 0;
    let ndcg5Sum = 0, ndcg10Sum = 0;

    for (const q of queries) {
      // Hit-rate@K
      if (q.firstHitPosition >= 0 && q.firstHitPosition < 1) hit1++;
      if (q.firstHitPosition >= 0 && q.firstHitPosition < 3) hit3++;
      if (q.firstHitPosition >= 0 && q.firstHitPosition < 5) hit5++;
      if (q.firstHitPosition >= 0 && q.firstHitPosition < 10) hit10++;

      // MRR
      const rr = q.firstHitPosition >= 0 ? 1 / (q.firstHitPosition + 1) : 0;
      rrSum += rr;

      // NDCG: 构建相关性向量（anchor 级别）
      // 相关 = anchor id 包含任一 expectAny 子串
      const relevance = q.hitPositions.length > 0
        ? q.hitPositions.map((pos) => 1) // 简化的二值相关性
        : [];
      // 为 NDCG 构建完整相关性向量（所有 anchor 位置）
      const fullRelevance: number[] = [];
      for (let i = 0; i < Math.min(q.totalAnchors, 20); i++) {
        fullRelevance.push(q.hitPositions.includes(i) ? 1 : 0);
      }
      ndcg5Sum += ndcgAtK(fullRelevance, 5);
      ndcg10Sum += ndcgAtK(fullRelevance, 10);
    }

    return {
      hitRateAt1: hit1 / n,
      hitRateAt3: hit3 / n,
      hitRateAt5: hit5 / n,
      hitRateAt10: hit10 / n,
      mrr: rrSum / n,
      ndcgAt5: ndcg5Sum / n,
      ndcgAt10: ndcg10Sum / n,
    };
  }

  // 全局指标
  const overallMetrics = computeMetrics(perQuery);
  const textHits = perQuery.filter((q) => q.textHit).length;
  const cleanNeg = negativeSamples.filter((n) => n.clean).length;

  // 每域指标
  const domainMap = new Map<string, PerQueryResult[]>();
  for (const q of perQuery) {
    const arr = domainMap.get(q.domain) ?? [];
    arr.push(q);
    domainMap.set(q.domain, arr);
  }
  const perDomain: DomainStats[] = [];
  for (const [domain, queries] of domainMap) {
    const metrics = computeMetrics(queries);
    perDomain.push({ domain, queryCount: queries.length, ...metrics });
  }
  perDomain.sort((a, b) => a.domain.localeCompare(b.domain));

  const wallClockMs = Date.now() - startTime;

  const results: EvalResults = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    totalNodes,
    totalEdges,
    queryCount: GOLDEN_SET.length,
    overall: {
      ...overallMetrics,
      textHitRate: textHits / perQuery.length,
      negativePrecision: cleanNeg / negativeSamples.length,
    },
    perDomain,
    perQuery,
    negativeSamples,
    wallClockMs,
  };

  // ── 输出 Markdown ──
  const md = generateMarkdown(results);
  const resultsDir = join(process.cwd(), "benchmarks");
  const cacheDir = join(resultsDir, ".cache");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

  writeFileSync(join(resultsDir, "RETRIEVAL-EVAL-RESULTS.md"), md, "utf8");
  writeFileSync(join(cacheDir, "retrieval-eval-results.json"), JSON.stringify(results, null, 2), "utf8");

  console.log(`\n[retrieval-eval] Done in ${(wallClockMs / 1000).toFixed(1)}s`);
  console.log(`[retrieval-eval] Hit-rate@5: ${(results.overall.hitRateAt5 * 100).toFixed(1)}%`);
  console.log(`[retrieval-eval] MRR:         ${(results.overall.mrr * 100).toFixed(1)}%`);
  console.log(`[retrieval-eval] NDCG@5:     ${(results.overall.ndcgAt5 * 100).toFixed(1)}%`);
  console.log(`[retrieval-eval] Results: benchmarks/RETRIEVAL-EVAL-RESULTS.md`);
}

function generateMarkdown(r: EvalResults): string {
  const lines: string[] = [];
  lines.push(`# Retrieval Quality Evaluation Results`);
  lines.push(``);
  lines.push(`> Auto-generated by \`npm run benchmark:retrieval\``);
  lines.push(`> Last run: ${r.timestamp}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Queries evaluated | ${r.queryCount} |`);
  lines.push(`| Graph nodes | ${r.totalNodes} |`);
  lines.push(`| Graph edges | ${r.totalEdges} |`);
  lines.push(`| **Hit-rate@1** | **${(r.overall.hitRateAt1 * 100).toFixed(1)}%** |`);
  lines.push(`| **Hit-rate@3** | **${(r.overall.hitRateAt3 * 100).toFixed(1)}%** |`);
  lines.push(`| **Hit-rate@5** | **${(r.overall.hitRateAt5 * 100).toFixed(1)}%** |`);
  lines.push(`| **Hit-rate@10** | **${(r.overall.hitRateAt10 * 100).toFixed(1)}%** |`);
  lines.push(`| **MRR** | **${r.overall.mrr.toFixed(3)}** |`);
  lines.push(`| **NDCG@5** | **${r.overall.ndcgAt5.toFixed(3)}** |`);
  lines.push(`| **NDCG@10** | **${r.overall.ndcgAt10.toFixed(3)}** |`);
  lines.push(`| Text hit-rate (summary+anchor) | ${(r.overall.textHitRate * 100).toFixed(1)}% |`);
  lines.push(`| Negative sample precision | ${(r.overall.negativePrecision * 100).toFixed(1)}% |`);
  lines.push(`| Wall-clock | ${(r.wallClockMs / 1000).toFixed(1)}s |`);
  lines.push(``);

  lines.push(`## Per-domain breakdown`);
  lines.push(``);
  lines.push(`| Domain | N | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR | NDCG@5 | NDCG@10 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const d of r.perDomain) {
    lines.push(`| ${d.domain} | ${d.queryCount} | ${(d.hitRateAt1 * 100).toFixed(0)}% | ${(d.hitRateAt3 * 100).toFixed(0)}% | ${(d.hitRateAt5 * 100).toFixed(0)}% | ${(d.hitRateAt10 * 100).toFixed(0)}% | ${d.mrr.toFixed(2)} | ${d.ndcgAt5.toFixed(2)} | ${d.ndcgAt10.toFixed(2)} |`);
  }
  lines.push(``);

  lines.push(`## Per-query detail (misses only)`);
  lines.push(``);
  const misses = r.perQuery.filter((q) => q.firstHitPosition < 0);
  if (misses.length === 0) {
    lines.push(`All queries hit. No misses.`);
  } else {
    lines.push(`| Query | Domain | First hit pos | Matched |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const q of misses) {
      lines.push(`| ${q.query} | ${q.domain} | MISS | ${q.matchedExpect.join(", ") || "none"} |`);
    }
  }
  lines.push(``);

  lines.push(`## Negative samples`);
  lines.push(``);
  const negViolations = r.negativeSamples.filter((n) => !n.clean);
  if (negViolations.length === 0) {
    lines.push(`All ${r.negativeSamples.length} negative samples clean (no decoy bleed).`);
  } else {
    lines.push(`| Query | Violations |`);
    lines.push(`| --- | --- |`);
    for (const n of negViolations) {
      lines.push(`| ${n.query} | ${n.violations.join(", ")} |`);
    }
  }
  lines.push(``);

  lines.push(`## Reproduce`);
  lines.push(``);
  lines.push(`\`\`\`bash`);
  lines.push(`npm install && npm run benchmark:retrieval`);
  lines.push(`\`\`\``);
  lines.push(``);

  return lines.join("\n");
}

main().catch((err) => {
  console.error("[retrieval-eval] Fatal error:", err);
  process.exit(1);
});
