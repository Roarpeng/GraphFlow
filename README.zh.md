# GraphFlow

[![npm](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![CI](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-roarpeng.graphflow-blue)](https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow)

> **面向 AI 编程 Agent 的省 Token 外科手术级代码引擎（v3.2.1）**
> 只暴露 4 个外科手术工具的 MCP 服务器 —— `gf_read`、`gf_edit`、`gf_exec`、`gf_macro` —— 对 **TS/JS、Python、Go、Rust、C/C++、C#** 提供一等公民 AST 支持，运行时依赖仅 `@babel/parser` + `@modelcontextprotocol/sdk` 两个。

---

## GraphFlow 3.0 — 大刀阔斧的重写

3.0 版本**整体替换了 2.x 架构**：10 工具的知识图谱 / 上下文压缩 MCP 面（`graphflow_context`、`graphflow_plan`、`graphflow_run`、`graphflow_index`、`graphflow_insight`、`graphflow_skill_*`、`graphflow_diagnose`、`graphflow_artifact`）、情景技能飞轮、VS Code 图记忆扩展、LLM 路由 —— **全部移除**。取而代之的是跑在纯 AST 流水线上的 4 个确定性手术工具。MCP schema 开销下降 **92%**（每轮 5897 → 约 460 tokens）。

| 2.x（已移除） | 3.x 替代方案 |
| :--- | :--- |
| `graphflow_context(...)` | `gf_read({ targets, q, skeleton: true })` |
| `graphflow_plan` / `graphflow_run` | 移除 —— 确定性流水线，无 LLM 路由 |
| `graphflow_index` | 移除 —— AST 索引按需构建 |
| `graphflow_insight` / `graphflow_skill_*` | `gf_macro({ action: "mine" \| "mine-git" })` |
| `graphflow_diagnose` | `graphflow status`（CLI） |
| `graphflow_artifact` | `gf_macro({ action: "visualize" })` → `.graphflow/knowledge-graph.html` |
| `GRAPHFLOW_MCP_PROFILE` 环境变量 | 移除 —— 4 个 `gf_*` 工具是唯一入口 |
| VS Code 图记忆扩展 | 轻量预编译启动器（见 [VSIX-INSTALL.md](./VSIX-INSTALL.md)） |
| 对话 / 工作台记忆功能 | 随飞轮一并移除；跨会话交接由 `gf_read({ targets: ["@brief"] })` 承担 |

**2.x 用户必须把工具调用从 `graphflow_*` 迁移到 `gf_*`。** 没有兼容层。

| 版本 | 说明 |
| :--- | :--- |
| 2.3.0 | 最后一个旧架构版本（10 工具知识图谱 MCP） |
| 3.0.0 | 大刀阔斧的重写 —— 破坏性变更，4 个手术工具 |
| 3.1.0 | 21-Agent 安装器、三振熔断、git 共变挖掘、结构体字段契约守卫 |
| 3.1.1 | 轻量预编译 VS Code 扩展、GitHub Releases 提供 VSIX |
| 3.2.0 | 文档图谱（跨 Agent 交接简报、文档↔代码链接、HTML 知识图）+ 中英双语分词器 |
| **3.2.1** | **修复包：affected-tests 感知 `package.json` `scripts.test`、`gf_exec` `run:true` 执行/预览门控、简报 hub 入度匹配带扩展名 import** |

## 四个外科手术工具

| 工具 | 用途 | 关键参数 |
| :--- | :--- | :--- |
| `gf_read` | 精准符号切片（自动跨文件类型闭合）+ `[Blast Radius]` 调用点、AST 骨架折叠、双语检索、`@brief` 跨 Agent 交接 | `targets`、`q`、`topK`、`skeleton`、`dedup` |
| `gf_edit` | 原地 / 批量原子编辑、零 LLM 跨仓重命名、结构体字段契约守卫 | `file`、`symbol`、`newCode`、`edits`、`renameTo` |
| `gf_exec` | 变更到测试路由（感知 `package.json` `scripts.test`）+ 输出脱水器：通过的测试套件只回 1 行 `PASS`；`run: true` 才执行，缺省仅预览 | `cmd`、`changedFiles`、`handle`、`run` |
| `gf_macro` | 习惯宏、git 共变挖掘、知识图谱 HTML 导出 | `action: "list" \| "run" \| "save" \| "mine" \| "mine-git" \| "visualize" \| "brief"` |

会话级读去重跳过未变更文件；连续 3 次编辑-测试失败触发确定性急救包（爆炸半径契约 + 最近 git diff）。

## 3.2.0 新特性

### 文档图谱（`src/doc-graph.ts`）

- **跨 Agent 入职简报** —— 持久化于 `.graphflow/cross-agent-brief.json`，以约 300 tokens 的 `@brief` 目标提供：
  - 新会话里的 `gf_read({})` 自动附带架构枢纽、上一位 Agent 改过的符号及其测试状态。
  - `gf_read({ targets: ["@brief"] })` 返回完整交接简报：枢纽 + 改动符号 + 测试状态 + 关联设计文档 + 已编译宏。
- **多格式文档↔代码双向链接** —— `.md`、`.html`、`.xml`、`.docx`、`.pdf`，零依赖原生 zlib 解析：
  - `.docx` 通过原生 ZIP Central Directory + 对 `word/document.xml` 执行 `zlib.inflateRawSync` 解析 —— 把 Word 设计规格小节链接到它提到的符号。
  - `.pdf` 通过对 `/FlateDecode` 流执行 `zlib.inflateSync` + `BT..ET` 文本提取 —— 把 PDF 接口协议链接到实现函数。
  - PLCopen / 配置 XML 小节链接到它们描述的解析器符号。
- **交互式知识图** —— `graphflow graph` 导出 `.graphflow/knowledge-graph.html`，单文件力导向 Canvas 拓扑，带搜索、节点过滤与点击检查器（文件、符号、文档、宏）。

### 中英双语分词器（`src/tokenizer.ts`）

一套查询引擎同时覆盖中文与英文：

- **拼音双向索引** —— `gf_read({ q: "dingdan chaoshi" })` 解析为 `订单超时`；`q: "订单支付"` 反向产出 `dingdan`/`zhifu`，能匹配 `handleDingDanZhiFu` 这类拼音命名的遗留标识符。
- **中文同义词簇** —— `q: "取消订单"` 同时命中 `作废/撤单/撤销`；`支付 ↔ 付款/收款/结账`、`用户 ↔ 客户/买家/会员/账号`、`校验 ↔ 验证/验签/核对/检查`。
- **同音字纠错** —— 输入法错别字自动纠正：`定单钞时取销 → 订单超时取消`、`回掉验千 → 回调验签`、`事物回滚 → 事务回滚`、`登陆帐号 → 登录账号`。
- **英文模糊匹配** —— 驼峰/下划线拆分（`resolveEfficiencyPolicy → resolve/efficiency/policy`）、词干还原、编辑距离 1 容错（`cancle → cancel`、`expried → expired`）。

## 基准数据

| 指标 | 基线 | GraphFlow 3.x | 节省 |
| :--- | :--- | :--- | :--- |
| 每轮 MCP 工具 schema 开销 | 5897 tokens（2.x，10 工具） | 444 tokens（4 工具） | **−92%** |
| 大文件读取 | 整文件原文 | AST 骨架折叠 | **−93%** |
| 通过的测试套件输出 | 完整日志 | 1 行 `PASS` 回执 | **−99%** |

## 支持语言

| 语言 | 一等公民 AST |
| :--- | :--- |
| TypeScript / JavaScript | 是（`@babel/parser`） |
| Python | 是 |
| Go | 是 |
| Rust | 是 |
| C / C++ | 是 |
| C# | 是 |

运行时依赖：`@babel/parser` + `@modelcontextprotocol/sdk`，仅此两项。

## 快速开始

```bash
# 1) 全局安装（Node 18+）
npm install -g @roarpeng/graphflow@3.2.1

# 2) 一键注册到检测到的 Agent（MCP + Skill + Rules + Hooks）
graphflow install            # 等价写法：npx @roarpeng/graphflow install

# 3) 启动 MCP 服务器（stdio）
graphflow-mcp
```

通过 [skills.sh](https://skills.sh) 生态的轻量入口（只装 Agent Skill，内置引导：再用 `npx @roarpeng/graphflow@latest install` 注册 MCP 服务器）：

```bash
npx skills add Roarpeng/GraphFlow
```

任意 Agent 手动注册 MCP：

```json
{ "mcpServers": { "graphflow": { "command": "graphflow-mcp" } } }
```

从源码跑测试：

```bash
git clone https://github.com/Roarpeng/GraphFlow && cd GraphFlow
npm install && npm test      # tsx tests/graphflow.test.ts
```

## VS Code 扩展

轻量预编译启动器（`roarpeng.graphflow`），提供三条命令：**Install MCP, Skills & Hooks to Agents**、**Mine Git Co-Change History**、**Show Detected Agents Status**。

- Marketplace：搜索 "GraphFlow" —— https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow
- Open VSX：https://open-vsx.org/extension/roarpeng/graphflow
- 手动 VSIX：从 https://github.com/Roarpeng/GraphFlow/releases 下载 `graphflow-<version>.vsix` → `code --install-extension graphflow-<version>.vsix`

完整步骤见 [VSIX-INSTALL.md](./VSIX-INSTALL.md)。

## 21-Agent 自动安装器

`graphflow install` 自动探测已安装的 Agent，注册 MCP + Skill + Rules + PreToolUse/PostToolUse 钩子；`graphflow uninstall` 干净卸载。

| 分组 | Agent |
| :--- | :--- |
| IDE / 编辑器 | Cursor、VS Code（GitHub Copilot）、Windsurf、Trae / Trae CN、Zed |
| 终端 Agent | Claude Code、OpenAI Codex、Gemini CLI、Antigravity、Kimi Code、DeepSeek Harness（DSH）、OpenCode、ZCode |
| 插件宿主 | Cline、Roo Code、Kilo Code、Continue、PearAI、Qoder / Qoder CN |
| 桌面 / 云端 | Claude Desktop、Amazon Q |

限定安装范围：`graphflow install --agents cursor,claude-code --workspace`。

## CLI 参考

| 命令 | 用途 |
| :--- | :--- |
| `graphflow install [--workspace] [--agents <id1,id2>]` | 向检测到的 Agent 注册 MCP + Skill + Rules + Hooks |
| `graphflow uninstall` | 干净移除所有 GraphFlow 注册项 |
| `graphflow status` | 列出检测到的 Agent 与注册状态 |
| `graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]` | 终端侧手术式读取 |
| `graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <name>]` | 手术式编辑 / 重命名 |
| `graphflow exec [cmd] [--run]` | 运行 `affected-tests` 或任意命令（带脱水；`--run` 才执行，缺省仅预览） |
| `graphflow macro <list\|run\|save\|mine\|mine-git> [id] [args...]` | 宏与 git 共变挖掘 |
| `graphflow graph` | 导出 `.graphflow/knowledge-graph.html` |
| `graphflow brief` | 打印跨 Agent 交接简报 |
| `graphflow hook <pre-tool\|post-tool>` | 宿主钩子拦截入口（内部使用） |
| `graphflow version \| help` | 版本 / 用法 |

## 文档

- [README.md](./README.md) —— 英文文档
- [VSIX-INSTALL.md](./VSIX-INSTALL.md) —— VS Code 扩展安装指南（EN + 中文）
- [skills/graphflow/SKILL.md](./skills/graphflow/SKILL.md) —— 面向 Agent 的 Skill 定义
- [Releases](https://github.com/Roarpeng/GraphFlow/releases) · [Issues](https://github.com/Roarpeng/GraphFlow/issues) · [许可证：Apache-2.0](./LICENSE)
