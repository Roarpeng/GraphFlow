/**
 * skill-installer.ts — 共享的 Skill / Rules 安装模块
 *
 * 封装 Trae Skill、Cursor Rules、Claude Code CLAUDE.md 的安装逻辑，
 * 可被 CLI init 和 VS Code 扩展共用。所有安装失败静默处理（log warn）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 类型定义 ──────────────────────────────────────────────────────────

export interface SkillInstallResult {
  /** 安装目标名称（如 "Trae"、"Cursor"） */
  target: string;
  /** 安装结果状态 */
  status: "created" | "updated" | "skipped" | "error";
  /** 可选的附加信息 */
  message?: string | undefined;
}

export interface SkillInstallSummary {
  traeSkills: SkillInstallResult[];
  cursorRules: SkillInstallResult[];
  claudeMd: SkillInstallResult[];
  /** Agent instruction files (Windsurf / Codex / Gemini global rules, etc.). */
  agentInstructions: SkillInstallResult[];
  /** Real Agent Skill folders (Cursor / Claude Code / Codex `skills/<name>/SKILL.md`). */
  agentSkills: SkillInstallResult[];
}

/** Status of a GraphFlow instruction block in a per-agent rules/memory file. */
export interface AgentInstructionStatus {
  /** Display name of the agent. */
  agent: string;
  /** Absolute path to the instruction file. */
  configPath: string;
  /** Whether the agent appears installed on this machine (marker present). */
  detected: boolean;
  /** Whether the GraphFlow managed block is present in the file. */
  installed: boolean;
}

// ── 平台检测 ──────────────────────────────────────────────────────────

const isWindows = process.platform === "win32";

function resolveHomePaths(): { home: string; appData: string; localAppData: string } {
  const home = homedir();
  const appData = process.env.APPDATA ?? (isWindows ? join(home, "AppData", "Roaming") : "");
  const localAppData =
    process.env.LOCALAPPDATA ?? (isWindows ? join(home, "AppData", "Local") : "");
  return { home, appData, localAppData };
}

// ── Trae Skill 安装 ──────────────────────────────────────────────────

function getTraeUserDirs(): Array<{ name: string; skillsDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; skillsDir: string }> = [];

  if (isWindows) {
    if (existsSync(join(appData, "Trae"))) {
      dirs.push({
        name: "Trae",
        skillsDir: join(appData, "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(appData, "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        skillsDir: join(appData, "Trae CN", "User", "skills"),
      });
    }
    if (existsSync(join(appData, "TRAE SOLO CN"))) {
      dirs.push({
        name: "TRAE SOLO CN",
        skillsDir: join(appData, "TRAE SOLO CN", "User", "skills"),
      });
    }
  } else {
    if (existsSync(join(home, ".config", "Trae"))) {
      dirs.push({
        name: "Trae",
        skillsDir: join(home, ".config", "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(home, ".config", "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        skillsDir: join(home, ".config", "Trae CN", "User", "skills"),
      });
    }
    if (existsSync(join(home, ".config", "TRAE SOLO CN"))) {
      dirs.push({
        name: "TRAE SOLO CN",
        skillsDir: join(home, ".config", "TRAE SOLO CN", "User", "skills"),
      });
    }
  }

  return dirs;
}

// ── Cursor Rules 安装 ─────────────────────────────────────────────────

function getCursorRulesDirs(): Array<{ name: string; rulesDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; rulesDir: string }> = [];

  // 用户级 Cursor rules 目录
  if (existsSync(join(home, ".cursor"))) {
    dirs.push({
      name: "Cursor (user)",
      rulesDir: join(home, ".cursor", "rules"),
    });
  }

  // AppData 位置（某些 Cursor 版本）
  if (isWindows && existsSync(join(appData, "Cursor"))) {
    dirs.push({
      name: "Cursor (AppData)",
      rulesDir: join(appData, "Cursor", "User", "rules"),
    });
  }

  return dirs;
}

// ── Claude Code CLAUDE.md 安装 ────────────────────────────────────────

function getClaudeCodeDirs(): Array<{ name: string; claudeDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; claudeDir: string }> = [];

  if (existsSync(join(home, ".claude"))) {
    dirs.push({
      name: "Claude Code",
      claudeDir: join(home, ".claude"),
    });
  }

  if (isWindows && existsSync(join(appData, "Claude Code"))) {
    dirs.push({
      name: "Claude Code (AppData)",
      claudeDir: join(appData, "Claude Code"),
    });
  }

  return dirs;
}

// ── 路径解析（支持多种候选路径） ────────────────────────────────────────

/**
 * 解析 Trae Skill 源文件路径。
 * 支持以下候选路径（按优先级排序）：
 * 1. vendorRuntimeRoot（VS Code 扩展打包后 vendor/graphflow 路径）
 * 2. 标准的 dist/surfaces/ 路径
 * 3. src/surfaces/ 源码路径
 */
export function resolveSkillSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    // VS Code 扩展 vendor 路径（打包后）
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "src", "surfaces", "trae-skill", "graphflow"),
          join(vendorRuntimeRoot, "dist", "surfaces", "trae-skill", "graphflow"),
        ]
      : []),
    // 标准构建产物路径
    join(__dirname, "..", "..", "surfaces", "trae-skill", "graphflow"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "trae-skill", "graphflow"),
    join(process.cwd(), "src", "surfaces", "trae-skill", "graphflow"),
    join(process.cwd(), "dist", "surfaces", "trae-skill", "graphflow"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * 解析 Cursor Rules 源文件路径。
 */
export function resolveCursorRulesSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    // VS Code 扩展 vendor 路径（打包后）
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "src", "surfaces", "cursor-rules"),
          join(vendorRuntimeRoot, "dist", "surfaces", "cursor-rules"),
        ]
      : []),
    // 标准构建产物路径
    join(__dirname, "..", "..", "surfaces", "cursor-rules"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "cursor-rules"),
    join(process.cwd(), "src", "surfaces", "cursor-rules"),
    join(process.cwd(), "dist", "surfaces", "cursor-rules"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "graphflow.mdc"))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * 解析 Claude Code CLAUDE.md 源文件路径。
 */
export function resolveClaudeMdSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    // VS Code 扩展 vendor 路径（打包后）
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "CLAUDE.md"),
        ]
      : []),
    // 标准路径
    join(__dirname, "..", "..", "CLAUDE.md"),
    join(__dirname, "..", "..", "..", "CLAUDE.md"),
    join(process.cwd(), "CLAUDE.md"),
  ];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return undefined;
}

// ── 文件安装辅助 ────────────────────────────────────────────────────

/**
 * 通用文件安装：将源文件复制到目标位置，若已存在且内容相同则跳过。
 */
function installFile(
  sourcePath: string,
  destDir: string,
  destFileName: string
): { status: "created" | "updated" | "skipped"; message?: string } {
  const destFile = join(destDir, destFileName);
  const existed = existsSync(destFile);

  if (existed) {
    const existingContent = readFileSync(destFile, "utf8");
    const newContent = readFileSync(sourcePath, "utf8");
    if (existingContent === newContent) {
      return { status: "skipped", message: "already up to date" };
    }
  }

  mkdirSync(destDir, { recursive: true });
  copyFileSync(sourcePath, destFile);
  return { status: existed ? "updated" : "created" };
}

// ── Agent 指令文件（append-with-markers 安全写入） ──────────────────────

const INSTRUCTION_BEGIN = "<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->";
const INSTRUCTION_END = "<!-- GRAPHFLOW:END -->";

/**
 * GraphFlow 的精简 token-first 指令块（受 Windsurf 6000 字符全局规则上限约束，保持简短）。
 * 写入各 agent 的全局规则/记忆文件，告诉模型优先调用 GraphFlow 压缩上下文。
 */
function buildInstructionBlock(): string {
  return [
    INSTRUCTION_BEGIN,
    "## GraphFlow Context-First Rule",
    "",
    "GraphFlow is a local code knowledge-graph + context compression MCP server.",
    "Before broad code exploration, implementation, debugging, review, or architecture",
    "questions in this project:",
    "",
    "1. Call `graphflow_preview_context` with the task/query first.",
    "2. Use the returned `summary`, `anchors`, and `tokenBudget` as the primary context.",
    "3. Read full files only when anchors point there or compressed context is insufficient.",
    "4. For multi-step or ambiguous work, call `graphflow_plan` before implementing.",
    "5. After project changes, call `graphflow_index` to keep the graph fresh.",
    "",
    "Do not scan the whole repository or read many large files before trying GraphFlow",
    "context. Treat GraphFlow output as structured, token-saving context.",
    INSTRUCTION_END,
    "",
  ].join("\n");
}

/**
 * 将受管指令块以 append-with-markers 方式写入文件：
 * - 文件不存在 → 创建并写入块
 * - 已存在且含旧块 → 仅替换标记之间的内容（保留用户其它内容）
 * - 已存在且无块 → 追加到文件末尾（保留用户其它内容）
 * - 块内容已是最新 → skipped
 */
function upsertManagedBlock(
  filePath: string,
  destDirToCreate: string
): { status: "created" | "updated" | "skipped" | "error"; message?: string } {
  try {
    const block = buildInstructionBlock();
    const existed = existsSync(filePath);

    if (!existed) {
      mkdirSync(destDirToCreate, { recursive: true });
      writeFileSync(filePath, `${block}\n`, "utf8");
      return { status: "created" };
    }

    const current = readFileSync(filePath, "utf8");
    const beginIdx = current.indexOf(INSTRUCTION_BEGIN);
    const endIdx = current.indexOf(INSTRUCTION_END);

    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const before = current.slice(0, beginIdx);
      const after = current.slice(endIdx + INSTRUCTION_END.length);
      const next = `${before}${block.trimEnd()}${after}`;
      if (next === current) {
        return { status: "skipped", message: "already up to date" };
      }
      writeFileSync(filePath, next, "utf8");
      return { status: "updated" };
    }

    // 无现有块：追加（保留用户已有内容）
    const separator = current.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(filePath, `${current}${separator}${block}\n`, "utf8");
    return { status: "updated" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** 各 agent 的全局指令/记忆文件目标（仅在检测到对应 marker 时写入）。 */
function getAgentInstructionTargets(): Array<{
  agent: string;
  markerDir: string;
  destDir: string;
  filePath: string;
}> {
  const { home } = resolveHomePaths();
  const targets: Array<{ agent: string; markerDir: string; destDir: string; filePath: string }> = [];

  // 注：Claude Code 的 ~/.claude/CLAUDE.md 由 installClaudeCodeMd 单独处理，
  // 此处不重复写入，避免对同一文件的双重写入冲突。

  // Windsurf 全局规则：~/.codeium/windsurf/memories/global_rules.md（6000 字符上限）
  targets.push({
    agent: "Windsurf",
    markerDir: join(home, ".codeium", "windsurf"),
    destDir: join(home, ".codeium", "windsurf", "memories"),
    filePath: join(home, ".codeium", "windsurf", "memories", "global_rules.md"),
  });

  // Codex 全局指令：~/.codex/AGENTS.md
  targets.push({
    agent: "Codex",
    markerDir: join(home, ".codex"),
    destDir: join(home, ".codex"),
    filePath: join(home, ".codex", "AGENTS.md"),
  });

  // Gemini CLI 全局指令：~/.gemini/GEMINI.md
  targets.push({
    agent: "Gemini",
    markerDir: join(home, ".gemini"),
    destDir: join(home, ".gemini"),
    filePath: join(home, ".gemini", "GEMINI.md"),
  });

  return targets;
}

/**
 * 将 GraphFlow 指令块安全写入所有检测到的 agent 的全局规则/记忆文件。
 * 使用 append-with-markers，绝不覆盖用户已有内容。
 */
export function installAgentInstructions(): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];

  for (const target of getAgentInstructionTargets()) {
    if (!existsSync(target.markerDir)) {
      continue; // 未检测到该 agent，跳过
    }
    const result = upsertManagedBlock(target.filePath, target.destDir);
    results.push({ target: target.agent, status: result.status, message: result.message });
  }

  if (results.length === 0) {
    results.push({ target: "Agent instructions", status: "skipped", message: "No supported agent detected" });
  }

  return results;
}

/** 检查每个 agent 的全局指令文件是否含 GraphFlow 受管块（用于 doctor 自检）。 */
export function getAgentInstructionStatus(): AgentInstructionStatus[] {
  return getAgentInstructionTargets().map((target) => {
    const detected = existsSync(target.markerDir);
    let installed = false;
    if (existsSync(target.filePath)) {
      const content = readFileSync(target.filePath, "utf8");
      installed = content.includes(INSTRUCTION_BEGIN) && content.includes(INSTRUCTION_END);
    }
    return { agent: target.agent, configPath: target.filePath, detected, installed };
  });
}

// ── Agent Skill 文件夹安装（真正的 Cursor / Claude / Codex Skill） ────────

/**
 * 各 agent 的"真正的 Skill"目录目标（仅在检测到对应 marker 时写入）。
 *
 * 重要：Cursor 自定义 Skill 的正确目录是 `~/.cursor/skills/<name>/SKILL.md`，
 * 绝不能写入 `~/.cursor/skills-cursor/`（那是 Cursor 内置 Skill 的保留目录）。
 * Claude Code / Codex 同样支持 `~/.claude/skills/`、`~/.codex/skills/` 约定。
 */
function getAgentSkillTargets(): Array<{
  agent: string;
  markerDir: string;
  skillsRoot: string;
}> {
  const { home } = resolveHomePaths();
  return [
    // Cursor 用户级 Skill（~/.cursor/skills/graphflow/SKILL.md）
    {
      agent: "Cursor",
      markerDir: join(home, ".cursor"),
      skillsRoot: join(home, ".cursor", "skills"),
    },
    // Claude Code 用户级 Skill（~/.claude/skills/graphflow/SKILL.md）
    {
      agent: "Claude Code",
      markerDir: join(home, ".claude"),
      skillsRoot: join(home, ".claude", "skills"),
    },
    // Codex 用户级 Skill（~/.codex/skills/graphflow/SKILL.md）
    {
      agent: "Codex",
      markerDir: join(home, ".codex"),
      skillsRoot: join(home, ".codex", "skills"),
    },
  ];
}

/**
 * 将 GraphFlow 的 SKILL.md 安装为各检测到的 agent 的"真正的 Skill"
 * （Cursor / Claude Code / Codex 的 `skills/graphflow/SKILL.md`）。
 * SKILL.md 已带合法的 `name: graphflow` frontmatter，可被 Cursor 直接识别。
 */
export function installAgentSkills(vendorRuntimeRoot?: string, workspaceRoot?: string): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const skillSourceDir = resolveSkillSourcePath(vendorRuntimeRoot);

  if (!skillSourceDir) {
    results.push({
      target: "Agent skills",
      status: "skipped",
      message: "Skill source (SKILL.md) not found",
    });
    return results;
  }

  const sourceSkillFile = join(skillSourceDir, "SKILL.md");
  let allFailed = true;
  let hasDetected = false;

  for (const target of getAgentSkillTargets()) {
    if (!existsSync(target.markerDir)) {
      continue;
    }
    hasDetected = true;
    try {
      const destDir = join(target.skillsRoot, "graphflow");
      const result = installFile(sourceSkillFile, destDir, "SKILL.md");
      results.push({ target: target.agent, status: result.status, message: result.message });
      allFailed = false;
    } catch (error) {
      results.push({
        target: target.agent,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (allFailed && workspaceRoot) {
    try {
      const workspaceSkillDir = join(workspaceRoot, ".graphflow", "skills", "graphflow");
      const wsResult = installFile(sourceSkillFile, workspaceSkillDir, "SKILL.md");
      results.push({
        target: `Workspace (${workspaceRoot})`,
        status: wsResult.status,
        message: wsResult.message,
      });
    } catch (error) {
      results.push({
        target: `Workspace (${workspaceRoot})`,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (results.length === 0 && !hasDetected) {
    results.push({
      target: "Agent skills",
      status: "skipped",
      message: "No supported agent detected",
    });
  }

  return results;
}

/** 检查每个 agent 的 Skill 文件是否已安装（用于 doctor 自检）。 */
export function getAgentSkillStatus(): AgentInstructionStatus[] {
  return getAgentSkillTargets().map((target) => {
    const detected = existsSync(target.markerDir);
    const filePath = join(target.skillsRoot, "graphflow", "SKILL.md");
    return { agent: `${target.agent} skill`, configPath: filePath, detected, installed: existsSync(filePath) };
  });
}

// ── 单项安装函数 ──────────────────────────────────────────────────────

/**
 * 安装 Trae Skill（SKILL.md）到所有检测到的 Trae 用户目录。
 */
export function installTraeSkills(vendorRuntimeRoot?: string, workspaceRoot?: string): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const skillSourceDir = resolveSkillSourcePath(vendorRuntimeRoot);

  if (!skillSourceDir) {
    results.push({
      target: "Trae",
      status: "skipped",
      message: "Skill source (SKILL.md) not found",
    });
    return results;
  }

  const traeDirs = getTraeUserDirs();
  const sourceSkillFile = join(skillSourceDir, "SKILL.md");
  let allFailed = false;

  if (traeDirs.length > 0) {
    for (const trae of traeDirs) {
      try {
        const destDir = join(trae.skillsDir, "graphflow");
        const result = installFile(sourceSkillFile, destDir, "SKILL.md");
        results.push({ target: trae.name, status: result.status, message: result.message });
      } catch (error) {
        results.push({
          target: trae.name,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        allFailed = true;
      }
    }
  } else {
    allFailed = true;
  }

  if (allFailed && workspaceRoot) {
    try {
      const workspaceSkillDir = join(workspaceRoot, ".graphflow", "skills", "graphflow");
      const wsResult = installFile(sourceSkillFile, workspaceSkillDir, "SKILL.md");
      results.push({
        target: `Workspace (${workspaceRoot})`,
        status: wsResult.status,
        message: wsResult.message,
      });
    } catch (error) {
      results.push({
        target: `Workspace (${workspaceRoot})`,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (results.length === 0) {
    results.push({
      target: "Trae",
      status: "skipped",
      message: "No Trae installation detected",
    });
  }

  return results;
}

/**
 * 安装 Cursor Rules（graphflow.mdc）到所有检测到的 Cursor 用户目录。
 */
export function installCursorRules(vendorRuntimeRoot?: string): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const rulesSourceDir = resolveCursorRulesSourcePath(vendorRuntimeRoot);

  if (!rulesSourceDir) {
    results.push({
      target: "Cursor",
      status: "skipped",
      message: "Cursor rules source (graphflow.mdc) not found",
    });
    return results;
  }

  const cursorDirs = getCursorRulesDirs();
  if (cursorDirs.length === 0) {
    results.push({
      target: "Cursor",
      status: "skipped",
      message: "No Cursor installation detected",
    });
    return results;
  }

  const sourceRulesFile = join(rulesSourceDir, "graphflow.mdc");

  for (const cursor of cursorDirs) {
    try {
      const result = installFile(sourceRulesFile, cursor.rulesDir, "graphflow.mdc");
      results.push({ target: cursor.name, status: result.status, message: result.message });
    } catch (error) {
      results.push({
        target: cursor.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * 安装 Claude Code CLAUDE.md 到检测到的 Claude Code 用户目录。
 */
export function installClaudeCodeMd(vendorRuntimeRoot?: string): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const sourcePath = resolveClaudeMdSourcePath(vendorRuntimeRoot);

  if (!sourcePath) {
    results.push({
      target: "Claude Code",
      status: "skipped",
      message: "CLAUDE.md source not found",
    });
    return results;
  }

  const claudeDirs = getClaudeCodeDirs();
  if (claudeDirs.length === 0) {
    results.push({
      target: "Claude Code",
      status: "skipped",
      message: "No Claude Code installation detected",
    });
    return results;
  }

  for (const claude of claudeDirs) {
    try {
      const result = installFile(sourcePath, claude.claudeDir, "CLAUDE.md");
      results.push({ target: claude.name, status: result.status, message: result.message });
    } catch (error) {
      results.push({
        target: claude.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

// ── 一站式安装函数 ────────────────────────────────────────────────────

/**
 * 一键安装所有 Skill / Rules / CLAUDE.md。
 * 所有失败静默处理（catch + 返回 error 状态），不会抛出异常。
 *
 * @param vendorRuntimeRoot 可选的 vendor 运行时根目录（VS Code 扩展中使用）
 * @param log 可选的日志回调，用于输出安装信息
 */
export function installAllSkills(
  vendorRuntimeRoot?: string,
  log?: (message: string) => void,
  workspaceRoot?: string
): SkillInstallSummary {
  const logFn = log ?? ((msg: string) => console.log(msg));

  const traeSkills = installTraeSkills(vendorRuntimeRoot, workspaceRoot);
  for (const result of traeSkills) {
    if (result.status === "error") {
      logFn(`[WARN] Trae Skill ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Trae Skill ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} Trae Skill for ${result.target}`);
  }

  const cursorRules = installCursorRules(vendorRuntimeRoot);
  for (const result of cursorRules) {
    if (result.status === "error") {
      logFn(`[WARN] Cursor Rules ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Cursor Rules ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} Cursor Rules for ${result.target}`);
  }

  const claudeMd = installClaudeCodeMd(vendorRuntimeRoot);
  for (const result of claudeMd) {
    if (result.status === "error") {
      logFn(`[WARN] Claude Code CLAUDE.md ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Claude Code CLAUDE.md ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} Claude Code CLAUDE.md for ${result.target}`);
  }

  // 向所有检测到的 agent 的全局规则/记忆文件安全写入 GraphFlow 指令块
  // （Windsurf / Codex / Gemini 等，append-with-markers，不覆盖用户内容）。
  const agentInstructions = installAgentInstructions();
  for (const result of agentInstructions) {
    if (result.status === "error") {
      logFn(`[WARN] Agent instructions ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Agent instructions ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} GraphFlow instructions for ${result.target}`);
  }

  // 安装"真正的 Agent Skill"（Cursor / Claude Code / Codex 的 skills/graphflow/SKILL.md），
  // 这样在 Cursor 的 Skills 列表中也能看到 graphflow，而不仅仅是 Rule。
  const agentSkills = installAgentSkills(vendorRuntimeRoot, workspaceRoot);
  for (const result of agentSkills) {
    if (result.status === "error") {
      logFn(`[WARN] Agent Skill ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Agent Skill ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} GraphFlow Skill for ${result.target}`);
  }

  return { traeSkills, cursorRules, claudeMd, agentInstructions, agentSkills };
}
