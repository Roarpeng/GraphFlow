# Installing the GraphFlow VS Code Extension / GraphFlow VS Code 扩展安装指南

Extension ID: `roarpeng.graphflow` — a thin prebuilt launcher with three commands: **Install MCP, Skills & Hooks to Agents**, **Mine Git Co-Change History**, **Show Detected Agents Status**. The engine itself lives in the npm package (`@roarpeng/graphflow`); the extension never bundles one.
扩展 ID：`roarpeng.graphflow` —— 轻量预编译启动器，含三条命令：**Install MCP, Skills & Hooks to Agents**、**Mine Git Co-Change History**、**Show Detected Agents Status**。引擎本体在 npm 包（`@roarpeng/graphflow`）中，扩展不内嵌引擎。

## English

Requirements: VS Code ≥ 1.99; Node 18+ on `PATH` (commands shell out to `npx`).

### Option 1 — Marketplace

1. VS Code → Extensions (`Ctrl+Shift+X`) → search **"GraphFlow"** (publisher: **roarpeng**) → **Install**.
2. Direct link: https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow

### Option 2 — Open VSX (VSCodium etc.)

Extensions → search **"GraphFlow"** → install `roarpeng.graphflow`.
Direct link: https://open-vsx.org/extension/roarpeng/graphflow

### Option 3 — Manual VSIX from GitHub Releases

```bash
# 1) Download graphflow-<version>.vsix from
#    https://github.com/Roarpeng/GraphFlow/releases
# 2) Install:
code --install-extension graphflow-<version>.vsix
```

### Post-install: enable MCP

Run **GraphFlow: Install MCP, Skills & Hooks to Agents** (`Ctrl+Shift+P`). It registers the `graphflow` MCP server, Skill, Rules, and PreToolUse/PostToolUse hooks into every coding agent detected on your machine.

## 中文

环境要求：VS Code ≥ 1.99；`PATH` 上有 Node 18+（命令通过 `npx` 调用外部进程）。

### 方式一 —— Marketplace（官方市场）

1. VS Code → 扩展面板（`Ctrl+Shift+X`）→ 搜索 **"GraphFlow"**（发布者：**roarpeng**）→ **Install**。
2. 直达链接：https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow

### 方式二 —— Open VSX（VSCodium 等）

扩展面板 → 搜索 **"GraphFlow"** → 安装 `roarpeng.graphflow`。
直达链接：https://open-vsx.org/extension/roarpeng/graphflow

### 方式三 —— 从 GitHub Releases 手动安装 VSIX

```bash
# 1) 从 https://github.com/Roarpeng/GraphFlow/releases
#    下载 graphflow-<version>.vsix
# 2) 安装：
code --install-extension graphflow-<version>.vsix
```

### 安装后：启用 MCP

执行 **GraphFlow: Install MCP, Skills & Hooks to Agents**（`Ctrl+Shift+P`）。该命令会把 `graphflow` MCP 服务器、Skill、Rules 及 PreToolUse/PostToolUse 钩子注册到本机检测到的所有编程 Agent 中。
