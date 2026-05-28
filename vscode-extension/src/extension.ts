import * as vscode from "vscode";
import { createVsCodeRuntime } from "graphflow";

interface RunRecord {
  task: string;
  status: string;
  attempts: number;
  feedback: string;
  timestamp: number;
}

const runs: RunRecord[] = [];
const runtime = createVsCodeRuntime();

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

    const runtimeRecord = await runtime.runTask(task);
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
