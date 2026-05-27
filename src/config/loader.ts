import { readFileSync } from "node:fs";
import type { GraphFlowConfig } from "./schema";

export function loadConfig(path = "graphflow.config.json"): GraphFlowConfig {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as GraphFlowConfig;
}
