# GraphFlow

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4D6BFE?labelColor=1f2430)](https://github.com/topics/dsh-plugin)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-6E56CF)](https://modelcontextprotocol.io)

> **给编程 Agent 用的记忆与上下文 harness。** 本地优先的代码知识图谱 · 有界上下文压缩（响应真正有界：压缩包之外，历史回显只以短预览下发；比整读 top-10 文件少 **95.6%** token——这是 token 数比值，不衡量回答质量，见[双基线](benchmarks/RESULTS.md)） · 跨会话学习飞轮。

GraphFlow 把 **记忆 + hooks + skills** 做成可移植的 MCP 表面（Cursor、Claude Code、DeepSeek Harness、15+ Agent），让无状态模型变成可长期工作的编码助手。它**不是编排执行器**：先压缩上下文、再规划，执行交给宿主 Agent。纯 TypeScript/Node，CLI + MCP + VS Code 扩展，本地优先，无需 API Key——索引/压缩/召回不需要 API Key；默认语义向量后端首次会从 huggingface.co 下载一次模型（失败自动降级到完全离线的 hash 后端；设 `embeddingProvider: "fnv"` 可完全不联网）。

**一条命令安装承诺**：`npm i -g @roarpeng/graphflow` = 安装 + 注册 + 检测 + 修复；VSIX 激活同样自动完成注册，并把运行时同步到稳定目录 `~/.graphflow/runtime/`，MCP 条目指向稳定路径——IDE 升级删旧扩展目录不再导致悬空。两种安装方式都是装完即用，三平台一致。

## 快速开始

```bash
npx @roarpeng/graphflow graph index .
npx @roarpeng/graphflow context preview "orchestrator" --json
graphflow mcp serve --http         # MCP Streamable HTTP（默认 stateless；--stateful 开启 SSE session）
npx @roarpeng/graphflow install    # 自动接入已检测到的 Agent（含 dsh）
```

MCP 入口：

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"]
    }
  }
}
```

### 注册 Skill + MCP 到本机 Agent（一条命令）

```bash
npm install -g @roarpeng/graphflow   # 一条命令（含安装）：全局安装的 postinstall 自动完成注册+检测+悬空修复
```

```bash
npx @roarpeng/graphflow@latest doctor     # 先自检：列出本机检测到的 Agent
npx @roarpeng/graphflow@latest install    # 向所有检测到的 Agent 注册（幂等，可重跑）
npx @roarpeng/graphflow@latest uninstall  # 一键移除所有 Agent 上的注册
```

`install` 自动扫描本机 20 个宿主的检测标记（`~/.zcode`、`~/.cursor`、`~/.claude`、`~/.codex`、`~/.config/opencode` 等），对每个**检测到的**宿主写入三件套（以 ZCode 为例，其余宿主路径由 HostAdapter 注册表管理）：

| 注册物 | 位置 | 内容 |
| --- | --- | --- |
| MCP 服务器 | `~/.zcode/cli/config.json` → `mcp.servers.graphflow` | stdio 启动 `graphflow-mcp`（10 个工具） |
| Skill | `~/.zcode/skills/graphflow/SKILL.md` | 按需触发的图谱上下文技能 |
| 全局指令 | `~/.zcode/AGENTS.md`（受管块） | GraphFlow 优先规则（append-with-markers，不动用户内容） |

注意事项：

- **注册后需重启对应 Agent（或新开会话）**才会加载 MCP 与技能，运行中的进程不会热加载配置。
- **Windows 首次启动慢/卡在"启动中"**：npx 条目首次要从 registry 下载完整包及原生依赖（`onnxruntime-node`，Windows 上数百 MB），可能超过连接超时。解决：`npm install -g @roarpeng/graphflow` 后重跑 `install`——检测到全局安装会自动写入 **node + server.js 直连条目**（秒级启动、不再依赖网络）；未全局安装时回退 npx 条目。
- 经常使用建议全局安装省去每次 npx 解析：`npm install -g @roarpeng/graphflow`，之后直接 `graphflow install` / `graphflow doctor`。
- DSH（DeepSeek Harness）走插件路径 `dsh plugin --profile web add @roarpeng/graphflow`，与 `install` **二选一**，叠加会重复加载（见下文 DSH 章节）。

Agent 应先调 `graphflow_context` 拿压缩上下文，再视需要调用 `graphflow_plan`。没有 LLM API Key（或 Key 已失效——plan/run 都会做真实问候探测）时会桥接到宿主 Agent（agent-delegated）：`graphflow_plan` 返回 `planSource: "probe-failed-bridge"` + 降级原因，`graphflow_run` 直接 `DELEGATED`（attempts=0 + executionDescriptor + bridgeReason）——坏 Key 与没配 Key 行为完全一致，不会把重试预算烧在占位符上。需要符号级精确编辑时，把 Serena 作为第二个 MCP server 并列挂载——见 [GraphFlow + Serena 联合方案](docs/graphflow-serena.zh.md)（配置示例：[`examples/graphflow-serena.mcp.json`](examples/graphflow-serena.mcp.json)）。

健康自检一条命令：`graphflow selfcheck`（配置加载 / 图存储代码节点 / delta 日志 / 索引新鲜度 / **LLM 真实连通** / 飞轮脉冲 / 对话脱敏 / 会话日志，红绿清单，`--json` 可编程消费）。

### Web 可视化配置后台（本地轻量服务）

除 VS Code 扩展设置面板外，NPM CLI 安装用户可随时通过一行命令在浏览器中唤起本地暗色配置后台：

```bash
graphflow settings      # 或 npx graphflow config ui
```

任意目录快速诊断凭证链路：

```bash
graphflow llm-check      # 逐 provider 显示获胜凭证来源、检查过的环境变量名、端点状态
```

* **通用模型协议**：原生支持 `openai-compatible` 与 `anthropic-compatible` 协议，仅需配置 `baseUrl` 和 `model`；
* **本地免密部署**：自动识别 `localhost` / `127.0.0.1` 等本地模型端点（如 Ollama / vLLM / JEV 本地服务），无需虚假 API Key 即可直接通信；
* **四级级联嗅探**：公网端点自动按域名特征映射对应环境变量（`DEEPSEEK_API_KEY`、`TYPESAFE_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）；未配置任何 Key 时 100% 平滑进入 Bridge 桥接模式，绝不抛错阻断。

### GraphFlow 2.x：Agent Efficiency Agent (`eff-agent`)

从“省 Token”升级为“计算规避决策层（Compute Avoidance）”。该包（`packages/efficiency-agent`）**尚未发布到 npm**，`npx eff-agent` 无法运行；请在克隆本仓库并 `npm install` 后从源码运行：

```bash
# 查看用法
npx tsx packages/efficiency-agent/bin/eff-agent.ts --help

# 通过 agent CLI 执行任务，由你自己的验证命令判定
npx tsx packages/efficiency-agent/bin/eff-agent.ts run "修复这个模块的类型报错" --worker external --cli-command claude --cli-args "-p" --validation "npm run typecheck"

# 在两个轨道上运行 50 任务黄金语料（每任务独立 git worktree，oracle 判定）
npx tsx packages/efficiency-agent/bin/eff-agent.ts bench run packages/efficiency-agent/benchmarks/golden-v1.jsonl --cli-command claude --cli-args "-p" --arm baseline --output runs/baseline.jsonl
npx tsx packages/efficiency-agent/bin/eff-agent.ts bench run packages/efficiency-agent/benchmarks/golden-v1.jsonl --cli-command claude --cli-args "-p" --arm adaptive --output runs/adaptive.jsonl

# 溯源门禁 A/B 对比；--gate 在任一 §28 验收门未通过时失败
npx tsx packages/efficiency-agent/bin/eff-agent.ts bench compare runs/baseline.jsonl runs/adaptive.jsonl --gate
```

首次真实 provider A/B（[benchmarks/REAL-AB-RESULTS.md](benchmarks/REAL-AB-RESULTS.md)）在 50 个任务上观测到输入 token 约少 47%（2026-10-02 修复基线检索后复跑：-54%，配对 95% CI -56.5% ~ -52.0%），每臂只跑一次，且**未测回答质量**（成功判据仅为非空回答）；只能视为输入量观测，不能当作“质量不变的节省”。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **R9 承诺账本 + 收尾审计** | 治「干着干着就忘了」：依赖 lock 一致性 / 孤儿文件接线 / 文档漂移内置检查器 + `graphflow.audit.json` 声明式规则（容器引用、驱动加载）；默认对账 git 未提交工作区；`graphflow audit` CLI + `report_outcome success` 前自动审计（`GRAPHFLOW_AUDIT_STRICT=1` 严格拒报成功）；**跨会话提醒**——下次会话首次 `graphflow_context` 返回「上次会话有 N 项未收尾」。见 [docs/closing-audit.md](docs/closing-audit.md) |
| **R8 省钱与靠谱双主线** | `working-set` 预取（消灭探索轮次）、`challenge` 图 diff 质询、`spawn-receipt` 出生证、`facts ask` 时点查询、`quote` 诚实任务报价 |
| **Harness** | 记忆动态、按任务召回（图锚点 + 压缩摘要 + 历史 episode + skill），有明确 L0–L3 token 预算；**符号正文进包**（前 3 个 L1 符号锚点各附声明正文，单条 ≤120 token、整包 ≤20% 预算，且只取锚点阶段剩下的预算——正文永不挤掉锚点；只有磁盘文本仍与索引期签名一致才附，否则保持纯指针，`expandAnchor` 报 `exact` / `relocated` / `drifted`；`enableSymbolBodies: false` 可关）；**打包外附加负载如实记账**（对话命中与 workbench/对话**预览回显**计入 `unbudgetedTokens`，`accountedTokens` = 压缩 + 包外负载，`estimatedSavingsPercent` 按该真实下发总量计算，`estimatedRawTokens` 不低于实际下发量；响应有界——回显为每条约 160 字符的消息预览并带 `truncated` 标记，全文留在图谱中，可经 `anchorId` 展开 / VS Code 面板查看；`recordDialogue: false` 完全关闭回显与记录） |
| **Token 比值（双口径）** | 对整读同一 ranker 的 top-10 文件少 **95.6%**；对朴素 grep 基线少 98.5%。两者回答不同问题，**不可互换**。二者都只是 token 数比值，**不检验压缩包是否仍含答题所需信息**，不代表回答质量；实时 `context preview` 的节省百分比口径不同，不承诺具体数值。见 [benchmarks/RESULTS.md](benchmarks/RESULTS.md) |
| **检索自测** | 132 条 golden 查询的 CI 门禁为 ≥80% recall / ≥90% top-K；commit 锚定基准（`npm run bench:retrieval`）当前实测 Hit@5=100%、MRR=0.779、NDCG@5=0.638——查询由作者编写、无 held-out 划分，属样本内回归门禁，不代表泛化能力；中文查询依赖智能体提供 `englishQuery`（提供时 5/5 命中，不提供 0/5） |
| **效率机制（SoL-Pi 借鉴）** | 默认**全开**、可在 **GraphFlow: Settings** 逐项关闭：大输出归档为句柄（ObservationPack）、日志压缩为**逐字核验**收据（Evidence-Preserving Reducer）、按观测压力自适应预算 + 压缩建议（Online Context Compact）、编辑+验证融合（Action Fusion）；dsh 侧在模型表面自动投影大结果（`GRAPHFLOW_D_DSH_PROJECTION=0` 关）。见 [docs/efficiency-mechanisms.md](docs/efficiency-mechanisms.md) |
| **效率/能力门禁 + 机制自动研究** | 配对双臂报告落 `graphflow-out/efficiency.json`，`governance release-gate` 新增 `--min-efficiency-qualifying` / `--max-capability-regressions` / `--min-anchor-recall-percent` / `--min-body-coverage-percent`；候选机制走 `graphflow mechanism propose\|trial\|freeze\|admit\|reject\|list`（held-out 隔离、代码强制） |
| **对话图** | 对话轮是带时间语义的类型化图节点（`supersedes` / `same_topic` 边 + `validAt` / `invalidAt`）：被修正的结论离线检测并以修正链渲染，当前真值过滤隐藏被取代轮。历史问答可检索：`dialogue search "<query>"`（`--include-superseded` 回看历史），`graphflow_context` 预览附加纯增量 `dialogueHits`、绝不挤掉代码锚点。`dialogue fork --from` 显式分叉、`dialogue list --path` 回放路径、`dialogue traces` 多 Agent 轨迹、`artifact export-memory` 导出 `dialogues.md`（按 session 分组、含修正链与轨迹）。注入在所有代码锚点**之后**、纯增量；落盘前做**密钥脱敏**（API Key / Bearer / JWT / 连接串 / PEM），`GRAPHFLOW_DIALOGUE_REDACT=0` 可关 |
| **飞轮复现** | `npm run proof:flywheel` 离线串检索 / skill A/B / memory A/B；见 [docs/flywheel-reproduction.md](docs/flywheel-reproduction.md)。skill / memory A/B 是手工构造图上的**合成机制测试**，不是任务成功率：采用 held-out 划分、两臂同一判据后，飞轮对未见任务**没有迁移收益**（skill 61.5% 对 61.5%；memory 51.6% 对 61.3%）。此前的“100% 对 61.5%”“100% 对 56.5%”用答案反推历史经验且两臂判据不一致，已撤回 |
| **团队记忆** | `graphflow team serve`：tenant 隔离 + viewer/contributor/admin；非 loopback 默认强制认证；`diagnose` 报告连通与 RBAC。见 [docs/team-memory-security.md](docs/team-memory-security.md) |
| **HostAdapter** | **全部 20 个宿主**的 install / uninstall / doctor 统一走注册表：4 个手写切片（Cursor / Claude Code / DeepSeek Harness / Kimi Code）+ 通用 profile 切片（Trae、VS Code、Windsurf、Cline、Roo、Kilo、PearAI、Gemini、Codex、Antigravity、Amazon Q、Zed、Continue、Qoder、Opencode、ZCode） |
| **2.x 效率决策层** | 仓库内独立包 `@roarpeng/graphflow-efficiency-agent`（未发布到 npm，需从源码运行）+ `eff-agent` CLI；四轨指纹、三层缓存、Layer B 小模型 Meta 决策、Dynamic Temporary Harness 动态任务沙盒、TypeSafe-JEV 强类型 AI Worker、External CLI Worker、R1-R6 溯源门禁 A/B 基准。详见 [packages/efficiency-agent/README.md](packages/efficiency-agent/README.md) |
| **Serena** | 并列第二个 MCP：context/plan → Serena 编辑 → `report_outcome` |

完整英文对照与基准数字：[README.md](README.md)。

## 工作台脉络

日常 Chat 仍是单线。复杂任务用 `graphflow_plan` 播种**功能主题容器**（画布上是计划步骤，不是一轮一节点）。点击节点，把 `topicId` 传给 `graphflow_context` 即可在该功能上继续或回到主线。问法跑偏会 Fork 孤立旁支，主线不被刷脏。答完再调 `graphflow_context({ assistantReply })` 回填原文。树上的标题只用于显示；下一轮必读是 Goal + 祖先标题 + 该节点原文 Q/A。

按需唤醒（仍是 10 个 MCP 工具，不新增）：

```bash
graphflow workbench tree --json
# VS Code / Cursor：GraphFlow: Workbench Tree（活动栏默认收起）或 Chat /tree
# MCP：graphflow_diagnose → graph.workbenchOutline
graphflow context preview --topic-id "<topic:...>" "在此节点继续"
graphflow context preview --reply "助手原文回答"
```

## DeepSeek Harness 插件

GraphFlow 本身就是一个 **dsh 插件包**（topic：`dsh-plugin`）。`package.json` 声明 `dsh.bundle`，根目录 `cordis.patch.yml` 把 GraphFlow MCP 与 ESM glue 插入 Harness 的插件树。

### 能力

| 能力 | 说明 | dsh 工具名 |
| --- | --- | --- |
| 压缩上下文 | 查询 → 锚点 + 摘要；按 `anchorId` 展开 | `mcp__graphflow__graphflow_context` |
| 任务规划 | simple / insight；无 LLM 时桥接宿主 | `mcp__graphflow__graphflow_plan` |
| 桥接执行包 | 规划 + 压缩上下文，不代跑代码 | `mcp__graphflow__graphflow_run` |
| 结果回填 | 关闭技能飞轮 | `mcp__graphflow__graphflow_report_outcome` |
| ATP Insight | submit / merge | `mcp__graphflow__graphflow_insight` |
| 建图 | 增量 / 单文件 / 全量重建 | `mcp__graphflow__graphflow_index` |
| 技能洞察 | 历史任务沉淀的 skill | `mcp__graphflow__graphflow_skill_insights` |
| 诊断 | 图谱、路由、token 节省、飞轮健康 | `mcp__graphflow__graphflow_diagnose` |
| 产物 | 图谱 import / export | `mcp__graphflow__graphflow_artifact` |
| 技能指南 | 给已连接 Agent 的用法说明 | `mcp__graphflow__graphflow_skill_guide` |

| 在 dsh 上 | 状态 |
| --- | --- |
| 上述 10 个 MCP 工具（stdio `cwd` = 会话工作区） | 支持 |
| Skill（bundle glue 注册；`dsh plugin add` 即可） | 支持 |
| 会话结束飞轮（仅 `agent/disposed` → `outcome report`；不是 live `session/flush`） | 支持 |
| 首轮短 hint（先调 `graphflow_context`）；兼容会话格式 v4（`source.kind = plugin:graphflow-dsh`） | 支持 |
| 对话自动入图（只记真人提问；v3 `plugin` / v4 宿主生产者 kind / `plugin:*` 注入一律排除） | 支持 |
| dsh web「知识节点」面板（`POST /api/gf/nodes`，经 `connection.fetch.register`；旧宿主回退 `/gf` RPC；web 半边依赖 `dsh-api-session-controller` / `dsh-client-connection` / `dsh-client-ui-renderer`） | 支持 |
| VS Code/Cursor 图谱面板、Settings、Workbench Tree、`@graphflow` chat | **不移植** |
| Cursor Agent Plugins 发现 / Claude Code Session* **文件** hooks | **不移植**（dsh 用 bundle + glue） |

核心价值：本地 AST 知识图谱（10 种语言走真实 tree-sitter AST（含 C/C++）；TypeScript/JavaScript 走 TypeScript 编译器（可选依赖，缺失时降级正则抽取、符号细节减少）；Markdown 为正则解析）、L1–L3 分层压缩（token 比值**双口径**并列——对整读 top-10 文件少 **95.6%**，对朴素 grep 基线少 98.5%，两者回答不同问题、不可互换，且都不衡量回答质量）、跨会话 Episodic / Skill 飞轮。GraphFlow **不执行代码**，只给宿主 Agent 压缩上下文和计划；对话写入边界默认做密钥脱敏（`GRAPHFLOW_DIALOGUE_REDACT=0` 可关）。Workbench 数据走 MCP `graphflow_context` / `graphflow_diagnose` 即可。

### 安装

**方式 0：插件市场一键装（推荐）**

GraphFlow 已按 [`dsh-plugin` 收录规范](https://github.com/topics/dsh-plugin) 打标（`dsh-plugin` / `cordis-plugin` / `deepseek-harness` / `cordis`），市场每 2 小时自动扫描该 topic——可在 [DSH 插件市场](https://github.com/dsh-market/dsh-market) 或 [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 搜 `GraphFlow` 一键安装/更新。也支持 GitHub 直装：

```bash
dsh plugin --profile web add github:Roarpeng/GraphFlow
```

> ⚠️ **只选一条注册路径**：市场 / `dsh plugin … add` 会自动把 `dsh.bundle` 的 `cordis.patch.yml` 注册进 profile；此时不要再跑 `npx @roarpeng/graphflow install`（它写 `$DSH_HOME/cordis.patch.yml` overlay），两条注册叠加会重复加载。市场判定类型为 **cordis-plugin**；仓库不提交 `dist/`（源码型），安装时会先询问「安装依赖并执行构建」，确认后执行 `npm install` + `npm run build`（离线可用）。

**披露（disclosure）**：本地优先——索引/压缩/召回/图存储全离线（默认 resilient local 语义向量：优先本地 `Xenova/bge-base-zh-v1.5`，失败降级 FNV-1a hash，可用 `embeddingProvider: "fnv"` 强制纯离线，无需 API Key）；仅当为 `graphflow_plan` / `graphflow_run` 配置 LLM provider 时才访问云端端点（`api.deepseek.com` / `api.openai.com` / `api.anthropic.com` / `dashscope.aliyuncs.com` / `ark.cn-beijing.volces.com`）。API Key 只从环境变量或全局配置读取；`~/.graphflow.config.json` 以 **0600** 权限写入，日志脱敏。可执行核验：`graphflow audit --privacy`（见 `docs/threat-model.md`）。完整字段见 `package.json` 的 `disclosure`。

**方式 A：装进某个 profile（推荐）**

```bash
dsh plugin --profile web add @roarpeng/graphflow
npx @deepseek-ai/dsh web
```

**方式 B：home 级 overlay（所有 profile 生效）**

先有 `$DSH_HOME`（默认 `~/.dsh`），再执行：

```bash
npx @roarpeng/graphflow install
```

会写入：

| 路径 | 作用 |
| --- | --- |
| `$DSH_HOME/cordis.patch.yml` | 插入 `mcp-graphflow`（`cwd: process.cwd()`）与 `graphflow-dsh` glue |
| `$DSH_HOME/skills/graphflow/SKILL.md` | Skill 目录（`graphflow install`）；bundle glue 也会在运行时 `ctx.skills.register` |

开发态也可：

```bash
dsh plugin --profile web add /absolute/path/to/GraphFlow
```

### 用法

1. 任何读代码、改代码、排错之前，先调 `mcp__graphflow__graphflow_context`，并传入当前仓库绝对路径 `rootDir`。
2. 用返回的 `summary` / `anchors` / `tokenBudget` 当第一上下文；不够再按 `anchorId` 展开。
3. 跨多文件或范围不清时，再调 `graphflow_plan`；结果里的 `workbench.topics` 是功能节点。之后可用 `topicId` 细化，或 `graphflow_diagnose.graph.workbenchOutline` / `graphflow workbench tree` 唤醒脉络树。
4. 改完文件后调 `graphflow_index`（单文件可传 `filePath`）。
5. 若走了 `graphflow_run`，结束后必须 `graphflow_report_outcome`（`episodeId` + `success`）。
6. 回答用户后应再调 `graphflow_context({ assistantReply })` 回填原文。
7. 中文问题请同时传 `englishQuery`（英文文件名 / 符号名），不要只用泛化中文词检索。

不要在 `cordis.patch.yml` 里写死 `GRAPHFLOW_WORKSPACE_ROOT`。

### 卸载

```bash
npx @roarpeng/graphflow uninstall
# 若只从某个 profile 移除 bundle：
dsh plugin --profile web remove @roarpeng/graphflow
```

## 换 Agent 工具：一个项目一份图谱与记忆

同一个项目轮流用 Cursor / ZCode / Cline / Claude Code / DSH，**不会重复建图**，记忆（对话、workbench 主题、episode、skill）也会延续：所有宿主按项目目录读写同一个 `graphflow-out/graphflow-graph.sqlite` 及其增量索引清单（`.graphflow-cache/index-state.sqlite.json`），只重新解析改动过的文件。

- **运行时依赖按需下载**：VS Code/Cursor 扩展与 MCP 共享运行时不打包 `better-sqlite3` 和 `@huggingface/transformers`，首次启动时后台装进 `~/.graphflow/optional-deps`（better-sqlite3 按 node / Electron ABI 分目录）。手动：`graphflow deps status`、`graphflow deps install [--with-model]`；关闭：`GRAPHFLOW_OPTIONAL_DEPS_AUTO=0` 或扩展设置 `graphflow.downloadRuntimeDeps`。
- **旧 JSON 存储自动合并**：老版本在缺依赖时会退回 `graphflow-graph.json`，与 SQLite 分叉。现在 SQLite 打开时发现同名 JSON 会把记忆并入（同 id 取较新；对话轮 id 冲突则顺延编号），原文件改名为 `*.merged-bak`，结果写入 `*.merge-log.json`，`graphflow diagnose` 的 `graphStore` 段可见。
- **量化向量模型**：默认 `Xenova/bge-base-zh-v1.5` 的 q8 版（约 98MB，fp32 约 400MB），缓存在 `~/.graphflow/models`，所有宿主共用。`embeddingPolicy.dtype` 或 `GRAPHFLOW_EMBEDDING_DTYPE` 可选 `fp32` / `fp16` / `q8` / `q4`。每个向量带模型指纹，召回只比较同模型向量；换模型后索引时逐批重算旧向量，模型加载失败退回哈希时不会覆盖已有的语义向量。
- **`graph index --full` 不再清掉记忆**：重建前先取出记忆子图，重建后写回。

## 其它安装路径

| 路径 | 适用 |
| --- | --- |
| [Agent Plugins 1.0](https://agent-plugins.org)（`plugin.json` + `mcp.json` + `skills/`） | Cursor 等支持插件清单的宿主 |
| `npx @roarpeng/graphflow install` | Rules / 多 Agent / 非插件宿主（含 dsh overlay） |
| VS Code / Cursor 扩展 | Open VSX：`roarpeng.graphflow` |

## 更多

完整英文文档、基准与协议：[README.md](README.md) · [ATP/IR](docs/atp-ir-spec-v1.md) · [上下文合同](docs/context-contract.md) · [经验记忆](docs/experience-memory.md) · [GraphFlow + Serena](docs/graphflow-serena.zh.md) · [竞品对比](docs/comparison.md)

第三方复现飞轮 / 记忆 A/B / 检索自测：`npm run proof:flywheel`（说明见 [docs/flywheel-reproduction.md](docs/flywheel-reproduction.md)）。所有数字均为作者在本仓库上的自测，不是独立评测；综合 / 多域基准是作者自定阈值的内部检查，不作为宣传分数。
