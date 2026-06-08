# GraphFlow 配置文件说明

欢迎使用 GraphFlow！本目录下包含 GraphFlow 的核心配置。

## 1. 配置文件 (`config.json`)
由于标准的 JSON 格式不支持注释，因此所有关于参数的详细说明都在这里：

- **`providers`**: 配置各个大模型厂商的 API Key 和 Base URL。例如，如果你使用 DeepSeek，可以在 `openai` 字段中配置 Base URL 为 `https://api.deepseek.com`，`apiKey` 使用 `"${DEEPSEEK_API_KEY}"` 占位符（需在环境中设置该变量）。
- **`tiers`**:
  - `smart`: 核心大脑模型（用于规划器 Planner 和验证器 Validator）。建议配置为能力最强的模型（如 `deepseek-v4-pro`）。
  - `economy`: 经济型干活模型（用于执行器 Worker）。建议配置为速度快、成本低的模型（如 `deepseek-v4-flash`）。
- **`graphPolicy`**: 控制图谱的生成和索引行为。如果你想让其分析整个仓库，确保 `workspaceRoot` 正确指向你的代码根目录。

## 2. MCP (Model Context Protocol) 自动注入
我们在安装时已经自动尝试将 GraphFlow MCP 节点注入到你的常见 AI IDE（VS Code, Trae, Cursor, Claude Code）配置中了。

**如何验证 MCP 是否可用？**
在你的 AI Agent（或 IDE 的对话框）中直接说：
> "检查你现在是否加载了 graphflow 的工具"
或者
> "使用 graphflow 为我输出当前项目架构的预览上下文"

如果有任何 MCP 找不到的情况，请确保在 IDE 的 MCP 配置中包含如下 JSON 节点：
```json
"graphflow": {
  "command": "npx",
  "args": ["-y", "graphflow-mcp"],
  "cwd": "C:\\Users\\roarp\\Desktop\\TMP\\Code\\AICode\\GraphFlow"
}
```
