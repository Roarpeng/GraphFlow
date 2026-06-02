import * as vscode from "vscode";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  buildContextPreviewHtml,
  buildGraphSnapshotHtml,
  buildSettingsHtml,
  buildSkillInsightsHtml,
  type ContextPreviewResult,
  type GraphSnapshotResult,
  type GraphFlowSettings,
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
  previewContext(query: string): Promise<ContextPreviewResult>;
  enrichSemanticsSilent(configPath?: string, options?: { batchSize?: number; sleepMs?: number; timeoutMs?: number }): Promise<{ enrichedCount: number }>;
  diagnoseRouting(): string;
  runLearningNightly(): string;
  inspectGraph(nodeLimit?: number, edgeLimit?: number): Promise<GraphSnapshotResult>;
  getSkillInsights(limit?: number): Promise<SkillInsightsResult>;
  getGraphFlowSettings(): GraphFlowSettings;
  saveGraphFlowSettings(settings: Omit<GraphFlowSettings, "configPath">): GraphFlowSettings;
  downloadOpenBmbModel(
    configPath?: string,
    options?: {
      model?: string;
      url?: string;
      sha256?: string;
      targetPath?: string;
      force?: boolean;
      onProgress?: (progress: {
        model: string;
        targetPath: string;
        downloadedBytes: number;
        totalBytes?: number;
        percent?: number;
        stage: "starting" | "downloading" | "verifying" | "completed" | "skipped";
      }) => void;
    }
  ): Promise<{ model: string; targetPath: string; bytes: number; skipped: boolean; verified: boolean; resumed?: boolean }>;
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

    const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(task));
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
    vscode.window.showInformationMessage(
      `GraphFlow finished: ${record.status}; saved≈${preview.tokenBudget.estimatedSavingsPercent}% tokens`
    );
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

    const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(task));
    const output = await runGraphFlow(workspaceRoot, (runtime) => Promise.resolve(runtime.planAndBrainstorm(task)));
    await vscode.window.showQuickPick(output.split("; "), {
      title: `GraphFlow Plan & Brainstorm (saved≈${preview.tokenBudget.estimatedSavingsPercent}% tokens)`,
    });
  });

  const previewContextCommand = vscode.commands.registerCommand("graphflow.previewContext", async () => {
    const query = await vscode.window.showInputBox({
      title: "GraphFlow Context Preview",
      prompt: "Enter query or task description",
      placeHolder: "refactor planner and reduce token usage",
    });

    if (!query) {
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(query));
    showContextPreviewPanel(context, preview);
  });

  const showSettings = vscode.commands.registerCommand("graphflow.showSettings", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const settings = await runGraphFlow(workspaceRoot, (runtime) =>
      Promise.resolve(runtime.getGraphFlowSettings())
    );
    showSettingsPanel(context, settings, workspaceRoot);
  });

  const showGraph = vscode.commands.registerCommand("graphflow.showGraph", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const snapshot = await runGraphFlow(workspaceRoot, (runtime) => runtime.inspectGraph(48, 96));
    showGraphSnapshotPanel(context, snapshot);
  });

  const showSkills = vscode.commands.registerCommand("graphflow.showSkills", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const insights = await runGraphFlow(workspaceRoot, (runtime) => runtime.getSkillInsights(24));
    showSkillInsightsPanel(context, insights);
  });

  const enrichGraph = vscode.commands.registerCommand("graphflow.enrichGraph", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const result = await runGraphFlow(workspaceRoot, (runtime) => runtime.enrichSemanticsSilent());
    vscode.window.showInformationMessage(`GraphFlow enriched ${result.enrichedCount} symbol nodes.`);
  });

  const downloadModel = vscode.commands.registerCommand("graphflow.downloadModel", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const model = (await vscode.window.showInputBox({
      title: "GraphFlow Download Model",
      prompt: "Enter model name",
      value: "minicpm-1b",
      placeHolder: "minicpm-1b",
    }))?.trim();

    if (!model) {
      return;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GraphFlow downloading ${model}`,
        cancellable: false,
      },
      async (progress) => {
        let lastPercent = 0;
        return runGraphFlow(workspaceRoot, (runtime) =>
          runtime.downloadOpenBmbModel(undefined, {
            model,
            onProgress: (update) => {
              const nextPercent = update.percent ?? lastPercent;
              const increment = Math.max(0, Math.min(100, nextPercent - lastPercent));
              lastPercent = nextPercent;
              const total = update.totalBytes !== undefined ? formatBytes(update.totalBytes) : "unknown";
              progress.report({
                increment,
                message: `${update.stage} ${formatBytes(update.downloadedBytes)}/${total}`,
              });
            },
          })
        );
      }
    );

    vscode.window.showInformationMessage(
      `GraphFlow model ready: ${result.model} -> ${result.targetPath}`
    );
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

      if (command === "settings") {
        const settings = await runGraphFlow(workspaceRoot, (runtime) =>
          Promise.resolve(runtime.getGraphFlowSettings())
        );
        stream.markdown(formatSettingsMarkdown(settings));
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
        const snapshot = await runGraphFlow(workspaceRoot, (runtime) => runtime.inspectGraph(24, 36));
        stream.markdown(formatGraphSnapshotMarkdown(snapshot));
        return;
      }

      if (command === "context") {
        if (!payload) {
          stream.markdown("Please provide a context query. Example: `/context refactor planner`");
          return;
        }

        const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(payload));
        stream.markdown(formatContextPreviewMarkdown(preview));
        return;
      }

      if (command === "skills") {
        const insights = await runGraphFlow(workspaceRoot, (runtime) => runtime.getSkillInsights(12));
        stream.markdown(formatSkillInsightsMarkdown(insights));
        return;
      }

      if (command === "enrich") {
        const result = await runGraphFlow(workspaceRoot, (runtime) => runtime.enrichSemanticsSilent());
        stream.markdown(`Graph enrichment result:\n- enrichedCount: ${result.enrichedCount}`);
        return;
      }

      if (!payload) {
        stream.markdown("Please provide a task description. Example: `/run update readme and add tests`");
        return;
      }

      if (command === "plan") {
        const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(payload));
        const output = await runGraphFlow(
          workspaceRoot,
          (runtime) => Promise.resolve(runtime.planAndBrainstorm(payload))
        );
        stream.markdown(`Token budget:\n${formatContextBudgetBullets(preview)}\n\nPlan result:\n\n${formatAsBullet(output)}`);
        return;
      }

      const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(payload));
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
        `Token budget:\n${formatContextBudgetBullets(preview)}\n\nRun result:\n- status: ${parsed.status}\n- attempts: ${parsed.attempts}\n- feedback: ${parsed.feedback}`
      );
    }
  );

  context.subscriptions.push(
    runTask,
    showRuns,
    planTask,
    previewContextCommand,
    showSettings,
    showGraph,
    showSkills,
    enrichGraph,
    downloadModel,
    participant
  );
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
        !module.previewContext ||
        !module.enrichSemanticsSilent ||
        !module.diagnoseRouting ||
        !module.runLearningNightly ||
        !module.inspectGraph ||
        !module.getSkillInsights ||
        !module.getGraphFlowSettings ||
        !module.saveGraphFlowSettings ||
        !module.downloadOpenBmbModel
      ) {
        throw new Error("Bundled GraphFlow runtime is missing required exports.");
      }

      return {
        runTask: module.runTask,
        planAndBrainstorm: module.planAndBrainstorm,
        previewContext: module.previewContext,
        enrichSemanticsSilent: module.enrichSemanticsSilent,
        diagnoseRouting: module.diagnoseRouting,
        runLearningNightly: module.runLearningNightly,
        inspectGraph: module.inspectGraph,
        getSkillInsights: module.getSkillInsights,
        getGraphFlowSettings: module.getGraphFlowSettings,
        saveGraphFlowSettings: module.saveGraphFlowSettings,
        downloadOpenBmbModel: module.downloadOpenBmbModel,
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
): "run" | "plan" | "history" | "context" | "settings" | "diagnose" | "learn" | "graph" | "skills" | "enrich" {
  if (prompt.startsWith("/plan")) {
    return "plan";
  }

  if (prompt.startsWith("/history")) {
    return "history";
  }

  if (prompt.startsWith("/context")) {
    return "context";
  }

  if (prompt.startsWith("/settings")) {
    return "settings";
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

  if (prompt.startsWith("/enrich")) {
    return "enrich";
  }

  return "run";
}

function stripInlineCommand(prompt: string): string {
  return prompt.replace(/^\/(run|plan|history|context|settings|diagnose|learn|graph|skills|enrich)\s*/i, "").trim();
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
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

function formatContextBudgetBullets(preview: ContextPreviewResult): string {
  return [
    `- raw≈${preview.tokenBudget.estimatedRawTokens}`,
    `- compressed=${preview.tokenBudget.compressedTokens}/${preview.tokenBudget.maxContextTokens}`,
    `- saved≈${preview.tokenBudget.estimatedSavingsPercent}%`,
    `- anchors=${preview.anchorCount} (L1=${preview.anchorsByLayer.l1}, L2=${preview.anchorsByLayer.l2}, L3=${preview.anchorsByLayer.l3})`,
  ].join("\n");
}

function formatContextPreviewMarkdown(preview: ContextPreviewResult): string {
  const summary = preview.summary.slice(0, 8).map((item) => `- ${item}`);
  return [
    "Context preview:",
    formatContextBudgetBullets(preview),
    "Summary:",
    ...(summary.length > 0 ? summary : ["- empty"]),
  ].join("\n");
}

function formatSettingsMarkdown(settings: GraphFlowSettings): string {
  return [
    "GraphFlow settings:",
    `- config: ${settings.configPath}`,
    `- provider: ${settings.provider}`,
    `- smart: ${settings.smartModel}`,
    `- economy: ${settings.economyModel}`,
    `- apiKeyEnvVar: ${settings.apiKeyEnvVar ?? "n/a"}`,
    `- maxContextTokens: ${settings.maxContextTokens}`,
    `- layerQuota: L1=${settings.layerQuota.l1}, L2=${settings.layerQuota.l2}, L3=${settings.layerQuota.l3}`,
    `- nearLossless: ${settings.enableNearLosslessMode}`,
  ].join("\n");
}

function showContextPreviewPanel(context: vscode.ExtensionContext, preview: ContextPreviewResult): void {
  const panel = vscode.window.createWebviewPanel(
    "graphflow.contextPreview",
    "GraphFlow Context Preview",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "context-preview.js")
  );
  panel.webview.html = buildContextPreviewHtml(preview, scriptUri.toString());
  context.subscriptions.push(panel);
}

function showSettingsPanel(
  context: vscode.ExtensionContext,
  settings: GraphFlowSettings,
  workspaceRoot: string
): void {
  const panel = vscode.window.createWebviewPanel(
    "graphflow.settings",
    "GraphFlow Settings",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "settings.js")
  );
  panel.webview.html = buildSettingsHtml(settings, scriptUri.toString());
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type !== "saveSettings") {
      return;
    }

    try {
      const saved = await runGraphFlow(workspaceRoot, (runtime) =>
        Promise.resolve(runtime.saveGraphFlowSettings(message.payload as Omit<GraphFlowSettings, "configPath">))
      );
      panel.webview.postMessage({ type: "settingsSaved", payload: saved });
      vscode.window.showInformationMessage("GraphFlow settings saved.");
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      panel.webview.postMessage({ type: "settingsError", payload: text });
      vscode.window.showErrorMessage(`Failed to save GraphFlow settings: ${text}`);
    }
  });
  context.subscriptions.push(panel);
}

function showGraphSnapshotPanel(context: vscode.ExtensionContext, snapshot: GraphSnapshotResult): void {
  const panel = vscode.window.createWebviewPanel(
    "graphflow.graphSnapshot",
    "GraphFlow Graph Snapshot",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "graph-snapshot.js")
  );
  panel.webview.html = buildGraphSnapshotHtml(snapshot, scriptUri.toString());
  wireGraphSnapshotPanel(panel, snapshot);
  context.subscriptions.push(panel);
}

function showSkillInsightsPanel(context: vscode.ExtensionContext, insights: SkillInsightsResult): void {
  const panel = vscode.window.createWebviewPanel(
    "graphflow.skillInsights",
    "GraphFlow Skill Insights",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "skill-insights.js")
  );
  panel.webview.html = buildSkillInsightsHtml(insights, scriptUri.toString());
  wireSkillInsightsPanel(panel, insights);
  context.subscriptions.push(panel);
}

function wireGraphSnapshotPanel(
  panel: vscode.WebviewPanel,
  snapshot: GraphSnapshotResult
): void {
  const payload = {
    nodes: snapshot.sampleNodes,
    edges: snapshot.sampleEdges,
  };

  const postSnapshot = (): void => {
    void panel.webview.postMessage({ type: "snapshot", payload });
  };

  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === "ready") {
      postSnapshot();
    }
  });

  postSnapshot();
}

function wireSkillInsightsPanel(
  panel: vscode.WebviewPanel,
  insights: SkillInsightsResult
): void {
  const postSkills = (): void => {
    void panel.webview.postMessage({
      type: "skills",
      payload: { skills: insights.skills },
    });
  };

  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === "ready") {
      postSkills();
    }
  });

  postSkills();
}
