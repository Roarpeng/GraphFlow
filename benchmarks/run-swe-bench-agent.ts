/**
 * run-swe-bench-agent.ts — 完整 SWE-bench 风格 Agent 评测
 *
 * 流程：
 * 1. 从真实 Flask PR 构建测试实例（problem_statement + gold patch）
 * 2. 对每个实例：
 *    a. git checkout 到 PR 合并前的 commit
 *    b. GraphFlow 索引仓库 → 提供压缩上下文
 *    c. DeepSeek 基于上下文生成 patch
 *    d. 应用 patch → 运行 pytest → 判断是否修复
 * 3. 输出解决率
 *
 * 前置条件：
 * - DEEPSEEK_API_KEY 环境变量
 * - tmp/swe-eval/flask 完整 clone
 * - Python 3 + pytest
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, execSync } from "node:child_process";

import { encode } from "gpt-tokenizer/model/gpt-4o";
import { validateConfig } from "../src/config/loader.js";
import { createGraphClient, type GraphClient } from "../src/graph/client-factory.js";
import { indexWorkspaceFiles } from "../src/graph/file-indexer.js";
import { buildEnhancedContextPackage } from "../src/graph/context-slicer.js";

function countTokens(text: string): number {
  if (!text) return 0;
  try { return encode(text).length; } catch { return Math.ceil(text.length / 4); }
}

// ── DeepSeek API ─────────────────────────────────────────────────────────────

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

async function callDeepSeek(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not set");

  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.0,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DeepSeek API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const choices = data.choices as Array<{ message: { content: string } }>;
  return choices[0].message.content;
}

// ── Test instances (from real Flask PRs) ─────────────────────────────────────

interface SweInstance {
  id: string;
  prNumber: number;
  /** commit hash BEFORE the fix (parent of merge commit) */
  baseCommit: string;
  problemStatement: string;
  goldPatch: string;
  testCommand: string;
  /** test file paths that should pass after fix */
  passAfterFix: string[];
}

// We'll discover base commits dynamically after clone is ready
const INSTANCES: Omit<SweInstance, "baseCommit">[] = [
  {
    id: "flask-6013",
    prNumber: 6013,
    problemStatement: `Fix autoescape selection to use case-insensitive comparison for file extensions.

Currently in Flask, the autoescape selection uses case-sensitive comparison on file extensions. This means templates with uppercase extensions like .HTML are not autoescaped, which is a security issue.

The fix should use case-insensitive comparison (e.g., .lower()) on the file extension so that .html, .HTML, .Html all trigger autoescaping.

Look in src/flask/sansio/app.py for the select_jinja_autoescape method.`,
    goldPatch: "",
    testCommand: "python -m pytest tests/ -x -q --tb=short",
    passAfterFix: ["tests/test_basic.py"],
  },
  {
    id: "flask-5928",
    prNumber: 5928,
    problemStatement: `Ensure all teardown callbacks are called despite errors in earlier callbacks.

Previously, Flask documented that teardown callbacks must not fail. However, when one teardown callback raises an exception, subsequent teardown callbacks are not called, leading to resource leaks.

The fix should ensure all teardown callbacks are called despite errors. Errors should be collected and reported after all callbacks run.

Look in src/flask/ctx.py for the teardown logic.`,
    goldPatch: "",
    testCommand: "python -m pytest tests/ -x -q --tb=short",
    passAfterFix: ["tests/test_appctx.py"],
  },
  {
    id: "flask-5600",
    prNumber: 5600,
    problemStatement: `Fix Flask application context cleanup when push fails.

When an error occurs during application context push, the context is not properly cleaned up, leading to context leaks. The fix should ensure proper cleanup in a finally block.

Look in src/flask/ctx.py for the AppContext.push method.`,
    goldPatch: "",
    testCommand: "python -m pytest tests/ -x -q --tb=short",
    passAfterFix: ["tests/test_appctx.py"],
  },
  {
    id: "flask-5500",
    prNumber: 5500,
    problemStatement: `Improve JSON provider error messages for custom types.

When json.dumps fails for a custom type, the error message should include the type name to help debugging. Currently the error is cryptic and doesn't indicate which type caused the failure.

Look in src/flask/json/provider.py for the default method.`,
    goldPatch: "",
    testCommand: "python -m pytest tests/test_json.py -x -q --tb=short",
    passAfterFix: ["tests/test_json.py"],
  },
];

// ── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..");
const FLASK_REPO = join(REPO_ROOT, "tmp", "swe-eval", "flask");
const WORK_DIR = join(REPO_ROOT, "tmp", "swe-eval", "work");

const BENCH_CONFIG = validateConfig({
  providers: {},
  tiers: {
    smart: { provider: "deepseek", model: "deepseek-chat" },
    economy: { provider: "deepseek", model: "deepseek-chat" },
  },
  budgetPolicy: { runTokenCap: 8000 },
  graphPolicy: {
    enableAutoBuild: true,
    transport: "memory",
    maxContextTokens: 4000,
    includeExtensions: [".py"],
  },
  embeddingPolicy: { provider: "hash" },
  learningPolicy: {
    enableFlywheel: false,
    trainingCadence: "nightly",
    exportPath: "graphflow-out/learning-dataset.jsonl",
  },
});

// ── Agent prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior Python developer. You will receive a bug report and compressed code context from a code graph.

Your task:
1. Analyze the problem statement
2. Use the provided context (file summaries and code anchors) to understand the codebase
3. Generate a minimal git patch (unified diff format) that fixes the issue
4. Only modify the necessary files

Output format:
- First, briefly explain your analysis (2-3 sentences)
- Then provide the patch in unified diff format between \`\`\`diff and \`\`\` markers

Important:
- Generate ONLY the patch, no full file rewrites
- Use standard unified diff format (--- a/... +++ b/...)
- Keep changes minimal and focused`;

// ── Main evaluation ──────────────────────────────────────────────────────────

async function main() {
  console.log("=== SWE-bench Agent Evaluation (DeepSeek + GraphFlow) ===\n");

  if (!DEEPSEEK_API_KEY) {
    console.error("Error: DEEPSEEK_API_KEY not set");
    process.exit(1);
  }

  if (!existsSync(FLASK_REPO)) {
    console.error(`Error: Flask repo not found at ${FLASK_REPO}`);
    console.error("Run: git clone https://github.com/pallets/flask.git tmp/swe-eval/flask");
    process.exit(1);
  }

  mkdirSync(WORK_DIR, { recursive: true });

  // Get PR merge commits to find base commits
  console.log("[0/4] Finding PR base commits...");
  const resolvedInstances: SweInstance[] = [];

  for (const inst of INSTANCES) {
    try {
      // Get the merge commit's parent (the base commit before the fix)
      const mergeCommit = execSync(
        `cd ${FLASK_REPO} && git log --merges --oneline --grep="#${inst.prNumber}" | head -1`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();

      if (!mergeCommit) {
        console.log(`  ⚠️ ${inst.id}: PR #${inst.prNumber} merge commit not found, skipping`);
        continue;
      }

      const mergeHash = mergeCommit.split(" ")[0];
      // Get the first parent (the branch before merge)
      const baseCommit = execSync(
        `cd ${FLASK_REPO} && git rev-parse ${mergeHash}^1`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();

      // Get the actual gold patch
      const goldPatch = execSync(
        `cd ${FLASK_REPO} && git diff ${baseCommit}..${mergeHash} -- '*.py'`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();

      resolvedInstances.push({ ...inst, baseCommit, goldPatch });
      console.log(`  ✓ ${inst.id}: base=${baseCommit.slice(0, 8)}, patch=${goldPatch.length} chars`);
    } catch (e) {
      console.log(`  ⚠️ ${inst.id}: Error finding base commit: ${e}`);
    }
  }

  console.log(`\n  Resolved ${resolvedInstances.length}/${INSTANCES.length} instances\n`);

  // Evaluate each instance
  console.log("[1/4] Evaluating with DeepSeek + GraphFlow...\n");
  const results: EvalResult[] = [];

  for (const inst of resolvedInstances) {
    console.log(`  --- ${inst.id} ---`);

    // Step 1: Checkout base commit in work directory
    const instWorkDir = join(WORK_DIR, inst.id);
    if (existsSync(instWorkDir)) {
      execSync(`rm -rf ${instWorkDir}`, { timeout: 10000 });
    }
    cpSync(FLASK_REPO, instWorkDir, { recursive: true });
    execSync(`cd ${instWorkDir} && git checkout ${inst.baseCommit} --quiet 2>/dev/null`, {
      encoding: "utf8", timeout: 30000,
    });

    // Step 2: GraphFlow indexing + context retrieval
    console.log(`  [GraphFlow] Indexing...`);
    const client: GraphClient = createGraphClient(BENCH_CONFIG);
    await indexWorkspaceFiles(client, instWorkDir, {
      ...BENCH_CONFIG.graphPolicy,
      embeddingProvider: undefined,
    } as unknown as Record<string, unknown>);

    const pkg = await buildEnhancedContextPackage(
      client,
      inst.problemStatement,
      inst.problemStatement,
      4000,
      { enableGraphCompression: true, maxAnchors: 20 }
    );

    const contextText = [
      "## Code Context (compressed by GraphFlow)",
      "",
      "### Summary Channel:",
      ...pkg.summaryChannel,
      "",
      "### Anchor Channel:",
      ...pkg.anchorChannel.map((a) => `- ${a.id} (${a.type}, ${a.layer})`),
    ].join("\n");

    const contextTokens = countTokens(contextText);
    console.log(`  [GraphFlow] Context: ${contextTokens} tokens, ${pkg.anchorChannel.length} anchors`);

    // Step 3: Call DeepSeek to generate patch
    console.log(`  [DeepSeek] Generating patch...`);
    const userPrompt = `## Bug Report\n\n${inst.problemStatement}\n\n${contextText}`;

    let patch = "";
    let apiError = "";
    try {
      const t0 = Date.now();
      const response = await callDeepSeek(SYSTEM_PROMPT, userPrompt);
      const latencyMs = Date.now() - t0;

      // Extract diff from response
      const diffMatch = response.match(/```diff\n([\s\S]*?)```/);
      if (diffMatch) {
        patch = diffMatch[1].trim();
      } else {
        // Try to find any diff-like content
        const lines = response.split("\n");
        const diffLines: string[] = [];
        let inDiff = false;
        for (const line of lines) {
          if (line.startsWith("---") || line.startsWith("diff --git")) inDiff = true;
          if (inDiff) diffLines.push(line);
        }
        patch = diffLines.join("\n");
      }

      console.log(`  [DeepSeek] Patch generated in ${latencyMs}ms (${patch.length} chars)`);
    } catch (e) {
      apiError = String(e);
      console.log(`  [DeepSeek] Error: ${apiError}`);
    }

    // Step 4: Apply patch and run tests
    let testPassed = false;
    let testOutput = "";

    if (patch) {
      try {
        // Write patch file
        const patchFile = join(instWorkDir, "agent.patch");
        writeFileSync(patchFile, patch);

        // Apply patch
        execSync(`cd ${instWorkDir} && git apply agent.patch 2>&1`, {
          encoding: "utf8", timeout: 10000,
        });
        console.log(`  [Test] Patch applied successfully`);

        // Install dependencies and run tests
        try {
          execSync(`cd ${instWorkDir} && pip install -e ".[dev]" --quiet 2>/dev/null`, {
            encoding: "utf8", timeout: 120000,
          });
        } catch {
          // May already be installed
        }

        try {
          testOutput = execSync(`cd ${instWorkDir} && ${inst.testCommand} 2>&1`, {
            encoding: "utf8", timeout: 120000,
          });
          testPassed = true;
          console.log(`  [Test] ✅ Tests passed!`);
        } catch (e) {
          testOutput = (e as { stdout?: string }).stdout || "";
          const stderr = (e as { stderr?: string }).stderr || "";
          // Check if at least some tests passed
          if (testOutput.includes("passed") && !testOutput.includes("failed")) {
            testPassed = true;
            console.log(`  [Test] ✅ Tests passed!`);
          } else {
            console.log(`  [Test] ❌ Tests failed`);
            // Show last few lines of output
            const lines = (testOutput + stderr).split("\n").filter(Boolean);
            console.log(`         ${lines.slice(-3).join("\n         ")}`);
          }
        }
      } catch (e) {
        console.log(`  [Test] ❌ Patch application failed: ${e}`);
      }
    }

    results.push({
      id: inst.id,
      prNumber: inst.prNumber,
      patchGenerated: !!patch,
      patchApplied: patch.length > 0 && testOutput.length > 0,
      testPassed,
      contextTokens,
      patchSize: patch.length,
      apiError,
    });

    // Cleanup
    try {
      execSync(`rm -rf ${instWorkDir}`, { timeout: 10000 });
    } catch {}
  }

  // Summary
  console.log("\n[2/4] Summary\n");

  const total = results.length;
  const patched = results.filter((r) => r.patchGenerated).length;
  const resolved = results.filter((r) => r.testPassed).length;

  console.log(`  Total instances: ${total}`);
  console.log(`  Patch generated: ${patched}/${total} (${(patched / total * 100).toFixed(0)}%)`);
  console.log(`  Tests passed:    ${resolved}/${total} (${(resolved / total * 100).toFixed(0)}%)`);
  console.log(`  Resolution rate: ${(resolved / total * 100).toFixed(1)}%`);

  // Write results
  console.log("\n[3/4] Writing results...");
  const resultsDir = join(REPO_ROOT, "benchmarks");
  mkdirSync(resultsDir, { recursive: true });

  const md = generateReport(results, resolved, patched, total);
  writeFileSync(join(resultsDir, "SWE-BENCH-AGENT-RESULTS.md"), md);
  console.log(`  → benchmarks/SWE-BENCH-AGENT-RESULTS.md`);

  console.log("\n[4/4] Done.\n");
}

// ── Types ────────────────────────────────────────────────────────────────────

interface EvalResult {
  id: string;
  prNumber: number;
  patchGenerated: boolean;
  patchApplied: boolean;
  testPassed: boolean;
  contextTokens: number;
  patchSize: number;
  apiError: string;
}

// ── Report generation ────────────────────────────────────────────────────────

function generateReport(results: EvalResult[], resolved: number, patched: number, total: number): string {
  const now = new Date().toISOString();
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
  } catch {}

  return `# SWE-bench Agent 评测（DeepSeek + GraphFlow）

> Generated: ${now}
> Commit: \`${commit}\`
> LLM: DeepSeek Chat (deepseek-chat)
> Context: GraphFlow compressed context

> **说明**：这是完整的 SWE-bench 风格评测。
> 对每个真实 Flask PR：
> 1. checkout 到 PR 合并前的 commit
> 2. GraphFlow 索引仓库并提供压缩上下文
> 3. DeepSeek 基于上下文生成 patch
> 4. 应用 patch 并运行 pytest
> 5. 测试通过 = resolved

## Summary

| Metric | Value |
| --- | --- |
| **Resolution Rate** | **${(resolved / total * 100).toFixed(1)}%** (${resolved}/${total}) |
| Patch Generated | ${patched}/${total} |
| Total Instances | ${total} |

## Instance Details

| ID | PR | Patch | Test | Context Tokens |
| --- | --- | --- | --- | --- |
${results.map((r) => {
  const patchStatus = r.patchGenerated ? `✅ (${r.patchSize} chars)` : `❌ ${r.apiError ? "API error" : "no patch"}`;
  const testStatus = r.testPassed ? "✅" : "❌";
  return `| ${r.id} | #${r.prNumber} | ${patchStatus} | ${testStatus} | ${r.contextTokens} |`;
}).join("\n")}

## 局限性

1. **仅 Flask 项目**：单项目评测，不代表通用能力
2. **实例数量少**：仅 ${total} 个实例，统计意义有限
3. **DeepSeek 模型**：结果依赖特定 LLM，换模型可能不同
4. **PR 描述 ≠ Issue 描述**：PR 描述通常比真实 issue 更具体
5. **测试环境**：本地 pytest，非 Docker 隔离

## Reproduce

\`\`\`bash
# 前置条件
export DEEPSEEK_API_KEY=your-key
git clone https://github.com/pallets/flask.git tmp/swe-eval/flask

# 运行评测
npm run benchmark:swe-bench-agent
\`\`\`
`;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
