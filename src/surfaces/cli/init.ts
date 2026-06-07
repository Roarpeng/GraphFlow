import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDefaultOverlayConfig } from "../../config/defaults";

const CONFIG_DIR = ".graphflow";
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const README_FILE = join(CONFIG_DIR, "README.md");

const README_CONTENT = `# GraphFlow 配置文件说明

欢迎使用 GraphFlow！本目录下包含 GraphFlow 的核心配置。

## 1. 配置文件 (\`config.json\`)
由于标准的 JSON 格式不支持注释，因此所有关于参数的详细说明都在这里：

- **\`providers\`**: 配置各个大模型厂商的 API Key 和 Base URL。例如，如果你使用 DeepSeek，可以在 \`openai\` 字段中配置 Base URL 为 \`https://api.deepseek.com\` 并填入 \`apiKey\`。
- **\`tiers\`**（建议在项目根目录的 \`graphflow.config.json\` 中配置）:
  - \`smart\`: 核心大脑模型（用于规划器 Planner 和验证器 Validator）。建议配置为能力最强的模型（如 \`deepseek-v4-pro\`）。
  - \`economy\`: 经济型干活模型（用于执行器 Worker）。建议配置为速度快、成本低的模型（如 \`deepseek-v4-flash\`）。
- **\`embeddingPolicy\`**: 嵌入式向量模型，用于语义召回。默认使用本地 \`Xenova/bge-base-zh-v1.5\`；也可改为 \`openai\` 或轻量 \`hash\` 模式。
- **\`graphPolicy\`**: 控制图谱的生成和索引行为。如果你想让其分析整个仓库，确保 \`workspaceRoot\` 正确指向你的代码根目录。

## 2. MCP (Model Context Protocol) 自动注入
我们在安装时已经自动尝试将 GraphFlow MCP 节点注入到你的常见 AI IDE（VS Code, Trae, Cursor, Claude Code）配置中了。

**如何验证 MCP 是否可用？**
在你的 AI Agent（或 IDE 的对话框）中直接说：
> "检查你现在是否加载了 graphflow 的工具"
或者
> "使用 graphflow 为我输出当前项目架构的预览上下文"

如果有任何 MCP 找不到的情况，请确保在 IDE 的 MCP 配置中包含如下 JSON 节点：
\`\`\`json
"graphflow": {
  "command": "npx",
  "args": ["-y", "graphflow-mcp"],
  "cwd": "${process.cwd().replace(/\\/g, '\\\\')}"
}
\`\`\`
`;

function injectMcpConfig() {
  const isWindows = process.platform === "win32";
  const appData = process.env.APPDATA || (isWindows ? join(homedir(), "AppData", "Roaming") : "");
  const home = homedir();

  const ideConfigs = [
    // VS Code
    { path: isWindows ? join(appData, "Code", "User", "mcp.json") : join(home, ".config", "Code", "User", "mcp.json"), key: "servers" },
    // Trae
    { path: isWindows ? join(appData, "Trae", "User", "mcp.json") : join(home, ".config", "Trae", "User", "mcp.json"), key: "mcpServers" },
    // Cursor
    { path: isWindows ? join(appData, "Cursor", "User", "globalStorage", "roval.cursor", "mcp.json") : join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    // Claude Code
    { path: isWindows ? join(appData, "Claude Code", "mcp.json") : join(home, ".claude", "mcp.json"), key: "mcpServers" },
  ];

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const mcpNode = {
    command: npmCmd,
    args: ["run", "start:mcp"],
    env: {},
    cwd: process.cwd()
  };

  for (const ide of ideConfigs) {
    if (!ide.path || !existsSync(ide.path)) continue;

    try {
      const raw = readFileSync(ide.path, "utf8");
      const json = raw.trim() ? JSON.parse(raw) : {};
      
      const targetKey = ide.key;
      if (!json[targetKey]) {
        json[targetKey] = {};
      }
      
      json[targetKey]["graphflow"] = mcpNode;
      writeFileSync(ide.path, JSON.stringify(json, null, 2) + "\n", "utf8");
      console.log(`[SUCCESS] Injected GraphFlow MCP to: ${ide.path}`);
    } catch (e) {
      console.error(`[ERROR] Failed to update MCP config at ${ide.path}:`, e);
    }
  }
}

export function runInit() {
  console.log("[START] Initializing GraphFlow project config...");
  
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    console.log(`[CREATED] Directory: ${CONFIG_DIR}`);
  }

  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify(getDefaultOverlayConfig(), null, 2) + "\n", "utf8");
    console.log(`[CREATED] Config file: ${CONFIG_FILE}`);
  } else {
    console.log(`[SKIP] Config already exists: ${CONFIG_FILE}`);
  }

  if (!existsSync(README_FILE)) {
    writeFileSync(README_FILE, README_CONTENT, "utf8");
    console.log(`[CREATED] Documentation: ${README_FILE}`);
  }

  injectMcpConfig();
  console.log("[FINISH] Initialization complete! Please check .graphflow/README.md for configuration instructions.");
}

if (require.main === module) {
  runInit();
}
