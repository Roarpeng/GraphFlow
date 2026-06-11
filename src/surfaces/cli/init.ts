import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultOverlayConfig } from "../../config/defaults";
import { ensureGlobalGraphFlowConfig } from "../../config/scaffold";
import {
  detectInstalledAgents,
  formatModelConfigGuide,
  installMcpToDetectedAgents,
  type McpInstallResult,
} from "../../integrations/agent-mcp-installer";

const CONFIG_DIR = ".graphflow";
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const README_FILE = join(CONFIG_DIR, "README.md");

function buildReadmeContent(workspaceRoot: string, installResults: McpInstallResult[]): string {
  const detectedAgents = detectInstalledAgents().map((agent) => agent.name).join(", ") || "未检测到";
  const installedLines =
    installResults.length > 0
      ? installResults
          .filter((result) => result.status === "injected" || result.status === "created")
          .map((result) => `- ${result.agentName} (${result.scope}): ${result.configPath}`)
          .join("\n")
      : "- 无";

  return `# GraphFlow 配置文件说明

欢迎使用 GraphFlow！本目录下包含 GraphFlow 的核心配置。

## 1. 配置文件 (\`config.json\`)
由于标准的 JSON 格式不支持注释，因此所有关于参数的详细说明都在这里：

- **\`providers\`**: 配置各个大模型厂商的 API Key 和 Base URL。例如，如果你使用 DeepSeek，可以在 \`openai\` 字段中配置 Base URL 为 \`https://api.deepseek.com\` 并填入 \`apiKey\`。
- **\`tiers\`**（建议在项目根目录的 \`graphflow.config.json\` 中配置）:
  - \`smart\`: 核心大脑模型（用于规划器 Planner 和验证器 Validator）。建议配置为能力最强的模型（如 \`deepseek-v4-pro\`）。
  - \`economy\`: 经济型干活模型（用于执行器 Worker）。建议配置为速度快、成本低的模型（如 \`deepseek-v4-flash\`）。
- **\`embeddingPolicy\`**: 嵌入式向量模型，用于语义召回。默认使用本地 \`Xenova/bge-base-zh-v1.5\`；也可改为 \`openai\` 或轻量 \`hash\` 模式。
- **\`graphPolicy\`**: 控制图谱的生成和索引行为。如果你想让其分析整个仓库，确保 \`workspaceRoot\` 正确指向你的代码根目录。
  - \`autoIndexOnPreview\` / \`autoIndexOnRun\`: 在预览上下文或执行任务前自动索引（默认开启）。
  - \`semanticEnrichment\`: 知识图谱 Symbol 节点的 LLM 语义摘要；\`provider\`/\`model\` 可留空以继承 Economy 层；\`autoRunOnIndex\` 在索引后静默小批量富化。

## 2. MCP (Model Context Protocol) 自动注入
安装时已自动嗅探本机 Agent 工具，并将 GraphFlow MCP 写入检测到的配置。

**已嗅探到的 Agent：** ${detectedAgents}

**已写入的配置：**
${installedLines}

**如何验证 MCP 是否可用？**
在你的 AI Agent（或 IDE 的对话框）中直接说：
> "检查你现在是否加载了 graphflow 的工具"
或者
> "使用 graphflow 为我输出当前项目架构的预览上下文"

如果有任何 MCP 找不到的情况，请确保在 IDE 的 MCP 配置中包含如下 JSON 节点：
\`\`\`json
"graphflow": {
  "command": "npx",
  "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
  "cwd": "${workspaceRoot.replace(/\\/g, "\\\\")}"
}
\`\`\`

## 3. 模型配置
${formatModelConfigGuide(workspaceRoot)}
`;
}

export function runInit() {
  if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
    console.log("[SKIP] GraphFlow postinstall skipped in CI/automation.");
    return;
  }

  const workspaceRoot = process.cwd();
  console.log("[START] Initializing GraphFlow project config...");

  const globalConfig = ensureGlobalGraphFlowConfig();
  if (globalConfig.status === "created") {
    console.log(`[CREATED] Global config: ${globalConfig.path}`);
  } else {
    console.log(`[SKIP] Global config already exists: ${globalConfig.path}`);
  }

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

  const installResults = installMcpToDetectedAgents({
    strategy: existsSync(join(workspaceRoot, "package.json")) ? "npm-script" : "npx",
    workspaceRoot,
    npmScriptCwd: workspaceRoot,
  });

  for (const result of installResults) {
    if (result.status === "error") {
      console.error(`[ERROR] ${result.agentName} (${result.configPath}): ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      console.log(`[SKIP] ${result.message ?? "MCP install skipped"}`);
      continue;
    }
    console.log(`[SUCCESS] ${result.status === "created" ? "Created" : "Updated"} GraphFlow MCP for ${result.agentName}: ${result.configPath}`);
  }

  writeFileSync(README_FILE, buildReadmeContent(workspaceRoot, installResults), "utf8");
  console.log(`[CREATED] Documentation: ${README_FILE}`);

  void bootstrapGraphIndex(workspaceRoot).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WARN] Bootstrap graph index skipped: ${message}`);
  });

  console.log("[FINISH] Initialization complete! Please check .graphflow/README.md for MCP and model configuration.");
}

async function bootstrapGraphIndex(workspaceRoot: string): Promise<void> {
  const { indexGraph } = await import("./runtime.js");
  const configPath = existsSync(CONFIG_FILE) ? CONFIG_FILE : undefined;
  const result = await indexGraph(workspaceRoot, configPath);
  console.log(
    `[INDEX] Bootstrap complete: indexedFiles=${result.indexedFiles}; indexedSymbols=${result.indexedSymbols}`
  );
}

if (require.main === module) {
  runInit();
}
