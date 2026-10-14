/**
 * GraphFlow slim bridge runtime (`src/runtime.ts`)
 *
 * Self-contained facade for the VS Code extension (and any dynamic importer
 * that expects the pre-slim runtime surface). The slim engine backs what it
 * can for real (context preview via the AST slicer, workspace inspection,
 * deterministic planning, macro listing, agent MCP installation); the legacy
 * learning-flywheel surfaces return valid empty shapes so legacy panels
 * degrade to their empty states instead of breaking.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { executeSurgicalRead } from "./slicer.js";
import { SUPPORTED_SOURCE_EXTS } from "./ast-engine.js";

// ── result shapes (superset of what extension panels read) ─────────────

export interface PreviewAnchor {
  id: string;
  type: string;
  layer: string;
  title?: string;
  line?: number;
  endLine?: number;
  tokens?: number;
}

export interface ContextPreviewResult {
  query: string;
  summaryCount: number;
  anchorCount: number;
  tokenEstimate: number;
  truncated: boolean;
  anchorsByLayer: { l1: number; l2: number; l3: number };
  refillPreview: string[];
  summary: string[];
  anchors: PreviewAnchor[];
  tokenBudget: {
    maxContextTokens: number;
    estimatedRawTokens: number;
    compressedTokens: number;
    estimatedSavingsPercent: number;
    budgetUsedPercent: number;
  };
  agentInstructions?: string | undefined;
  agentWorkItems?: Array<{ id: string; kind: string; prompt: string }> | undefined;
}

export interface ExecutionDescriptor {
  action: string;
  task: string;
  context: string;
  retryHints: string[];
}

export interface TaskRunResult {
  status: "COMPLETED" | "HUMAN_REVIEW_REQUIRED" | "FAILED";
  attempts: number;
  feedback: string;
  executionDescriptor?: ExecutionDescriptor;
}

export interface PlanStep {
  id: string;
  description: string;
  dependencies: string[];
}

export interface PlanInsightResult {
  mode: string;
  ideas: string[];
  plan: PlanStep[];
  agentInstructions?: string;
  agentWorkItems?: Array<{ id: string; kind: string; prompt: string }>;
}

export interface SkillInsightsResult {
  source: "graph-store" | "unavailable";
  transport: "memory" | "mcp-http" | "file" | "sqlite" | "auto";
  storePath?: string;
  skills: Array<{
    id: string;
    name: string;
    score: number;
    uses: number;
    lastOutcome: "pass" | "fail";
    updatedAt: number;
  }>;
}

export interface FlywheelReport {
  skills: { total: number; positive: number; neutral: number; negative: number; byOutcomeKind: Record<string, number>; topUsed: Array<{ name: string; score: number; uses: number }> };
  episodes: { total: number; pass: number; fail: number; pending: number };
  autoCaptureEnabled: boolean;
  sessionJournal: { path: string; exists: boolean; pendingCount: number };
  memoryAttribution: { memoryHits: number; staleEpisodes: number };
  experience?: { provenSkillCount?: number };
}

export interface GraphSnapshotResult {
  transport: "memory" | "mcp-http" | "file" | "sqlite" | "auto";
  storePath?: string;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCount: Record<string, number>;
  topRelations: Array<{ relation: string; count: number }>;
  sampleNodes: Array<Record<string, unknown>>;
  sampleEdges: Array<{ from: string; relation: string; to: string }>;
  workbenchOutline?: Array<Record<string, unknown>>;
  graphStore?: Record<string, unknown>;
}

export interface GraphIndexResult {
  indexed: number;
  totalFiles?: number;
  note?: string;
}

export interface GraphFlowSettings {
  configPath: string;
  smartProvider: string;
  smartApiKey?: string;
  smartModel: string;
  smartBaseUrl?: string;
  economyProvider: string;
  economyApiKey?: string;
  economyModel: string;
  economyBaseUrl?: string;
  provider: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  maxContextTokens: number;
  layerQuota: { l1: number; l2: number; l3: number };
  enableNearLosslessMode: boolean;
  autoIndexOnPreview: boolean;
  autoIndexOnRun: boolean;
  autoIndexOnSave: boolean;
  autoRunOnIndex: boolean;
  transport: "memory" | "mcp-http" | "file" | "sqlite" | "auto";
  graphStorePath: string;
}

export interface SettingsPanelStatus {
  extensionVersion: string;
  graphNodeCount: number;
  graphEdgeCount: number;
  graphLastModified: string | null;
  diagnoseSummary: string;
  overlayKeys: string[];
  baseConfigPath: string;
  mcpAgents: Array<{
    agentId: string;
    agentName: string;
    configPath: string;
    scope: "user" | "workspace";
    detected: boolean;
    installed: boolean;
  }>;
}

export interface DetectedAgent {
  id: string;
  name: string;
  configPath: string;
}

export interface McpInstallResult {
  agent: string;
  status: "created" | "updated" | "skipped" | "error";
  message?: string;
}

const SETTINGS_PATH = join(homedir(), ".graphflow.config.json");

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function walkSourceFiles(root: string, limit = 400): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", ".graphflow", ".graphflow-cache", "graphflow-out", "vendor"]);
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith(".") && e.name !== ".trae") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full);
      } else if (e.isFile() && SUPPORTED_SOURCE_EXTS.has(extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// ── context preview: the real slim slicer ──────────────────────────────

export async function previewContext(
  query?: string,
  _configPath?: string,
  rootDir?: string,
  _englishQuery?: string
): Promise<ContextPreviewResult> {
  const root = rootDir ?? process.cwd();
  const q = query ?? "";
  if (!q.trim()) {
    return {
      query: q,
      summaryCount: 0,
      anchorCount: 0,
      tokenEstimate: 0,
      truncated: false,
      anchorsByLayer: { l1: 0, l2: 0, l3: 0 },
      refillPreview: [],
      summary: [],
      anchors: [],
      tokenBudget: {
        maxContextTokens: 0,
        estimatedRawTokens: 0,
        compressedTokens: 0,
        estimatedSavingsPercent: 0,
        budgetUsedPercent: 0,
      },
    };
  }
  const slice = executeSurgicalRead({ rootDir: root, query: q, topK: 3, includeCallers: true });
  const anchors = slice.matchedSymbols.map((m) => ({
    id: `symbol:${m.file}:${m.name}`,
    type: m.kind,
    layer: "l1",
    title: `${m.file}#${m.name}`,
    line: m.line,
    endLine: m.endLine,
  }));
  const summary = slice.text.split("\n").filter((l) => l.trim()).slice(0, 40);
  const raw = slice.rawFileTokens;
  const compressed = slice.estimatedTokens;
  const savings = raw > 0 ? Math.round(((raw - compressed) / raw) * 100) : 0;
  return {
    query: q,
    summaryCount: summary.length,
    anchorCount: anchors.length,
    tokenEstimate: compressed,
    truncated: false,
    anchorsByLayer: { l1: anchors.length, l2: 0, l3: 0 },
    refillPreview: [],
    summary,
    anchors,
    tokenBudget: {
      maxContextTokens: Math.max(raw, compressed),
      estimatedRawTokens: raw,
      compressedTokens: compressed,
      estimatedSavingsPercent: savings,
      budgetUsedPercent: raw > 0 ? Math.min(100, Math.round((compressed / raw) * 100)) : 0,
    },
  };
}

export async function expandAnchor(_anchorId: string): Promise<ContextPreviewResult> {
  return {
    query: "",
    summaryCount: 0,
    anchorCount: 0,
    tokenEstimate: 0,
    truncated: false,
    anchorsByLayer: { l1: 0, l2: 0, l3: 0 },
    refillPreview: [],
    summary: [],
    anchors: [],
    tokenBudget: {
      maxContextTokens: 0,
      estimatedRawTokens: 0,
      compressedTokens: 0,
      estimatedSavingsPercent: 0,
      budgetUsedPercent: 0,
    },
  };
}

export async function captureAssistantReply(): Promise<{ ok: boolean }> {
  return { ok: true };
}

// ── planning: deterministic, no LLM in the slim core ───────────────────

export async function runTaskResult(task: string): Promise<TaskRunResult> {
  return {
    status: "HUMAN_REVIEW_REQUIRED",
    attempts: 1,
    feedback: "The learning flywheel was removed with the slim core. Use the gf_* surgical tools directly.",
    executionDescriptor: {
      action: "agent-delegated",
      task,
      context: "call gf_read first (targets or q), then gf_edit, then gf_exec affected-tests",
      retryHints: [],
    },
  };
}

export async function runTask(task: string): Promise<string> {
  const result = await runTaskResult(task);
  return `[${result.status}] ${result.executionDescriptor?.context ?? ""}`;
}

export async function planAndBrainstormResult(task: string): Promise<PlanInsightResult> {
  return {
    mode: "deterministic",
    ideas: [
      `目标澄清: ${task}`,
      "实现路径: 先 gf_read 定位符号与调用点, 同回合 gf_edit 修改, gf_exec affected-tests 验证",
      "风险提示: 关注跨文件调用点 (Blast Radius) 与批量原子编辑的回滚",
    ],
    plan: [
      { id: "s1", description: "gf_read 定位目标符号与 Blast Radius 调用点", dependencies: [] },
      { id: "s2", description: "gf_edit 原地修改定义与受影响调用点", dependencies: ["s1"] },
      { id: "s3", description: "gf_exec affected-tests 验证", dependencies: ["s2"] },
    ],
    agentInstructions: "Use gf_read first, then gf_edit in the same turn for every [Blast Radius] call site, then gf_exec affected-tests.",
  };
}

export async function planAndBrainstorm(task: string): Promise<string> {
  const r = await planAndBrainstormResult(task);
  return r.ideas.join("\n");
}

export async function planInsightResult(task: string): Promise<PlanInsightResult> {
  return planAndBrainstormResult(task);
}

export async function planInsight(task: string): Promise<string> {
  return planAndBrainstorm(task);
}

// ── graph inspection: bounded AST walk over the workspace ──────────────

export async function inspectGraph(
  _configPath?: string,
  options?: { nodeLimit?: number; edgeLimit?: number; includeOutline?: boolean }
): Promise<GraphSnapshotResult> {
  const root = process.cwd();
  const files = walkSourceFiles(root, 200);
  return {
    transport: "memory" as const,
    nodeCount: files.length,
    edgeCount: 0,
    nodeTypeCount: { File: files.length },
    topRelations: [],
    sampleNodes: files.slice(0, options?.nodeLimit ?? 10).map((f) => ({
      id: `file:${f}`,
      type: "File",
      contentPreview: "",
      displayLabel: f,
      viewLayer: "code" as const,
    })),
    sampleEdges: [],
    graphStore: { backend: "slim-ast-scan", filesScanned: files.length, note: "on-demand; no persistent graph in the slim core" },
  };
}

export async function indexGraph(_configPath?: string): Promise<GraphIndexResult> {
  return { indexed: 0, note: "the slim AST index is on-demand (mtime cache); nothing to persist" };
}

export async function indexFile(_filePath: string): Promise<GraphIndexResult> {
  return { indexed: 0, note: "on-demand" };
}

export async function rebuildGraph(_configPath?: string): Promise<GraphIndexResult> {
  return indexGraph(_configPath);
}

export function startFileWatcherIfEnabled(): null {
  return null;
}

// ── skills / flywheel: macros are the slim successor; episodes are gone ─

export async function getSkillInsights(_configPath?: string, limit = 12): Promise<SkillInsightsResult> {
  const root = process.cwd();
  const macrosPath = join(root, ".graphflow", "macros.json");
  const store = readJson(macrosPath);
  const macros = Array.isArray(store.macros) ? (store.macros as Array<Record<string, unknown>>) : [];
  return {
    source: (existsSync(macrosPath) ? "graph-store" : "unavailable") as "graph-store" | "unavailable",
    transport: "memory" as const,
    storePath: macrosPath,
    skills: macros.slice(0, limit).map((m, i) => ({
      id: String(m.id ?? `macro-${i}`),
      name: String(m.name ?? m.id ?? `macro-${i}`),
      score: typeof m.occurrences === "number" ? m.occurrences : 0,
      uses: typeof m.occurrences === "number" ? m.occurrences : 0,
      lastOutcome: "pass" as const,
      updatedAt: Date.now(),
    })),
  };
}

export function getFlywheelReport(): FlywheelReport {
  return {
    skills: { total: 0, positive: 0, neutral: 0, negative: 0, byOutcomeKind: {}, topUsed: [] },
    episodes: { total: 0, pass: 0, fail: 0, pending: 0 },
    autoCaptureEnabled: false,
    sessionJournal: { path: join(homedir(), ".graphflow", "session-journal.jsonl"), exists: false, pendingCount: 0 },
    memoryAttribution: { memoryHits: 0, staleEpisodes: 0 },
    experience: { provenSkillCount: 0 },
  };
}

export async function runLearningNightly(): Promise<{ ran: boolean; note: string }> {
  return { ran: false, note: "removed with the flywheel" };
}

export async function runLearningNightlyResult(): Promise<{ ran: boolean; note: string }> {
  return runLearningNightly();
}

export async function listEpisodes(): Promise<{ items: unknown[] }> {
  return { items: [] };
}

export async function searchEpisodes(): Promise<{ hits: unknown[] }> {
  return { hits: [] };
}

export async function forgetEpisode(): Promise<{ forgotten: boolean }> {
  return { forgotten: false };
}

// ── settings ────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: GraphFlowSettings = {
  configPath: SETTINGS_PATH,
  smartProvider: "",
  smartModel: "",
  economyProvider: "",
  economyModel: "",
  provider: "",
  maxContextTokens: 8000,
  layerQuota: { l1: 60, l2: 30, l3: 10 },
  enableNearLosslessMode: false,
  autoIndexOnPreview: false,
  autoIndexOnRun: false,
  autoIndexOnSave: false,
  autoRunOnIndex: false,
  transport: "memory",
  graphStorePath: "",
};

export function getGraphFlowSettings(): GraphFlowSettings {
  const cfg = readJson(SETTINGS_PATH);
  return { ...DEFAULT_SETTINGS, ...((cfg.settings as Partial<GraphFlowSettings>) ?? {}) };
}

export function saveGraphFlowSettings(input: GraphFlowSettings): { saved: boolean; path: string } {
  const cfg = readJson(SETTINGS_PATH);
  cfg.settings = { ...((cfg.settings as GraphFlowSettings) ?? {}), ...input };
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(cfg, null, 2), "utf8");
  return { saved: true, path: SETTINGS_PATH };
}

export function getSettingsPanelStatus(): SettingsPanelStatus {
  const agents = detectInstalledAgents();
  return {
    extensionVersion: "3.1.0",
    graphNodeCount: walkSourceFiles(process.cwd(), 200).length,
    graphEdgeCount: 0,
    graphLastModified: null,
    diagnoseSummary: "slim core: on-demand AST; no persistent graph",
    overlayKeys: [],
    baseConfigPath: SETTINGS_PATH,
    mcpAgents: agents.map((a) => {
      let installed = false;
      try {
        installed = readFileSync(a.configPath, "utf8").includes("graphflow");
      } catch {
        installed = false;
      }
      return { agentId: a.id, agentName: a.name, configPath: a.configPath, scope: "user" as const, detected: true, installed };
    }),
  };
}

export async function indexGraphFromSettings(): Promise<GraphIndexResult> {
  return indexGraph();
}

export async function testRoutingAndIndexGraph(): Promise<{ ok: boolean; detail: string }> {
  return { ok: true, detail: "slim engine: routing removed; AST slicer ready" };
}

export function ensureGlobalGraphFlowConfig(): { path: string; created: boolean } {
  const created = !existsSync(SETTINGS_PATH);
  if (created) {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ settings: {} }, null, 2), "utf8");
  }
  return { path: SETTINGS_PATH, created };
}

export function ensureWorkspaceGraphFlowConfig(): { path: string; created: boolean } {
  const p = join(process.cwd(), "graphflow.config.json");
  const created = !existsSync(p);
  if (created) writeFileSync(p, JSON.stringify({ graphPolicy: { workspaceRoot: process.cwd() } }, null, 2), "utf8");
  return { path: p, created };
}

// ── agent detection + MCP install (minimal, config-file based) ─────────

export function detectInstalledAgents(): DetectedAgent[] {
  const home = homedir();
  const candidates: Array<[string, string, string]> = [
    ["cursor", "Cursor", join(home, ".cursor", "mcp.json")],
    ["claude-code", "Claude Code", join(home, ".claude.json")],
    ["kimi", "Kimi Code", join(home, ".kimi", "mcp.json")],
    ["trae", "Trae", join(home, ".trae", "mcp.json")],
    ["windsurf", "Windsurf", join(home, ".codeium", "windsurf", "mcp.json")],
  ];
  return candidates
    .filter(([id]) => {
      const marker = id === "claude-code" ? join(home, ".claude") : dirname(candidates.find((c) => c[0] === id)![2]);
      return existsSync(marker);
    })
    .map(([id, name, configPath]) => ({ id, name, configPath }));
}

export function formatModelConfigGuide(): string {
  return "Slim core has no built-in LLM routing. Configure providers in your host agent; GraphFlow's gf_* tools are deterministic and offline.";
}

export function installMcpToDetectedAgents(): McpInstallResult[] {
  const results: McpInstallResult[] = [];
  for (const agent of detectInstalledAgents()) {
    try {
      mkdirSync(dirname(agent.configPath), { recursive: true });
      let cfg: Record<string, unknown> = {};
      try {
        cfg = readJson(agent.configPath);
      } catch {
        cfg = {};
      }
      const serversKey = agent.id === "claude-code" ? "mcpServers" : "mcpServers";
      const servers = (cfg[serversKey] as Record<string, unknown>) ?? {};
      servers.graphflow = {
        command: "npx",
        args: ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      };
      cfg[serversKey] = servers;
      writeFileSync(agent.configPath, JSON.stringify(cfg, null, 2), "utf8");
      results.push({ agent: agent.name, status: "updated" });
    } catch (error) {
      results.push({ agent: agent.name, status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export function repairUnsafeWindowsMcpCommands(): { repaired: number } {
  return { repaired: 0 };
}

export function repairStaleGraphFlowMcpLaunchers(): { repaired: number } {
  return { repaired: 0 };
}

// ── diagnostics ─────────────────────────────────────────────────────────

export function diagnoseRoutingResult(): Record<string, unknown> {
  return {
    dynamicRouting: false,
    health: {},
    planner: { provider: "none", model: "deterministic", fallbackApplied: false },
    team: { enabled: false, transport: "none" },
    note: "slim core: no LLM routing; the surgical engine is offline",
  };
}

export function diagnoseRouting(): string {
  const r = diagnoseRoutingResult();
  const planner = r.planner as { model?: string };
  return `planner=${planner.model ?? "deterministic"}; routing=removed(slim); engine=gf v3.1`;
}

// ── facade assertion (the extension calls this on load) ────────────────

export interface GraphFlowRuntimeModule {
  runTask: typeof runTask;
  runTaskResult: typeof runTaskResult;
  planAndBrainstorm: typeof planAndBrainstorm;
  planAndBrainstormResult: typeof planAndBrainstormResult;
  planInsightResult: typeof planInsightResult;
  planInsight: typeof planInsight;
  previewContext: typeof previewContext;
  indexGraph: typeof indexGraph;
  rebuildGraph: typeof rebuildGraph;
  diagnoseRouting: typeof diagnoseRouting;
  diagnoseRoutingResult: typeof diagnoseRoutingResult;
  inspectGraph: typeof inspectGraph;
  getSkillInsights: typeof getSkillInsights;
  getFlywheelReport: typeof getFlywheelReport;
  startFileWatcherIfEnabled: typeof startFileWatcherIfEnabled;
  getGraphFlowSettings: typeof getGraphFlowSettings;
  getSettingsPanelStatus: typeof getSettingsPanelStatus;
  saveGraphFlowSettings: typeof saveGraphFlowSettings;
  indexGraphFromSettings: typeof indexGraphFromSettings;
  testRoutingAndIndexGraph: typeof testRoutingAndIndexGraph;
  ensureGlobalGraphFlowConfig: typeof ensureGlobalGraphFlowConfig;
  ensureWorkspaceGraphFlowConfig: typeof ensureWorkspaceGraphFlowConfig;
  detectInstalledAgents: typeof detectInstalledAgents;
  formatModelConfigGuide: typeof formatModelConfigGuide;
  installMcpToDetectedAgents: typeof installMcpToDetectedAgents;
  repairUnsafeWindowsMcpCommands: typeof repairUnsafeWindowsMcpCommands;
  repairStaleGraphFlowMcpLaunchers: typeof repairStaleGraphFlowMcpLaunchers;
  runLearningNightly: typeof runLearningNightly;
  runLearningNightlyResult: typeof runLearningNightlyResult;
  listEpisodes: typeof listEpisodes;
  searchEpisodes: typeof searchEpisodes;
  forgetEpisode: typeof forgetEpisode;
  expandAnchor: typeof expandAnchor;
  captureAssistantReply: typeof captureAssistantReply;
}

const REQUIRED_EXPORTS: Array<keyof GraphFlowRuntimeModule> = [
  "runTask",
  "planAndBrainstorm",
  "previewContext",
  "indexGraph",
  "diagnoseRouting",
  "inspectGraph",
  "getSkillInsights",
  "getFlywheelReport",
  "startFileWatcherIfEnabled",
  "getGraphFlowSettings",
  "getSettingsPanelStatus",
  "indexGraphFromSettings",
  "testRoutingAndIndexGraph",
  "saveGraphFlowSettings",
  "ensureGlobalGraphFlowConfig",
  "ensureWorkspaceGraphFlowConfig",
  "detectInstalledAgents",
  "formatModelConfigGuide",
  "installMcpToDetectedAgents",
  "repairUnsafeWindowsMcpCommands",
  "repairStaleGraphFlowMcpLaunchers",
  "runLearningNightly",
  "runLearningNightlyResult",
  "listEpisodes",
  "searchEpisodes",
  "forgetEpisode",
];

export function assertGraphFlowRuntime(module: unknown): GraphFlowRuntimeModule {
  const candidate = module as Partial<GraphFlowRuntimeModule>;
  const missing = REQUIRED_EXPORTS.filter((key) => typeof candidate[key] !== "function");
  if (missing.length > 0) {
    throw new Error(`Bundled GraphFlow runtime is missing required exports: ${missing.join(", ")}`);
  }
  return candidate as GraphFlowRuntimeModule;
}

export type GraphFlowRuntime = GraphFlowRuntimeModule;
