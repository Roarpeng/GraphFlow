/**
 * GraphFlow 3.1.0 — Pure Token-First Surgical Engine Public Entrypoint (`src/index.ts`)
 */

export {
  SUPPORTED_SOURCE_EXTS,
  analyzeSourceFile,
  extractStructFields,
  parseCCpp,
  parseCSharp,
  parseGo,
  parsePython,
  parseRust,
  parseWithStructuralScanner,
  resolveRelativeImportPath,
  type AstBackend,
  type AstCallSite,
  type AstImport,
  type AstSymbol,
  type FileAstAnalysis,
  type SymbolKind,
} from "./ast-engine.js";

export {
  executeSurgicalRead,
  foldFileSkeleton,
  formatNumberedLines,
  getWorkspaceAstIndex,
  type ReadOptions,
  type SliceResult,
} from "./slicer.js";

export {
  computeBlastRadius,
  formatBlastRadiusText,
  type CallSiteSnippet,
  type ImporterSite,
  type SymbolBlastRadius,
} from "./blast-radius.js";

export {
  executeSurgicalEdit,
  type SingleEditSpec,
  type StaticGuardDiagnostic,
  type SurgicalEditInput,
  type SurgicalEditResult,
} from "./surgical-edit.js";

export {
  buildAffectedTestCommand,
  dehydrateCommandOutput,
  execAndDehydrate,
  recallArchivedOutput,
  resolveAffectedTests,
  stripAnsi,
  type DehydratedExecResult,
} from "./dehydrator.js";

export {
  evaluatePostEditHabits,
  executeMacro,
  extractCommandTemplate,
  findMatchingMacroHint,
  loadMacroStore,
  loadMacros,
  loadTrajectoryEvents,
  loadUserHabits,
  mineAndCompileMacros,
  recordEditPatternAndMine,
  recordTrajectoryAndMine,
  registerCustomMacro,
  saveMacros,
  syncGitCoChangeHabits,
  type CoEditHabit,
  type CompiledMacro,
  type DirectoryVerifyHabit,
  type MacroKind,
  type TrajectoryActionKind,
  type TrajectoryEvent,
  type UserHabitProfile,
} from "./macro-engine.js";

export {
  V3_TOOL_DEFINITIONS,
  executeV3ToolCall,
  type V3ToolCallResponse,
  type V3ToolDefinition,
} from "./mcp-tools.js";

export {
  PACKAGE_VERSION,
  createMcpServer,
  executeToolCall,
  getToolDefinitions,
  getV3ToolDefinitions,
  resolvePackageVersion,
  type GraphFlowToolCapability,
  type GraphFlowToolRisk,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpServer,
  type ToolAnnotations,
  type ToolCall,
  type ToolCallResponse,
  type ToolDefinition,
  type ToolGovernanceMeta,
} from "./mcp-server.js";

export {
  interceptPostToolUse,
  interceptPreToolUse,
  type HostToolUsePayload,
  type PostToolInterceptResult,
  type PreToolInterceptOptions,
  type PreToolInterceptResult,
} from "./host-interceptor.js";

export {
  computeTemporalCouplingFromCommits,
  getRecentFileGitDiff,
  mineGitCoChangeHistory,
  parseGitLogCommitFiles,
  type GitCoChangePair,
  type GitHotspot,
  type GitMineOptions,
  type GitMiningResult,
} from "./git-miner.js";

export {
  checkAndRecordSessionRead,
  computeContentSha256,
  loadSessionGuardState,
  markSessionFilesEdited,
  recordTestAndCheckCircuitBreaker,
  saveSessionGuardState,
  type SessionGuardState,
  type SessionReadRecord,
} from "./circuit-breaker.js";

export {
  CURSOR_RULE_MDC_CONTENT,
  GRAPHFLOW_BLOCK_BEGIN,
  GRAPHFLOW_BLOCK_END,
  MANAGED_INSTRUCTION_BLOCK,
  SKILL_MD_CONTENT,
  buildAgentProfiles,
  detectInstalledAgents,
  installAllAgents,
  uninstallAllAgents,
  type AgentInstallItemResult,
  type AgentMcpTarget,
  type AgentProfile,
  type InstallAllAgentsOptions,
  type InstallAllAgentsReport,
  type McpConfigFormat,
  type McpServersKey,
} from "./agent-installer.js";
