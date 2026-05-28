export { orchestrate, type OrchestrateOptions } from "./core/orchestrator";
export { createVsCodeRuntime } from "./surfaces/vscode/extension";
export { runTask, previewContext, indexGraph, resolveConfig } from "./surfaces/cli/runtime";
export type { TaskRunResult } from "./core/types";
export {
  createGraphClient,
  type GraphClient,
} from "./graph/client-factory";
export { validateConfig, loadConfig } from "./config/loader";
