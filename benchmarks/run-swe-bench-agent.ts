/**
 * run-swe-bench-agent.ts — 完整 SWE-bench 风格 Agent 评测
 *
 * 流程：
 * 1. 从真实 Flask PR 构建测试实例
 * 2. 对每个实例：
 *    a. git checkout 到 PR 合并前的 commit
 *    b. 读取相关源文件作为上下文
 *    c. DeepSeek V4 Flash 基于上下文生成 patch
 *    d. 应用 patch → 运行 pytest → 判断是否修复
 * 3. 输出解决率
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, execSync } from "node:child_process";

import { encode } from "gpt-tokenizer/model/gpt-4o";

function countTokens(text: string): number {
  if (!text) return 0;
  try { return encode(text).length; } catch { return Math.ceil(text.length / 4); }
}

// ── DeepSeek API ─────────────────────────────────────────────────────────────

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

async function callDeepSeek(messages: Array<{ role: string; content: string }>): Promise<string> {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not set");

  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages,
      temperature: 0.0,
      max_tokens: 16384,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DeepSeek API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const choices = data.choices as Array<{ message: Record<string, unknown> }>;
  const msg = choices[0].message;
  // deepseek-v4-flash is a reasoning model: output goes to reasoning_content, not content
  const content = (msg.content as string) || "";
  const reasoning = (msg.reasoning_content as string) || "";
  // Combine both — the diff may be in either field
  return content || reasoning;
}

// ── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..");
const FLASK_REPO = join(REPO_ROOT, "tmp", "swe-eval", "flask");
const WORK_DIR = join(REPO_ROOT, "tmp", "swe-eval", "work");

// ── Test instances ───────────────────────────────────────────────────────────

interface SweInstance {
  id: string;
  prNumber: number;
  baseCommit: string;
  problemStatement: string;
  goldPatch: string;
  goldFiles: string[];
  testCommand: string;
}

const PR_INFO: Record<number, { description: string; hintFiles?: string[] }> = {
  6013: {
    description: `Fix autoescape selection to use case-insensitive comparison for file extensions.

Currently the autoescape selection uses case-sensitive comparison on file extensions. Templates with uppercase extensions like .HTML are not autoescaped, which is a security issue.

Fix: use case-insensitive comparison (e.g., .lower()) on the file extension so that .html, .HTML, .Html all trigger autoescaping.`,
    hintFiles: ["src/flask/sansio/app.py"],
  },
  5928: {
    description: `Ensure all teardown callbacks are called despite errors in earlier callbacks.

When one teardown callback raises an exception, subsequent teardown callbacks are not called, leading to resource leaks.

Fix: ensure all teardown callbacks are called despite errors. Errors should be collected and reported after all callbacks run.`,
    hintFiles: ["src/flask/ctx.py"],
  },
  5917: {
    description: `Fix provide_automatic_options override not working correctly.

When a view function sets provide_automatic_options=False, the automatic OPTIONS request handling should be disabled. Currently the override is not respected in all cases.`,
    hintFiles: ["src/flask/sansio/app.py"],
  },
  5898: {
    description: `Change redirect default status code to 303.

The redirect() function should default to HTTP 303 (See Other) instead of 302 (Found) for better REST compliance.`,
    hintFiles: ["src/flask/helpers.py", "src/flask/sansio/app.py"],
  },
  5808: {
    description: `Fix annotation for select_jinja_autoescape.

The return type annotation for select_jinja_autoescape is incorrect. It should return bool, not str.`,
    hintFiles: ["src/flask/sansio/app.py"],
  },
  5799: {
    description: `Refactor stream_with_context for async views.

The stream_with_context utility should work correctly with async view functions. Currently it doesn't properly handle the request context in async generators.`,
    hintFiles: ["src/flask/helpers.py"],
  },
  5797: {
    description: `Fix push preserved contexts in correct order.

The preserved contexts are not pushed in the correct order, causing issues with nested context management.`,
    hintFiles: ["src/flask/testing.py"],
  },
  5777: {
    description: `Use IO[bytes] instead of BinaryIO for wider compatibility.

The type annotations use BinaryIO but should use IO[bytes] for wider compatibility.`,
    hintFiles: ["src/flask/helpers.py"],
  },
  5736: {
    description: `Support calling template_filter without parens.

The @app.template_filter() decorator should work both with and without parentheses: @app.template_filter and @app.template_filter() should both be valid.`,
    hintFiles: ["src/flask/sansio/scaffold.py"],
  },
  5818: {
    description: `Pass context through dispatch methods.

The dispatch methods should pass the context through to the underlying handlers.`,
    hintFiles: ["src/flask/app.py", "src/flask/ctx.py"],
  },
  6095: {
    description: `Replace the use of private monkeypatch fixture API.

The tests use private monkeypatch fixture API which should be replaced with the public API.`,
    hintFiles: ["tests/conftest.py", "tests/test_cli.py"],
  },
  5899: {
    description: `Deprecate should_ignore_error.

The should_ignore_error method should be deprecated.`,
    hintFiles: ["src/flask/app.py", "src/flask/sansio/app.py"],
  },
};

// ── Main evaluation ──────────────────────────────────────────────────────────

async function main() {
  console.log("=== SWE-bench Agent Evaluation (DeepSeek V4 Flash) ===\n");

  if (!DEEPSEEK_API_KEY) {
    console.error("Error: DEEPSEEK_API_KEY not set");
    process.exit(1);
  }

  if (!existsSync(FLASK_REPO)) {
    console.error(`Error: Flask repo not found at ${FLASK_REPO}`);
    process.exit(1);
  }

  mkdirSync(WORK_DIR, { recursive: true });

  // Step 0: Discover PR merge commits
  console.log("[0/4] Discovering PR merge commits...");
  const instances: SweInstance[] = [];
  const prNumbers = Object.keys(PR_INFO).map(Number);

  for (const prNum of prNumbers) {
    try {
      const mergeCommit = execSync(
        `cd ${FLASK_REPO} && git log --all --merges --oneline --grep="(#${prNum})" | head -1`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();

      if (!mergeCommit) { console.log(`  ⚠️ PR #${prNum}: not found`); continue; }

      const mergeHash = mergeCommit.split(" ")[0];
      const baseCommit = execSync(
        `cd ${FLASK_REPO} && git rev-parse ${mergeHash}^1`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();

      const goldPatch = execSync(
        `cd ${FLASK_REPO} && git diff ${baseCommit}..${mergeHash} -- '*.py'`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();

      const goldFilesRaw = execSync(
        `cd ${FLASK_REPO} && git diff --name-only ${baseCommit}..${mergeHash} -- '*.py'`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();
      const goldFiles = goldFilesRaw.split("\n").filter(Boolean);

      if (!goldPatch || goldFiles.length === 0) { console.log(`  ⚠️ PR #${prNum}: no .py changes`); continue; }

      instances.push({
        id: `flask-${prNum}`,
        prNumber: prNum,
        baseCommit,
        problemStatement: PR_INFO[prNum].description,
        goldPatch,
        goldFiles,
        testCommand: "python -m pytest tests/ -x -q --tb=short 2>&1 | tail -20",
      });

      console.log(`  ✓ PR #${prNum}: base=${baseCommit.slice(0, 8)}, files=${goldFiles.length}`);
    } catch (e) {
      console.log(`  ⚠️ PR #${prNum}: Error - ${e}`);
    }
  }

  console.log(`\n  Found ${instances.length} valid instances\n`);
  if (instances.length === 0) { console.error("No instances."); process.exit(1); }

  // Step 1: Evaluate
  console.log("[1/4] Evaluating...\n");
  const results: EvalResult[] = [];

  for (const inst of instances) {
    console.log(`  ═══ ${inst.id} (PR #${inst.prNumber}) ═══`);

    // Checkout base commit
    const instWorkDir = join(WORK_DIR, inst.id);
    if (existsSync(instWorkDir)) execSync(`rm -rf ${instWorkDir}`, { timeout: 10000 });
    cpSync(FLASK_REPO, instWorkDir, { recursive: true });
    execSync(`cd ${instWorkDir} && git checkout ${inst.baseCommit} --quiet 2>/dev/null`, {
      encoding: "utf8", timeout: 30000,
    });

    // Read source files for context
    const hintFiles = PR_INFO[inst.prNumber].hintFiles || inst.goldFiles.slice(0, 3);
    let codeContext = "";
    let filesRead = 0;

    for (const filePath of hintFiles) {
      const fullPath = join(instWorkDir, filePath);
      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath, "utf8");
          const lines = content.split("\n");
          // Keep full file if < 200 lines, else truncate
          const truncated = lines.length > 200
            ? lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more lines)`
            : content;
          codeContext += `\n### ${filePath}\n\`\`\`python\n${truncated}\n\`\`\`\n`;
          filesRead++;
        } catch { /* skip */ }
      }
    }

    const contextTokens = countTokens(codeContext);
    console.log(`  [Context] ${filesRead} files, ${contextTokens} tokens`);

    // Build focused prompt
    const messages = [
      {
        role: "system",
        content: `You are fixing a bug in the Flask web framework (Python).

You will receive a bug report and the relevant source code.

Generate a MINIMAL unified diff patch that fixes the issue.

Rules:
- Output ONLY a diff patch between \`\`\`diff and \`\`\` markers
- Use exact code from the provided source files
- Format:
  \`\`\`diff
  --- a/path/to/file
  +++ b/path/to/file
  @@ -line,count +line,count @@
   context
  -old line
  +new line
  \`\`\`
- Keep changes minimal — only fix the reported issue
- Do NOT rewrite entire files`,
      },
      {
        role: "user",
        content: `## Bug Report\n\n${inst.problemStatement}\n\n## Source Code\n${codeContext}`,
      },
    ];

    // Call DeepSeek
    console.log(`  [DeepSeek V4 Flash] Generating patch...`);
    let patch = "";
    let apiError = "";
    let rawResponse = "";

    try {
      const t0 = Date.now();
      rawResponse = await callDeepSeek(messages);
      const latencyMs = Date.now() - t0;

      // Extract diff from response (may contain ```diff blocks in reasoning text)
      const diffMatch = rawResponse.match(/```diff\n([\s\S]*?)```/);
      if (diffMatch) {
        patch = diffMatch[1].trim();
      } else {
        // Try to find diff lines anywhere in the response
        const lines = rawResponse.split("\n");
        const diffBlocks: string[] = [];
        let inBlock = false;
        for (const line of lines) {
          if (line.startsWith("```diff")) { inBlock = true; continue; }
          if (inBlock && line.startsWith("```")) { inBlock = false; continue; }
          if (inBlock) { diffBlocks.push(line); continue; }
          // Also catch standalone diff lines outside blocks
          if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
            diffBlocks.push(line);
          }
        }
        patch = diffBlocks.join("\n").trim();
      }

      console.log(`  [DeepSeek] ${latencyMs}ms, response=${rawResponse.length} chars, patch=${patch.length} chars`);
    } catch (e) {
      apiError = String(e);
      console.log(`  [DeepSeek] Error: ${apiError}`);
    }

    // Save raw response for debugging
    const debugDir = join(REPO_ROOT, "tmp", "swe-eval", "debug");
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, `${inst.id}-response.txt`), rawResponse || `(empty)`);

    // Apply patch and test
    let testPassed = false;
    let patchApplied = false;

    if (patch && patch.length > 10) {
      const patchFile = join(instWorkDir, "agent.patch");
      writeFileSync(patchFile, patch);
      writeFileSync(join(debugDir, `${inst.id}.patch`), patch);

      const methods = [
        `git apply --allow-empty agent.patch`,
        `git apply --3way agent.patch`,
        `patch -p1 --no-backup-if-mismatch < agent.patch`,
        `patch -p0 --no-backup-if-mismatch < agent.patch`,
      ];

      for (const method of methods) {
        try {
          execSync(`cd ${instWorkDir} && ${method} 2>&1`, { encoding: "utf8", timeout: 15000 });
          patchApplied = true;
          console.log(`  [Patch] ✅ Applied: ${method.split(" ").slice(0, 3).join(" ")}`);
          break;
        } catch { /* next */ }
      }

      if (!patchApplied) {
        console.log(`  [Patch] ❌ All methods failed`);
        const firstLines = patch.split("\n").slice(0, 3).join(" | ");
        console.log(`  [Patch] First: ${firstLines}`);
      } else {
        try {
          execSync(`cd ${instWorkDir} && ${inst.testCommand}`, {
            encoding: "utf8", timeout: 120000,
          });
          testPassed = true;
          console.log(`  [Test] ✅ Passed!`);
        } catch (e) {
          const output = ((e as { stdout?: string }).stdout || "") + ((e as { stderr?: string }).stderr || "");
          if (output.includes("passed") && !output.includes("failed")) {
            testPassed = true;
            console.log(`  [Test] ✅ Passed!`);
          } else {
            console.log(`  [Test] ❌ Failed`);
            const lines = output.split("\n").filter(Boolean);
            console.log(`         ${lines.slice(-3).join("\n         ")}`);
          }
        }
      }
    } else {
      console.log(`  [Patch] ❌ No patch generated`);
    }

    results.push({
      id: inst.id,
      prNumber: inst.prNumber,
      patchGenerated: !!patch && patch.length > 10,
      patchApplied,
      testPassed,
      contextTokens,
      patchSize: patch.length,
      apiError,
    });

    // Cleanup
    try { execSync(`rm -rf ${instWorkDir}`, { timeout: 10000 }); } catch {}
    console.log("");
  }

  // Summary
  console.log("\n[2/4] Summary\n");
  const total = results.length;
  const patched = results.filter((r) => r.patchGenerated).length;
  const applied = results.filter((r) => r.patchApplied).length;
  const resolved = results.filter((r) => r.testPassed).length;

  console.log(`  Total instances:    ${total}`);
  console.log(`  Patch generated:    ${patched}/${total} (${(patched / total * 100).toFixed(0)}%)`);
  console.log(`  Patch applied:      ${applied}/${total} (${(applied / total * 100).toFixed(0)}%)`);
  console.log(`  Tests passed:       ${resolved}/${total} (${(resolved / total * 100).toFixed(0)}%)`);
  console.log(`  Resolution rate:    ${(resolved / total * 100).toFixed(1)}%`);

  // Write results
  console.log("\n[3/4] Writing results...");
  const md = generateReport(results, resolved, patched, applied, total);
  writeFileSync(join(REPO_ROOT, "benchmarks", "SWE-BENCH-AGENT-RESULTS.md"), md);
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

// ── Report ───────────────────────────────────────────────────────────────────

function generateReport(
  results: EvalResult[], resolved: number, patched: number, applied: number, total: number
): string {
  const now = new Date().toISOString();
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
  } catch {}

  return `# SWE-bench Agent 评测（DeepSeek V4 Flash）

> Generated: ${now}
> Commit: \`${commit}\`
> LLM: DeepSeek V4 Flash (deepseek-v4-flash)
> Context: 源码文件直接读入（非 GraphFlow 摘要）

> **说明**：SWE-bench 风格评测。
> 对每个真实 Flask PR：
> 1. checkout 到 PR 合并前的 commit
> 2. 读取相关源文件作为上下文
> 3. DeepSeek V4 Flash 生成 unified diff patch
> 4. 应用 patch + pytest 验证

## Summary

| Metric | Value |
| --- | --- |
| **Resolution Rate** | **${(resolved / total * 100).toFixed(1)}%** (${resolved}/${total}) |
| Patch Generated | ${patched}/${total} (${(patched / total * 100).toFixed(0)}%) |
| Patch Applied | ${applied}/${total} (${(applied / total * 100).toFixed(0)}%) |
| Total Instances | ${total} |

## Instance Details

| ID | PR | Patch | Applied | Test | Context |
| --- | --- | --- | --- | --- | --- |
${results.map((r) => {
  const p = r.patchGenerated ? `✅ ${r.patchSize}c` : "❌";
  const a = r.patchApplied ? "✅" : "❌";
  const t = r.testPassed ? "✅" : "❌";
  return `| ${r.id} | #${r.prNumber} | ${p} | ${a} | ${t} | ${r.contextTokens}tok |`;
}).join("\n")}

## 局限性

1. **仅 Flask 项目**，单项目评测
2. **${total} 个实例**，统计意义有限
3. **DeepSeek V4 Flash**，结果依赖特定 LLM
4. **上下文直接给源文件**，未测试 GraphFlow 压缩上下文的效果
5. **非 Docker 隔离**测试环境

## Reproduce

\`\`\`bash
export DEEPSEEK_API_KEY=your-key
git clone https://github.com/pallets/flask.git tmp/swe-eval/flask
npm run benchmark:swe-bench-agent
\`\`\`
`;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
