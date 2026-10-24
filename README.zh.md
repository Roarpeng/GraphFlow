# GraphFlow

[English](./README.md) | **简体中文**

[![npm](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![CI](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-roarpeng.graphflow-blue)](https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow)

**面向编码 agent 的省 Token 外科手术引擎。** 四个确定性 MCP 工具加 **0-LLM 提示词反射**——全本地执行，引擎环内无 LLM。

## 四个外科手术工具

| 工具 | 能力 |
| :--- | :--- |
| `gf_read` | 精确切片符号（`file.ts#fn`），自动跨文件类型闭合 + 爆炸半径调用点；中英双语关键词检索（`q: "启动 / launch"`）；AST 骨架折叠（−93% token）。 |
| `gf_edit` | 符号/行级就地编辑、自底向上原子批改、跨仓重命名——带 AST 语法回滚、调用方参数个数与结构体字段守卫。 |
| `gf_exec` | `affected-tests` 路由（两跳反向导入）或任意命令的脱水执行：1 行 `PASS` 回执、5 行失败源码窗口、三连败熔断。`run:true` 执行，否则预览。 |
| `gf_macro` | 习惯挖掘的确定性宏：重复读取 → 上下文捆绑；重复命令 → 单步 pipeline / 参数化模板；同构编辑 → codemod。回放零 LLM。 |

## Prompt Reflex（0-LLM 本地反射）

短命令式输入（如 `启动项目`）命中宏触发词 → **本地执行宏并阻断 prompt 进入模型**；长句降级为注入提示；其余静默放行。总闸：`GRAPHFLOW_PROMPT_REFLEX=0`。

- **第一档 —— 完整阻断**（自动注册）：ZCode、Claude Code、Codex CLI、Gemini CLI、Cursor、Windsurf、Trae、Qoder、Kimi Code、Continue CLI。
- **第二档 —— 注入/改写**：OpenCode、Kilo Code、Cline（Unix）、DeepSeek Harness。
- **第三档 —— 回退**（`gf_macro` MCP）：VS Code Copilot、Zed、Claude Desktop、PearAI、Antigravity、Roo Code（已归档）。

逐宿主配置与安全说明：[docs/prompt-reflex.md](./docs/prompt-reflex.md)。

## 快速开始

```bash
npm install -g @roarpeng/graphflow   # Node 18+
graphflow install                     # 一键注册 MCP + Skill + Rules + Hooks 到检测到的 agent
graphflow status                      # 各 agent 注册状态
graphflow-mcp                         # stdio MCP 服务器
```

仅装技能：`npx skills add Roarpeng/GraphFlow`。读 `mcpServers` JSON 的宿主手动注册：`{ "mcpServers": { "graphflow": { "command": "graphflow-mcp" } } }`。

## 支持语言

| 语言 | 后端 |
| :--- | :--- |
| TypeScript / JavaScript | 真 AST（`@babel/parser`） |
| Python / Go / Rust / C / C++ / C# | 可选 `tree-sitter-*` 语法的真 AST（缺失时结构化兜底；`GRAPHFLOW_TREE_SITTER=0` 关闭） |

运行时依赖：`@babel/parser`、`@modelcontextprotocol/sdk`、`tree-sitter` + 可选语法包。tree-sitter 仅做语法；跨文件类型推断保持启发式（有已记录的边界）。

## 22-agent 自动安装器

`graphflow install` 检测已装 agent 并注册 MCP + Skill + Rules + Hooks——钩子合并幂等且保留用户条目；`graphflow uninstall` 只移除 GraphFlow 拥有的注册。用 `--agents <id1,id2>` / `--all` / `--workspace` 收窄范围。

覆盖：Cursor、VS Code、Windsurf、Trae、Zed、Claude Code、Codex、Gemini CLI、Antigravity、Kimi Code、DeepSeek Harness、OpenCode、ZCode、Cline、Roo Code、Kilo Code、Continue、PearAI、Qoder、Claude Desktop、Amazon Q、WorkBuddy。

## DeepSeek Harness（DSH）

DSH 读 Cordis patch 而非 `mcp.json`。`graphflow install` 在 `~/.dsh/cordis.patch.yml` 写入托管块（`# GRAPHFLOW-DSH-BEGIN/END`）并把 `cwd` 钉到你的工作区——请**在工作区里运行**以保证相对目标可解析。替代方案：纯配置 bundle `@roarpeng/graphflow-dsh`（二选一，同时用会产生重复行）。

## VS Code 扩展

Marketplace / Open VSX 搜索 "GraphFlow"（`roarpeng.graphflow`）——预构建启动器：安装 / 挖掘 git / 查看状态三个命令。手动 VSIX：[VSIX-INSTALL.md](./VSIX-INSTALL.md)。

## CLI 参考

| 命令 | 用途 |
| :--- | :--- |
| `graphflow install [--workspace] [--agents <id1,id2>]` | 注册 MCP + Skill + Rules + Hooks（钩子合并，保留用户条目） |
| `graphflow uninstall [--agents <id1,id2>] [--all]` | 移除 GraphFlow 注册（仅自有条目）；默认检测到的 agent，`--all` 清理全部 |
| `graphflow status [--agents <id1,id2>] [--all]` | 各 agent 注册状态（`[MCP ✓] [Skill ✓] [Rule -] [Hook ✓]`） |
| `graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]` | 终端外科读取 |
| `graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <name>]` | 外科编辑 / 重命名 |
| `graphflow exec [cmd] [--run] [--root <dir>]` | affected-tests 路由或任意命令脱水执行（`--run` 才执行） |
| `graphflow macro <list\|run\|save\|mine\|mine-git> [id] [args...]` | 宏与 git 共变挖掘 |
| `graphflow task <list\|show\|record\|run\|log\|harvest>` | 本地任务反射：记录、提升重复指令、离线回放 |
| `graphflow reflect "<instruction>" [args...]` | 本地运行已记录/近似的任务指令（未知返回 MISS） |
| `graphflow hook <pre-tool\|post-tool\|user-prompt> [--protocol generic\|cursor\|gemini]` | 宿主钩子拦截入口（内部） |
| `graphflow graph` / `graphflow brief` | 知识图谱 HTML 导出 / 跨 agent 交接简报 |
| `graphflow doctor parsers [--strict]` / `graphflow parsers` | tree-sitter 引擎诊断（`--strict` 无真 AST 时非零退出） |
| `graphflow version \| help` | 版本 / 用法 |

## 开发

```bash
npm install && npm test        # 40 个测试文件（含 MCP stdio e2e）
npm run build                  # tsc → dist/
npm run bench                  # 本地基准 → benchmarks/latest.md
npm run verify:parsers         # 真 AST vs 结构化矩阵
npm run preflight              # 发布前静态检查
```

## 文档

- [Prompt Reflex —— 宿主矩阵与配置](./docs/prompt-reflex.md)
- [VSIX 安装](./VSIX-INSTALL.md)
