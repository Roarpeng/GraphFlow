import { existsSync, statSync } from "node:fs";
import { listConfigOverlayKeys } from "../../../config/merge";
import { resolveGlobalConfigPath } from "../../../config/scaffold";
import { resolveConfig, resolveConfigPath } from "../../../config/resolve";
import { resolveGraphStorePath } from "../../../config/paths";
import { getMcpInstallStatus } from "../../../integrations/agent-mcp-installer";
import { inspectGraph, indexGraph } from "./graph.js";
import {
  diagnoseRouting,
  diagnoseRoutingResult,
  probeRoutingConnectivity,
} from "./routing.js";
import {
  saveGraphFlowSettings,
  validateSettingsForGraphIndex,
  validateSettingsForRouting,
} from "./settings.js";
import type {
  GraphFlowSettingsInput,
  GraphIndexFromSettingsResult,
  RoutingConnectivityResult,
  SettingsPanelStatusData,
} from "./types.js";

export async function indexGraphFromSettings(
  settings: GraphFlowSettingsInput,
  workspaceRoot?: string,
  configPath?: string
): Promise<GraphIndexFromSettingsResult> {
  const validationIssues = validateSettingsForGraphIndex(settings);
  const actualPath = resolveConfigPath(configPath ?? "graphflow.config.json");
  if (validationIssues.length > 0) {
    return { ok: false, validationIssues };
  }

  saveGraphFlowSettings(settings, actualPath);
  const graphIndex = await indexGraph(workspaceRoot, actualPath);
  const snapshot = await inspectGraph(actualPath, { nodeLimit: 1, edgeLimit: 1 });

  return {
    ok: true,
    validationIssues: [],
    graphIndex,
    graphSnapshot: {
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
    },
  };
}

export async function testRoutingAndIndexGraph(
  settings: GraphFlowSettingsInput,
  workspaceRoot?: string,
  configPath?: string
): Promise<RoutingConnectivityResult> {
  const validationIssues = validateSettingsForRouting(settings);
  const actualPath = resolveConfigPath(configPath ?? "graphflow.config.json");
  if (validationIssues.length > 0) {
    return {
      ok: false,
      validationIssues,
      diagnosis: diagnoseRoutingResult(actualPath),
      probes: [],
    };
  }

  saveGraphFlowSettings(settings, actualPath);
  const diagnosis = diagnoseRoutingResult(actualPath);
  const probes = await probeRoutingConnectivity(actualPath);

  const connectivityOk = probes.every((probe) => probe.ok);
  if (!connectivityOk) {
    return {
      ok: false,
      validationIssues: [],
      diagnosis,
      probes,
    };
  }

  const graphIndex = await indexGraph(workspaceRoot, actualPath);
  const snapshot = await inspectGraph(actualPath, { nodeLimit: 1, edgeLimit: 1 });

  return {
    ok: true,
    validationIssues: [],
    diagnosis,
    probes,
    graphIndex,
    graphSnapshot: {
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
    },
  };
}

export async function getSettingsPanelStatus(configPath?: string): Promise<SettingsPanelStatusData> {
  const config = resolveConfig(configPath);
  const snapshot = await inspectGraph(configPath, { nodeLimit: 1, edgeLimit: 1 });
  const storePath = resolveGraphStorePath(config);
  let graphLastModified: string | null = null;
  if (existsSync(storePath)) {
    graphLastModified = new Date(statSync(storePath).mtimeMs).toISOString();
  }

  return {
    graphNodeCount: snapshot.nodeCount,
    graphEdgeCount: snapshot.edgeCount,
    graphLastModified,
    diagnoseSummary: diagnoseRouting(configPath),
    overlayKeys: listConfigOverlayKeys(),
    baseConfigPath: existsSync(resolveGlobalConfigPath())
      ? resolveGlobalConfigPath()
      : existsSync("graphflow.config.json")
        ? "graphflow.config.json"
        : "（未创建）",
    mcpAgents: getMcpInstallStatus(),
  };
}
