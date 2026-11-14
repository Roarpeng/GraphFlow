/** Minimal local tool receipts. No prompts, source text, command text or secrets are persisted. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { contentSha256 } from "./edit-transaction.js";
import { ensureGraphflowDir } from "./graphflow-dir.js";
import { describeBranchScope } from "./branch-scope.js";

export interface ToolEvidence {
  taskId?: string;
  tool: string;
  workspaceHash: string;
  artifactHash: string;
  estimatedOutputTokens: number;
  durationMs: number;
  testStatus: "PASS" | "FAIL" | "NO_TESTS" | "UNKNOWN" | "TIMEOUT";
  verifiedOutcome: "UNKNOWN" | "VERIFIED" | "FAILED";
  observedModelUsage?: { inputTokens?: number; outputTokens?: number };
  at: string;
}

export function appendToolEvidence(rootDir: string, input: {
  taskId?: string;
  tool: string;
  output: string;
  durationMs: number;
  testStatus?: ToolEvidence["testStatus"];
  verifiedOutcome?: ToolEvidence["verifiedOutcome"];
  observedModelUsage?: ToolEvidence["observedModelUsage"];
}): ToolEvidence {
  const packagePath = join(rootDir, "package.json");
  const packageHash = existsSync(packagePath) ? contentSha256(readFileSync(packagePath, "utf8")) : "none";
  let revision = "no-git";
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { /* workspace without git */ }
  const receipt: ToolEvidence = {
    ...(input.taskId ? { taskId: input.taskId.slice(0, 80) } : {}),
    tool: input.tool,
    workspaceHash: contentSha256(`${rootDir}|${describeBranchScope(rootDir)}|${revision}|${packageHash}`),
    artifactHash: contentSha256(input.output),
    estimatedOutputTokens: Math.ceil(input.output.length / 4),
    durationMs: input.durationMs,
    testStatus: input.testStatus ?? "UNKNOWN",
    verifiedOutcome: input.verifiedOutcome ?? "UNKNOWN",
    ...(input.observedModelUsage ? { observedModelUsage: input.observedModelUsage } : {}),
    at: new Date().toISOString(),
  };
  appendFileSync(join(ensureGraphflowDir(rootDir), "evidence-ledger.jsonl"), JSON.stringify(receipt) + "\n", "utf8");
  return receipt;
}
