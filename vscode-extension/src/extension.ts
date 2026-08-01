import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolveRuntimeCwd, requireWorkspaceFolder } from "./workspace";
import {
  buildAgentWorkItemsHtml,
  buildContextPreviewHtml,
  buildGraphSnapshotHtml,
  buildSettingsHtml,
  buildSkillInsightsHtml,
  type AgentDelegationPanelResult,
  type AgentWorkItemView,
  type ContextPreviewResult,
  type GraphSnapshotResult,
  type GraphFlowSettings,
  type SettingsPanelStatus,
  type SkillInsightsResult,
} from "./panels";
import type { GraphFlowRuntime } from "./runtime-types";

interface RunRecord {
  task: string;
  status: string;
  attempts: number;
  feedback: string;
  timestamp: number;
}

const runs: RunRecord[] = [];
function resolveChatParticipantId(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { publisher?: string; name?: string };
    const publisher = pkg.publisher || "roarpeng";
    const name = pkg.name || "graphflow";
    return `${publisher}.${name}.graphflowAgent`;
  } catch {
    return "roarpeng.graphflow.graphflowAgent";
  }
}
const CHAT_PARTICIPANT_ID = resolveChatParticipantId();
let runtimePromise: Promise<GraphFlowRuntime> | undefined;

const MCP_INSTALL_VERSION_KEY = "graphflow.mcpInstallVersion";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = getWorkspaceRoot();
  const output = vscode.window.createOutputChannel("GraphFlow");
  context.subscriptions.push(output);

  void bootstrapExtension(context, workspaceRoot, output);

  if (workspaceRoot) {
    runGraphFlow(workspaceRoot, (runtime) => runtime.indexGraph(workspaceRoot)).catch((err) => {
      console.error("GraphFlow auto-index on activate failed:", err);
    });
    registerDebouncedIndexOnSave(context, workspaceRoot);
  }

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
      vscode.window.showInformationMessage("GraphFlow: 请先打开一个项目文件夹。", "打开文件夹").then((choice) => {
        if (choice === "打开文件夹") {
          void vscode.commands.executeCommand("workbench.action.files.openFolder");
        }
      });
      return;
    }

    const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(task));
    const result = await runGraphFlow(workspaceRoot, (runtime) => runtime.runTaskResult(task));

    const record: RunRecord = {
      task,
      status: result.status,
      attempts: result.attempts,
      feedback: result.feedback,
      timestamp: Date.now(),
    };

    runs.push(record);

    if (shouldShowAgentWorkItemsPanel(result)) {
      showAgentWorkItemsPanel(context, buildPanelResultFromRun(task, result, preview));
      return;
    }

    vscode.window.showInformationMessage(
      `GraphFlow finished: ${record.status}; saved≈${preview.tokenBudget.estimatedSavingsPercent}% tokens`
    );
  });

  const planInsightCommand = vscode.commands.registerCommand("graphflow.planInsight", async () => {
    const task = await vscode.window.showInputBox({
      title: "GraphFlow Plan Insight (Six Hats)",
      prompt: "Enter task description for agent-delegated plan insight",
      placeHolder: "refactor architecture and add tests",
    });

    if (!task) {
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showInformationMessage("GraphFlow: 请先打开一个项目文件夹。", "打开文件夹").then((choice) => {
        if (choice === "打开文件夹") {
          void vscode.commands.executeCommand("workbench.action.files.openFolder");
        }
      });
      return;
    }

    const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(task));
    const result = await runGraphFlow(workspaceRoot, (runtime) => runtime.planInsightResult(task));

    if (shouldShowAgentWorkItemsPanel(result)) {
      showAgentWorkItemsPanel(context, {
        task,
        mode: result.mode,
        agentInstructions: result.agentInstructions,
        agentWorkItems: (result.agentWorkItems ?? []) as AgentWorkItemView[],
        plan: result.plan,
        tokenBudget: preview.tokenBudget,
      });
      return;
    }

    vscode.window.showInformationMessage(
      `GraphFlow plan insight (${result.mode}): ${result.plan.length} tasks; saved≈${preview.tokenBudget.estimatedSavingsPercent}% tokens`
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
      vscode.window.showInformationMessage("GraphFlow: 请先打开一个项目文件夹。", "打开文件夹").then((choice) => {
        if (choice === "打开文件夹") {
          void vscode.commands.executeCommand("workbench.action.files.openFolder");
        }
      });
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
      vscode.window.showInformationMessage("GraphFlow: 请先打开一个项目文件夹。", "打开文件夹").then((choice) => {
        if (choice === "打开文件夹") {
          void vscode.commands.executeCommand("workbench.action.files.openFolder");
        }
      });
      return;
    }

    const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(query));
    showContextPreviewPanel(context, preview);
  });

  const showSettings = vscode.commands.registerCommand("graphflow.showSettings", async () => {
    await openGraphFlowSettings(context, output);
  });

  const showGraph = vscode.commands.registerCommand("graphflow.showGraph", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showInformationMessage("GraphFlow: 请先打开一个项目文件夹。", "打开文件夹").then((choice) => {
        if (choice === "打开文件夹") {
          void vscode.commands.executeCommand("workbench.action.files.openFolder");
        }
      });
      return;
    }

    const snapshot = await runGraphFlow(workspaceRoot, (runtime) =>
      runtime.inspectGraph(undefined, { nodeLimit: 120, edgeLimit: 200 })
    );
    showGraphSnapshotPanel(context, snapshot);
  });

  const showSkills = vscode.commands.registerCommand("graphflow.showSkills", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showInformationMessage("GraphFlow: 请先打开一个项目文件夹。", "打开文件夹").then((choice) => {
        if (choice === "打开文件夹") {
          void vscode.commands.executeCommand("workbench.action.files.openFolder");
        }
      });
      return;
    }

    const insights = await runGraphFlow(workspaceRoot, (runtime) => runtime.getSkillInsights(undefined, 24));
    const flywheel = await runGraphFlow(workspaceRoot, (runtime) =>
      Promise.resolve(runtime.getFlywheelReport())
    );
    showSkillInsightsPanel(context, { ...insights, flywheel });
  });

  const installMcp = vscode.commands.registerCommand("graphflow.installMcp", async () => {
    const root = getWorkspaceRoot();
    await runConfigBootstrap(root, output);
    await runMcpBootstrap(context, root, output, { forceNotify: true, installScope: "all" });
    await installSkillsFromExtension(context, root, output, { includeProjectLevel: true });
  });

  const participant = vscode.chat.createChatParticipant(
    CHAT_PARTICIPANT_ID,
    async (request, _context, stream) => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        stream.markdown("GraphFlow: 请先打开一个项目文件夹后再使用。");
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
        const snapshot = await runGraphFlow(workspaceRoot, (runtime) =>
          runtime.inspectGraph(undefined, { nodeLimit: 24, edgeLimit: 36 })
        );
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
        const insights = await runGraphFlow(workspaceRoot, (runtime) => runtime.getSkillInsights(undefined, 12));
        stream.markdown(formatSkillInsightsMarkdown(insights));
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

      if (command === "plan-insight") {
        const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(payload));
        const result = await runGraphFlow(workspaceRoot, (runtime) => runtime.planInsightResult(payload));

        if (shouldShowAgentWorkItemsPanel(result)) {
          showAgentWorkItemsPanel(context, {
            task: payload,
            mode: result.mode,
            agentInstructions: result.agentInstructions,
            agentWorkItems: (result.agentWorkItems ?? []) as AgentWorkItemView[],
            plan: result.plan,
            tokenBudget: preview.tokenBudget,
          });
          stream.markdown(formatAgentDelegationChatMarkdown(payload, preview, result));
          return;
        }

        const planLines = result.plan.map((node) => `- ${node.id}: ${node.description}`);
        stream.markdown(
          [
            `Plan insight (${result.mode}):`,
            formatContextBudgetBullets(preview),
            "",
            `Plan (${result.plan.length} tasks):`,
            ...(planLines.length > 0 ? planLines : ["- empty"]),
          ].join("\n")
        );
        return;
      }

      const preview = await runGraphFlow(workspaceRoot, (runtime) => runtime.previewContext(payload));
      const result = await runGraphFlow(workspaceRoot, (runtime) => runtime.runTaskResult(payload));
      runs.push({
        task: payload,
        status: result.status,
        attempts: result.attempts,
        feedback: result.feedback,
        timestamp: Date.now(),
      });

      if (shouldShowAgentWorkItemsPanel(result)) {
        showAgentWorkItemsPanel(context, buildPanelResultFromRun(payload, result, preview));
        stream.markdown(formatAgentDelegationChatMarkdown(payload, preview, result));
        return;
      }

      stream.markdown(
        `Token budget:\n${formatContextBudgetBullets(preview)}\n\nRun result:\n- status: ${result.status}\n- attempts: ${result.attempts}\n- feedback: ${result.feedback}`
      );
    }
  );

  context.subscriptions.push(
    runTask,
    planInsightCommand,
    showRuns,
    planTask,
    previewContextCommand,
    showSettings,
    showGraph,
    showSkills,
    installMcp,
    participant
  );
}

async function bootstrapExtension(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
  output: vscode.OutputChannel
): Promise<void> {
  await runConfigBootstrap(workspaceRoot, output);

  const extensionVersion = context.extension.packageJSON.version as string;
  const lastInstalledVersion = context.globalState.get<string>(MCP_INSTALL_VERSION_KEY);
  const isFreshInstall = lastInstalledVersion !== extensionVersion;

  // Painless Windows migrate: rewrite any existing spaced Program Files commands
  // before (re)install, so Trae Solo works without a manual "Install MCP" click.
  await runMcpWindowsSpaceRepair(workspaceRoot, output);

  await runMcpBootstrap(context, workspaceRoot, output, { forceNotify: isFreshInstall, isFreshInstall });

  // MCP 安装成功后，安装用户级 Skill / Rules（项目级文件仅在显式 "Install MCP" 时写入）
  await installSkillsFromExtension(context, workspaceRoot, output);

  if (isFreshInstall) {
    await context.globalState.update(MCP_INSTALL_VERSION_KEY, extensionVersion);
  }
}

async function runConfigBootstrap(
  workspaceRoot: string | undefined,
  output: vscode.OutputChannel
): Promise<void> {
  const cwdRoot = workspaceRoot ?? process.cwd();

  try {
    const globalResult = await runGraphFlow(cwdRoot, (runtime) =>
      Promise.resolve(runtime.ensureGlobalGraphFlowConfig())
    );
    output.appendLine(
      `[GraphFlow] Global config ${globalResult.status}: ${globalResult.path}`
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    output.appendLine(`[GraphFlow] Config scaffold failed: ${text}`);
  }
}

async function runMcpWindowsSpaceRepair(
  workspaceRoot: string | undefined,
  output: vscode.OutputChannel
): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const cwdRoot = workspaceRoot ?? process.cwd();
  try {
    const repairs = await runGraphFlow(cwdRoot, (runtime) =>
      Promise.resolve(runtime.repairUnsafeWindowsMcpCommands())
    );
    const fixed = repairs.filter((r) => r.repaired);
    if (fixed.length === 0) {
      return;
    }
    output.appendLine("[GraphFlow] Auto-repaired Windows MCP spaced paths:");
    for (const item of fixed) {
      output.appendLine(
        `- ${item.agentName}: ${item.beforeCommand} → ${item.afterCommand} (${item.configPath})`
      );
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    output.appendLine(`[GraphFlow] MCP path auto-repair skipped: ${text}`);
  }
}

async function runMcpBootstrap(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
  output: vscode.OutputChannel,
  options: { forceNotify: boolean; isFreshInstall?: boolean; installScope?: "user" | "all" }
): Promise<{
  results: Awaited<ReturnType<GraphFlowRuntime["installMcpToDetectedAgents"]>>;
  mcpAgents: Awaited<ReturnType<GraphFlowRuntime["getSettingsPanelStatus"]>>["mcpAgents"];
} | undefined> {
  const extensionPath = context.extensionPath;
  const bundledRuntimeRoot = join(extensionPath, "vendor", "graphflow");
  const bundledServerPath = join(bundledRuntimeRoot, "dist", "surfaces", "mcp", "server.js");
  const launcherPath =
    process.platform === "win32"
      ? join(extensionPath, "mcp-launcher.cmd")
      : join(extensionPath, "mcp-launcher.cjs");
  const cwdRoot = workspaceRoot ?? process.cwd();

  try {
    const results = await runGraphFlow(cwdRoot, (runtime) =>
      Promise.resolve(
        runtime.installMcpToDetectedAgents({
          strategy: "node-bundled",
          // Default user-scope only (matches CLI init). Workspace .cursor/mcp.json is opt-in via Install MCP.
          installScope: options.installScope ?? "user",
          ...(workspaceRoot ? { workspaceRoot } : {}),
          bundledServerPath,
          bundledRuntimeRoot,
          launcherPath,
          ...(process.platform === "win32" ? { electronExecPath: process.execPath } : {}),
        })
      )
    );

    const successes = results.filter((result) => result.status === "injected" || result.status === "created");
    const updated = results.filter((result) => result.status === "updated");
    const detected = await runGraphFlow(cwdRoot, (runtime) => Promise.resolve(runtime.detectInstalledAgents()));
    const guide = await runGraphFlow(cwdRoot, (runtime) =>
      Promise.resolve(runtime.formatModelConfigGuide(workspaceRoot))
    );
    const panelStatus = await runGraphFlow(cwdRoot, (runtime) => runtime.getSettingsPanelStatus());

    output.appendLine("[GraphFlow] MCP auto-install results:");
    for (const result of results) {
      output.appendLine(`- ${result.agentName} (${result.scope}) ${result.status}: ${result.configPath}${result.message ? ` (${result.message})` : ""}`);
    }
    output.appendLine("");
    output.appendLine(guide);

    if (options.isFreshInstall) {
      if (workspaceRoot) {
        void vscode.commands.executeCommand("graphflow.showSettings");
      } else {
        vscode.window.showInformationMessage("GraphFlow 安装成功！请打开一个项目文件夹以开始使用。", "打开项目").then((choice) => {
          if (choice === "打开项目") {
            void vscode.commands.executeCommand("workbench.action.files.openFolder");
          }
        });
      }
    }

    if (!options.forceNotify && successes.length === 0) {
      return { results, mcpAgents: panelStatus.mcpAgents };
    }

    const agentNames = detected.map((agent) => agent.name).join(", ") || "未检测到";
    if (successes.length === 0 && updated.length === 0) {
      vscode.window.showWarningMessage(
        `GraphFlow 未写入 MCP（嗅探到: ${agentNames}）。可运行 "GraphFlow: Install MCP to Agents" 重试。`,
        "打开设置"
      ).then((choice) => {
        if (choice === "打开设置") {
          void vscode.commands.executeCommand("graphflow.showSettings");
        }
      });
      return { results, mcpAgents: panelStatus.mcpAgents };
    }

    const allNotified = [...successes, ...updated];
    const installedNames = [...new Set(allNotified.map((result) => result.agentName))].join(", ");
    
    const message = workspaceRoot
      ? `GraphFlow MCP 已安装到: ${installedNames}。请配置模型 API Key 后重启对应 Agent 工具。`
      : `GraphFlow MCP 已安装到: ${installedNames}。请打开一个项目文件夹以使用 GraphFlow 的全部功能。`;
    
    const buttons = workspaceRoot ? ["配置模型"] : ["打开项目"];
    
    vscode.window
      .showInformationMessage(message, ...buttons)
      .then((choice) => {
        if (choice === "配置模型") {
          void vscode.commands.executeCommand("graphflow.showSettings");
        } else if (choice === "打开项目") {
          void vscode.commands.executeCommand("workbench.action.files.openFolder");
        }
      });
    return { results, mcpAgents: panelStatus.mcpAgents };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    output.appendLine(`[GraphFlow] MCP auto-install failed: ${text}`);
    if (options.forceNotify) {
      vscode.window.showErrorMessage(`GraphFlow MCP 自动安装失败: ${text}`);
    }
    return undefined;
  }
}

/**
 * 在 VS Code 扩展激活时安装 Trae Skill / Cursor Rules / Claude Code CLAUDE.md。
 * 通过 vendor 运行时动态加载 skill-installer 模块，所有失败静默处理。
 */
async function installSkillsFromExtension(
  context: vscode.ExtensionContext,
  workspaceRoot: string | undefined,
  output: vscode.OutputChannel,
  options?: { includeProjectLevel?: boolean }
): Promise<void> {
  try {
    const extensionPath = context.extensionPath;
    const bundledRuntimeRoot = join(extensionPath, "vendor", "graphflow");

    // 动态加载 vendor 中的 skill-installer 模块
    const installerPath = join(bundledRuntimeRoot, "dist", "integrations", "skill-installer.js");
    let installer: typeof import("../../src/integrations/skill-installer") | undefined;

    try {
      const loaded = await import(pathToFileURL(installerPath).toString());
      installer = loaded as typeof installer;
    } catch {
      // vendor 中没有 skill-installer（构建尚未包含），跳过
      output.appendLine("[GraphFlow] Skill installer module not found in vendor, skipping skill installation.");
      return;
    }

    if (typeof installer?.installAllSkills !== "function") {
      output.appendLine("[GraphFlow] installAllSkills function not found in skill-installer module.");
      return;
    }

    const projectRoot = options?.includeProjectLevel ? workspaceRoot : undefined;
    const summary = installer.installAllSkills(bundledRuntimeRoot, (msg) => {
      output.appendLine(`[GraphFlow] ${msg}`);
    }, projectRoot);

    // 汇总日志
    const changed = (list?: Array<{ status: string }>): number =>
      (list ?? []).filter((r) => r.status === "created" || r.status === "updated").length;
    const totalCount =
      changed(summary.traeSkills) +
      changed(summary.cursorRules) +
      changed(summary.claudeMd) +
      changed(summary.agentInstructions) +
      changed(summary.agentSkills);

    if (totalCount > 0) {
      output.appendLine(`[GraphFlow] Skill/Rules 安装完成：${totalCount} 个文件已创建或更新。`);
    }
  } catch (err) {
    // 静默处理所有异常，不影响扩展正常使用
    const text = err instanceof Error ? err.message : String(err);
    output.appendLine(`[GraphFlow] Skill installation skipped: ${text}`);
  }
}

export function deactivate(): void {
  // no-op
}

async function runGraphFlow<T>(
  workspaceRoot: string | undefined,
  execute: (runtime: GraphFlowRuntime) => Promise<T>
): Promise<T> {
  const runtime = await loadRuntime();
  return withWorkspaceCwd(resolveRuntimeCwd(workspaceRoot), () => execute(runtime));
}

async function loadRuntime(): Promise<GraphFlowRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      process.env.GRAPHFLOW_LOG_JSON = process.env.GRAPHFLOW_LOG_JSON ?? "1";
      const runtimePath = join(__dirname, "..", "vendor", "graphflow", "dist", "surfaces", "cli", "runtime.js");
      const loaded = (await import(pathToFileURL(runtimePath).toString())) as {
        assertGraphFlowRuntime?: (module: unknown) => GraphFlowRuntime;
      };
      if (typeof loaded.assertGraphFlowRuntime === "function") {
        return loaded.assertGraphFlowRuntime(loaded);
      }

      throw new Error("Bundled GraphFlow runtime is missing assertGraphFlowRuntime export.");
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
): "run" | "plan" | "plan-insight" | "history" | "context" | "settings" | "diagnose" | "learn" | "graph" | "skills" {
  if (prompt.startsWith("/plan-insight") || prompt.startsWith("/insight")) {
    return "plan-insight";
  }

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

  return "run";
}

function stripInlineCommand(prompt: string): string {
  return prompt
    .replace(/^\/plan-insight\s*/i, "")
    .replace(/^\/insight\s*/i, "")
    .replace(/^\/(run|plan|history|context|settings|diagnose|learn|graph|skills)\s*/i, "")
    .trim();
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

async function openGraphFlowSettings(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const [settings, panelStatus] = await runGraphFlow(workspaceRoot, async (runtime) => {
    const loaded = runtime.getGraphFlowSettings();
    const status = await runtime.getSettingsPanelStatus();
    return [loaded, status] as const;
  });
  const extensionVersion = context.extension.packageJSON.version?.toString() ?? "unknown";
  showSettingsPanel(
    context,
    settings,
    {
      ...panelStatus,
      extensionVersion,
    },
    workspaceRoot,
    output
  );
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

function formatAgentDelegationChatMarkdown(
  task: string,
  preview: ContextPreviewResult,
  result: {
    mode?: string;
    episodeId?: string;
    agentWorkItems?: unknown[];
    executionDescriptor?: {
      agentMode?: string;
      agentWorkItems?: unknown[];
      context?: string;
    };
    plan?: Array<{ id: string; description: string; dependencies: string[] }>;
  }
): string {
  const workItems = (result.agentWorkItems ??
    result.executionDescriptor?.agentWorkItems ??
    []) as AgentWorkItemView[];
  const episodeSuffix = result.episodeId ? `, \`episodeId\`=\`${result.episodeId}\`` : "";
  const plan =
    result.plan ?? parsePlanFromExecutionContext(result.executionDescriptor?.context) ?? [];

  const lines = [
    "Agent-delegated mode (connected agent supplies LLM):",
    `- task: ${task}`,
    ...(result.mode ? [`- mode: ${result.mode}`] : []),
    ...(result.episodeId ? [`- episodeId: \`${result.episodeId}\``] : []),
    `- agentWorkItems: ${workItems.length}`,
    "",
    "Token budget:",
    formatContextBudgetBullets(preview),
  ];

  if (workItems.length > 0) {
    lines.push("", "Work items:");
    for (const item of workItems) {
      const previewText =
        item.prompt.length > 100 ? `${item.prompt.slice(0, 100)}…` : item.prompt;
      lines.push(`- **${item.id}** (${item.kind}): ${previewText}`);
    }
  }

  lines.push(
    "",
    "Close the loop:",
    "1. Answer each work-item prompt with your model.",
    `2. Call \`graphflow_insight\` with mode=\`submit\` per item (\`task\`, \`workItemId\`, \`response\`${episodeSuffix}).`,
    "3. When all required items are submitted, call `graphflow_insight` with mode=`merge` to produce the real insight + plan.",
    "4. Execute the plan / `executionDescriptor`.",
    `5. Call \`graphflow_report_outcome\` with \`success\`${result.episodeId ? ` and \`episodeId\`=\`${result.episodeId}\`` : ""}.`
  );

  if (plan.length > 0) {
    lines.push("", `Plan preview (${plan.length} tasks):`);
    for (const node of plan) {
      lines.push(`- ${node.id}: ${node.description}`);
    }
  }

  return lines.join("\n");
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

function showAgentWorkItemsPanel(
  context: vscode.ExtensionContext,
  result: AgentDelegationPanelResult
): void {
  const panel = vscode.window.createWebviewPanel(
    "graphflow.agentWorkItems",
    "GraphFlow Agent Work Items",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "agent-work-items.js")
  );
  panel.webview.html = buildAgentWorkItemsHtml(result, scriptUri.toString());
  context.subscriptions.push(panel);
}

function shouldShowAgentWorkItemsPanel(result: {
  mode?: string;
  executionDescriptor?: { agentMode?: string; agentWorkItems?: unknown[] };
  agentWorkItems?: unknown[];
}): boolean {
  if (result.mode === "agent-delegated") {
    return true;
  }
  if ((result.agentWorkItems?.length ?? 0) > 0) {
    return true;
  }
  if (result.executionDescriptor?.agentMode === "delegated-llm") {
    return true;
  }
  return (result.executionDescriptor?.agentWorkItems?.length ?? 0) > 0;
}

function buildPanelResultFromRun(
  task: string,
  result: {
    episodeId?: string;
    executionDescriptor?: AgentDelegationPanelResult["executionDescriptor"];
  },
  preview?: ContextPreviewResult
): AgentDelegationPanelResult {
  const executionDescriptor = result.executionDescriptor;
  const agentWorkItems = (executionDescriptor?.agentWorkItems ?? []) as AgentWorkItemView[];

  return {
    task,
    mode:
      executionDescriptor?.agentMode === "delegated-llm" || agentWorkItems.length > 0
        ? "agent-delegated"
        : "llm",
    agentWorkItems,
    plan: parsePlanFromExecutionContext(executionDescriptor?.context),
    executionDescriptor,
    episodeId: result.episodeId,
    tokenBudget: preview?.tokenBudget,
  };
}

function parsePlanFromExecutionContext(
  context?: string
): AgentDelegationPanelResult["plan"] | undefined {
  if (!context) {
    return undefined;
  }

  const match = context.match(/plan=(\[[\s\S]*?\])(?:;|$)/);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]) as Array<{
      id: string;
      description: string;
      dependencies: string[];
    }>;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function registerDebouncedIndexOnSave(context: vscode.ExtensionContext, workspaceRoot: string): void {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleIndex = (): void => {
    void runGraphFlow(workspaceRoot, async (runtime) => {
      const settings = runtime.getGraphFlowSettings();
      if (!settings.autoIndexOnSave) {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        void runGraphFlow(workspaceRoot, (activeRuntime) =>
          activeRuntime.indexGraph(workspaceRoot)
        ).catch((err) => {
          console.error("GraphFlow debounced index on save failed:", err);
        });
      }, 3000);
    }).catch((err) => {
      console.error("GraphFlow save-index settings lookup failed:", err);
    });
  };

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx,md,json}");
  watcher.onDidChange(scheduleIndex);
  watcher.onDidCreate(scheduleIndex);
  watcher.onDidDelete(scheduleIndex);
  context.subscriptions.push(watcher);
}

function showSettingsPanel(
  context: vscode.ExtensionContext,
  settings: GraphFlowSettings,
  status: SettingsPanelStatus,
  workspaceRoot: string | undefined,
  output: vscode.OutputChannel
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
  panel.webview.html = buildSettingsHtml(settings, scriptUri.toString(), status);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === "installMcp") {
      try {
        const bootstrap = await runMcpBootstrap(context, workspaceRoot, output, { forceNotify: false });
        const panelStatus = await runGraphFlow(workspaceRoot, (runtime) => runtime.getSettingsPanelStatus());
        const successes =
          bootstrap?.results.filter((result) => result.status === "injected" || result.status === "created" || result.status === "updated") ??
          [];
        const installedNames = [...new Set(successes.map((result) => result.agentName))].join(", ");
        panel.webview.postMessage({
          type: "mcpInstallResult",
          payload: {
            ok: successes.length > 0,
            mcpAgents: panelStatus.mcpAgents,
            message:
              successes.length > 0
                ? `MCP 已写入: ${installedNames}。请重启对应 Agent / IDE 以加载 graphflow 工具。`
                : "未写入 MCP。请确认本机已安装 Cursor / VS Code / Claude Code 等工具后重试。",
          },
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({
          type: "mcpInstallResult",
          payload: { ok: false, message: `MCP 安装失败: ${text}` },
        });
      }
      return;
    }

    if (message?.type === "indexGraphOnly") {
      if (!requireWorkspaceFolder(workspaceRoot)) {
        vscode.window.showWarningMessage("请先打开一个项目文件夹后再建立或索引知识图谱。");
        return;
      }
      const payload = message.payload as Omit<GraphFlowSettings, "configPath">;
      try {
        output.appendLine("[GraphFlow] Building knowledge graph (structural index, LLM optional)...");
        output.show(true);

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "GraphFlow 建立知识图谱",
            cancellable: false,
          },
          async () =>
            runGraphFlow(workspaceRoot, (runtime) => runtime.indexGraphFromSettings(payload, workspaceRoot))
        );

        if (result.ok && result.graphIndex) {
          output.appendLine(
            `[GraphFlow] Graph indexed: files=${result.graphIndex.indexedFiles}; symbols=${result.graphIndex.indexedSymbols}`
          );
          void vscode.commands.executeCommand("graphflow.showGraph");
          vscode.window.showInformationMessage(
            `知识图谱已建立：${result.graphIndex.indexedFiles} 个文件（结构索引，无需 LLM）。`
          );
        } else if (!result.ok) {
          const reason =
            result.validationIssues?.map((issue) => issue.message).join("; ") || "索引失败";
          vscode.window.showWarningMessage(`GraphFlow 建立图谱未成功：${reason}`);
        }

        panel.webview.postMessage({
          type: "graphIndexResult",
          payload: result,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ type: "settingsError", payload: text });
        vscode.window.showErrorMessage(`GraphFlow 建立图谱失败: ${text}`);
      }
      return;
    }

    if (message?.type === "testRoutingAndIndex") {
      if (!requireWorkspaceFolder(workspaceRoot)) {
        vscode.window.showWarningMessage("请先打开一个项目文件夹后再建立或索引知识图谱。");
        return;
      }
      const payload = message.payload as Omit<GraphFlowSettings, "configPath">;
      try {
        output.appendLine("[GraphFlow] Testing routing connectivity (planner + worker)...");
        output.show(true);

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "GraphFlow 路由连通性测试",
            cancellable: false,
          },
          async () =>
            runGraphFlow(workspaceRoot, (runtime) => runtime.testRoutingAndIndexGraph(payload, workspaceRoot))
        );

        const diagnoseSummary = await runGraphFlow(workspaceRoot, (runtime) =>
          Promise.resolve(runtime.diagnoseRouting())
        );

        for (const probe of result.probes) {
          output.appendLine(
            `[GraphFlow][Route] ${probe.role} ${probe.provider}/${probe.model}: ${
              probe.ok ? `OK (${probe.latencyMs}ms)` : probe.error ?? "failed"
            }`
          );
        }

        if (result.ok && result.graphIndex) {
          output.appendLine(
            `[GraphFlow] Graph indexed: files=${result.graphIndex.indexedFiles}; symbols=${result.graphIndex.indexedSymbols}`
          );
          void vscode.commands.executeCommand("graphflow.showGraph");
          vscode.window.showInformationMessage(
            `GraphFlow 路由测试通过，已索引 ${result.graphIndex.indexedFiles} 个文件。`
          );
        } else if (!result.ok) {
          vscode.window.showWarningMessage("GraphFlow 路由测试未通过，请检查 API Key 与 Base URL。");
        }

        panel.webview.postMessage({
          type: "routingTestResult",
          payload: {
            ...result,
            diagnosisSummary: diagnoseSummary,
          },
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ type: "settingsError", payload: text });
        vscode.window.showErrorMessage(`GraphFlow 路由测试失败: ${text}`);
      }
      return;
    }

    if (message?.type !== "saveSettings") {
      return;
    }

    try {
      const payload = message.payload as Omit<GraphFlowSettings, "configPath">;

      const saved = await runGraphFlow(workspaceRoot, (runtime) =>
        Promise.resolve(runtime.saveGraphFlowSettings(payload))
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
    "GraphFlow 知识图谱",
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
    meta: {
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
      nodeTypeCount: snapshot.nodeTypeCount,
      topRelations: snapshot.topRelations,
      storePath: snapshot.storePath,
    },
  };

  const postSnapshot = (): void => {
    void panel.webview.postMessage({ type: "snapshot", payload });
  };

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === "ready") {
      postSnapshot();
      return;
    }
    if (message?.type === "openSource" && typeof message.path === "string" && message.path.length > 0) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage("请先打开工作区文件夹后再跳转源文件。");
        return;
      }
      const uri = vscode.Uri.joinPath(folder.uri, message.path);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        const line = typeof message.line === "number" && message.line > 0 ? message.line - 1 : 0;
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`无法打开源文件 ${message.path}: ${text}`);
      }
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
