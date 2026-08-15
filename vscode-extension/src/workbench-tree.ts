import * as vscode from "vscode";
import type { WorkbenchOutline, WorkbenchOutlineNode } from "./panels";

export class WorkbenchTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly outlineNode?: WorkbenchOutlineNode,
    readonly outline?: WorkbenchOutline
  ) {
    super(label, collapsible);
  }
}

export class WorkbenchTreeProvider implements vscode.TreeDataProvider<WorkbenchTreeItem> {
  private readonly emitter = new vscode.EventEmitter<WorkbenchTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private outlines: WorkbenchOutline[] = [];

  constructor(private readonly loadOutlines: () => Promise<WorkbenchOutline[]>) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: WorkbenchTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorkbenchTreeItem): Promise<WorkbenchTreeItem[]> {
    if (!element) {
      this.outlines = await this.loadOutlines();
      if (this.outlines.length === 0) {
        const empty = new WorkbenchTreeItem("尚无工作台 — 先 graphflow_plan", vscode.TreeItemCollapsibleState.None);
        empty.tooltip = "复杂任务先调用 graphflow_plan，功能节点会出现在这里。";
        return [empty];
      }
      return this.outlines.map((outline) => {
        const item = new WorkbenchTreeItem(
          outline.task,
          vscode.TreeItemCollapsibleState.Collapsed,
          undefined,
          outline
        );
        item.contextValue = "workbench-root";
        item.tooltip = outline.rootId;
        return item;
      });
    }

    if (element.outline && !element.outlineNode) {
      return element.outline.nodes.map((node) => this.toItem(node));
    }

    return (element.outlineNode?.children ?? []).map((node) => this.toItem(node));
  }

  private toItem(node: WorkbenchOutlineNode): WorkbenchTreeItem {
    const hasChildren = node.children.length > 0;
    const item = new WorkbenchTreeItem(
      `${node.kind === "side" ? "旁支" : "主线"}${node.active ? " · 当前" : ""}: ${node.title}`,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      node
    );
    item.description = node.pendingReply ? "待回填" : node.lastUserPreview;
    item.tooltip = [node.title, node.lastUserPreview, node.id].filter(Boolean).join("\n");
    item.contextValue = "workbench-topic";
    item.command = {
      command: "graphflow.resumeWorkbenchTopic",
      title: "在此节点继续",
      arguments: [node],
    };
    return item;
  }
}
