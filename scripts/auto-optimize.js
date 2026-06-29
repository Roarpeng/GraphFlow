#!/usr/bin/env node
/**
 * GraphFlow 自动优化脚本
 * 执行完整的分析-改进-提交流程
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TMP_DIR = path.join(PROJECT_ROOT, "tmp");

function run(cmd, options = {}) {
  console.log(`\n>> ${cmd}`);
  try {
    const result = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: options.silent ? "pipe" : "inherit",
      ...options,
    });
    return { success: true, output: result || "" };
  } catch (e) {
    return { success: false, output: e.stdout || "", stderr: e.stderr || "" };
  }
}

function getNowBeijing() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}

function formatBeijingTime(date) {
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}

function readFile(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}

// ==================== 主流程 ====================

async function main() {
  console.log("========================================");
  console.log("GraphFlow 自动优化任务启动");
  console.log("========================================");

  // 1. 时间检查（北京时间 >= 10:00 跳过）
  const now = getNowBeijing();
  const timeStr = formatBeijingTime(now);
  console.log(`\n当前北京时间：${timeStr}`);

  if (now.getHours() >= 10) {
    console.log("\n[跳过] 已超过10点，停止执行。");
    process.exit(0);
  }
  console.log("[通过] 在允许执行时段内。");

  // 2. 检查工作区状态（防止并发）
  const gitStatus = run("git status --porcelain", { silent: true }).output.trim();
  if (gitStatus) {
    console.log("\n[警告] 工作区存在未提交更改：");
    console.log(gitStatus);
    console.log("\n[跳过] 可能上一个任务仍在运行，本次取消。");
    process.exit(0);
  }
  console.log("[通过] 工作区干净。");

  // 3. 确保输出目录
  ensureDir(TMP_DIR);

  // 4. GraphFlow 上下文分析
  console.log("\n========================================");
  console.log("运行 GraphFlow 上下文分析");
  console.log("========================================");
  const ctxResult = run(
    'node dist/surfaces/cli/index.js context preview "项目整体架构、代码质量、潜在改进点" --json',
    { silent: true }
  );
  writeFile(path.join(TMP_DIR, "graphflow-context.json"), ctxResult.output);
  console.log(ctxResult.success ? "[成功] 上下文分析完成" : "[失败] 上下文分析出错");

  // 5. GraphFlow 图结构检查
  console.log("\n========================================");
  console.log("运行 GraphFlow 图结构检查");
  console.log("========================================");
  const graphResult = run("node dist/surfaces/cli/index.js graph inspect --json", { silent: true });
  writeFile(path.join(TMP_DIR, "graphflow-inspect.json"), graphResult.output);
  console.log(graphResult.success ? "[成功] 图结构检查完成" : "[失败] 图结构检查出错");

  // 6. ESLint 检查
  console.log("\n========================================");
  console.log("运行 ESLint 代码质量检查");
  console.log("========================================");
  const lintResult = run("npm run lint", { silent: true });
  writeFile(path.join(TMP_DIR, "eslint-report.txt"), lintResult.output + "\n" + lintResult.stderr);
  console.log(lintResult.success ? "[成功] ESLint 检查通过" : "[发现] ESLint 发现问题，已记录");

  // 7. 构建验证
  console.log("\n========================================");
  console.log("运行构建验证");
  console.log("========================================");
  const buildResult = run("npm run build", { silent: true });
  writeFile(path.join(TMP_DIR, "build-report.txt"), buildResult.output + "\n" + buildResult.stderr);
  console.log(buildResult.success ? "[成功] 构建通过" : "[失败] 构建失败，已记录");

  // 8. 汇总报告
  const report = {
    timestamp: timeStr,
    timeCheck: "通过",
    workspaceCheck: "通过",
    graphflowContext: ctxResult.success ? "成功" : "失败",
    graphflowInspect: graphResult.success ? "成功" : "失败",
    eslint: lintResult.success ? "通过" : "发现问题",
    build: buildResult.success ? "通过" : "失败",
  };
  writeFile(path.join(TMP_DIR, "auto-optimize-report.json"), JSON.stringify(report, null, 2));

  console.log("\n========================================");
  console.log("分析阶段完成");
  console.log("========================================");
  console.log("结果文件：");
  console.log("  - tmp/graphflow-context.json");
  console.log("  - tmp/graphflow-inspect.json");
  console.log("  - tmp/eslint-report.txt");
  console.log("  - tmp/build-report.txt");
  console.log("  - tmp/auto-optimize-report.json");
  console.log("\n请根据分析结果执行代码改进。");
}

main().catch((e) => {
  console.error("脚本执行出错：", e);
  process.exit(1);
});
