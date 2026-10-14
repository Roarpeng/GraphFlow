/**
 * GraphFlow 3.0 — Token-First Surgical Engine Public Barrel (`src/v3/index.ts`)
 */

export {
  SUPPORTED_SOURCE_EXTS,
  analyzeSourceFile,
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
  recordTrajectoryAndMine,
  registerCustomMacro,
  saveMacros,
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
  interceptPostToolUse,
  interceptPreToolUse,
  type HostToolUsePayload,
  type PostToolInterceptResult,
  type PreToolInterceptOptions,
  type PreToolInterceptResult,
} from "./host-interceptor.js";
