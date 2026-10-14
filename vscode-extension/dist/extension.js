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

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("GraphFlow");

  const installCmd = vscode.commands.registerCommand("graphflow.installMcp", async () => {
    const root = getWorkspaceRoot();
    outputChannel.show(true);
    outputChannel.appendLine("[GraphFlow] Auto-registering MCP, Skills, Rules & Hooks...");
    const res = await runGraphflowCli(["install", "--root", root], root);
    outputChannel.appendLine(res.output);
    if (res.ok) {
      vscode.window.showInformationMessage("GraphFlow v3.1 MCP, Skills & Hooks registered.");
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
