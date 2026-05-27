import * as vscode from "vscode";

interface RunRecord {
  task: string;
  status: string;
  attempts: number;
  feedback: string;
  timestamp: number;
}

const runs: RunRecord[] = [];

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

    const record: RunRecord = {
      task,
      status: "COMPLETED",
      attempts: 1,
      feedback: "Stub runtime: integrate GraphFlow core next.",
      timestamp: Date.now(),
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
