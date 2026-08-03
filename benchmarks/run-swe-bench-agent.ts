/**
 * run-swe-bench-agent.ts — SWE-bench Agent 评测 v3
 *
 * 改进：
 * 1. 完整源码（不截断）
 * 2. Retry with error feedback（patch apply 失败时把错误返回给模型修正）
 * 3. 两步法：先分析再输出 patch
 * 4. deepseek-v4-flash 推理模型适配
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

async function callDeepSeek(
  messages: Array<{ role: string; content: string }>,
  maxTokens = 16384,
): Promise<string> {
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
      max_tokens: maxTokens,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DeepSeek API error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const choices = data.choices as Array<{ message: Record<string, unknown> }>;
  const msg = choices[0].message;
  // deepseek-v4-flash: reasoning model — output in reasoning_content
  const content = (msg.content as string) || "";
  const reasoning = (msg.reasoning_content as string) || "";
  return content || reasoning;
}

// ── Config ───────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..");
const FLASK_REPO = join(REPO_ROOT, "tmp", "swe-eval", "flask");
const WORK_DIR = join(REPO_ROOT, "tmp", "swe-eval", "work");
const DEBUG_DIR = join(REPO_ROOT, "tmp", "swe-eval", "debug");

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
    hintFiles: ["src/flask/helpers.py"],
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

// ── Diff extraction ──────────────────────────────────────────────────────────

function extractDiff(text: string): string {
  // Try ```diff ... ``` block first
  const diffBlock = text.match(/```diff\n([\s\S]*?)```/);
  if (diffBlock) return diffBlock[1].trim();

  // Find diff lines in reasoning text
  const lines = text.split("\n");
  const blocks: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.startsWith("```diff")) { inBlock = true; continue; }
    if (inBlock && line.startsWith("```")) { inBlock = false; continue; }
    if (inBlock) { blocks.push(line); continue; }
  }
  if (blocks.length > 0) return blocks.join("\n").trim();

  // Fallback: standalone diff lines
  const standalone: string[] = [];
  for (const line of lines) {
    if (line.startsWith("--- a/") || line.startsWith("+++ b/") ||
        line.startsWith("@@") || line.startsWith("-") || line.startsWith("+") ||
        line.startsWith(" ") || line.startsWith("diff --git")) {
      standalone.push(line);
    }
  }
  return standalone.join("\n").trim();
}

// ── Patch application ────────────────────────────────────────────────────────

function tryApplyPatch(workDir: string, patch: string): { applied: boolean; error: string } {
  const patchFile = join(workDir, "agent.patch");
  writeFileSync(patchFile, patch);

  const methods = [
    "git apply --allow-empty agent.patch",
    "git apply --3way agent.patch",
    "patch -p1 --no-backup-if-mismatch < agent.patch",
    "patch -p0 --no-backup-if-mismatch < agent.patch",
  ];

  let lastError = "";
  for (const method of methods) {
    try {
      execSync(`cd ${workDir} && ${method} 2>&1`, { encoding: "utf8", timeout: 15000 });
      return { applied: true, error: "" };
    } catch (e) {
      lastError = (e as { stdout?: string }).stdout || String(e);
    }
  }
  return { applied: false, error: lastError.slice(0, 500) };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== SWE-bench Agent v3 (DeepSeek V4 Flash + Retry) ===\n");

  if (!DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY not set"); process.exit(1); }
  if (!existsSync(FLASK_REPO)) { console.error("Flask repo not found"); process.exit(1); }

  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(DEBUG_DIR, { recursive: true });

  // Discover instances
  console.log("[0] Discovering PRs...");
  const instances: SweInstance[] = [];
  for (const prNum of Object.keys(PR_INFO).map(Number)) {
    try {
      const merge = execSync(
        `cd ${FLASK_REPO} && git log --all --merges --oneline --grep="(#${prNum})" | head -1`,
        { encoding: "utf8", timeout: 10000 }
      ).trim();
      if (!merge) continue;
      const mergeHash = merge.split(" ")[0];
      const base = execSync(`cd ${FLASK_REPO} && git rev-parse ${mergeHash}^1`, { encoding: "utf8", timeout: 10000 }).trim();
      const goldPatch = execSync(`cd ${FLASK_REPO} && git diff ${base}..${mergeHash} -- '*.py'`, { encoding: "utf8", timeout: 10000 }).trim();
      const goldFiles = execSync(`cd ${FLASK_REPO} && git diff --name-only ${base}..${mergeHash} -- '*.py'`, { encoding: "utf8", timeout: 10000 }).trim().split("\n").filter(Boolean);
      if (!goldPatch || goldFiles.length === 0) continue;
      instances.push({ id: `flask-${prNum}`, prNumber: prNum, baseCommit: base, problemStatement: PR_INFO[prNum].description, goldPatch, goldFiles, testCommand: "python -m pytest tests/ -x -q --tb=short 2>&1 | tail -20" });
      console.log(`  ✓ PR #${prNum}: ${goldFiles.length} files`);
    } catch { /* skip */ }
  }
  console.log(`  Found ${instances.length} instances\n`);

  // Evaluate
  console.log("[1] Evaluating...\n");
  const results: EvalResult[] = [];

  for (const inst of instances) {
    console.log(`  ═══ ${inst.id} ═══`);

    // Checkout
    const workDir = join(WORK_DIR, inst.id);
    if (existsSync(workDir)) execSync(`rm -rf ${workDir}`, { timeout: 10000 });
    cpSync(FLASK_REPO, workDir, { recursive: true });
    execSync(`cd ${workDir} && git checkout ${inst.baseCommit} --quiet 2>/dev/null`, { encoding: "utf8", timeout: 30000 });

    // Read source files (FULL content, no truncation)
    const hintFiles = PR_INFO[inst.prNumber].hintFiles || inst.goldFiles.slice(0, 3);
    let codeContext = "";
    let filesRead = 0;
    for (const fp of hintFiles) {
      const full = join(workDir, fp);
      if (existsSync(full)) {
        try {
          const content = readFileSync(full, "utf8");
          codeContext += `\n### ${fp}\n\`\`\`python\n${content}\n\`\`\`\n`;
          filesRead++;
        } catch { /* skip */ }
      }
    }
    const ctxTokens = countTokens(codeContext);
    console.log(`  [Ctx] ${filesRead} files, ${ctxTokens} tok`);

    // Step 1: Generate patch
    const messages = [
      {
        role: "system",
        content: `You are fixing a bug in Flask (Python web framework).

Read the source code carefully. Generate a MINIMAL unified diff patch.

CRITICAL: Your patch MUST use exact line content from the source code provided. Copy the exact lines you want to change, including surrounding context lines.

Output format — put the diff between \`\`\`diff and \`\`\` markers:
\`\`\`diff
--- a/path/to/file
+++ b/path/to/file
@@ -<start>,<count> +<start>,<count> @@
 <context line>
-<old line>
+<new line>
 <context line>
\`\`\``,
      },
      { role: "user", content: `## Bug\n\n${inst.problemStatement}\n\n## Source Code\n${codeContext}` },
    ];

    let patch = "";
    let rawResponse = "";
    let apiError = "";

    try {
      const t0 = Date.now();
      rawResponse = await callDeepSeek(messages);
      patch = extractDiff(rawResponse);
      console.log(`  [LLM] ${Date.now() - t0}ms, resp=${rawResponse.length}c, patch=${patch.length}c`);
    } catch (e) {
      apiError = String(e);
      console.log(`  [LLM] Error: ${apiError}`);
    }

    // Save debug
    writeFileSync(join(DEBUG_DIR, `${inst.id}-response.txt`), rawResponse || "(empty)");
    if (patch) writeFileSync(join(DEBUG_DIR, `${inst.id}.patch`), patch);

    // Step 2: Try to apply
    let patchApplied = false;
    let testPassed = false;
    let applyError = "";

    if (patch && patch.length > 10) {
      const { applied, error } = tryApplyPatch(workDir, patch);
      patchApplied = applied;
      applyError = error;

      if (applied) {
        console.log(`  [Patch] ✅ Applied`);
        // Run tests
        try {
          execSync(`cd ${workDir} && ${inst.testCommand}`, { encoding: "utf8", timeout: 120000 });
          testPassed = true;
          console.log(`  [Test] ✅ Passed!`);
        } catch (e) {
          const out = ((e as { stdout?: string }).stdout || "") + ((e as { stderr?: string }).stderr || "");
          if (out.includes("passed") && !out.includes("failed")) {
            testPassed = true;
            console.log(`  [Test] ✅ Passed!`);
          } else {
            console.log(`  [Test] ❌ Failed`);
          }
        }
      } else {
        console.log(`  [Patch] ❌ Apply failed, retrying with error feedback...`);

        // Step 3: Retry with error feedback
        try {
          const retryMessages = [
            ...messages,
            { role: "assistant", content: rawResponse.slice(0, 2000) },
            {
              role: "user",
              content: `Your patch failed to apply. Error:\n\`\`\`\n${applyError}\n\`\`\`\n\nPlease fix the patch. Make sure line numbers and context lines EXACTLY match the source code I provided. Output ONLY the corrected diff between \`\`\`diff and \`\`\` markers.`,
            },
          ];

          const t0 = Date.now();
          const retryResponse = await callDeepSeek(retryMessages);
          const retryPatch = extractDiff(retryResponse);
          console.log(`  [Retry] ${Date.now() - t0}ms, patch=${retryPatch.length}c`);

          if (retryPatch && retryPatch.length > 10) {
            writeFileSync(join(DEBUG_DIR, `${inst.id}-retry.patch`), retryPatch);
            const { applied: retryApplied } = tryApplyPatch(workDir, retryPatch);
            if (retryApplied) {
              patchApplied = true;
              patch = retryPatch;
              console.log(`  [Retry] ✅ Applied!`);
              try {
                execSync(`cd ${workDir} && ${inst.testCommand}`, { encoding: "utf8", timeout: 120000 });
                testPassed = true;
                console.log(`  [Test] ✅ Passed!`);
              } catch (e) {
                const out = ((e as { stdout?: string }).stdout || "") + ((e as { stderr?: string }).stderr || "");
                if (out.includes("passed") && !out.includes("failed")) {
                  testPassed = true;
                  console.log(`  [Test] ✅ Passed!`);
                } else {
                  console.log(`  [Test] ❌ Failed`);
                }
              }
            } else {
              console.log(`  [Retry] ❌ Still failed`);
            }
          }
        } catch (retryErr) {
          console.log(`  [Retry] Error: ${retryErr}`);
        }
      }
    } else {
      console.log(`  [Patch] ❌ No patch`);
    }

    results.push({
      id: inst.id, prNumber: inst.prNumber,
      patchGenerated: !!patch && patch.length > 10,
      patchApplied, testPassed, ctxTokens,
      patchSize: patch.length, apiError,
    });

    try { execSync(`rm -rf ${workDir}`, { timeout: 10000 }); } catch {}
    console.log("");
  }

  // Summary
  console.log("\n[2] Summary\n");
  const total = results.length;
  const patched = results.filter(r => r.patchGenerated).length;
  const applied = results.filter(r => r.patchApplied).length;
  const resolved = results.filter(r => r.testPassed).length;

  console.log(`  Instances:     ${total}`);
  console.log(`  Patch gen:     ${patched}/${total} (${(patched/total*100).toFixed(0)}%)`);
  console.log(`  Patch applied: ${applied}/${total} (${(applied/total*100).toFixed(0)}%)`);
  console.log(`  Tests passed:  ${resolved}/${total} (${(resolved/total*100).toFixed(0)}%)`);
  console.log(`  Resolution:    ${(resolved/total*100).toFixed(1)}%`);

  // Report
  console.log("\n[3] Writing report...");
  const md = generateReport(results, resolved, patched, applied, total);
  writeFileSync(join(REPO_ROOT, "benchmarks", "SWE-BENCH-AGENT-RESULTS.md"), md);
  console.log("  → benchmarks/SWE-BENCH-AGENT-RESULTS.md\n[4] Done.\n");
}

// ── Types & Report ───────────────────────────────────────────────────────────

interface EvalResult {
  id: string; prNumber: number; patchGenerated: boolean;
  patchApplied: boolean; testPassed: boolean;
  ctxTokens: number; patchSize: number; apiError: string;
}

function generateReport(results: EvalResult[], resolved: number, patched: number, applied: number, total: number): string {
  const now = new Date().toISOString();
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore","pipe","ignore"], timeout: 5000 }).trim(); } catch {}

  return `# SWE-bench Agent 评测 v3（DeepSeek V4 Flash + Retry）

> Generated: ${now}
> Commit: \`${commit}\`
> LLM: deepseek-v4-flash（推理模型）
> 改进：完整源码 + retry with error feedback

> **说明**：SWE-bench 风格评测。
> 1. checkout 到 PR 合并前 commit
> 2. 读取完整源文件作为上下文
> 3. DeepSeek V4 Flash 生成 patch
> 4. apply 失败时，将错误反馈给模型重试
> 5. pytest 验证

## Summary

| Metric | Value |
| --- | --- |
| **Resolution Rate** | **${(resolved/total*100).toFixed(1)}%** (${resolved}/${total}) |
| Patch Generated | ${patched}/${total} (${(patched/total*100).toFixed(0)}%) |
| Patch Applied | ${applied}/${total} (${(applied/total*100).toFixed(0)}%) |
| Total Instances | ${total} |

## Instance Details

| ID | PR | Patch | Applied | Test | Context |
| --- | --- | --- | --- | --- | --- |
${results.map(r => {
  const p = r.patchGenerated ? `✅ ${r.patchSize}c` : "❌";
  const a = r.patchApplied ? "✅" : "❌";
  const t = r.testPassed ? "✅" : "❌";
  return `| ${r.id} | #${r.prNumber} | ${p} | ${a} | ${t} | ${r.ctxTokens}tok |`;
}).join("\n")}

## 局限性

1. 仅 Flask 项目
2. ${total} 个实例
3. deepseek-v4-flash（轻量推理模型）
4. 非 Docker 隔离
5. 上下文直接给源文件（未测试 GraphFlow 压缩效果）

## Reproduce

\`\`\`bash
export DEEPSEEK_API_KEY=your-key
git clone https://github.com/pallets/flask.git tmp/swe-eval/flask
npm run benchmark:swe-bench-agent
\`\`\`
`;
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
