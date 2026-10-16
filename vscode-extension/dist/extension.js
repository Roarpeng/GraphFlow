"use strict";
const vscode = require("vscode");
const { execFile } = require("node:child_process");

function runGraphflowCli(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["-y", "--package=@roarpeng/graphflow", "graphflow", ...args],
      { cwd: cwd || process.cwd(), timeout: 30000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          output: (stdout || stderr || (err ? err.message : "")).trim(),
        });
      }
    );
  });
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
}

function getExtensionVersion() {
  try {
    const ext = vscode.extensions.getExtension("roarpeng.graphflow");
    const version = ext && ext.packageJSON && ext.packageJSON.version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

async function autoInstallOnce(context, outputChannel) {
  try {
    const cfg = vscode.workspace.getConfiguration("graphflow");
    const enabled = cfg && typeof cfg.get === "function" ? cfg.get("autoInstall", true) : true;
    if (enabled === false) return;
    const version = getExtensionVersion();
    const KEY = "graphflow.installedVersion";
    if (context.globalState.get(KEY) === version) return;
    const root = getWorkspaceRoot();
    outputChannel.appendLine("[GraphFlow] Auto-registering MCP, Skills, Rules & Hooks (v" + version + ")...");
    const res = await runGraphflowCli(["install", "--root", root], root);
    outputChannel.appendLine(res.output);
    if (res.ok) {
      await context.globalState.update(KEY, version);
    } else {
      outputChannel.appendLine("[GraphFlow] Auto-register finished with warnings; run the install command manually if needed.");
    }
  } catch (err) {
    // Fail-open: never break activation because auto-register failed.
    try {
      outputChannel.appendLine("[GraphFlow] Auto-register skipped: " + (err && err.message ? err.message : String(err)));
    } catch {
      /* ignore */
    }
  }
}

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("GraphFlow");

  // Auto-register once per extension version (fail-open): a fresh
  // install/update registers MCP, Skills, Rules & Hooks to every detected
  // agent and prunes legacy registrations. Opt out with
  // `"graphflow.autoInstall": false`.
  void autoInstallOnce(context, outputChannel);

  const installCmd = vscode.commands.registerCommand("graphflow.installMcp", async () => {
    const root = getWorkspaceRoot();
    outputChannel.show(true);
    outputChannel.appendLine("[GraphFlow] Auto-registering MCP, Skills, Rules & Hooks...");
    const res = await runGraphflowCli(["install", "--root", root], root);
    outputChannel.appendLine(res.output);
    if (res.ok) {
      vscode.window.showInformationMessage("GraphFlow MCP, Skills & Hooks registered.");
    } else {
      vscode.window.showWarningMessage("GraphFlow install finished with warnings. Check Output panel.");
    }
  });

  const mineGitCmd = vscode.commands.registerCommand("graphflow.mineGit", async () => {
    const root = getWorkspaceRoot();
    outputChannel.show(true);
    outputChannel.appendLine("[GraphFlow] Mining Git co-change temporal coupling...");
    const res = await runGraphflowCli(["macro", "mine-git", "--root", root], root);
    outputChannel.appendLine(res.output);
    vscode.window.showInformationMessage("GraphFlow Git co-change history mined.");
  });

  const statusCmd = vscode.commands.registerCommand("graphflow.status", async () => {
    const root = getWorkspaceRoot();
    const res = await runGraphflowCli(["status", "--root", root], root);
    outputChannel.show(true);
    outputChannel.appendLine(res.output);
    vscode.window.showInformationMessage(res.output || "GraphFlow status logged to Output.");
  });

  context.subscriptions.push(outputChannel, installCmd, mineGitCmd, statusCmd);
}

function deactivate() {}

module.exports = { activate, deactivate };
