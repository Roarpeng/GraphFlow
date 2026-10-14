/**
 * Slim bundled-runtime checks: verify the vendored GraphFlow runtime exposes
 * the bridge facade and that its slim-backed functions answer with valid
 * shapes. Runs against the repo workspace (no config file needed).
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(scriptDir, "..");
const workspaceRoot = join(extensionRoot, "..");
const runtimePath = join(extensionRoot, "vendor", "graphflow", "dist", "runtime.js");

process.env.GRAPHFLOW_LOG_JSON = "1";
process.chdir(workspaceRoot);

if (!existsSync(runtimePath)) {
  console.error(`[FAIL] bundled runtime missing: ${runtimePath}`);
  process.exit(1);
}

const runtime = await import(pathToFileURL(runtimePath).toString());

const checks = [
  ["assertGraphFlowRuntime", async () => {
    const asserted = runtime.assertGraphFlowRuntime(runtime);
    if (!asserted || typeof asserted.previewContext !== "function") {
      throw new Error("assertGraphFlowRuntime did not return the facade");
    }
    return "facade ok";
  }],
  ["previewContext", async () => {
    const preview = await runtime.previewContext("slicer skeleton");
    if (!preview || typeof preview.tokenEstimate !== "number" || !Array.isArray(preview.anchors)) {
      throw new Error("previewContext returned invalid payload");
    }
    return `tokens=${preview.tokenEstimate}; anchors=${preview.anchors.length}`;
  }],
  ["inspectGraph", async () => {
    const snapshot = await runtime.inspectGraph(undefined, { nodeLimit: 5 });
    if (!snapshot || typeof snapshot.nodeCount !== "number") {
      throw new Error("inspectGraph returned invalid snapshot");
    }
    return `nodes=${snapshot.nodeCount}; transport=${snapshot.transport}`;
  }],
  ["diagnoseRouting", async () => {
    const text = runtime.diagnoseRouting();
    if (!text.includes("planner=")) {
      throw new Error(`unexpected diagnose output: ${text}`);
    }
    return text.split("; ").slice(0, 2).join("; ");
  }],
  ["getSkillInsights", async () => {
    const insights = await runtime.getSkillInsights(undefined, 5);
    if (!insights || !Array.isArray(insights.skills)) {
      throw new Error("getSkillInsights returned invalid payload");
    }
    return `macros=${insights.skills.length}; transport=${insights.transport}`;
  }],
  ["getGraphFlowSettings", async () => {
    const settings = runtime.getGraphFlowSettings();
    if (!settings || typeof settings !== "object") {
      throw new Error("getGraphFlowSettings returned invalid payload");
    }
    return "settings readable";
  }],
  ["getSettingsPanelStatus", async () => {
    const status = runtime.getSettingsPanelStatus();
    if (typeof status.graphNodeCount !== "number" || !Array.isArray(status.mcpAgents)) {
      throw new Error("getSettingsPanelStatus returned invalid payload");
    }
    return `nodes=${status.graphNodeCount}; agents=${status.mcpAgents.length}`;
  }],
  ["planAndBrainstorm", async () => {
    const output = await runtime.planAndBrainstorm("health check");
    if (!output.includes("gf_read")) {
      throw new Error(`unexpected plan output: ${output}`);
    }
    return "plan mentions gf_read";
  }],
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    const summary = await run();
    console.log(`[PASS] ${name}: ${summary}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${name}:`, err instanceof Error ? err.message : err);
  }
}

if (failed > 0) {
  process.exitCode = 1;
  console.error(`\n${failed}/${checks.length} bundled runtime checks failed.`);
} else {
  console.log(`\nAll ${checks.length} bundled runtime checks passed.`);
}
