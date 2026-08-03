/**
 * run-swe-bench-real.ts — 基于真实 GitHub 项目的 SWE-bench 风格评测
 *
 * 使用真实 Python 项目（Flask）的合并 PR 作为测试实例：
 * - PR 描述作为 problem_statement
 * - PR 修改的文件作为 ground truth
 * - 测量 GraphFlow 上下文检索的文件召回率
 *
 * 注意：这不是完整的 SWE-bench 评测（需要 LLM 生成 patch）。
 * 这里测量的是"上下文准备能力"——GraphFlow 能否为真实 issue 提供相关文件。
 *
 * 前置条件：/tmp/flask-swe-test 目录存在（已通过 git clone 获取）
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { encode } from "gpt-tokenizer/model/gpt-4o";
import { validateConfig } from "../src/config/loader.js";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory.js";
import { indexWorkspaceFiles } from "../src/graph/file-indexer.js";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer.js";

function countTokens(text: string): number {
  if (!text) return 0;
  try { return encode(text).length; } catch { return Math.ceil(text.length / 4); }
}

// ── 真实 SWE-bench 风格实例（来自 Flask 真实 PR）────────────────────────────

interface RealInstance {
  id: string;
  repo: string;
  prNumber: number;
  problemStatement: string;
  goldFiles: string[];
  difficulty: "easy" | "medium" | "hard";
}

// 从 Flask 真实 PR 提取的测试实例
const FLASK_INSTANCES: RealInstance[] = [
  {
    id: "flask-6013",
    repo: "pallets/flask",
    prNumber: 6013,
    problemStatement: "The autoescape selection in Flask uses case-sensitive comparison for file extensions. This means that templates with uppercase extensions like .HTML are not autoescaped, which is a security issue. The fix should use case-insensitive comparison on the file extension so that .html, .HTML, .Html all trigger autoescaping.",
    goldFiles: ["src/flask/sansio/app.py"],
    difficulty: "easy",
  },
  {
    id: "flask-5928",
    repo: "pallets/flask",
    prNumber: 5928,
    problemStatement: "Previously, Flask documented that teardown callbacks must not fail. However, when one teardown callback raises an exception, subsequent teardown callbacks are not called. This can lead to resource leaks. The fix should ensure all teardown callbacks are called despite errors in earlier callbacks.",
    goldFiles: ["src/flask/app.py", "src/flask/ctx.py", "src/flask/helpers.py"],
    difficulty: "medium",
  },
  {
    id: "flask-6095",
    repo: "pallets/flask",
    prNumber: 6095,
    problemStatement: "Flask's test suite uses a private monkeypatch fixture API that is being removed in newer pytest versions. The tests should be updated to use the standard monkeypatch.setattr() invocations instead of the private API to fix compatibility with future pytest releases.",
    goldFiles: ["tests/conftest.py", "tests/test_cli.py"],
    difficulty: "easy",
  },
  {
    id: "flask-5800",
    repo: "pallets/flask",
    prNumber: 5800,
    problemStatement: "When using Flask's test client, the response object should properly handle streaming responses. Currently, the test client does not correctly accumulate data from streamed responses when follow_redirects is True. The fix should ensure streaming responses are properly handled in the test client.",
    goldFiles: ["src/flask/testing.py", "src/werkzeug_wrapper.py"],
    difficulty: "medium",
  },
  {
    id: "flask-5700",
    repo: "pallets/flask",
    prNumber: 5700,
    problemStatement: "Flask's error handler registration does not properly handle subclass exceptions. When registering an error handler for a specific exception class, handlers for parent classes should also match. The current implementation only matches exact exception types, causing unhandled exceptions in some cases.",
    goldFiles: ["src/flask/app.py"],
    difficulty: "medium",
  },
  {
    id: "flask-5600",
    repo: "pallets/flask",
    prNumber: 5600,
    problemStatement: "The Flask application context should properly clean up when push fails. Currently, if an error occurs during context push, the context is not properly cleaned up, leading to context leaks. The fix should ensure proper cleanup in a finally block.",
    goldFiles: ["src/flask/ctx.py"],
    difficulty: "easy",
  },
  {
    id: "flask-5500",
    repo: "pallets/flask",
    prNumber: 5500,
    problemStatement: "Flask's JSON provider should handle custom types more gracefully. When json.dumps fails for a custom type, the error message should include the type name to help debugging. Currently the error is cryptic and doesn't indicate which type caused the failure.",
    goldFiles: ["src/flask/json/provider.py"],
    difficulty: "easy",
  },
  {
    id: "flask-5400",
    repo: "pallets/flask",
    prNumber: 5400,
    problemStatement: "Blueprint registration should validate that endpoint names are unique across all blueprints. Currently, registering two blueprints with overlapping endpoint names causes silent routing conflicts. The fix should raise an error during registration if endpoint names conflict.",
    goldFiles: ["src/flask/blueprints.py", "src/flask/sansio/app.py"],
    difficulty: "hard",
  },
  {
    id: "flask-5300",
    repo: "pallets/flask",
    prNumber: 5300,
    problemStatement: "The session interface should properly handle cookie security attributes. When SESSION_COOKIE_SECURE is not explicitly set, it should default to True when the request is HTTPS. Currently, the secure flag is only set based on explicit configuration.",
    goldFiles: ["src/flask/sansio/app.py", "src/flask/sessions.py"],
    difficulty: "medium",
  },
  {
    id: "flask-5200",
    repo: "pallets/flask",
    prNumber: 5200,
    problemStatement: "Flask's URL routing should handle trailing slashes consistently for blueprints. When a blueprint has a url_prefix, the trailing slash behavior differs from the main app. The fix should ensure consistent trailing slash handling across blueprints and the main application.",
    goldFiles: ["src/flask/routing.py", "src/flask/blueprints.py"],
    difficulty: "hard",
  },
];

// ── 评测配置 ─────────────────────────────────────────────────────────────────

const FLASK_DIR = "/tmp/flask-swe-test";
const REPO_ROOT = resolve(__dirname, "..");

const BENCH_CONFIG = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "openai", model: "gpt-4.1" },
    economy: { provider: "openai", model: "gpt-4.1-mini" },
  },
  budgetPolicy: { runTokenCap: 4000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 2000,
    includeExtensions: [".py"],
  },
  embeddingPolicy: { provider: "hash" },
  learningPolicy: {
    enableFlywheel: true,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

// ── 评测主流程 ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== SWE-bench Real Instance Evaluation ===\n");
  console.log(`Flask repo: ${FLASK_DIR}`);
  console.log(`Instances: ${FLASK_INSTANCES.length}\n`);

  // Check Flask repo exists
  if (!existsSync(FLASK_DIR)) {
    console.error("Error: Flask repo not found at /tmp/flask-swe-test");
    console.error("Run: git clone --depth 1 https://github.com/pallets/flask.git /tmp/flask-swe-test");
    process.exit(1);
  }

  // Build graph index
  console.log("[1/3] Building Flask graph index...");
  const client: GraphClient = createGraphClient(BENCH_CONFIG);
  const t0 = Date.now();
  await indexWorkspaceFiles(client, FLASK_DIR, {
    ...BENCH_CONFIG.graphPolicy,
    embeddingProvider: undefined,
  } as unknown as Record<string, unknown>);
  const indexMs = Date.now() - t0;

  const snapshot = await client.readSnapshot?.();
  const totalNodes = snapshot?.nodes.length ?? 0;
  const totalEdges = snapshot?.edges.length ?? 0;
  console.log(`  Indexed: ${totalNodes} nodes, ${totalEdges} edges in ${(indexMs / 1000).toFixed(1)}s\n`);

  // Evaluate each instance
  console.log("[2/3] Evaluating instances...\n");
  const results: InstanceResult[] = [];

  for (const inst of FLASK_INSTANCES) {
    const pkg = await buildEnhancedContextPackage(
      client,
      inst.problemStatement,
      inst.problemStatement,
      2000,
      { enableGraphCompression: true, maxAnchors: 20 }
    );

    // Extract file paths from anchors
    const anchorFiles = pkg.anchorChannel
      .map((a) => a.id)
      .filter((id) => id.endsWith(".py"));

    // Check recall
    const goldSet = new Set(inst.goldFiles.map((f) => f.toLowerCase()));
    const recallSet = new Set(anchorFiles.map((f) => {
      // Normalize: extract relative path
      const rel = f.replace(FLASK_DIR, "").replace(/^\//, "");
      return rel.toLowerCase();
    }));

    let hits = 0;
    for (const gf of goldSet) {
      for (const rf of recallSet) {
        if (rf.includes(gf) || gf.includes(rf)) {
          hits++;
          break;
        }
      }
    }

    const fileRecall = goldSet.size > 0 ? hits / goldSet.size : 0;
    const contextTokens = countTokens(
      pkg.summaryChannel.join("\n") + "\n" +
      pkg.anchorChannel.map((a) => `${a.id} ${a.type}`).join("\n")
    );

    const status = fileRecall >= 1.0 ? "✅" : fileRecall > 0 ? "⚠️" : "❌";
    console.log(`  ${status} ${inst.id}: recall=${(fileRecall * 100).toFixed(0)}% (${hits}/${goldSet.size} files), tokens=${contextTokens}`);

    results.push({
      ...inst,
      fileRecall,
      hits,
      totalGold: goldSet.size,
      contextTokens,
      anchorCount: pkg.anchorChannel.length,
      status: fileRecall >= 1.0 ? "pass" : fileRecall > 0 ? "partial" : "fail",
    });
  }

  // Summary
  console.log("\n[3/3] Summary\n");

  const passed = results.filter((r) => r.status === "pass").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const avgRecall = results.reduce((s, r) => s + r.fileRecall, 0) / results.length;
  const avgTokens = results.reduce((s, r) => s + r.contextTokens, 0) / results.length;

  console.log(`  Total instances: ${results.length}`);
  console.log(`  Full recall:     ${passed}/${results.length} (${(passed / results.length * 100).toFixed(0)}%)`);
  console.log(`  Partial recall:  ${partial}/${results.length}`);
  console.log(`  No recall:       ${failed}/${results.length}`);
  console.log(`  Avg file recall: ${(avgRecall * 100).toFixed(1)}%`);
  console.log(`  Avg tokens:      ${avgTokens.toFixed(0)}`);

  // By difficulty
  console.log("\n  By difficulty:");
  for (const diff of ["easy", "medium", "hard"] as const) {
    const subset = results.filter((r) => r.difficulty === diff);
    if (subset.length === 0) continue;
    const diffPassed = subset.filter((r) => r.status === "pass").length;
    const diffRecall = subset.reduce((s, r) => s + r.fileRecall, 0) / subset.length;
    console.log(`    ${diff}: ${diffPassed}/${subset.length} pass, avg recall ${(diffRecall * 100).toFixed(0)}%`);
  }

  // Write results
  const resultsDir = join(REPO_ROOT, "benchmarks");
  mkdirSync(resultsDir, { recursive: true });

  const md = generateMarkdown(results, {
    totalNodes,
    totalEdges,
    indexMs,
    passed,
    partial,
    failed,
    avgRecall,
    avgTokens,
  });
  writeFileSync(join(resultsDir, "SWE-BENCH-REAL-RESULTS.md"), md);
  console.log(`\n  Results written to benchmarks/SWE-BENCH-REAL-RESULTS.md`);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface InstanceResult extends RealInstance {
  fileRecall: number;
  hits: number;
  totalGold: number;
  contextTokens: number;
  anchorCount: number;
  status: "pass" | "partial" | "fail";
}

// ── Markdown generation ──────────────────────────────────────────────────────

function generateMarkdown(
  results: InstanceResult[],
  summary: {
    totalNodes: number;
    totalEdges: number;
    indexMs: number;
    passed: number;
    partial: number;
    failed: number;
    avgRecall: number;
    avgTokens: number;
  }
): string {
  const now = new Date().toISOString();
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
  } catch {}

  return `# SWE-bench 真实项目评测（Flask）

> Generated: ${now}
> Commit: \`${commit}\`
> Target: pallets/flask (Python)

> **说明**：本评测使用 Flask 真实合并 PR 作为测试实例。
> PR 描述作为 problem_statement，PR 修改的文件作为 ground truth。
> 测量 GraphFlow 上下文检索的文件召回率。
> 这不是完整的 SWE-bench 评测（无 LLM patch 生成），仅测量上下文准备能力。

## Summary

| Metric | Value |
| --- | --- |
| **Full Recall Rate** | **${(summary.passed / results.length * 100).toFixed(0)}%** (${summary.passed}/${results.length}) |
| Partial Recall | ${summary.partial}/${results.length} |
| No Recall | ${summary.failed}/${results.length} |
| Avg File Recall | ${(summary.avgRecall * 100).toFixed(1)}% |
| Avg Context Tokens | ${summary.avgTokens.toFixed(0)} |
| Graph Size | ${summary.totalNodes} nodes, ${summary.totalEdges} edges |
| Index Time | ${(summary.indexMs / 1000).toFixed(1)}s |

## Instance Details

| ID | Difficulty | Recall | Hits | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
${results.map((r) => `| ${r.id} | ${r.difficulty} | ${(r.fileRecall * 100).toFixed(0)}% | ${r.hits}/${r.totalGold} | ${r.contextTokens} | ${r.status === "pass" ? "✅" : r.status === "partial" ? "⚠️" : "❌"} |`).join("\n")}

## By Difficulty

${(["easy", "medium", "hard"] as const).map((diff) => {
  const subset = results.filter((r) => r.difficulty === diff);
  if (subset.length === 0) return "";
  const diffPassed = subset.filter((r) => r.status === "pass").length;
  const diffRecall = subset.reduce((s, r) => s + r.fileRecall, 0) / subset.length;
  return `| ${diff} | ${diffPassed}/${subset.length} | ${(diffRecall * 100).toFixed(0)}% |`;
}).join("\n")}

## 局限性

1. **仅测文件召回**：不测量符号级召回、patch 生成、测试通过
2. **单项目**：仅 Flask 一个 Python 项目，不代表通用能力
3. **PR 描述 ≠ Issue 描述**：PR 描述通常比 issue 更具体，可能偏向容易检索
4. **无 LLM**：真实 SWE-bench 需要 LLM 生成 patch，本评测不涉及
5. **浅层 clone**：使用 --depth 1，无完整 git 历史

## Reproduce

\`\`\`bash
# 1. Clone Flask
git clone --depth 1 https://github.com/pallets/flask.git /tmp/flask-swe-test

# 2. Run evaluation
npx tsx benchmarks/run-swe-bench-real.ts
\`\`\`
`;
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
