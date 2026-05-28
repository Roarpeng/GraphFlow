import * as vscode from "vscode";
import { exec } from "node:child_process";
import { promisify } from "node:util";

interface RunRecord {
  task: string;
  status: string;
  attempts: number;
  feedback: string;
  timestamp: number;
}

const runs: RunRecord[] = [];
const execAsync = promisify(exec);

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

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const command = `npm run start -- run "${task.replaceAll('"', '\\"')}"`;
    const { stdout } = await execAsync(command, { cwd: workspaceRoot });
    const parsed = parseCliResult(stdout.trim());

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

  context.subscriptions.push(runTask, showRuns);
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
