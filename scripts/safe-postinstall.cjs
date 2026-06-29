#!/usr/bin/env node
const { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { spawnSync } = require("node:child_process");

const isWindows = process.platform === "win32";

// ─── 版本比较与自动更新 ───

/** 版本标记文件路径：记录上次安装的 GraphFlow 版本号 */
const VERSION_FILE = join(homedir(), ".graphflow-install-version");

/**
 * 读取上次安装时记录的版本号
 * @returns {string | null} 上次版本号，不存在则返回 null
 */
function readPreviousVersion() {
  try {
    if (existsSync(VERSION_FILE)) {
      return readFileSync(VERSION_FILE, "utf8").trim();
    }
  } catch {
    // 忽略读取失败
  }
  return null;
}

/**
 * 将当前版本号写入标记文件
 * @param {string} version 当前版本号
 */
function writeCurrentVersion(version) {
  try {
    writeFileSync(VERSION_FILE, version, "utf8");
  } catch {
    // 忽略写入失败
  }
}

/**
 * 比较版本号，判断是否需要强制更新 Skill/Rules/MCP 文件
 * @param {string} currentVersion 当前安装的版本号
 * @returns {boolean} 是否需要强制更新
 */
function needsForceUpdate(currentVersion) {
  const previousVersion = readPreviousVersion();
  if (!previousVersion) {
    return true; // 首次安装或无版本记录，强制更新
  }
  return previousVersion !== currentVersion;
}

function resolveHomePaths() {
  const home = homedir();
  const appData = process.env.APPDATA || (isWindows ? join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA || (isWindows ? join(home, "AppData", "Local") : "");
  return { home, appData, localAppData };
}

function detectTrae() {
  const { home, appData } = resolveHomePaths();
  const markers = [
    join(home, ".trae"),
    join(home, ".trae-cn"),
    join(appData, "Trae"),
    join(appData, "Trae CN"),
  ];
  return markers.some((m) => existsSync(m));
}

function getTraeUserDirs() {
  const { home, appData } = resolveHomePaths();
  const dirs = [];

  if (isWindows) {
    if (existsSync(join(appData, "Trae"))) {
      dirs.push({
        name: "Trae",
        userDir: join(appData, "Trae", "User"),
        skillsDir: join(appData, "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(appData, "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        userDir: join(appData, "Trae CN", "User"),
        skillsDir: join(appData, "Trae CN", "User", "skills"),
      });
    }
  } else {
    if (existsSync(join(home, ".config", "Trae"))) {
      dirs.push({
        name: "Trae",
        userDir: join(home, ".config", "Trae", "User"),
        skillsDir: join(home, ".config", "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(home, ".config", "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        userDir: join(home, ".config", "Trae CN", "User"),
        skillsDir: join(home, ".config", "Trae CN", "User", "skills"),
      });
    }
  }

  return dirs;
}

function installSkill(skillsDir, skillSourceDir) {
  const skillDestDir = join(skillsDir, "graphflow");
  const skillDestFile = join(skillDestDir, "SKILL.md");
  const skillSourceFile = join(skillSourceDir, "SKILL.md");

  if (!existsSync(skillSourceFile)) {
    return { status: "skipped", reason: "skill source not found" };
  }

  try {
    const existed = existsSync(skillDestFile);

    if (existed) {
      const existingContent = readFileSync(skillDestFile, "utf8");
      const newContent = readFileSync(skillSourceFile, "utf8");
      if (existingContent === newContent) {
        return { status: "skipped", reason: "already up to date" };
      }
    }

    mkdirSync(skillDestDir, { recursive: true });
    copyFileSync(skillSourceFile, skillDestFile);

    return { status: existed ? "updated" : "created" };
  } catch (err) {
    return { status: "error", reason: err.message || String(err) };
  }
}

function getSkillSourceDir() {
  const candidates = [
    join(__dirname, "..", "dist", "surfaces", "trae-skill", "graphflow"),
    join(__dirname, "..", "src", "surfaces", "trae-skill", "graphflow"),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return null;
}

function runMcpInstaller() {
  const installerPath = join(__dirname, "..", "dist", "integrations", "agent-mcp-installer.js");
  if (!existsSync(installerPath)) {
    return { status: "skipped", reason: "installer not built yet" };
  }

  try {
    const result = spawnSync(
      process.execPath,
      ["-e", `
        const { installMcpToDetectedAgents } = require(${JSON.stringify(installerPath)});
        const results = installMcpToDetectedAgents({ strategy: "npx" });
        console.log(JSON.stringify(results));
      `],
      { encoding: "utf8" }
    );
    if (result.status === 0 && result.stdout.trim()) {
      try {
        return { status: "installed", details: JSON.parse(result.stdout.trim()) };
      } catch {
        return { status: "unknown", output: result.stdout.trim() };
      }
    }
    return { status: "error", error: result.stderr || result.stdout };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function isGlobalInstall() {
  if (process.env.npm_config_global === "true") {
    return true;
  }
  try {
    const pkgRoot = join(__dirname, "..");
    const globalPrefix = process.env.npm_config_prefix || "";
    if (globalPrefix && pkgRoot.startsWith(globalPrefix)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * 获取 Cursor Rules 源文件路径（graphflow.mdc）
 * 优先从 dist 目录查找，回退到 src 目录。
 * @returns {string | null} 源文件路径，不存在则返回 null
 */
function getCursorRulesSourceFile() {
  const candidates = [
    join(__dirname, "..", "dist", "surfaces", "cursor-rules", "graphflow.mdc"),
    join(__dirname, "..", "src", "surfaces", "cursor-rules", "graphflow.mdc"),
  ];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * 获取 CLAUDE.md 源文件路径
 * 优先从包根目录查找。
 * @returns {string | null} 源文件路径，不存在则返回 null
 */
function getClaudeMdSourceFile() {
  const candidates = [
    join(__dirname, "..", "CLAUDE.md"),
  ];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * 获取 Cursor rules 目录列表。
 * Cursor 的 rules 目录为 ~/.cursor/rules/（跨平台一致），
 * 也有用户使用 %APPDATA%/Cursor/User/rules/。
 * @returns {Array<{name: string, rulesDir: string}>} Cursor rules 目录列表
 */
function getCursorRulesDirs() {
  const { home, appData } = resolveHomePaths();
  const dirs = [];

  // ~/.cursor/rules — Cursor 的标准 rules 目录
  if (existsSync(join(home, ".cursor"))) {
    dirs.push({
      name: "Cursor (~/.cursor)",
      rulesDir: join(home, ".cursor", "rules"),
    });
  }

  // %APPDATA%/Cursor/User/rules — Windows 上的备选目录
  if (isWindows && existsSync(join(appData, "Cursor", "User"))) {
    dirs.push({
      name: "Cursor (AppData)",
      rulesDir: join(appData, "Cursor", "User", "rules"),
    });
  }

  return dirs;
}

/**
 * 通用文件安装逻辑：检测 marker → 创建目标目录 → 复制文件 → 已存在且内容相同则跳过
 * @param {string} sourceFile 源文件路径
 * @param {string} destDir 目标目录
 * @param {string} destFileName 目标文件名
 * @returns {{status: string, reason?: string}} 安装结果
 */
function installFileToDir(sourceFile, destDir, destFileName) {
  if (!existsSync(sourceFile)) {
    return { status: "skipped", reason: "源文件不存在" };
  }

  const destFile = join(destDir, destFileName);
  const existed = existsSync(destFile);

  if (existed) {
    const existingContent = readFileSync(destFile, "utf8");
    const newContent = readFileSync(sourceFile, "utf8");
    if (existingContent === newContent) {
      return { status: "skipped", reason: "已是最新" };
    }
  }

  mkdirSync(destDir, { recursive: true });
  copyFileSync(sourceFile, destFile);

  return { status: existed ? "updated" : "created" };
}

/**
 * 检测并安装 Cursor Rules（graphflow.mdc）到 Cursor rules 目录
 * @returns {{status: string, reason?: string} | null} 安装结果，无需安装则返回 null
 */
function installCursorRules() {
  const sourceFile = getCursorRulesSourceFile();
  if (!sourceFile) {
    return { status: "skipped", reason: "Cursor Rules 源文件不存在" };
  }

  const dirs = getCursorRulesDirs();
  if (dirs.length === 0) {
    return null; // 未检测到 Cursor，跳过
  }

  // 只需要安装到第一个有效目录
  const target = dirs[0];
  return installFileToDir(sourceFile, target.rulesDir, "graphflow.mdc");
}

/**
 * 检测并安装 CLAUDE.md 到 ~/.claude/CLAUDE.md（Claude Code 约定）
 * @returns {{status: string, reason?: string} | null} 安装结果，无需安装则返回 null
 */
function installClaudeMd() {
  const sourceFile = getClaudeMdSourceFile();
  if (!sourceFile) {
    return { status: "skipped", reason: "CLAUDE.md 源文件不存在" };
  }

  const { home } = resolveHomePaths();
  const claudeDir = join(home, ".claude");

  // 检测 ~/.claude 是否存在（Claude Code 的 marker 目录）
  if (!existsSync(claudeDir)) {
    return null; // 未检测到 Claude Code，跳过
  }

  return installFileToDir(sourceFile, claudeDir, "CLAUDE.md");
}

/**
 * 注入 workspace 级 MCP 配置到已存在的 workspace MCP 文件。
 * 仅在检测到 .cursor/mcp.json 或 .vscode/mcp.json 时生效（更安全，只在当前项目内）。
 * @param {string} workspaceRoot 当前项目根目录
 * @returns {Array<{configPath: string, status: string}>} 注入结果列表
 */
function installWorkspaceLevelMcp(workspaceRoot) {
  const results = [];
  const configFiles = [
    { path: join(workspaceRoot, ".cursor", "mcp.json"), name: "Cursor", key: "mcpServers" },
    { path: join(workspaceRoot, ".vscode", "mcp.json"), name: "VS Code", key: "servers" },
  ];

  const mcpEntry = {
    command: "npx",
    args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
    env: { GRAPHFLOW_MCP_STDIO: "1", GRAPHFLOW_LOG_JSON: "1" },
  };

  for (const config of configFiles) {
    if (!existsSync(config.path)) {
      continue; // 该 workspace 级配置不存在，跳过
    }

    try {
      let json = {};
      try {
        json = JSON.parse(readFileSync(config.path, "utf8"));
      } catch {
        // 配置文件为空或损坏，初始化为空对象
      }

      const servers = json[config.key] || {};
      if (servers.graphflow) {
        results.push({ configPath: config.path, status: "skipped", name: config.name, reason: "already configured" });
        continue;
      }

      servers.graphflow = mcpEntry;
      json[config.key] = servers;
      writeFileSync(config.path, JSON.stringify(json, null, 2) + "\n", "utf8");
      results.push({ configPath: config.path, status: "created", name: config.name });
      console.log(`[GraphFlow] Workspace 级 MCP 已注入到 ${config.path} (${config.name})`);
    } catch (err) {
      results.push({ configPath: config.path, status: "error", name: config.name, reason: err.message });
      console.log(`[GraphFlow] Workspace 级 MCP 注入失败 ${config.path}: ${err.message}`);
    }
  }

  return results;
}

/**
 * 在 workspace 级创建 .graphflow/skills/ 目录并复制 Skill 文件。
 * 仅在检测到 .cursor/mcp.json 或 .vscode/mcp.json 时生效。
 * @param {string} workspaceRoot 当前项目根目录
 */
function installWorkspaceLevelSkills(workspaceRoot) {
  const configFiles = [
    join(workspaceRoot, ".cursor", "mcp.json"),
    join(workspaceRoot, ".vscode", "mcp.json"),
  ];
  const hasWorkspaceConfig = configFiles.some((p) => existsSync(p));

  if (!hasWorkspaceConfig) {
    return; // 无 workspace 级 MCP 配置，跳过 Skill 安装
  }

  const skillSourceDir = getSkillSourceDir();
  if (!skillSourceDir) {
    return;
  }

  // 在 .graphflow/skills/graphflow/ 下创建 workspace 级 Skill
  const skillDestDir = join(workspaceRoot, ".graphflow", "skills", "graphflow");
  const result = installSkill(skillDestDir, skillSourceDir);
  if (result.status !== "skipped") {
    console.log(`[GraphFlow] Workspace 级 Skill: ${result.status}${result.reason ? ` (${result.reason})` : ""} -> ${skillDestDir}`);
  }

  // 同时安装 Cursor Rules 到 workspace 级 .cursor/rules/
  const cursorRulesSource = getCursorRulesSourceFile();
  if (cursorRulesSource && existsSync(join(workspaceRoot, ".cursor"))) {
    const cursorRulesDir = join(workspaceRoot, ".cursor", "rules");
    const rulesResult = installFileToDir(cursorRulesSource, cursorRulesDir, "graphflow.mdc");
    if (rulesResult.status !== "skipped") {
      console.log(`[GraphFlow] Workspace 级 Cursor Rules: ${rulesResult.status}${rulesResult.reason ? ` (${rulesResult.reason})` : ""}`);
    }
  }
}

function main() {
  if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
    process.exit(0);
  }

  const globalInstall = isGlobalInstall();
  const explicitlyEnabled = process.env.GRAPHFLOW_ENABLE_POSTINSTALL === "1";

  if (!globalInstall && !explicitlyEnabled) {
    // 本地安装：检测 workspace 级 MCP 配置，若有则自动注入 workspace 级 MCP + Skill
    const workspaceRoot = process.cwd();
    const workspaceMcpResults = installWorkspaceLevelMcp(workspaceRoot);
    const hasWorkspaceConfig = workspaceMcpResults.some((r) => r.status === "created" || r.status === "skipped");

    if (hasWorkspaceConfig) {
      console.log("[GraphFlow] 检测到 workspace 级 MCP 配置，已自动注入 workspace 级 GraphFlow MCP。");
      installWorkspaceLevelSkills(workspaceRoot);
      console.log("[GraphFlow] 如需完整安装（用户级 MCP + Trae Skill），运行:");
      console.log("[GraphFlow]   npx @roarpeng/graphflow install");
    } else {
      console.log("[GraphFlow] Local install detected. Auto-setup skipped to avoid modifying your global config.");
      console.log("[GraphFlow] To install GraphFlow MCP + Skill, run:");
      console.log("[GraphFlow]   npx @roarpeng/graphflow install");
    }
    process.exit(0);
  }

  // 读取当前版本号，用于版本比较和强制更新
  let currentVersion = "unknown";
  try {
    const pkg = require("../package.json");
    currentVersion = pkg.version || "unknown";
  } catch {
    // npm 包中 package.json 在上层目录；如果读取失败则跳过版本比较
  }

  const forceUpdate = needsForceUpdate(currentVersion);
  const previousVersion = readPreviousVersion();

  try {
    console.log(`[GraphFlow] Running post-install setup (${globalInstall ? "global install" : "explicitly enabled"})...`);
    console.log(`[GraphFlow] 版本: ${currentVersion}`);

    if (forceUpdate && previousVersion) {
      console.log(`[GraphFlow] 检测到版本变化 (${previousVersion} → ${currentVersion})，将强制更新所有 Skill/Rules/MCP 文件`);
    } else if (forceUpdate && !previousVersion) {
      console.log("[GraphFlow] 首次安装，将安装所有 Skill/Rules/MCP 文件");
    }

    const skillSourceDir = getSkillSourceDir();
    const traeDirs = getTraeUserDirs();

    const skillResults = [];
    if (skillSourceDir && traeDirs.length > 0) {
      for (const trae of traeDirs) {
        const result = installSkill(trae.skillsDir, skillSourceDir);
        skillResults.push({ agent: trae.name, ...result });
        console.log(`[GraphFlow] Skill for ${trae.name}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
      }
    }

    const mcpResult = runMcpInstaller();
    if (mcpResult.status === "installed" && Array.isArray(mcpResult.details)) {
      for (const item of mcpResult.details) {
        console.log(`[GraphFlow] MCP for ${item.agentName} (${item.scope}): ${item.status}`);
      }
    } else if (mcpResult.status === "skipped") {
      console.log(`[GraphFlow] MCP install skipped: ${mcpResult.reason}`);
    } else if (mcpResult.status === "error") {
      console.log(`[GraphFlow] MCP install encountered errors: ${mcpResult.error || "unknown"}`);
      console.log("[GraphFlow] You can manually run: npx @roarpeng/graphflow install");
    }

    // ─── Cursor Rules 安装 ───
    const cursorRulesResult = installCursorRules();
    if (cursorRulesResult) {
      console.log(`[GraphFlow] Cursor Rules: ${cursorRulesResult.status}${cursorRulesResult.reason ? ` (${cursorRulesResult.reason})` : ""}`);
    }

    // ─── Claude Code 约定安装 ───
    const claudeMdResult = installClaudeMd();
    if (claudeMdResult) {
      console.log(`[GraphFlow] Claude Code 约定: ${claudeMdResult.status}${claudeMdResult.reason ? ` (${claudeMdResult.reason})` : ""}`);
    }

    // 写入当前版本号标记文件
    if (currentVersion !== "unknown") {
      writeCurrentVersion(currentVersion);
    }

    console.log("[GraphFlow] Post-install complete.");
  } catch (err) {
    console.warn("[GraphFlow] Post-install setup encountered an error (non-fatal):", err.message || String(err));
    console.warn("[GraphFlow] GraphFlow core is still installed. To complete setup manually, run:");
    console.warn("[GraphFlow]   npx @roarpeng/graphflow install");
  }
}

if (require.main === module) {
  main();
}

module.exports = { installSkill, detectTrae, getTraeUserDirs, getSkillSourceDir, readPreviousVersion, writeCurrentVersion, needsForceUpdate, VERSION_FILE };
