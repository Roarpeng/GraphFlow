# GraphFlow 核心技术规范与项目总结 (v0.5.0)

## 项目定位
**GraphFlow** 是一款面向“超大规模复杂代码库”的 AI Agent 基础设施。通过静态代码分析提取引用依赖图谱（Call Graph / Module Graph），它能在对话、任务规划（Planning）与执行时，利用基于图论（BFS/引力算法）的上下文压缩技术，突破大模型 Context Window 限制，实现极高命中率的关联代码注入，彻底解决 AI 辅助编程中的“幻觉”和“瞎编”问题。

## 核心架构
GraphFlow 被设计为一套三体互通的架构，适应多种不同的 Agent 集成场景：

1. **CLI 核心运行时 (`src/surfaces/cli`)**
   - **底层基石**：负责所有图谱扫描、指令执行、本地 SQLite 存储、以及 GPT-Tokenizer Token 预算管理的硬核逻辑。
   - **执行模式**：允许通过 `npx graphflow` 或 Node.js API 在 CI/CD 管道或本地终端进行图谱更新和批量任务诊断。

2. **VS Code 扩展 (`vscode-extension`)**
   - **用户界面**：无缝注入 VS Code 的 Chat Participant (`@graphflow`)。
   - **交互面板**：提供 Graph Snapshot（可视化引力图谱）、Context Preview（上下文预算分析）、Skill Insights（高频技能点洞察）。
   - **特点**：自带本地大模型代理和状态机，充当用户的 AI 副驾大脑。

3. **MCP 服务端 (`src/surfaces/mcp`)**
   - **扩展生态**：实现了标准的 **Model Context Protocol (MCP)**。
   - **被动赋能**：将 GraphFlow 强大的 Context Preview 和 Plan 能力包装成 MCP Tools，被 Cursor 或 Claude Desktop 等外部宿主 Agent 随时调用，充当“辅助外脑”。

## 核心引擎能力

### 1. 多语言静态代码索引 (File Indexer)
- **实现方案**：通过 TypeScript API 和 `web-tree-sitter` (WASM) 驱动。
- **支持语言**：完美匹配并解析 `TypeScript`, `JavaScript`, `Python`, `Rust`, `Go`, `C`, `C++` 等主流语言。
- **最新增强 (v0.5.0)**：
  - **精准相对路径回溯**：原生接入 `node:path` POSIX 规范，对所有基于 `./` 和 `../` 的前端或 C++ 引用实现绝对路径展开并匹配。
  - **Python 模块智能映射**：彻底打通 Python 独特的点号绝对引用（`a.b.c`）和点号相对引用（`from .utils`），让所有的 Python 后端项目也能精准连线，告别“孤岛节点”。
  - **版本化缓存失效**：引入 `index-state.json` 的强版本化验证 (`version: 2`)，当解析算法升级时，自动作废旧图谱缓存，对全量文件触发重构，无需用户干预。

### 2. 上下文引力压缩 (Context Preview & Compression)
- **图论降维**：基于 BFS 遍历，优先选取高连通度（Hub 节点）的 File 和 Symbol 进行注入。
- **预算控制**：深度集成 `gpt-tokenizer`，允许设定硬性 Token 预算阈值（例如 `maxContextTokens: 60000`）。
- **逐层剥离**：若候选文本超出预算，执行“牺牲次要信息以保全骨架”的降级策略（层级：源码 -> 压缩签名 -> 舍弃）。

### 3. Agent 规划与执行状态机 (Task Orchestrator)
- 包含一套完整的 Planner -> Worker -> Validator 架构。
- 能在后台全自动提取 Graph 关联信息，生成任务 Plan，然后交给底层逻辑执行。

## 项目里程碑 (v0.5.0)
- **底层架构**：修复了 MCP 的 stdio 传输层 HTTP Header 阻塞 bug，现已完全拥抱标准的 jsonlines `\n` 分隔，彻底消除了 Cursor 连接 MCP 时的 30 秒超时问题。
- **解析器**：全语言相对路径解析和 Python 路径映射重构完成。
- **发布状态**：CLI 与 VS Code Extension 双端包提升至 `0.5.0`，已发布并同步至 GitHub `main` 分支。