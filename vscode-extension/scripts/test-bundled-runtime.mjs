import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(scriptDir, "..");
const workspaceRoot = join(extensionRoot, "..");
const runtimePath = join(extensionRoot, "vendor", "graphflow", "dist", "surfaces", "cli", "runtime.js");

process.env.GRAPHFLOW_LOG_JSON = "1";
process.chdir(workspaceRoot);

const runtime = await import(pathToFileURL(runtimePath).toString());

const checks = [
  ["inspectGraph", async () => {
    const snapshot = await runtime.inspectGraph(undefined, { nodeLimit: 5, edgeLimit: 5 });
    if (!snapshot || typeof snapshot.nodeCount !== "number") {
      throw new Error("inspectGraph returned invalid snapshot");
    }
    return `nodes=${snapshot.nodeCount}; edges=${snapshot.edgeCount}`;
  }],
  ["diagnoseRouting", async () => {
    const text = runtime.diagnoseRouting();
    if (!text.includes("planner=")) {
      throw new Error(`unexpected diagnose output: ${text}`);
    }
    return text.split("; ").slice(0, 3).join("; ");
  }],
  ["getSkillInsights", async () => {
    const insights = await runtime.getSkillInsights(undefined, 5);
    if (!insights || !Array.isArray(insights.skills)) {
      throw new Error("getSkillInsights returned invalid payload");
    }
    return `skills=${insights.skills.length}; transport=${insights.transport}`;
  }],
  ["previewContext", async () => {
    const preview = await runtime.previewContext("graph snapshot routing");
    if (!preview || typeof preview.tokenEstimate !== "number") {
      throw new Error("previewContext returned invalid payload");
    }
    return `tokens=${preview.tokenEstimate}; anchors=${preview.anchorCount}`;
  }],
  ["getGraphFlowSettings", async () => {
    const settings = runtime.getGraphFlowSettings();
    if (!settings?.smartModel) {
      throw new Error("getGraphFlowSettings returned invalid payload");
    }
    return `smart=${settings.smartModel}; economy=${settings.economyModel}`;
  }],
  ["planAndBrainstorm", async () => {
    const output = runtime.planAndBrainstorm("health check");
    if (!output.includes("mode=")) {
      throw new Error(`unexpected plan output: ${output}`);
    }
    return output.split("; ").slice(0, 2).join("; ");
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
