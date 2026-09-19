# GraphFlow 隐私威胁模型（threat model）

> R7-d：把「本地优先（local-first）」从口号变成可核验的事实。
> 配套可执行审计：`graphflow audit --privacy`（落盘路径 + 出网端点 + 密钥处理，一键列出）。

## 1. 信任边界

```
+------------------+        +------------------+        +------------------+
|  你的工作区源码   | -----> | GraphFlow 本地引擎 | -----> | 本地落盘产物      |
|  (只读扫描)       |        | (索引/压缩/召回/   |        | graphflow-out/    |
|                  |        |  图存储/飞轮/审计)  |        | .graphflow/       |
+------------------+        +--------+---------+        | .graphflow-cache/ |
                                     |                  | 全局配置 0600     |
                     仅当你配置      |                  +------------------+
                     LLM provider    |
                     或下载模型时    v
                           +------------------+
                           | 云端 / 网络       |
                           | (默认不触碰)      |
                           +------------------+
```

- **默认零网络**：索引、压缩、召回、图存储、飞轮、审计全部离线；默认向量为 resilient local（transformers 优先、失败降级 FNV-1a 纯 CPU hash）。
- **出网只发生在三种显式动作**：(a) 你配置了 LLM provider 并跑了需要 LLM 的命令；(b) 首次下载 embedding 模型；(c) 你显式用了 team/anydoc 等网络功能。

## 2. 数据流

| 数据 | 从哪来 | 到哪去 | 出网？ |
|---|---|---|---|
| 工作区源码 | 本地文件扫描（尊重 `.gitignore`） | 内存图 → 本地图（sqlite/file） | 否 |
| 符号/边/摘要 | 本地 AST/正则索引器 | 本地图 + 按需向量索引（`.hnsw`） | 否 |
| 对话 turn/技能/episode | 本地会话 + outcome 上报 | 本地图 Skill/Decision 节点 | 否 |
| 观测归档（gfo:句柄） | 超大工具输出 | `.graphflow/observations/`（脱敏后） | 否 |
| LLM prompt/completion | 需要 LLM 的规划/压缩/ort | 你配置的 provider endpoint | **是（仅配置时）** |
| embedding 模型权重 | HuggingFace Hub（可配 `HF_ENDPOINT` 镜像） | 本地模型缓存 | **是（首次下载一次）** |
| team skill pack / graph artifact | `team serve` / artifact 导入导出 | 你指定的远端/文件 | 是（显式使用时） |
| Office/PDF 解析器 | `@firecrawl/anydoc`（可选依赖） | `~/.graphflow/optional-deps` | 是（启用 Office 索引时） |

## 3. 出网点枚举（完整）

出网端点（仅当对应功能被配置/使用时才会连接）：

- LLM providers（`graphflow_plan` / `graphflow_run` 的 LLM 路径、压缩网络后端、llm reducer、OpenAI embedding）：
  - `https://api.deepseek.com`（`DEEPSEEK_API_KEY`）
  - `https://api.openai.com/v1`（`OPENAI_API_KEY`）
  - `https://api.anthropic.com`（`ANTHROPIC_API_KEY`）
  - `https://dashscope.aliyuncs.com`（百炼，`DASHSCOPE_API_KEY` / `BAILIAN_API_KEY`）
  - `https://ark.cn-beijing.volces.com`（豆包，`ARK_API_KEY`）
- 模型下载：HuggingFace Hub（可用 `HF_ENDPOINT` / `GRAPHFLOW_HF_ENDPOINT` 改镜像；超时 `GRAPHFLOW_EMBEDDING_TIMEOUT_MS`，失败降级 hash）。
- 团队后端：你自己填的 `graphPolicy.mcpEndpoint`（`graphflow team serve` / `transport: mcp-http` / `skill sync push|pull`）。

`package.json` 的 `disclosure` 块是机器可读版本（`cloud/network/offline_mode/api_keys/permissions`）。

## 4. 密钥处理

- API Key 只从环境变量或配置文件读取（`providers.<name>.apiKey` 支持 `${ENV}` 模板），从不写入环境。
- 全局配置 `~/.graphflow.config.json` 以 **0600（属主可读写）** 写入并在每次保存时收紧已存在文件权限（Windows 无 POSIX mode 位，为 best-effort）。
- 日志脱敏：观测归档写入前 `redactSecrets`；`diagnose` 只报 provider 健康布尔值，不回显 key。
- 对应测试：`tests/m86-config-file-mode.test.ts`（0600 断言）、`tests/m39-config-secrets.test.ts`。

## 5. 落盘路径（完整）

| 路径 | 内容 | 敏感度 |
|---|---|---|
| `<workspace>/graphflow-out/graphflow-graph.sqlite`（或 `.json`） | 代码图 + 技能 + episode + 对话 | 含源码摘要/符号，**不要提交到公开仓**（已在默认 `.gitignore` 建议中） |
| `<workspace>/graphflow-out/vectors.db` + `.hnsw` | 向量召回索引 | 同上 |
| `<workspace>/graphflow-out/*.jsonl`（learning-dataset/events/summary、efficiency、fidelity） | 学习事件与效率证据 | 含任务描述，注意脱敏 |
| `<workspace>/.graphflow/observations/` | 超大输出归档（content-addressed）+ `index.jsonl` | 脱敏后存储，TTL 14 天 |
| `<workspace>/.graphflow/session-journal.jsonl` | outcome 自动捕获 journal | 含任务文本 |
| `<workspace>/.graphflow/skills/` | skill 包/markdown 导出 | 技能是指南文本，无成功证据（导出故意剥离） |
| `<workspace>/.graphflow-cache/` | 文件索引缓存（mtime+hash） | 无源码内容，只有指纹 |
| `~/.graphflow.config.json`（0600） | 全局 provider/模型配置 | **含 API Key** |
| `~/.graphflow/optional-deps` | anydoc 可选解析器 | 第三方二进制 |
| `~/.cache/huggingface`（或 `GRAPHFLOW_EMBEDDING_CACHE_DIR`） | embedding 模型权重 | 公开模型，无隐私 |

## 6. 剩余风险与缓解

| 风险 | 现状 | 缓解/建议 |
|---|---|---|
| 索引把密钥文件吃进图 | 默认尊重 `.gitignore`，但 `.env` 若未忽略会被读 | 索引器跳过常见密钥文件名（`.env*`、`*.pem`、`id_rsa*`）；`audit --privacy` 提示检查 |
| 图产物被误提交 | sqlite/json 含源码摘要 | 保持 `.gitignore` 模板含 `graphflow-out/`；audit 的 doc-consistency 可扩展检查 |
| 团队 sync 把内部技能外发 | `skill sync push` 显式动作 | push 前打印技能数/来源确认；外部技能入库一律 `correctable` 不继承信任 |
| 导入的 SKILL.md 投毒 | 外部文件可任意文本 | 导入永不继承成功证据/canary；provenance 标记 `import`；建议 review 后再 admit |
| 模型下载被投毒 | HF Hub 远端权重 | 固定 canonical 模型 + 哈希校验由 transformers 库完成；可用内网镜像锁定版本 |

## 7. 核验方法

```bash
graphflow audit --privacy        # 一键：落盘路径存在性 + 出网端点 + 密钥文件权限
graphflow doctor                 # 安装自检（含配置路径与权限）
graphflow diagnose               # provider 健康 + embedding 后端（semantic/off）+ 图统计
```

断言：**在不配置任何 provider、不启用 Office 索引、不使用 team 的情况下，`audit --privacy` 应报告零必需出网**（模型首下除外，属一次性显式成本）。
