import * as vscode from "vscode";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  buildGraphSnapshotHtml,
  buildSkillInsightsHtml,
  type GraphSnapshotResult,
  type SkillInsightsResult,
} from "./panels";

interface RunRecord {
  task: string;
  status: string;
  attempts: number;
  feedback: string;
  timestamp: number;
}

const runs: RunRecord[] = [];
const CHAT_PARTICIPANT_ID = "roarpeng.graphflow-vscode.graphflowAgent";
let runtimePromise: Promise<GraphFlowRuntime> | undefined;

interface GraphFlowRuntime {
  runTask(task: string): Promise<string>;
  planAndBrainstorm(task: string): string;
  diagnoseRouting(): string;
  runLearningNightly(): string;
  inspectGraph(nodeLimit?: number, edgeLimit?: number): GraphSnapshotResult;
  getSkillInsights(limit?: number): SkillInsightsResult;
}

export function activate(context: vscode.ExtensionContext): void {
  const runTask = vscode.commands.registerCommand("graphflow.runTask", async () => {
    const task = await vscode.window.showInputBox({
      title: "GraphFlow Run Task",
      prompt: "Enter task description",
      placeHolder: "update readme and add tests",
    });

    if (!task) {
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const output = await runGraphFlow(workspaceRoot, (runtime) => runtime.runTask(task));
    const parsed = parseCliResult(output);

    const runtimeRecord = {
      task,
      status: parsed.status,
      attempts: parsed.attempts,
      feedback: parsed.feedback,
      timestamp: Date.now(),
    };
    const record: RunRecord = {
      task: runtimeRecord.task,
      status: runtimeRecord.status,
      attempts: runtimeRecord.attempts,
      feedback: runtimeRecord.feedback,
      timestamp: runtimeRecord.timestamp,
    };

    runs.push(record);
    vscode.window.showInformationMessage(`GraphFlow finished: ${record.status}`);
  });

  const showRuns = vscode.commands.registerCommand("graphflow.showRuns", async () => {
    if (runs.length === 0) {
      vscode.window.showInformationMessage("No GraphFlow runs yet.");
      return;
    }

    const items = runs
      .slice()
      .reverse()
      .map((run) => `${run.status} | ${run.task} | attempts=${run.attempts}`);

    await vscode.window.showQuickPick(items, {
      title: "GraphFlow Run History",
    });
  });

  const planTask = vscode.commands.registerCommand("graphflow.planTask", async () => {
    const task = await vscode.window.showInputBox({
      title: "GraphFlow Plan & Brainstorm",
      prompt: "Enter task description",
      placeHolder: "refactor architecture and add tests",
    });

    if (!task) {
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const output = await runGraphFlow(workspaceRoot, (runtime) =>
      Promise.resolve(runtime.planAndBrainstorm(task))
    );
    await vscode.window.showQuickPick(output.split("; "), {
      title: "GraphFlow Plan & Brainstorm",
    });
  });

  const showGraph = vscode.commands.registerCommand("graphflow.showGraph", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const snapshot = await runGraphFlow(workspaceRoot, (runtime) =>
      Promise.resolve(runtime.inspectGraph(48, 96))
    );
    showGraphSnapshotPanel(snapshot);
  });

  const showSkills = vscode.commands.registerCommand("graphflow.showSkills", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const insights = await runGraphFlow(workspaceRoot, (runtime) =>
      Promise.resolve(runtime.getSkillInsights(24))
    );
    showSkillInsightsPanel(insights);
  });

  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, _context, stream) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        stream.markdown("No workspace folder found.");
        return;
      }

      const normalizedPrompt = request.prompt.trim();
      const command = request.command ?? detectInlineCommand(normalizedPrompt);
      const payload = stripInlineCommand(normalizedPrompt);

      if (command === "history") {
        if (runs.length === 0) {
          stream.markdown("No GraphFlow runs yet.");
          return;
        }

        const lines = runs
          .slice()
          .reverse()
          .slice(0, 10)
          .map(
            (run) =>
              `- ${run.status} | ${run.task} | attempts=${run.attempts} | ${new Date(run.timestamp).toLocaleString()}`
          );
        stream.markdown(`Recent runs:\n${lines.join("\n")}`);
        return;
      }

      if (command === "diagnose") {
        const output = await runGraphFlow(workspaceRoot, (runtime) =>
          Promise.resolve(runtime.diagnoseRouting())
        );
        stream.markdown(`Routing diagnostics:\n${formatAsBullet(output)}`);
        return;
      }

      if (command === "learn") {
        const output = await runGraphFlow(workspaceRoot, (runtime) =>
          Promise.resolve(runtime.runLearningNightly())
        );
        stream.markdown(`Nightly learning:\n${formatAsBullet(output)}`);
        return;
      }

      if (command === "graph") {
        const snapshot = await runGraphFlow(workspaceRoot, (runtime) =>
          Promise.resolve(runtime.inspectGraph(24, 36))
        );
        stream.markdown(formatGraphSnapshotMarkdown(snapshot));
        return;
      }

      if (command === "skills") {
        const insights = await runGraphFlow(workspaceRoot, (runtime) =>
          Promise.resolve(runtime.getSkillInsights(12))
        );
        stream.markdown(formatSkillInsightsMarkdown(insights));
        return;
      }

      if (!payload) {
        stream.markdown("Please provide a task description. Example: `/run update readme and add tests`");
        return;
      }

      if (command === "plan") {
        const output = await runGraphFlow(
          workspaceRoot,
          (runtime) => Promise.resolve(runtime.planAndBrainstorm(payload))
        );
        stream.markdown(`Plan result:\n\n${formatAsBullet(output)}`);
        return;
      }

      const runOutput = await runGraphFlow(workspaceRoot, (runtime) => runtime.runTask(payload));
      const parsed = parseCliResult(runOutput);
      runs.push({
        task: payload,
        status: parsed.status,
        attempts: parsed.attempts,
        feedback: parsed.feedback,
        timestamp: Date.now(),
      });
      stream.markdown(
        `Run result:\n- status: ${parsed.status}\n- attempts: ${parsed.attempts}\n- feedback: ${parsed.feedback}`
      );
    }
  );

  context.subscriptions.push(runTask, showRuns, planTask, showGraph, showSkills, participant);
}

export function deactivate(): void {
  // no-op
}

function parseCliResult(line: string): { status: string; attempts: number; feedback: string } {
  const cleaned = line.split(/\r?\n/).filter(Boolean).at(-1) ?? line;
  const parts = cleaned.split(";").map((part) => part.trim());
  const map = new Map<string, string>();

  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      map.set(key, value);
    }
  }

  return {
    status: map.get("status") ?? "UNKNOWN",
    attempts: Number(map.get("attempts") ?? "0"),
    feedback: map.get("feedback") ?? cleaned,
  };
}

async function runGraphFlow<T>(
  workspaceRoot: string,
  execute: (runtime: GraphFlowRuntime) => Promise<T>
): Promise<T> {
  const runtime = await loadRuntime();
  return withWorkspaceCwd(workspaceRoot, () => execute(runtime));
}

async function loadRuntime(): Promise<GraphFlowRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const runtimePath = join(__dirname, "..", "vendor", "graphflow", "dist", "surfaces", "cli", "runtime.js");
      const module = (await import(pathToFileURL(runtimePath).toString())) as Partial<GraphFlowRuntime>;
      if (
        !module.runTask ||
        !module.planAndBrainstorm ||
        !module.diagnoseRouting ||
        !module.runLearningNightly ||
        !module.inspectGraph ||
        !module.getSkillInsights
      ) {
        throw new Error("Bundled GraphFlow runtime is missing required exports.");
      }

      return {
        runTask: module.runTask,
        planAndBrainstorm: module.planAndBrainstorm,
        diagnoseRouting: module.diagnoseRouting,
        runLearningNightly: module.runLearningNightly,
        inspectGraph: module.inspectGraph,
        getSkillInsights: module.getSkillInsights,
      };
    })();
  }

  return runtimePromise;
}

async function withWorkspaceCwd<T>(workspaceRoot: string, action: () => Promise<T>): Promise<T> {
  const current = process.cwd();
  process.chdir(workspaceRoot);
  try {
    return await action();
  } finally {
    process.chdir(current);
  }
}

function detectInlineCommand(
  prompt: string
): "run" | "plan" | "history" | "diagnose" | "learn" | "graph" | "skills" {
  if (prompt.startsWith("/plan")) {
    return "plan";
  }

  if (prompt.startsWith("/history")) {
    return "history";
  }

  if (prompt.startsWith("/diagnose")) {
    return "diagnose";
  }

  if (prompt.startsWith("/learn")) {
    return "learn";
  }

  if (prompt.startsWith("/graph")) {
    return "graph";
  }

  if (prompt.startsWith("/skills")) {
    return "skills";
  }

  return "run";
}

function stripInlineCommand(prompt: string): string {
  return prompt.replace(/^\/(run|plan|history|diagnose|learn|graph|skills)\s*/i, "").trim();
}

function formatAsBullet(output: string): string {
  return output
    .split("; ")
    .map((line) => `- ${line}`)
    .join("\n");
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function formatGraphSnapshotMarkdown(snapshot: GraphSnapshotResult): string {
  const typeLine = Object.entries(snapshot.nodeTypeCount)
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
  const relationLine = snapshot.topRelations.length
    ? snapshot.topRelations.map((item) => `${item.relation}:${item.count}`).join(", ")
    : "none";

  return [
    "Graph snapshot:",
    `- transport: ${snapshot.transport}`,
    `- nodes: ${snapshot.nodeCount}`,
    `- edges: ${snapshot.edgeCount}`,
    `- nodeTypes: ${typeLine}`,
    `- topRelations: ${relationLine}`,
    ...(snapshot.storePath ? [`- store: ${snapshot.storePath}`] : []),
  ].join("\n");
}

function formatSkillInsightsMarkdown(insights: SkillInsightsResult): string {
  if (insights.skills.length === 0) {
    return [
      "Skill insights:",
      `- source: ${insights.source}`,
      `- transport: ${insights.transport}`,
      "- skills: empty",
    ].join("\n");
  }

  const lines = insights.skills
    .slice(0, 10)
    .map((skill) => `- ${skill.name} | score=${skill.score} | uses=${skill.uses} | last=${skill.lastOutcome}`);

  return [
    "Skill insights:",
    `- source: ${insights.source}`,
    `- transport: ${insights.transport}`,
    ...(insights.storePath ? [`- store: ${insights.storePath}`] : []),
    ...lines,
  ].join("\n");
}

function showGraphSnapshotPanel(snapshot: GraphSnapshotResult): void {
  const panel = vscode.window.createWebviewPanel(
    "graphflow.graphSnapshot",
    "GraphFlow Graph Snapshot",
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  panel.webview.html = buildGraphSnapshotHtml(snapshot);
}

function showSkillInsightsPanel(insights: SkillInsightsResult): void {
  const panel = vscode.window.createWebviewPanel(
    "graphflow.skillInsights",
    "GraphFlow Skill Insights",
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  panel.webview.html = buildSkillInsightsHtml(insights);
}
