import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { ensureGlobalGraphFlowConfig, resolveGlobalConfigPath } from "../../config/scaffold";
import {
  detectInstalledAgents,
  formatModelConfigGuide,
  getMcpInstallStatus,
  type McpAgentInstallStatus,
  installMcpToDetectedAgents,
  type McpInstallResult,
  uninstallMcpFromDetectedAgents,
  type McpRemoveResult,
} from "../../integrations/agent-mcp-installer";
import {
  type AgentInstructionStatus,
  getAgentInstructionStatus,
  getAgentSkillStatus,
  installAllSkills,
} from "../../integrations/skill-installer";

const CONFIG_DIR = ".graphflow";
const README_FILE = join(CONFIG_DIR, "README.md");

const isWindows = process.platform === "win32";

function resolveHomePaths(): { home: string; appData: string; localAppData: string } {
  const home = homedir();
  const appData = process.env.APPDATA ?? (isWindows ? join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA ?? (isWindows ? join(home, "AppData", "Local") : "");
  return { home, appData, localAppData };
}

function getTraeUserDirs(): Array<{ name: string; skillsDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; skillsDir: string }> = [];

  if (isWindows) {
    if (existsSync(join(appData, "Trae"))) {
      dirs.push({ name: "Trae", skillsDir: join(appData, "Trae", "User", "skills") });
    }
    if (existsSync(join(appData, "Trae CN"))) {
      dirs.push({ name: "Trae CN", skillsDir: join(appData, "Trae CN", "User", "skills") });
    }
    if (existsSync(join(appData, "TRAE SOLO CN"))) {
      dirs.push({ name: "TRAE SOLO CN", skillsDir: join(appData, "TRAE SOLO CN", "User", "skills") });
    }
  } else {
    if (existsSync(join(home, ".config", "Trae"))) {
      dirs.push({ name: "Trae", skillsDir: join(home, ".config", "Trae", "User", "skills") });
    }
    if (existsSync(join(home, ".config", "Trae CN"))) {
      dirs.push({ name: "Trae CN", skillsDir: join(home, ".config", "Trae CN", "User", "skills") });
    }
    if (existsSync(join(home, ".config", "TRAE SOLO CN"))) {
      dirs.push({ name: "TRAE SOLO CN", skillsDir: join(home, ".config", "TRAE SOLO CN", "User", "skills") });
    }
  }

  return dirs;
}

function resolveSkillSourcePath(): string | undefined {
  const candidates: string[] = [
    join(__dirname, "..", "..", "surfaces", "trae-skill", "graphflow"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "trae-skill", "graphflow"),
    join(process.cwd(), "src", "surfaces", "trae-skill", "graphflow"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return undefined;
}

function resolveCursorRulesSourcePath(): string | undefined {
  const candidates: string[] = [
    join(__dirname, "..", "..", "surfaces", "cursor-rules"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "cursor-rules"),
    join(process.cwd(), "src", "surfaces", "cursor-rules"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "graphflow.mdc"))) {
      return dir;
    }
  }
  return undefined;
}

export interface SkillInstallResult {
  target: string;
  status: "created" | "updated" | "skipped" | "error";
  message?: string | undefined;
}

export interface CursorRulesInstallResult {
  target: string;
  status: "created" | "updated" | "skipped" | "error";
  message?: string;
}

export function installTraeSkills(): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const skillSourceDir = resolveSkillSourcePath();

  if (!skillSourceDir) {
    results.push({ target: "Trae", status: "skipped", message: "Skill source not found" });
    return results;
  }

  const traeDirs = getTraeUserDirs();
  if (traeDirs.length === 0) {
    results.push({ target: "Trae", status: "skipped", message: "No Trae installation detected" });
    return results;
  }

  const sourceSkillFile = join(skillSourceDir, "SKILL.md");

  for (const trae of traeDirs) {
    try {
      const destDir = join(trae.skillsDir, "graphflow");
      const destFile = join(destDir, "SKILL.md");

      const existed = existsSync(destFile);
      if (existed) {
        const existingContent = readFileSync(destFile, "utf8");
        const newContent = readFileSync(sourceSkillFile, "utf8");
        if (existingContent === newContent) {
          results.push({ target: trae.name, status: "skipped", message: "already up to date" });
          continue;
        }
      }

      mkdirSync(destDir, { recursive: true });
      copyFileSync(sourceSkillFile, destFile);
      results.push({ target: trae.name, status: existed ? "updated" : "created" });
    } catch (error) {
      results.push({
        target: trae.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export function installCursorRules(): CursorRulesInstallResult[] {
  const results: CursorRulesInstallResult[] = [];
  const rulesSourceDir = resolveCursorRulesSourcePath();

  if (!rulesSourceDir) {
    results.push({ target: "Cursor", status: "skipped", message: "Cursor rules source not found" });
    return results;
  }

  const { home, appData } = resolveHomePaths();
  const cursorRulesDirs: Array<{ name: string; path: string }> = [];

  // User-level Cursor rules directory
  const userRulesDir = join(home, ".cursor", "rules");
  if (existsSync(join(home, ".cursor"))) {
    cursorRulesDirs.push({ name: "Cursor (user)", path: userRulesDir });
  }

  // Also check AppData location (some Cursor versions)
  const appDataCursorDir = join(appData, "Cursor", "User", "rules");
  if (isWindows && existsSync(join(appData, "Cursor"))) {
    cursorRulesDirs.push({ name: "Cursor (AppData)", path: appDataCursorDir });
  }

  if (cursorRulesDirs.length === 0) {
    results.push({ target: "Cursor", status: "skipped", message: "No Cursor installation detected" });
    return results;
  }

  const sourceRulesFile = join(rulesSourceDir, "graphflow.mdc");

  for (const target of cursorRulesDirs) {
    try {
      const destDir = target.path;
      const destFile = join(destDir, "graphflow.mdc");

      const existed = existsSync(destFile);
      if (existed) {
        const existingContent = readFileSync(destFile, "utf8");
        const newContent = readFileSync(sourceRulesFile, "utf8");
        if (existingContent === newContent) {
          results.push({ target: target.name, status: "skipped", message: "already up to date" });
          continue;
        }
      }

      mkdirSync(destDir, { recursive: true });
      copyFileSync(sourceRulesFile, destFile);
      results.push({ target: target.name, status: existed ? "updated" : "created" });
    } catch (error) {
      results.push({
        target: target.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function buildReadmeContent(installResults: McpInstallResult[]): string {
  const detectedAgents = detectInstalledAgents().map((agent) => agent.name).join(", ") || "未检测到";
  const installedLines =
    installResults.length > 0
      ? installResults
          .filter((result) => result.status === "injected" || result.status === "created" || result.status === "updated")
          .map((result) => `- ${result.agentName} (${result.scope}): ${result.configPath}`)
          .join("\n")
      : "- 无";
  const globalConfigPath = resolveGlobalConfigPath();

  return `# GraphFlow 配置文件说明

欢迎使用 GraphFlow！模型与路由配置默认保存在用户全局文件中，新开项目无需重复配置。

## 1. 全局配置文件
- 路径：\`${globalConfigPath}\`
- **\`providers\`**: 配置各个大模型厂商的 API Key 和 Base URL。例如，如果你使用 DeepSeek，可以在 \`openai\` 字段中配置 Base URL 为 \`https://api.deepseek.com\` 并填入 \`apiKey\`。
- **\`tiers\`**:
  - \`smart\`: 核心大脑模型（用于规划器 Planner 和验证器 Validator）。建议配置为能力最强的模型（如 \`deepseek-v4-pro\`）。
  - \`economy\`: 经济型干活模型（用于执行器 Worker）。建议配置为速度快、成本低的模型（如 \`deepseek-v4-flash\`）。
- **\`embeddingPolicy\`**: 嵌入式向量模型，用于语义召回。默认使用本地 \`Xenova/bge-base-zh-v1.5\`；也可改为 \`openai\` 或轻量 \`hash\` 模式。
- **\`graphPolicy\`**: 控制图谱的生成和索引行为。
  - \`autoIndexOnPreview\` / \`autoIndexOnRun\`: 在预览上下文或执行任务前自动索引（默认开启）。
  - \`semanticEnrichment\`: 知识图谱 Symbol 节点的 LLM 语义摘要；\`provider\`/\`model\` 可留空以继承 Economy 层；\`autoRunOnIndex\` 在索引后静默小批量富化。

如需仅对某个项目覆盖配置，可在项目根目录创建 \`graphflow.config.json\` 或 \`.graphflow/config.json\`。

## 2. MCP (Model Context Protocol) 自动注入
安装时已自动嗅探本机 Agent 工具，并将 GraphFlow MCP 写入**用户级**配置（所有项目共享）。

**已嗅探到的 Agent：** ${detectedAgents}

**已写入的配置：**
${installedLines}

**如何验证 MCP 是否可用？**
在你的 AI Agent（或 IDE 的对话框）中直接说：
> "检查你现在是否加载了 graphflow 的工具"
或者
> "使用 graphflow 为我输出当前项目架构的预览上下文"

## 3. 模型配置
${formatModelConfigGuide()}
`;
}

function resolveBundledServerPath(): string | undefined {
  // Standard candidates based on __dirname (works for normal npm install -g)
  const candidates = [
    join(__dirname, "..", "mcp", "server.js"),
    join(__dirname, "..", "..", "surfaces", "mcp", "server.js"),
    join(__dirname, "..", "..", "..", "dist", "surfaces", "mcp", "server.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return resolve(p);
    }
  }

  // Fallback: derive from process.argv[1] when __dirname is resolved through
  // a Windows junction (npm install -g . creates a junction to the source dir).
  // process.argv[1] preserves the junction path containing @roarpeng/graphflow.
  const argv1 = process.argv[1];
  if (argv1) {
    const argvDir = dirname(argv1);
    const argvCandidates = [
      join(argvDir, "..", "mcp", "server.js"),
      join(argvDir, "..", "..", "surfaces", "mcp", "server.js"),
    ];
    for (const p of argvCandidates) {
      if (existsSync(p)) {
        return resolve(p);
      }
    }
  }

  return undefined;
}

function isRunningFromNpmPackage(): boolean {
  // On Windows, npm install -g . creates a junction (symlink) from
  // node_modules/@roarpeng/graphflow to the source directory.
  // Node.js resolves __dirname through the junction to the real path,
  // so __dirname won't contain "@roarpeng/graphflow".
  // However, process.argv[1] preserves the junction path, so we check that.
  const scriptPath = (process.argv[1] ?? "").replace(/\\/g, "/").toLowerCase();
  return scriptPath.includes("@roarpeng/graphflow");
}

function runInstallation(workspaceRoot: string): { mcpResults: McpInstallResult[]; skillResults: SkillInstallResult[]; cursorRulesResults: SkillInstallResult[]; claudeMdResults: SkillInstallResult[] } {
  const globalConfig = ensureGlobalGraphFlowConfig();
  if (globalConfig.status === "created") {
    console.log(`[CREATED] Global config: ${globalConfig.path}`);
  } else {
    console.log(`[SKIP] Global config already exists: ${globalConfig.path}`);
  }

  const bundledServerPath = resolveBundledServerPath();
  const fromPackage = isRunningFromNpmPackage();
  const hasPackageJson = existsSync(join(workspaceRoot, "package.json"));

  let mcpOptions: Parameters<typeof installMcpToDetectedAgents>[0];

  if (bundledServerPath && fromPackage) {
    // Derive bundledRuntimeRoot from process.argv[1] (preserves junction path on Windows)
    // rather than from bundledServerPath (which resolves through junction to source dir).
    const argv1 = process.argv[1];
    const runtimeRoot = argv1
      ? resolve(join(dirname(argv1), "..", "..", "..", ".."))
      : join(bundledServerPath, "..", "..", "..", "..");
    mcpOptions = {
      strategy: "node-bundled",
      installScope: "user",
      bundledServerPath,
      bundledRuntimeRoot: runtimeRoot,
      workspaceRoot,
    };
    console.log(`[INFO] Running from npm package — using bundled server: ${bundledServerPath}`);
  } else if (hasPackageJson) {
    mcpOptions = {
      strategy: "npm-script",
      installScope: "user",
      npmScriptCwd: workspaceRoot,
    };
  } else {
    mcpOptions = {
      strategy: "npx",
      installScope: "user",
      workspaceRoot,
    };
  }

  const installResults = installMcpToDetectedAgents(mcpOptions);

  for (const result of installResults) {
    if (result.status === "error") {
      console.error(`[ERROR] ${result.agentName} (${result.configPath}): ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      console.log(`[SKIP] ${result.message ?? "MCP install skipped"}`);
      continue;
    }
    console.log(`[SUCCESS] ${result.status === "created" ? "Created" : "Updated"} GraphFlow MCP for ${result.agentName}: ${result.configPath}`);
  }

  // 使用共享的 skill-installer 模块安装所有 Skill / Rules / CLAUDE.md
  const skillSummary = installAllSkills();

  return {
    mcpResults: installResults,
    skillResults: skillSummary.traeSkills,
    cursorRulesResults: skillSummary.cursorRules,
    claudeMdResults: skillSummary.claudeMd,
  };
}

export function runInstall() {
  const workspaceRoot = process.cwd();
  console.log("[START] Installing GraphFlow MCP + Skills to all detected agents...");

  const { mcpResults } = runInstallation(workspaceRoot);

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(README_FILE, buildReadmeContent(mcpResults), "utf8");
  console.log(`[CREATED] Documentation: ${README_FILE}`);

  void bootstrapGraphIndex(workspaceRoot).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WARN] Bootstrap graph index skipped: ${message}`);
  });

  console.log(`[FINISH] Installation complete! Global config: ${join(homedir(), ".graphflow.config.json")}`);
}

export function runInit() {
  if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
    console.log("[SKIP] GraphFlow postinstall skipped in CI/automation.");
    return;
  }

  const workspaceRoot = process.cwd();
  console.log("[START] Initializing GraphFlow global config...");

  const { mcpResults: installResults } = runInstallation(workspaceRoot);

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(README_FILE, buildReadmeContent(installResults), "utf8");
  console.log(`[CREATED] Documentation: ${README_FILE}`);

  void bootstrapGraphIndex(workspaceRoot).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WARN] Bootstrap graph index skipped: ${message}`);
  });

  console.log(`[FINISH] Initialization complete! Global config: ${join(homedir(), ".graphflow.config.json")}`);
  console.log("[HINT] To run init on npm install, set GRAPHFLOW_ENABLE_POSTINSTALL=1");
}

/**
 * 卸载 GraphFlow：移除所有 agent 的 MCP 配置、Skill 文件、Cursor Rules、版本标记文件
 */
export function runUninstall() {
  console.log("[START] 卸载 GraphFlow — 移除所有 MCP 配置和 Skill 文件...");

  const results: { mcpResults: McpRemoveResult[]; skillRemoved: boolean; cursorRulesRemoved: boolean; versionFileRemoved: boolean } = {
    mcpResults: [],
    skillRemoved: false,
    cursorRulesRemoved: false,
    versionFileRemoved: false,
  };

  // 1. 移除所有 agent 的 MCP 配置
  results.mcpResults = uninstallMcpFromDetectedAgents();
  for (const result of results.mcpResults) {
    if (result.removed) {
      console.log(`[REMOVED] MCP ${result.agentName}: ${result.configPath}`);
    } else {
      console.log(`[SKIP] MCP ${result.agentName}: ${result.message}`);
    }
  }

  // 2. 移除 Trae Skill 文件
  const traeDirs = getTraeUserDirs();
  for (const trae of traeDirs) {
    const skillDir = join(trae.skillsDir, "graphflow");
    if (existsSync(skillDir)) {
      try {
        rmSync(skillDir, { recursive: true, force: true });
        console.log(`[REMOVED] Skill ${trae.name}: ${skillDir}`);
        results.skillRemoved = true;
      } catch (error) {
        console.error(`[ERROR] 移除 Skill ${trae.name} 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 3. 移除 Cursor Rules 文件
  const { home, appData } = resolveHomePaths();
  const cursorRulesPaths = [
    join(home, ".cursor", "rules", "graphflow.mdc"),
  ];
  if (isWindows && existsSync(join(appData, "Cursor"))) {
    cursorRulesPaths.push(join(appData, "Cursor", "User", "rules", "graphflow.mdc"));
  }
  for (const rulesPath of cursorRulesPaths) {
    if (existsSync(rulesPath)) {
      try {
        rmSync(rulesPath, { force: true });
        console.log(`[REMOVED] Cursor Rules: ${rulesPath}`);
        results.cursorRulesRemoved = true;
      } catch (error) {
        console.error(`[ERROR] 移除 Cursor Rules 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 4. 移除版本标记文件
  const versionFile = join(homedir(), ".graphflow-install-version");
  if (existsSync(versionFile)) {
    try {
      rmSync(versionFile, { force: true });
      console.log(`[REMOVED] 版本标记文件: ${versionFile}`);
      results.versionFileRemoved = true;
    } catch (error) {
      console.error(`[ERROR] 移除版本标记文件失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("[FINISH] 卸载完成！");
}

/**
 * 移除指定 agent（或所有 agent）的 MCP 配置（不移除 Skill/Rules）
 * @param agentId 可选：指定移除某个 agent 的 MCP 配置（如 "cursor"、"trae"）
 */
export function runMcpRemove(agentId?: string) {
  const target = agentId ?? "所有检测到的 agent";
  console.log(`[START] 移除 GraphFlow MCP 配置 — 目标: ${target}`);

  const results = uninstallMcpFromDetectedAgents(agentId ? { agentId } : undefined);

  if (results.length === 0) {
    console.log("[SKIP] 未检测到需要移除的 MCP 配置");
    return results;
  }

  for (const result of results) {
    if (result.removed) {
      console.log(`[REMOVED] MCP ${result.agentName}: ${result.configPath}`);
    } else {
      console.log(`[SKIP] MCP ${result.agentName}: ${result.message}`);
    }
  }

  console.log("[FINISH] MCP 配置移除完成！");
  return results;
}

export interface DoctorReport {
  detectedAgents: Array<{ id: string; name: string }>;
  mcp: McpAgentInstallStatus[];
  instructions: AgentInstructionStatus[];
  /** 真正的 Agent Skill（Cursor/Claude/Codex 的 skills/graphflow/SKILL.md）状态。 */
  skills: AgentInstructionStatus[];
}

/**
 * 自检：汇总各 agent 的 MCP 注册与指令文件状态，便于用户验证"一次安装是否注册到所有 agent"。
 * 返回结构化数据（供 --json）并打印可读报告。
 */
export function runDoctor(): DoctorReport {
  const detectedAgents = detectInstalledAgents();
  const mcp = getMcpInstallStatus();
  const instructions = getAgentInstructionStatus();
  const skills = getAgentSkillStatus();

  console.log("[GraphFlow Doctor] 检测到的 Agent / AI IDE:");
  if (detectedAgents.length === 0) {
    console.log("  (未在本机检测到受支持的 agent)");
  } else {
    console.log(`  ${detectedAgents.map((agent) => agent.name).join(", ")}`);
  }

  console.log("");
  console.log("[GraphFlow Doctor] MCP 注册状态:");
  if (mcp.length === 0) {
    console.log("  (无)");
  } else {
    for (const item of mcp) {
      const mark = item.installed ? "OK " : "-- ";
      console.log(`  [${mark}] ${item.agentName}: ${item.configPath}`);
    }
  }

  console.log("");
  console.log("[GraphFlow Doctor] 指令文件状态:");
  for (const item of instructions) {
    if (!item.detected) {
      continue;
    }
    const mark = item.installed ? "OK " : "-- ";
    console.log(`  [${mark}] ${item.agent}: ${item.configPath}`);
  }

  console.log("");
  console.log("[GraphFlow Doctor] Agent Skill 状态:");
  for (const item of skills) {
    if (!item.detected) {
      continue;
    }
    const mark = item.installed ? "OK " : "-- ";
    console.log(`  [${mark}] ${item.agent}: ${item.configPath}`);
  }

  const pendingMcp = mcp.filter((item) => !item.installed);
  const pendingSkills = skills.filter((item) => item.detected && !item.installed);
  if (pendingMcp.length > 0 || pendingSkills.length > 0) {
    console.log("");
    console.log("[HINT] 部分 agent 尚未注册 MCP/Skill，运行 `graphflow install` 完成注册。");
  }

  return { detectedAgents, mcp, instructions, skills };
}

async function bootstrapGraphIndex(workspaceRoot: string): Promise<void> {
  const { indexGraph } = await import("./runtime.js");
  const result = await indexGraph(workspaceRoot);
  console.log(
    `[INDEX] Bootstrap complete: indexedFiles=${result.indexedFiles}; indexedSymbols=${result.indexedSymbols}`
  );
}

if (require.main === module) {
  runInit();
}
