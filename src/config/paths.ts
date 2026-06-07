import { isAbsolute, resolve } from "node:path";
import type { GraphFlowConfig } from "./schema";

/** Resolve a config path relative to workspaceRoot (absolute paths pass through). */
export function resolveWorkspacePath(workspaceRoot: string, pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return resolve(pathValue);
  }
  return resolve(workspaceRoot, pathValue);
}

export function resolveGraphStorePath(config: GraphFlowConfig): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const storePath =
    config.graphPolicy.graphStorePath ??
    (config.graphPolicy.transport === "sqlite"
      ? "tmp/graphflow-graph.sqlite"
      : "tmp/graphflow-graph.json");
  return resolveWorkspacePath(root, storePath);
}

export function resolveLearningPath(
  config: GraphFlowConfig,
  key: "exportPath" | "eventsPath" | "summaryPath"
): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  const defaults: Record<typeof key, string> = {
    exportPath: "tmp/learning-dataset.jsonl",
    eventsPath: "tmp/learning-events.jsonl",
    summaryPath: "tmp/learning-summary.json",
  };
  const configured = config.learningPolicy[key] ?? defaults[key];
  return resolveWorkspacePath(root, configured);
}
