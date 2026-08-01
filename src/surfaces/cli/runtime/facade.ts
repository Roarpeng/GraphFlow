import type {
  ensureGlobalGraphFlowConfig,
  ensureWorkspaceGraphFlowConfig,
} from "../../../config/scaffold";
import type {
  detectInstalledAgents,
  formatModelConfigGuide,
  installMcpToDetectedAgents,
  repairUnsafeWindowsMcpCommands,
} from "../../../integrations/agent-mcp-installer";
import type { getFlywheelReport, getSkillInsights, indexGraph, inspectGraph, previewContext, rebuildGraph, startFileWatcherIfEnabled } from "./graph.js";
import type { getSettingsPanelStatus, indexGraphFromSettings, testRoutingAndIndexGraph } from "./panel.js";
import type {
  diagnoseRouting,
  diagnoseRoutingResult,
  planAndBrainstorm,
  planAndBrainstormResult,
  planInsight,
  planInsightResult,
  runTask,
  runTaskResult,
} from "./routing.js";
import type { getGraphFlowSettings, saveGraphFlowSettings } from "./settings.js";
import type { runLearningNightly, runLearningNightlyResult } from "./learning.js";
import type { listEpisodes, searchEpisodes, forgetEpisode } from "./memory.js";

/** Bundled runtime module shape used by VS Code extension and other dynamic importers. */
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
  runLearningNightly: typeof runLearningNightly;
  runLearningNightlyResult: typeof runLearningNightlyResult;
  listEpisodes: typeof listEpisodes;
  searchEpisodes: typeof searchEpisodes;
  forgetEpisode: typeof forgetEpisode;
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

/** Alias for consumers that refer to the bundled runtime as GraphFlowRuntime. */
export type GraphFlowRuntime = GraphFlowRuntimeModule;
