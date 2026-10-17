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

Run **GraphFlow: Install MCP, Skills & Hooks to Agents** (`Ctrl+Shift+P`). It registers the `graphflow` MCP server, Skill, Rules, and PreToolUse/PostToolUse hooks into every coding agent detected on your machine — host hooks are **merged** into existing configs, so user hooks are preserved and re-running is idempotent. **GraphFlow: Show Detected Agents Status** (or `graphflow status`) prints each agent's registration state, e.g. `[MCP ✓] [Skill ✓] [Rule -] [Hook ✓] Cursor (cursor)`; uninstall removes only GraphFlow-owned entries.

For **DeepSeek Harness (DSH)** the registration is written to `~/.dsh/cordis.patch.yml` as an `@deepseek-ai/dsh-mcp-client` insert with `cwd` set to the current workspace (plus `GRAPHFLOW_WORKSPACE_ROOT` in its env) and the skill at `~/.dsh/skills/graphflow/SKILL.md` — DSH does not read `~/.dsh/mcp.json`.

The engine now parses all six language families with true ASTs: TS/JS via `@babel/parser`, and Python/Go/Rust/C/C++/C# via optional native tree-sitter grammars. npm may print peer-range warnings while installing the grammar packages — this is expected; if a grammar is unavailable, that language falls back to the structural analyzer (`GRAPHFLOW_TREE_SITTER=0` forces structural for all).

Tune and verify parser backends with `graphflow doctor parsers` (`--strict` fails when true AST is unavailable) and, from a source checkout, `npm run verify:parsers`. Call-target resolution is backed by a self-written semantic index (no extra runtime deps); the optional TypeScript compiler API and LSP providers activate only when present in your environment. DSH users can alternatively install the configuration-only `@roarpeng/graphflow-dsh` bundle via `plugin_manager install_bundle` — use the bundle or the CLI installer, not both.

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

执行 **GraphFlow: Install MCP, Skills & Hooks to Agents**（`Ctrl+Shift+P`）。该命令会把 `graphflow` MCP 服务器、Skill、Rules 及 PreToolUse/PostToolUse 钩子注册到本机检测到的所有编程 Agent 中 —— 宿主钩子采用**合并**写入，保留用户钩子，重复执行幂等。**GraphFlow: Show Detected Agents Status**（或 `graphflow status`）会按 Agent 打印注册状态，例如 `[MCP ✓] [Skill ✓] [Rule -] [Hook ✓] Cursor (cursor)`；卸载只移除 GraphFlow 自己的条目。

对 **DeepSeek Harness（DSH）**，注册会写入 `~/.dsh/cordis.patch.yml` 的 `@deepseek-ai/dsh-mcp-client` insert 块，`cwd` 指向当前工作区（env 中带 `GRAPHFLOW_WORKSPACE_ROOT`），并把 Skill 安装到 `~/.dsh/skills/graphflow/SKILL.md` —— DSH 不读取 `~/.dsh/mcp.json`。

引擎现在对全部 6 种语言家族使用真 AST：TS/JS 用 `@babel/parser`，Python/Go/Rust/C/C++/C# 用可选的 tree-sitter 原生语法包。安装语法包时 npm 可能打印 peer 范围警告 —— 属正常现象；若某个语法包不可用，该语言会回退到结构化分析器（设置 `GRAPHFLOW_TREE_SITTER=0` 可强制全部走结构化）。

解析器后端可用 `graphflow doctor parsers` 检查（`--strict` 在真 AST 不可用时失败），源码检出下可用 `npm run verify:parsers` 验证。调用目标解析由自研语义索引支撑（不新增运行时依赖）；可选 TypeScript Compiler API 与 LSP 提供者仅在你的环境中存在时启用。DSH 用户也可改用纯配置的 `@roarpeng/graphflow-dsh` bundle（`plugin_manager install_bundle` 安装）—— 配置包与 CLI 安装器二选一。
