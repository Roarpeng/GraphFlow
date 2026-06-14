import type {
  buildMcpServerNode,
  detectInstalledAgents,
  formatModelConfigGuide,
  installMcpToDetectedAgents,
} from "../../../integrations/agent-mcp-installer";
import type {
  ensureGlobalGraphFlowConfig,
  ensureWorkspaceGraphFlowConfig,
} from "../../../config/scaffold";
import type { downloadOpenBmbModel, enrichSemanticsSilent, getSkillInsights, indexGraph, inspectGraph, previewContext, rebuildGraph } from "./graph.js";
import type { getSettingsPanelStatus, indexGraphFromSettings, testRoutingAndIndexGraph } from "./panel.js";
import type {
  diagnoseRouting,
  diagnoseRoutingResult,
  planAndBrainstorm,
  planAndBrainstormResult,
  runLearningNightly,
  runLearningNightlyResult,
  runTask,
  runTaskResult,
} from "./routing.js";
import type { applyEnrichmentProviderEnv, applyOpenBmbRuntimeEnv, prepareSemanticEnrichmentRuntime } from "./env.js";
import type {
  getGraphFlowSettings,
  saveGraphFlowSettings,
  validateSettingsForGraphIndex,
  validateSettingsForRouting,
} from "./settings.js";

/** Bundled runtime module shape used by VS Code extension and other dynamic importers. */
export interface GraphFlowRuntimeModule {
  runTask: typeof runTask;
  runTaskResult: typeof runTaskResult;
  planAndBrainstorm: typeof planAndBrainstorm;
  planAndBrainstormResult: typeof planAndBrainstormResult;
  previewContext: typeof previewContext;
  indexGraph: typeof indexGraph;
  rebuildGraph: typeof rebuildGraph;
  enrichSemanticsSilent: typeof enrichSemanticsSilent;
  diagnoseRouting: typeof diagnoseRouting;
  diagnoseRoutingResult: typeof diagnoseRoutingResult;
  runLearningNightly: typeof runLearningNightly;
  runLearningNightlyResult: typeof runLearningNightlyResult;
  inspectGraph: typeof inspectGraph;
  getSkillInsights: typeof getSkillInsights;
  getGraphFlowSettings: typeof getGraphFlowSettings;
  getSettingsPanelStatus: typeof getSettingsPanelStatus;
  saveGraphFlowSettings: typeof saveGraphFlowSettings;
  indexGraphFromSettings: typeof indexGraphFromSettings;
  testRoutingAndIndexGraph: typeof testRoutingAndIndexGraph;
  validateSettingsForGraphIndex: typeof validateSettingsForGraphIndex;
  validateSettingsForRouting: typeof validateSettingsForRouting;
  detectInstalledAgents: typeof detectInstalledAgents;
  ensureGlobalGraphFlowConfig: typeof ensureGlobalGraphFlowConfig;
  ensureWorkspaceGraphFlowConfig: typeof ensureWorkspaceGraphFlowConfig;
  installMcpToDetectedAgents: typeof installMcpToDetectedAgents;
  formatModelConfigGuide: typeof formatModelConfigGuide;
  downloadOpenBmbModel: typeof downloadOpenBmbModel;
  prepareSemanticEnrichmentRuntime: typeof prepareSemanticEnrichmentRuntime;
  applyEnrichmentProviderEnv: typeof applyEnrichmentProviderEnv;
  applyOpenBmbRuntimeEnv: typeof applyOpenBmbRuntimeEnv;
  buildMcpServerNode: typeof buildMcpServerNode;
}

const REQUIRED_EXPORTS: Array<keyof GraphFlowRuntimeModule> = [
  "runTask",
  "planAndBrainstorm",
  "previewContext",
  "indexGraph",
  "enrichSemanticsSilent",
  "diagnoseRouting",
  "runLearningNightly",
  "inspectGraph",
  "getSkillInsights",
  "getGraphFlowSettings",
  "getSettingsPanelStatus",
  "indexGraphFromSettings",
  "testRoutingAndIndexGraph",
  "saveGraphFlowSettings",
  "detectInstalledAgents",
  "ensureGlobalGraphFlowConfig",
  "ensureWorkspaceGraphFlowConfig",
  "installMcpToDetectedAgents",
  "formatModelConfigGuide",
  "downloadOpenBmbModel",
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
