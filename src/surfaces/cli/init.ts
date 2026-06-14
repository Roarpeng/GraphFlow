import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureGlobalGraphFlowConfig, resolveGlobalConfigPath } from "../../config/scaffold";
import {
  detectInstalledAgents,
  formatModelConfigGuide,
  installMcpToDetectedAgents,
  type McpInstallResult,
} from "../../integrations/agent-mcp-installer";

const CONFIG_DIR = ".graphflow";
const README_FILE = join(CONFIG_DIR, "README.md");

function buildReadmeContent(installResults: McpInstallResult[]): string {
  const detectedAgents = detectInstalledAgents().map((agent) => agent.name).join(", ") || "未检测到";
  const installedLines =
    installResults.length > 0
      ? installResults
          .filter((result) => result.status === "injected" || result.status === "created" || result.status === "updated")
          .map((result) => `- ${result.agentName} (${result.scope}): ${result.configPath}`)
          .join("\n")
      : "- 无";
  const globalConfigPath = resolveGlobalConfigPath();

  return `# GraphFlow 配置文件说明

欢迎使用 GraphFlow！模型与路由配置默认保存在用户全局文件中，新开项目无需重复配置。

## 1. 全局配置文件
- 路径：\`${globalConfigPath}\`
- **\`providers\`**: 配置各个大模型厂商的 API Key 和 Base URL。例如，如果你使用 DeepSeek，可以在 \`openai\` 字段中配置 Base URL 为 \`https://api.deepseek.com\` 并填入 \`apiKey\`。
- **\`tiers\`**:
  - \`smart\`: 核心大脑模型（用于规划器 Planner 和验证器 Validator）。建议配置为能力最强的模型（如 \`deepseek-v4-pro\`）。
  - \`economy\`: 经济型干活模型（用于执行器 Worker）。建议配置为速度快、成本低的模型（如 \`deepseek-v4-flash\`）。
- **\`embeddingPolicy\`**: 嵌入式向量模型，用于语义召回。默认使用本地 \`Xenova/bge-base-zh-v1.5\`；也可改为 \`openai\` 或轻量 \`hash\` 模式。
- **\`graphPolicy\`**: 控制图谱的生成和索引行为。
  - \`autoIndexOnPreview\` / \`autoIndexOnRun\`: 在预览上下文或执行任务前自动索引（默认开启）。
  - \`semanticEnrichment\`: 知识图谱 Symbol 节点的 LLM 语义摘要；\`provider\`/\`model\` 可留空以继承 Economy 层；\`autoRunOnIndex\` 在索引后静默小批量富化。

如需仅对某个项目覆盖配置，可在项目根目录创建 \`graphflow.config.json\` 或 \`.graphflow/config.json\`。

## 2. MCP (Model Context Protocol) 自动注入
安装时已自动嗅探本机 Agent 工具，并将 GraphFlow MCP 写入**用户级**配置（所有项目共享）。

**已嗅探到的 Agent：** ${detectedAgents}

**已写入的配置：**
${installedLines}

**如何验证 MCP 是否可用？**
在你的 AI Agent（或 IDE 的对话框）中直接说：
> "检查你现在是否加载了 graphflow 的工具"
或者
> "使用 graphflow 为我输出当前项目架构的预览上下文"

## 3. 模型配置
${formatModelConfigGuide()}
`;
}

export function runInit() {
  if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
    console.log("[SKIP] GraphFlow postinstall skipped in CI/automation.");
    return;
  }

  const workspaceRoot = process.cwd();
  console.log("[START] Initializing GraphFlow global config...");

  const globalConfig = ensureGlobalGraphFlowConfig();
  if (globalConfig.status === "created") {
    console.log(`[CREATED] Global config: ${globalConfig.path}`);
  } else {
    console.log(`[SKIP] Global config already exists: ${globalConfig.path}`);
  }

  const installResults = installMcpToDetectedAgents({
    strategy: existsSync(join(workspaceRoot, "package.json")) ? "npm-script" : "npx",
    installScope: "user",
    ...(existsSync(join(workspaceRoot, "package.json"))
      ? { npmScriptCwd: workspaceRoot }
      : {}),
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

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(README_FILE, buildReadmeContent(installResults), "utf8");
  console.log(`[CREATED] Documentation: ${README_FILE}`);

  void bootstrapGraphIndex(workspaceRoot).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WARN] Bootstrap graph index skipped: ${message}`);
  });

  console.log(`[FINISH] Initialization complete! Global config: ${join(homedir(), ".graphflow.config.json")}`);
  console.log("[HINT] To run init on npm install, set GRAPHFLOW_ENABLE_POSTINSTALL=1");
}

async function bootstrapGraphIndex(workspaceRoot: string): Promise<void> {
  const { indexGraph } = await import("./runtime.js");
  const result = await indexGraph(workspaceRoot);
  console.log(
    `[INDEX] Bootstrap complete: indexedFiles=${result.indexedFiles}; indexedSymbols=${result.indexedSymbols}`
  );
}

if (require.main === module) {
  runInit();
}
