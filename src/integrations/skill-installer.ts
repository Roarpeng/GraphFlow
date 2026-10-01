/**
 * skill-installer.ts — 共享的 Skill / Rules 安装模块
 *
 * 封装 Trae Skill、Cursor Rules、Claude Code CLAUDE.md 的安装逻辑，
 * 可被 CLI init 和 VS Code 扩展共用。所有安装失败静默处理（log warn）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isUnsafeWorkspaceFallback } from "../config/discover-workspace.js";
import { resolveDshHome } from "./dsh-harness-installer";
import { resolveKimiCodeHome } from "./kimi-code-paths";
import { pruneEmptyDirsUpward } from "./config-file-cleanup";
import {
  GRAPHFLOW_BLOCK_BEGIN,
  GRAPHFLOW_BLOCK_END,
  isManagedContentInstalled,
  removeManagedBlockFile,
  wrapManagedBlock,
  writeManagedBlockFile,
} from "./managed-block";

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
  /** Project-level rule files (.cursor/rules, .trae/rules, .windsurfrules, etc.). */
  projectRules: SkillInstallResult[];
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
 * 1. Agent Plugins 1.0 `skills/graphflow/`（规范源）
 * 2. vendorRuntimeRoot（VS Code 扩展打包后 vendor/graphflow 路径）
 * 3. 兼容副本：dist/surfaces/trae-skill、src/surfaces/trae-skill
 */
export function resolveSkillSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    // Agent Plugins 1.0 fixed discovery path (canonical source)
    join(process.cwd(), "skills", "graphflow"),
    join(__dirname, "..", "..", "skills", "graphflow"),
    // VS Code 扩展 vendor 路径（打包后）
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "skills", "graphflow"),
          join(vendorRuntimeRoot, "src", "surfaces", "trae-skill", "graphflow"),
          join(vendorRuntimeRoot, "dist", "surfaces", "trae-skill", "graphflow"),
        ]
      : []),
    // 兼容副本 / 标准构建产物路径
    join(__dirname, "..", "surfaces", "trae-skill", "graphflow"),
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
 * 解析 Trae Rules 源文件路径（`.trae/rules/graphflow.md`）。
 */
export function resolveTraeRulesSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "src", "surfaces", "trae-rules"),
          join(vendorRuntimeRoot, "dist", "surfaces", "trae-rules"),
        ]
      : []),
    join(__dirname, "..", "surfaces", "trae-rules"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "trae-rules"),
    join(process.cwd(), "src", "surfaces", "trae-rules"),
    join(process.cwd(), "dist", "surfaces", "trae-rules"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "graphflow.md"))) {
      return dir;
    }
  }
  return undefined;
}

function surfaceDirCandidates(
  surfaceName: string,
  markerFile: string,
  vendorRuntimeRoot?: string
): string[] {
  return [
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "src", "surfaces", surfaceName),
          join(vendorRuntimeRoot, "dist", "surfaces", surfaceName),
        ]
      : []),
    join(__dirname, "..", "surfaces", surfaceName),
    join(__dirname, "..", "..", "..", "src", "surfaces", surfaceName),
    join(process.cwd(), "src", "surfaces", surfaceName),
    join(process.cwd(), "dist", "surfaces", surfaceName),
  ].filter((dir) => existsSync(join(dir, markerFile)));
}

/**
 * 解析 Antigravity 项目 Rules 源文件路径（`.agent/rules/graphflow.md`）。
 */
export function resolveAntigravityRulesSourcePath(vendorRuntimeRoot?: string): string | undefined {
  for (const dir of surfaceDirCandidates("antigravity-rules", "graphflow.md", vendorRuntimeRoot)) {
    return dir;
  }
  return undefined;
}

/**
 * 解析 GitHub Copilot 项目指令源文件路径（`.github/copilot-instructions.md`）。
 */
export function resolveCopilotInstructionsSourcePath(vendorRuntimeRoot?: string): string | undefined {
  for (const dir of surfaceDirCandidates("copilot-instructions", "graphflow.md", vendorRuntimeRoot)) {
    return dir;
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
    join(__dirname, "..", "surfaces", "cursor-rules"),
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

const INSTRUCTION_BEGIN = GRAPHFLOW_BLOCK_BEGIN;
const INSTRUCTION_END = GRAPHFLOW_BLOCK_END;

function readTemplate(sourcePath: string | undefined): string | undefined {
  if (!sourcePath || !existsSync(sourcePath)) return undefined;
  try {
    return readFileSync(sourcePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Full-file templates earlier versions copied verbatim over shared instruction files. */
function legacyInstructionTemplates(vendorRuntimeRoot?: string): string[] {
  const copilotDir = resolveCopilotInstructionsSourcePath(vendorRuntimeRoot);
  return [
    readTemplate(resolveClaudeMdSourcePath(vendorRuntimeRoot)),
    readTemplate(copilotDir ? join(copilotDir, "graphflow.md") : undefined),
  ].filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/**
 * Merge a GraphFlow template into a file the user may also own (CLAUDE.md,
 * AGENTS.md, .windsurfrules, copilot-instructions.md): the template goes inside
 * the managed markers, everything outside them is left untouched. A file that is
 * byte-for-byte an old full-file GraphFlow copy is converted to the block form.
 */
export function installManagedTemplateFile(
  sourcePath: string,
  filePath: string,
  vendorRuntimeRoot?: string
): { status: "created" | "updated" | "skipped" | "error"; message?: string } {
  const template = readTemplate(sourcePath);
  if (template === undefined) {
    return { status: "skipped", message: "Source file not found" };
  }
  return writeManagedBlockFile(filePath, wrapManagedBlock(template), {
    legacyWholeFile: legacyInstructionTemplates(vendorRuntimeRoot),
  });
}

/** True when a shared instruction file carries GraphFlow guidance (block or legacy full copy). */
export function isManagedTemplateInstalled(filePath: string, vendorRuntimeRoot?: string): boolean {
  return isManagedContentInstalled(filePath, { legacyWholeFile: legacyInstructionTemplates(vendorRuntimeRoot) });
}

/**
 * GraphFlow 的精简 token-first 指令块（受 Windsurf 6000 字符全局规则上限约束，保持简短）。
 * 写入各 agent 的全局规则/记忆文件，告诉模型优先调用 GraphFlow 压缩上下文。
 * 工具面为权威 10 工具集；首调必须是 `graphflow_context`（勿再用已弃用的 graphflow_preview_context）。
 */
export function buildInstructionBlock(): string {
  return [
    INSTRUCTION_BEGIN,
    "## GraphFlow Context-First Rule",
    "",
    "GraphFlow is a local code knowledge-graph + context compression MCP server (10 tools).",
    "Before broad code exploration, implementation, debugging, review, or architecture",
    "questions in this project:",
    "",
    "1. Call `graphflow_context` with the task/query first.",
    "2. Use the returned `summary`, `anchors`, and `tokenBudget` as the primary context.",
    "3. Read full files only when anchors point there or compressed context is insufficient.",
    "4. For multi-step or ambiguous work, call `graphflow_plan` before implementing.",
    "5. After project changes, call `graphflow_index` to keep the graph fresh.",
    "6. The flywheel auto-closes: pending episodes are backfilled by Claude Code",
    "   hooks (or `graphflow_report_outcome`) by default; set GRAPHFLOW_AUTO_CAPTURE=0 to opt out.",
    "",
    "Pass `rootDir` = this project's absolute path. Never pass your home directory, AppData,",
    "or an unexpanded `${workspaceFolder}` placeholder — GraphFlow refuses unsafe workspace",
    "roots. If a call answers `unsafe workspace root`, retry it without `rootDir`.",
    "",
    "When using Cursor `CallMcpTool`, always pass `server` + `toolName` + `arguments`",
    "(e.g. server `\"graphflow\"` / `\"user-graphflow\"`, toolName `\"graphflow_context\"`).",
    "",
    "Tools: graphflow_context, graphflow_plan, graphflow_run, graphflow_report_outcome,",
    "graphflow_insight, graphflow_index, graphflow_artifact, graphflow_skill_insights,",
    "graphflow_skill_guide, graphflow_diagnose.",
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
  _destDirToCreate: string
): { status: "created" | "updated" | "skipped" | "error"; message?: string } {
  return writeManagedBlockFile(filePath, buildInstructionBlock());
}

/** 各 agent 的全局指令/记忆文件目标（仅在检测到对应 marker 时写入）。 */
export function getAgentInstructionTargets(): Array<{
  agent: string;
  markerDir: string;
  destDir: string;
  filePath: string;
}> {
  const { home, appData } = resolveHomePaths();
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

  // Claude Code 项目/用户级规则：~/.claude/rules/graphflow.md
  targets.push({
    agent: "Claude Code rules",
    markerDir: join(home, ".claude"),
    destDir: join(home, ".claude", "rules"),
    filePath: join(home, ".claude", "rules", "graphflow.md"),
  });

  // Roo Code 全局指令：~/.roo/rules/AGENTS.md
  targets.push({
    agent: "Roo Code",
    markerDir: join(home, ".roo"),
    destDir: join(home, ".roo", "rules"),
    filePath: join(home, ".roo", "rules", "AGENTS.md"),
  });

  // Kilo Code 全局指令：~/.kilocode/AGENTS.md
  targets.push({
    agent: "Kilo Code",
    markerDir: join(home, ".kilocode"),
    destDir: join(home, ".kilocode"),
    filePath: join(home, ".kilocode", "AGENTS.md"),
  });

  // Opencode 全局指令：~/.config/opencode/AGENTS.md
  targets.push({
    agent: "Opencode",
    markerDir: join(home, ".config", "opencode"),
    destDir: join(home, ".config", "opencode"),
    filePath: join(home, ".config", "opencode", "AGENTS.md"),
  });

  // ZCode 全局指令：~/.zcode/AGENTS.md
  targets.push({
    agent: "ZCode",
    markerDir: join(home, ".zcode"),
    destDir: join(home, ".zcode"),
    filePath: join(home, ".zcode", "AGENTS.md"),
  });

  // Kimi Code 全局指令：~/.kimi-code/AGENTS.md（或 $KIMI_CODE_HOME / GRAPHFLOW_KIMI_CODE_HOME）
  const kimiHome = resolveKimiCodeHome();
  targets.push({
    agent: "Kimi Code",
    markerDir: kimiHome,
    destDir: kimiHome,
    filePath: join(kimiHome, "AGENTS.md"),
  });

  // Cline 全局指令：Documents/Cline/Rules/graphflow.md
  const documentsDir = isWindows ? join(home, "Documents") : join(home, "Documents");
  const clineMarkerCandidates = [
    join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
    join(appData, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev"),
  ];
  const clineMarkerDir = (clineMarkerCandidates.find((d) => existsSync(d)) ?? clineMarkerCandidates[0])!;
  targets.push({
    agent: "Cline",
    markerDir: clineMarkerDir,
    destDir: join(documentsDir, "Cline", "Rules"),
    filePath: join(documentsDir, "Cline", "Rules", "graphflow.md"),
  });

  return targets;
}

/**
 * 将 GraphFlow 指令块安全写入所有检测到的 agent 的全局规则/记忆文件。
 * 使用 append-with-markers，绝不覆盖用户已有内容。
 */
export function installAgentInstructions(): SkillInstallResult[] {
  const results = installInstructionsToTargets(getAgentInstructionTargets().map((target) => target.agent));

  if (results.length === 0) {
    results.push({ target: "Agent instructions", status: "skipped", message: "No supported agent detected" });
  }

  return results;
}

/**
 * 将 GraphFlow 受管指令块写入**指定** agent 的全局规则/记忆文件（按 agent 名精确匹配）。
 *
 * HostAdapter 迁移用：让单个宿主的 install slice 只写自己的文件，
 * 不因为"机器上还装了别的 agent"而顺带写入其它宿主。
 * 未检测到（marker 目录不存在）的 agent 返回 skipped，绝不创建目录。
 */
export function installInstructionsToTargets(agentNames: readonly string[]): SkillInstallResult[] {
  const wanted = new Set(agentNames);
  const results: SkillInstallResult[] = [];

  for (const target of getAgentInstructionTargets()) {
    if (!wanted.has(target.agent)) continue;
    if (!existsSync(target.markerDir)) {
      results.push({ target: target.agent, status: "skipped", message: "agent not detected" });
      continue;
    }
    const result = upsertManagedBlock(target.filePath, target.destDir);
    results.push({ target: target.agent, status: result.status, message: result.message });
  }

  return results;
}

/** 从**指定** agent 的全局指令文件移除 GraphFlow 受管块（HostAdapter 卸载用）。 */
export function removeInstructionsFromTargets(agentNames: readonly string[]): SkillInstallResult[] {
  const wanted = new Set(agentNames);
  const results: SkillInstallResult[] = [];

  for (const target of getAgentInstructionTargets()) {
    if (!wanted.has(target.agent)) continue;
    const removed = removeManagedBlock(target.filePath);
    results.push({
      target: target.agent,
      status: removed ? "updated" : "skipped",
      message: removed ? "removed managed block" : "no managed block",
    });
  }

  return results;
}

/** 检查每个 agent 的全局指令文件是否含 GraphFlow 受管块（用于 doctor 自检）。 */
export function getAgentInstructionStatus(): AgentInstructionStatus[] {
  return getAgentInstructionTargets().map((target) => {
    const detected = existsSync(target.markerDir);
    let installed = false;
    if (existsSync(target.filePath)) {
      // existsSync + readFileSync 之间存在竞态窗口（并行测试/安装可删除文件）；
      // 读失败一律视为未安装，不抛异常。
      try {
        const content = readFileSync(target.filePath, "utf8");
        installed = content.includes(INSTRUCTION_BEGIN) && content.includes(INSTRUCTION_END);
      } catch {
        installed = false;
      }
    }
    return { agent: target.agent, configPath: target.filePath, detected, installed };
  });
}

// ── 项目级规则/指令文件 ─────────────────────────────────────────────

/**
 * 返回项目级规则/指令文件的目标路径列表（相对于 workspace root）。
 * 这些文件在 install --scope all 时写入项目目录，随 Git 共享给团队。
 */
export function getProjectLevelRuleTargets(workspaceRoot: string): Array<{
  agent: string;
  destDir: string;
  filePath: string;
  sourceType:
    | "cursor-rules"
    | "trae-rules"
    | "trae-skill-file"
    | "antigravity-rules"
    | "antigravity-skill-file"
    | "windsurf-rules"
    | "copilot-instructions"
    | "claude-rules"
    | "agentic-md";
}> {
  if (!workspaceRoot) return [];
  return [
    // Trae CN / Trae SOLO 项目级 Rules（alwaysApply，每轮注入）
    {
      agent: "Trae CN (project rules)",
      destDir: join(workspaceRoot, ".trae", "rules"),
      filePath: join(workspaceRoot, ".trae", "rules", "graphflow.md"),
      sourceType: "trae-rules",
    },
    // Trae 项目级 Skill（`#graphflow` / 语义匹配）
    {
      agent: "Trae CN (project skills)",
      destDir: join(workspaceRoot, ".trae", "skills", "graphflow"),
      filePath: join(workspaceRoot, ".trae", "skills", "graphflow", "SKILL.md"),
      sourceType: "trae-skill-file",
    },
    // Cursor 项目级 rules: .cursor/rules/graphflow.mdc
    {
      agent: "Cursor (project rules)",
      destDir: join(workspaceRoot, ".cursor", "rules"),
      filePath: join(workspaceRoot, ".cursor", "rules", "graphflow.mdc"),
      sourceType: "cursor-rules",
    },
    // Windsurf 项目级规则: .windsurfrules
    {
      agent: "Windsurf (project rules)",
      destDir: workspaceRoot,
      filePath: join(workspaceRoot, ".windsurfrules"),
      sourceType: "windsurf-rules",
    },
    // Claude Code 项目级规则: .claude/rules/graphflow.md
    {
      agent: "Claude Code (project rules)",
      destDir: join(workspaceRoot, ".claude", "rules"),
      filePath: join(workspaceRoot, ".claude", "rules", "graphflow.md"),
      sourceType: "claude-rules",
    },
    // Antigravity 项目级 Rules: .agent/rules/graphflow.md
    {
      agent: "Antigravity (project rules)",
      destDir: join(workspaceRoot, ".agent", "rules"),
      filePath: join(workspaceRoot, ".agent", "rules", "graphflow.md"),
      sourceType: "antigravity-rules",
    },
    // Antigravity 项目级 Skill: .agent/skills/graphflow/SKILL.md
    {
      agent: "Antigravity (project skills)",
      destDir: join(workspaceRoot, ".agent", "skills", "graphflow"),
      filePath: join(workspaceRoot, ".agent", "skills", "graphflow", "SKILL.md"),
      sourceType: "antigravity-skill-file",
    },
    // GitHub Copilot 项目级指令: .github/copilot-instructions.md
    {
      agent: "GitHub Copilot (project instructions)",
      destDir: join(workspaceRoot, ".github"),
      filePath: join(workspaceRoot, ".github", "copilot-instructions.md"),
      sourceType: "copilot-instructions",
    },
    // AGENTS.md — 多 Agent 兼容的项目级指令（Claude Code、Codex、Cursor 均可读取）
    {
      agent: "AGENTS.md (multi-agent)",
      destDir: workspaceRoot,
      filePath: join(workspaceRoot, "AGENTS.md"),
      sourceType: "agentic-md",
    },
  ];
}

export type ProjectRuleSourceType = ReturnType<typeof getProjectLevelRuleTargets>[number]["sourceType"];

export interface ProjectRuleOptions {
  /**
   * Detected host ids (agent-mcp-installer profile ids). When given, a project
   * file is written only if a host that reads it is present; undefined keeps
   * the legacy "write every project file" behaviour.
   */
  detectedHostIds?: ReadonlySet<string>;
}

/** Project files that users commonly author themselves: GraphFlow only manages a marked block in them. */
const SHARED_PROJECT_RULE_TYPES = new Set<ProjectRuleSourceType>(["agentic-md", "windsurf-rules", "copilot-instructions"]);

/** Hosts whose presence justifies each project file; "any" = any detected host reads it (AGENTS.md). */
const PROJECT_RULE_HOSTS: Record<ProjectRuleSourceType, readonly string[] | "any"> = {
  "trae-rules": ["trae", "trae-windows"],
  "trae-skill-file": ["trae", "trae-windows"],
  "cursor-rules": ["cursor", "cursor-windows"],
  "windsurf-rules": ["windsurf", "windsurf-windows"],
  "claude-rules": ["claude-code", "claude-code-windows"],
  "antigravity-rules": ["antigravity"],
  "antigravity-skill-file": ["antigravity"],
  "copilot-instructions": ["vscode", "vscode-windows"],
  "agentic-md": "any",
};

const PROJECT_GEMINI_HOSTS = ["gemini", "gemini-windows", "antigravity"] as const;

function anyDetected(hosts: readonly string[] | "any", detected: ReadonlySet<string> | undefined): boolean {
  if (!detected) return true;
  if (hosts === "any") return detected.size > 0;
  return hosts.some((id) => detected.has(id));
}

export function isProjectRuleWanted(sourceType: ProjectRuleSourceType, detectedHostIds?: ReadonlySet<string>): boolean {
  return anyDetected(PROJECT_RULE_HOSTS[sourceType], detectedHostIds);
}

function isProjectGeminiWanted(detectedHostIds?: ReadonlySet<string>): boolean {
  return anyDetected(PROJECT_GEMINI_HOSTS, detectedHostIds);
}

/**
 * Doctor view of the project files install would write, using the same host
 * gating and the same "is GraphFlow's content there" test install relies on.
 * Empty when the root is the home directory (install refuses to write there).
 */
export function getProjectLevelRuleStatus(
  workspaceRoot: string,
  options: ProjectRuleOptions = {}
): AgentInstructionStatus[] {
  if (!workspaceRoot || isUnsafeWorkspaceFallback(resolve(workspaceRoot))) return [];
  const out: AgentInstructionStatus[] = [];
  for (const target of getProjectLevelRuleTargets(workspaceRoot)) {
    if (!isProjectRuleWanted(target.sourceType, options.detectedHostIds)) continue;
    const installed = SHARED_PROJECT_RULE_TYPES.has(target.sourceType)
      ? isManagedTemplateInstalled(target.filePath)
      : existsSync(target.filePath);
    out.push({ agent: target.agent, configPath: target.filePath, detected: true, installed });
  }
  if (isProjectGeminiWanted(options.detectedHostIds)) {
    const geminiPath = join(workspaceRoot, "GEMINI.md");
    out.push({
      agent: "Antigravity/Gemini project GEMINI.md",
      configPath: geminiPath,
      detected: true,
      installed: isManagedContentInstalled(geminiPath),
    });
  }
  return out;
}

// ── Agent Skill 文件夹安装（真正的 Cursor / Claude / Codex Skill） ────────

/**
 * 各 agent 的"真正的 Skill"目录目标（仅在检测到对应 marker 时写入）。
 *
 * 重要：Cursor 自定义 Skill 的正确目录是 `~/.cursor/skills/<name>/SKILL.md`，
 * 绝不能写入 `~/.cursor/skills-cursor/`（那是 Cursor 内置 Skill 的保留目录）。
 * Claude Code / Codex 同样支持 `~/.claude/skills/`、`~/.codex/skills/` 约定。
 */
export function getAgentSkillTargets(): Array<{
  agent: string;
  markerDir: string;
  skillsRoot: string;
}> {
  const { home } = resolveHomePaths();
  return [
    {
      agent: "Cursor",
      markerDir: join(home, ".cursor"),
      skillsRoot: join(home, ".cursor", "skills"),
    },
    {
      agent: "Claude Code",
      markerDir: join(home, ".claude"),
      skillsRoot: join(home, ".claude", "skills"),
    },
    {
      agent: "Codex",
      markerDir: join(home, ".codex"),
      skillsRoot: join(home, ".codex", "skills"),
    },
    {
      agent: "Codex (agents)",
      markerDir: join(home, ".codex"),
      skillsRoot: join(home, ".agents", "skills"),
    },
    {
      agent: "Roo Code",
      markerDir: join(home, ".roo"),
      skillsRoot: join(home, ".roo", "skills"),
    },
    {
      agent: "Kilo Code",
      markerDir: join(home, ".kilocode"),
      skillsRoot: join(home, ".kilocode", "skills"),
    },
    {
      agent: "Antigravity",
      markerDir: join(home, ".gemini", "antigravity"),
      skillsRoot: join(home, ".gemini", "antigravity", "skills"),
    },
    {
      agent: "Qoder",
      markerDir: join(home, ".qoder"),
      skillsRoot: join(home, ".qoder", "skills"),
    },
    {
      // Qoder CN 版（~/.qoder-cn/skills）
      agent: "Qoder CN",
      markerDir: join(home, ".qoder-cn"),
      skillsRoot: join(home, ".qoder-cn", "skills"),
    },
    {
      agent: "DeepSeek Harness",
      markerDir: resolveDshHome(),
      skillsRoot: join(resolveDshHome(), "skills"),
    },
    {
      agent: "Kimi Code",
      markerDir: resolveKimiCodeHome(),
      skillsRoot: join(resolveKimiCodeHome(), "skills"),
    },
    {
      agent: "ZCode",
      markerDir: join(home, ".zcode"),
      skillsRoot: join(home, ".zcode", "skills"),
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

  if (allFailed && workspaceRoot && !isUnsafeWorkspaceFallback(resolve(workspaceRoot))) {
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

/**
 * 将 GraphFlow SKILL.md 安装到**指定** agent 的 Skill 目录（按 agent 名精确匹配）。
 *
 * HostAdapter 迁移用：单宿主 install slice 只写自己的 `skills/graphflow/SKILL.md`。
 * 未检测到（marker 目录不存在）的 agent 返回 skipped，绝不创建目录。
 */
export function installSkillToTargets(
  agentNames: readonly string[],
  vendorRuntimeRoot?: string
): SkillInstallResult[] {
  const wanted = new Set(agentNames);
  const results: SkillInstallResult[] = [];
  const skillSourceDir = resolveSkillSourcePath(vendorRuntimeRoot);

  if (!skillSourceDir) {
    return [{ target: "Agent skills", status: "skipped", message: "Skill source (SKILL.md) not found" }];
  }

  const sourceSkillFile = join(skillSourceDir, "SKILL.md");

  for (const target of getAgentSkillTargets()) {
    if (!wanted.has(target.agent)) continue;
    if (!existsSync(target.markerDir)) {
      results.push({ target: target.agent, status: "skipped", message: "agent not detected" });
      continue;
    }
    try {
      const destDir = join(target.skillsRoot, "graphflow");
      const result = installFile(sourceSkillFile, destDir, "SKILL.md");
      results.push({ target: target.agent, status: result.status, message: result.message });
    } catch (error) {
      results.push({
        target: target.agent,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/** 从**指定** agent 的 Skill 目录移除 graphflow Skill（HostAdapter 卸载用）。 */
export function removeSkillFromTargets(agentNames: readonly string[]): SkillInstallResult[] {
  const wanted = new Set(agentNames);
  const results: SkillInstallResult[] = [];

  for (const target of getAgentSkillTargets()) {
    if (!wanted.has(target.agent)) continue;
    const removed = removeAgentSkill(target.skillsRoot);
    results.push({
      target: target.agent,
      status: removed ? "updated" : "skipped",
      message: removed ? "removed graphflow skill" : "no graphflow skill",
    });
  }

  return results;
}

/** 检查 Trae 用户 Skill 与项目级 Rules/Skill 安装状态（doctor 用）。 */
export function getTraeInstallStatus(workspaceRoot?: string): AgentInstructionStatus[] {
  const out: AgentInstructionStatus[] = [];

  for (const trae of getTraeUserDirs()) {
    const filePath = join(trae.skillsDir, "graphflow", "SKILL.md");
    out.push({
      agent: `${trae.name} skill`,
      configPath: filePath,
      detected: true,
      installed: existsSync(filePath),
    });
  }

  if (workspaceRoot) {
    const rulePath = join(workspaceRoot, ".trae", "rules", "graphflow.md");
    out.push({
      agent: "Trae CN project rules",
      configPath: rulePath,
      detected: existsSync(join(workspaceRoot, ".trae")),
      installed: existsSync(rulePath),
    });
    const projectSkillPath = join(workspaceRoot, ".trae", "skills", "graphflow", "SKILL.md");
    out.push({
      agent: "Trae CN project skill",
      configPath: projectSkillPath,
      detected: existsSync(join(workspaceRoot, ".trae", "skills")),
      installed: existsSync(projectSkillPath),
    });
  }

  return out;
}

/** 检查 Antigravity 用户 Skill 与项目级 Rules/Skill 安装状态（doctor 用）。 */
export function getAntigravityInstallStatus(workspaceRoot?: string): AgentInstructionStatus[] {
  const { home } = resolveHomePaths();
  const out: AgentInstructionStatus[] = [];
  const markerDir = join(home, ".gemini", "antigravity");
  const globalSkillPath = join(markerDir, "skills", "graphflow", "SKILL.md");

  if (existsSync(markerDir)) {
    out.push({
      agent: "Antigravity global skill",
      configPath: globalSkillPath,
      detected: true,
      installed: existsSync(globalSkillPath),
    });
    const mcpPath = join(markerDir, "mcp_config.json");
    out.push({
      agent: "Antigravity MCP config",
      configPath: mcpPath,
      detected: true,
      installed: existsSync(mcpPath),
    });
  }

  if (workspaceRoot) {
    const rulePath = join(workspaceRoot, ".agent", "rules", "graphflow.md");
    out.push({
      agent: "Antigravity project rules",
      configPath: rulePath,
      detected: existsSync(join(workspaceRoot, ".agent")) || existsSync(join(workspaceRoot, ".agents")),
      installed: existsSync(rulePath),
    });
    const projectSkillPath = join(workspaceRoot, ".agent", "skills", "graphflow", "SKILL.md");
    out.push({
      agent: "Antigravity project skill",
      configPath: projectSkillPath,
      detected: existsSync(join(workspaceRoot, ".agent", "skills")),
      installed: existsSync(projectSkillPath),
    });
    const geminiMdPath = join(workspaceRoot, "GEMINI.md");
    let geminiInstalled = false;
    if (existsSync(geminiMdPath)) {
      const content = readFileSync(geminiMdPath, "utf8");
      geminiInstalled = content.includes(INSTRUCTION_BEGIN) && content.includes(INSTRUCTION_END);
    }
    out.push({
      agent: "Antigravity/Gemini project GEMINI.md",
      configPath: geminiMdPath,
      detected: true,
      installed: geminiInstalled,
    });
  }

  return out;
}

/** 检查 GitHub Copilot 项目指令安装状态（doctor 用）。 */
export function getCopilotInstallStatus(workspaceRoot?: string): AgentInstructionStatus[] {
  if (!workspaceRoot) return [];
  const filePath = join(workspaceRoot, ".github", "copilot-instructions.md");
  return [
    {
      agent: "GitHub Copilot project instructions",
      configPath: filePath,
      detected: true,
      installed: existsSync(filePath),
    },
  ];
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
export function installTraeSkills(
  vendorRuntimeRoot?: string,
  workspaceRoot?: string,
  options: ProjectRuleOptions = {}
): SkillInstallResult[] {
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

  // Project-scoped copies obey the same guards as the other project files:
  // never into the home directory, and only when Trae is actually present.
  const projectSkillsWanted =
    Boolean(workspaceRoot) &&
    !isUnsafeWorkspaceFallback(resolve(workspaceRoot!)) &&
    isProjectRuleWanted("trae-skill-file", options.detectedHostIds);
  if (workspaceRoot && !projectSkillsWanted) {
    results.push({
      target: "Trae project skill",
      status: "skipped",
      message: isUnsafeWorkspaceFallback(resolve(workspaceRoot))
        ? "home directory is not a project root"
        : "agent not detected",
    });
  } else if (workspaceRoot) {
    for (const destDir of [
      join(workspaceRoot, ".trae", "skills", "graphflow"),
      join(workspaceRoot, ".graphflow", "skills", "graphflow"),
    ]) {
      try {
        const wsResult = installFile(sourceSkillFile, destDir, "SKILL.md");
        results.push({
          target: `Trae project skill (${basename(destDir)})`,
          status: wsResult.status,
          message: wsResult.message,
        });
      } catch (error) {
        results.push({
          target: `Trae project skill (${basename(destDir)})`,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else if (allFailed) {
    results.push({
      target: "Trae",
      status: "skipped",
      message: "No Trae installation detected (pass workspaceRoot for project-level .trae/skills)",
    });
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
      // ~/.claude/CLAUDE.md is the user's own memory file: merge a managed block.
      const result = installManagedTemplateFile(sourcePath, join(claude.claudeDir, "CLAUDE.md"), vendorRuntimeRoot);
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
 * 安装项目级规则文件（仅在 workspaceRoot 提供时生效）。
 * 这些文件会写入项目目录，可通过 Git 共享给团队。
 */
export function installProjectLevelRules(
  workspaceRoot: string,
  vendorRuntimeRoot?: string,
  log?: (message: string) => void,
  options: ProjectRuleOptions = {}
): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  if (!workspaceRoot) return results;

  const logFn = log ?? ((msg: string) => console.log(msg));

  // Refuse to scatter project files into the user's home directory. Observed on
  // both Ubuntu and Windows: running `graphflow install` from `~` /
  // `C:\Users\x` makes every "project" target resolve to the home directory, and
  // one of these writers is a plain copy without managed-block markers, so it
  // overwrote a marker-ful instruction file with a bare AGENTS.md copy. doctor
  // then reported the file as `missing` (it checks for the markers) while install
  // reported "already up to date" — the same file, two opposite verdicts.
  // Graph index already refuses an unsafe root; project files must too.
  if (isUnsafeWorkspaceFallback(resolve(workspaceRoot))) {
    const message =
      `Refusing to write project rule files into the home directory (${workspaceRoot}). ` +
      `Run \`graphflow install\` from a project directory.`;
    logFn(`[SKIP] ${message}`);
    for (const target of getProjectLevelRuleTargets(workspaceRoot)) {
      results.push({ target: target.agent, status: "skipped", message: "home directory is not a project root" });
    }
    return results;
  }

  const targets = getProjectLevelRuleTargets(workspaceRoot);

  for (const target of targets) {
    if (!isProjectRuleWanted(target.sourceType, options.detectedHostIds)) {
      results.push({ target: target.agent, status: "skipped", message: "agent not detected" });
      continue;
    }
    try {
      let sourcePath: string | undefined;

      switch (target.sourceType) {
        case "cursor-rules": {
          const rulesDir = resolveCursorRulesSourcePath(vendorRuntimeRoot);
          if (rulesDir) sourcePath = join(rulesDir, "graphflow.mdc");
          break;
        }
        case "trae-rules": {
          const traeRulesDir = resolveTraeRulesSourcePath(vendorRuntimeRoot);
          if (traeRulesDir) sourcePath = join(traeRulesDir, "graphflow.md");
          break;
        }
        case "trae-skill-file": {
          const skillDir = resolveSkillSourcePath(vendorRuntimeRoot);
          if (skillDir) sourcePath = join(skillDir, "SKILL.md");
          break;
        }
        case "antigravity-rules": {
          const rulesDir = resolveAntigravityRulesSourcePath(vendorRuntimeRoot);
          if (rulesDir) sourcePath = join(rulesDir, "graphflow.md");
          break;
        }
        case "antigravity-skill-file": {
          const skillDir = resolveSkillSourcePath(vendorRuntimeRoot);
          if (skillDir) sourcePath = join(skillDir, "SKILL.md");
          break;
        }
        case "copilot-instructions": {
          const copilotDir = resolveCopilotInstructionsSourcePath(vendorRuntimeRoot);
          if (copilotDir) sourcePath = join(copilotDir, "graphflow.md");
          break;
        }
        case "claude-rules":
        case "agentic-md": {
          const mdPath = resolveClaudeMdSourcePath(vendorRuntimeRoot);
          if (mdPath) sourcePath = mdPath;
          break;
        }
        case "windsurf-rules": {
          // Windsurf 使用纯文本指令块
          const mdPath = resolveClaudeMdSourcePath(vendorRuntimeRoot);
          if (mdPath) sourcePath = mdPath;
          break;
        }
      }

      if (!sourcePath || !existsSync(sourcePath)) {
        results.push({ target: target.agent, status: "skipped", message: "Source file not found" });
        continue;
      }

      const result = SHARED_PROJECT_RULE_TYPES.has(target.sourceType)
        ? installManagedTemplateFile(sourcePath, target.filePath, vendorRuntimeRoot)
        : installFile(sourcePath, target.destDir, basename(target.filePath));
      results.push({ target: target.agent, status: result.status, message: result.message });

      if (result.status === "created" || result.status === "updated") {
        logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} ${target.agent}: ${target.filePath}`);
      }
    } catch (error) {
      results.push({
        target: target.agent,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * 向项目根目录 GEMINI.md 写入 GraphFlow 受管指令块（Antigravity / Gemini CLI 项目级规则）。
 */
export function installProjectGeminiInstructions(
  workspaceRoot: string,
  options: ProjectRuleOptions = {}
): SkillInstallResult[] {
  if (!workspaceRoot) return [];
  if (!isProjectGeminiWanted(options.detectedHostIds)) {
    return [{ target: "Antigravity/Gemini project GEMINI.md", status: "skipped", message: "agent not detected" }];
  }
  // Same home-root guard as installProjectLevelRules. Verified residue on a
  // machine where install was run from `~`: a 1.6 KB `~/GEMINI.md`.
  if (isUnsafeWorkspaceFallback(resolve(workspaceRoot))) {
    return [
      {
        target: "Antigravity/Gemini project GEMINI.md",
        status: "skipped",
        message: "home directory is not a project root",
      },
    ];
  }
  const filePath = join(workspaceRoot, "GEMINI.md");
  const result = upsertManagedBlock(filePath, workspaceRoot);
  return [{ target: "Antigravity/Gemini project GEMINI.md", status: result.status, message: result.message }];
}

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
  workspaceRoot?: string,
  options: ProjectRuleOptions = {}
): SkillInstallSummary {
  const logFn = log ?? ((msg: string) => console.log(msg));

  const traeSkills = installTraeSkills(vendorRuntimeRoot, workspaceRoot, options);
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
  // With host gating on, an empty detection result means "nothing to configure",
  // not "drop a fallback Skill into the project".
  const agentSkills = installAgentSkills(
    vendorRuntimeRoot,
    options.detectedHostIds ? undefined : workspaceRoot
  );
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

  // 安装项目级规则文件
  const projectRules = [
    ...installProjectLevelRules(workspaceRoot ?? "", vendorRuntimeRoot, logFn, options),
    ...(workspaceRoot ? installProjectGeminiInstructions(workspaceRoot, options) : []),
  ];

  return { traeSkills, cursorRules, claudeMd, agentInstructions, agentSkills, projectRules };
}

// ── 卸载辅助函数 ──────────────────────────────────────────────────────

/** 从文件中移除 GraphFlow 受管指令块（如果存在） */
export function removeManagedBlock(filePath: string): boolean {
  try {
    return removeManagedBlockFile(filePath);
  } catch {
    return false;
  }
}

/** 移除指定 agent 的 GraphFlow Skill 目录 */
export function removeAgentSkill(skillsRoot: string, skillName = "graphflow"): boolean {
  const skillDir = join(skillsRoot, skillName);
  if (!existsSync(skillDir)) return false;
  try {
    rmSync(skillDir, { recursive: true, force: true });
    // On some Windows environments rmSync may silently succeed without removing files.
    // Verify and retry if necessary: remove contents first, then the empty directory.
    if (existsSync(skillDir)) {
      _rimraf(skillDir);
    }
    pruneEmptyDirsUpward(skillsRoot);
    return true;
  } catch { return false; }
}

/** Cross-platform recursive directory removal fallback. */
function _rimraf(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      _rimraf(full);
    } else {
      rmSync(full, { force: true });
    }
  }
  try { rmdirSync(dirPath); } catch { /* ignore */ }
}

function removeFileIfExists(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    rmSync(filePath, { force: true });
    return !existsSync(filePath);
  } catch {
    return false;
  }
}

/** True when content looks like a GraphFlow-owned install (not a lightly annotated user file). */
export function looksLikeGraphFlowOwnedContent(content: string): boolean {
  if (!content.includes("graphflow_context")) return false;
  return (
    content.includes(INSTRUCTION_BEGIN) ||
    content.includes("Token-First Rule") ||
    content.includes("10 MCP tools") ||
    content.includes("graphflow-mcp") ||
    content.includes("A Context-Aware Multi-Agent Orchestration Engine") ||
    content.includes("memory & context harness") ||
    /^\s*#\s*GraphFlow\b/m.test(content)
  );
}

/**
 * Remove a GraphFlow-owned file:
 * - `graphflow.md` / `graphflow.mdc` → delete
 * - managed-marker files → strip block
 * - known instruction filenames that are wholly GraphFlow content → delete
 */
export function removeGraphFlowOwnedFile(filePath: string): boolean {
  const removed = removeGraphFlowOwnedFileContent(filePath);
  if (removed && !existsSync(filePath)) pruneEmptyDirsUpward(dirname(filePath));
  return removed;
}

function removeGraphFlowOwnedFileContent(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const name = basename(filePath);
  if (/^graphflow\.(md|mdc)$/i.test(name)) {
    return removeFileIfExists(filePath);
  }
  // Shared instruction files (CLAUDE.md, AGENTS.md, ...) lose only GraphFlow's
  // managed block. Without markers the file is deleted only when it is an exact,
  // unmodified copy of a GraphFlow template — never on a content heuristic,
  // because a user file that merely mentions GraphFlow is still the user's.
  // The template's own directory (the GraphFlow checkout) is never touched.
  const legacy = isTemplateSourceDir(dirname(filePath)) ? [] : legacyInstructionTemplates();
  try {
    return removeManagedBlockFile(filePath, { legacyWholeFile: legacy });
  } catch {
    return false;
  }
}

function isTemplateSourceDir(dir: string): boolean {
  const source = resolveClaudeMdSourcePath();
  return source !== undefined && resolve(dirname(source)) === resolve(dir);
}

export interface SkillUninstallResult {
  target: string;
  path: string;
  removed: boolean;
  message?: string;
}

/**
 * Uninstall all GraphFlow Skills, Rules, and managed instruction blocks
 * written by `graphflow install` / `installAllSkills`.
 *
 * Call this together with MCP uninstall so Agent Plugin / IDE uninstall
 * leftovers cannot keep guiding agents toward GraphFlow tools.
 */
export function uninstallAllSkillsAndRules(workspaceRoot?: string): SkillUninstallResult[] {
  const results: SkillUninstallResult[] = [];
  const root = workspaceRoot?.trim() ? workspaceRoot : process.cwd();

  const push = (target: string, path: string, removed: boolean, message?: string) => {
    results.push({ target, path, removed, ...(message ? { message } : {}) });
  };

  // 1) User-level agent skills (~/.cursor/skills/graphflow, etc.)
  for (const target of getAgentSkillTargets()) {
    const skillDir = join(target.skillsRoot, "graphflow");
    const removed = removeAgentSkill(target.skillsRoot);
    push(`${target.agent} skill`, skillDir, removed, removed ? "removed" : "not found");
  }

  // 2) Trae user skills
  for (const trae of getTraeUserDirs()) {
    const skillDir = join(trae.skillsDir, "graphflow");
    const removed = removeAgentSkill(trae.skillsDir);
    push(`${trae.name} skill`, skillDir, removed, removed ? "removed" : "not found");
  }

  // 3) Cursor user rules
  for (const cursor of getCursorRulesDirs()) {
    const filePath = join(cursor.rulesDir, "graphflow.mdc");
    const removed = removeGraphFlowOwnedFile(filePath);
    push(`${cursor.name} rules`, filePath, removed, removed ? "removed" : "not found");
  }

  // 4) Claude Code user CLAUDE.md
  for (const claude of getClaudeCodeDirs()) {
    const filePath = join(claude.claudeDir, "CLAUDE.md");
    const removed = removeGraphFlowOwnedFile(filePath);
    push(`${claude.name} CLAUDE.md`, filePath, removed, removed ? "removed" : "not found / kept (user content)");
  }

  // 5) Global agent instruction targets
  for (const target of getAgentInstructionTargets()) {
    const removed = removeGraphFlowOwnedFile(target.filePath);
    push(`${target.agent} instructions`, target.filePath, removed, removed ? "removed" : "not found / kept");
  }

  // 6) Project-level rules / skills / instruction files
  for (const target of getProjectLevelRuleTargets(root)) {
    if (
      target.sourceType === "trae-skill-file" ||
      target.sourceType === "antigravity-skill-file"
    ) {
      // destDir is .../skills/graphflow — parent is the skills root
      const skillsRoot = dirname(target.destDir);
      const ok = removeAgentSkill(skillsRoot);
      push(target.agent, target.destDir, ok, ok ? "removed" : "not found");
      continue;
    }
    const removed = removeGraphFlowOwnedFile(target.filePath);
    push(target.agent, target.filePath, removed, removed ? "removed" : "not found / kept");
  }

  // 7) Workspace fallback skill cache
  const workspaceSkillParent = join(root, ".graphflow", "skills");
  const wsRemoved = removeAgentSkill(workspaceSkillParent);
  push("Workspace .graphflow/skills", join(workspaceSkillParent, "graphflow"), wsRemoved, wsRemoved ? "removed" : "not found");

  // 8) Project GEMINI.md managed block / owned file
  const geminiPath = join(root, "GEMINI.md");
  const geminiRemoved = removeGraphFlowOwnedFile(geminiPath);
  push("Project GEMINI.md", geminiPath, geminiRemoved, geminiRemoved ? "removed" : "not found / kept");

  return results;
}
