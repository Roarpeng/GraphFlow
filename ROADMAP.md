# GraphFlow 路线图（ROADMAP）

> 最后更新：2026-09-05（v1.15.1 之后：公开飞轮复现包 `npm run proof:flywheel`）
>
> GraphFlow 是**单人维护**项目（bus factor = 1）。本路线图既是对外承诺，也是社区贡献的入口——欢迎按 [CONTRIBUTING.md](CONTRIBUTING.md) 认领任意 ⬜ / 🟡 事项，直接降低单点风险。

## 状态图例

- ✅ 已完成
- 🟡 进行中 / 部分完成
- ⬜ 未开始（欢迎认领）

## 已完成里程碑（v1.0 → v1.13.0）

| 版本 | 日期 | 里程碑 | 关键交付 | 状态 |
| --- | --- | --- | --- | --- |
| v1.0.0 | 2026-06-19 | **建图与分发** | 12 语言 AST 索引（TS/JS/Python/Rust/Go/C/C++/Java/Ruby/Kotlin/Swift/Dart）；CLI + MCP 骨架（22 工具时代）；首个稳定版（280+ 测试） | ✅ |
| v1.3–v1.4 | 2026-07 | **压缩与存储收敛** | L0–L3 分层锚点压缩；file / memory / sqlite（FTS5）存储后端抽象 | ✅ |
| v1.7.0–v1.7.15 | 2026-07-11 → 07-28 | **工具面收敛与基础协议** | MCP 工具 22→10；Bridge 委托与 agent-delegated 模式；词干匹配召回；PageRank LRU 缓存；HNSW 向量索引持久化；`transport: auto`；检索 golden set；skill sync 团队共享；飞轮报告；[ATP/IR 公开规范 v1.0](docs/atp-ir-spec-v1.md)；15+ Agent 自动安装 | ✅ |
| v1.8.0 | 2026-07-28 | **Goal 对齐** | Goal 锚点节点化（意图五元组固化为一等公民）；低置信度澄清门（<0.6 不出 plan）；alignment-check 执行期回检；deviation 偏离分类；Goal 版本链 + 变更 diff；ATP/IR 规范 v1.1 | ✅ |
| v1.9.0–v1.9.4 | 2026-08-01 | **证据与团队化** | 检索 golden set 26→132；skill A/B 基准与记忆 ROI 基准；技能四分类；CI 版本一致性门禁；skill sync 双向 MERGE；MCP 官方 SDK 化；`graphflow://diagnose` | ✅ |
| v1.9.5 | 2026-08-01 | **索引卫生** | 索引排除 Agent 工具目录；批量剪枝 `GraphClient.deleteNodes` | ✅ |
| v1.9.8 | 2026-08-08 | **P0/P1 融合闭环** | 飞轮 diagnose 可观测 + backfill；Skill-conditioned DAG；SkillOpt-lite；Trie 引用预过滤；sync skill canary；Codex Windows NODE/NPX_CLI MCP | ✅ |
| v1.9.9 | 2026-08-08 | **文档图谱** | CI walkFiles ENAMETOOLONG 修复；可选 `@firecrawl/anydoc` Office/PDF→MD 建图；`document-semantic` bridge | ✅ |
| v1.9.10 | 2026-08-08 | **跨层 Engineering KG** | Concept/Requirement 节点；`documents`/`implements`/`derived_from`；document-semantic submit 落图；明确 VSIX 不含 anydoc | ✅ |
| v1.9.11 | 2026-08-08 | **VSIX 按需 anydoc** | 激活时自动下载当前 OS 的 `@firecrawl/anydoc` 到 `~/.graphflow/optional-deps`；设置 `graphflow.downloadAnydoc` | ✅ |
| v1.9.12 | 2026-08-12 | **Experience P0/P2 收口** | skill consolidate `--apply`；retrieval golden dataset；ATP/IR v1.2 Stable + episode↔Engineering KG | ✅ |
| v1.9.13 | 2026-08-13 | **Settings 一页配置** | GraphFlow: Settings 集成文档解析、anydoc、语义召回、MCP、模型与功能入口 | ✅ |
| v1.9.14 | 2026-08-15 | **工作台脉络** | 计划 DAG 播种功能主题容器；按需唤醒大纲；`topicId` / `assistantReply` 续聊；DeepSeek Harness 插件 | ✅ |
| v1.9.15 | 2026-08-20 | **Experience v2 + dsh glue** | 噪声清理、outcome 不默认成功、保真度拆分、File expand 全文、准入/playbook、workflow 蒸馏与撤销；dsh `plugin.mjs` + `agent/disposed` 飞轮 | ✅ |
| v1.12.0 | 2026-08-22 | **Evidence & Knowledge Release** | context fidelity 指标流；O(1) skill read；自适应遗忘；SKILL.md export/import；确定性 Concept/Requirement 抽取；MCP structuredContent、JSON Schema 2020-12 与 `server/discover`；SDK 1.30 | ✅ |
| v1.12.1 | 2026-08-22 | **MCP Streamable HTTP** | stateless JSON + stateful SSE transport；`graphflow-mcp --http` / `graphflow mcp serve --http`；loopback 默认与 Host/Origin 防护；HTTP initialize/ping/tools/resources/tool-call/session DELETE 矩阵 | ✅ |
| v1.12.2 | 2026-08-22 | **Cross-platform Release Fix** | structured-result 测试隔离改用 file backend，修复 Windows SQLite 清理竞态导致的 validate `EBUSY` | ✅ |
| v1.13.0 | 2026-08-23 | **Evidence & Governance Plane** | outcome evidence package/backfill/audit chain；ADR/Invariant/APIContract/Test 版本治理；artifact 三方合并、签名、加密、保留与隔离；bearer/JWT HTTP auth、tenant 隔离与审计；host adapter registry 和 release gates | ✅ |

## 下一阶段

### Experience v2（v1.9.15 已发版）

冻结模型权重 θ，只演化图上的 Σ（轨迹、playbook、workflow、准入）。

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | **噪声技能清理** | ✅ | `cleanupNoiseSkills` 按名字清泛化/`readme+update`（即使旧 `hasSymbolEvidence` 为真）；组合技能要求双亲都是符号名；`skill consolidate` DELETE 融合噪声 |
| **P0** | **outcome 不默认成功** | ✅ | SessionEnd `$2` 为空则保持 pending；`reportOutcome` 无质量 lessons 不写 skill 学习；`FlywheelReport.fidelity.pendingRatio` |
| **P0** | **savings ≠ 保真度 + File expand 全文** | ✅ | `explainSavings()`；File expand 上限 20 万字符；Symbol 窗口 `GRAPHFLOW_EXPAND_SYMBOL_*`；见 [docs/context-contract.md](docs/context-contract.md) |
| **P1** | **held-out 准入 + ACE playbook** | ✅ | `admitSkillToProven` golden overlap；`applyPlaybookDelta` 只增量计数/追加，不整段改写 `guidance` |
| **P1** | **成功 DAG → workflow skill** | ✅ | `distillWorkflowFromEpisode`；`plan.skillRefs` |
| **P2** | **descendant 撤销 + L3 pin** | ✅ | `forgetEpisode` / `quarantineSkillsFromEpisode` 按 `provenance.episodeId` 软隐藏；L3 钉住 goal/alignment/deviation |
| **P2** | **DeepSeek Harness 插件持续支持** | ✅ | `dsh plugin add @roarpeng/graphflow`；`dsh/plugin.mjs` + `cordis.patch.yml` 打进 npm `files`；`agent/disposed` 不默认 pass |

### Experience 层（已合入 main）

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | **飞轮 Experience 指标 + QM 式 skill 巩固** | ✅ | `skill consolidate` dry-run + `--apply`/`--execute`；`getFlywheelReport` / diagnose / skill report 暴露 `experience`（含 consolidation 动作计数与 hint） |
| **P1** | **Context 合同产品化 + Agent Plugin 主路径 + memory pack** | ✅ | [docs/context-contract.md](docs/context-contract.md)；[docs/experience-memory.md](docs/experience-memory.md)；Plugin 为首选安装，`install` 为 Rules/多 Agent 回退；`artifact export-memory` Markdown 包 |
| **P2** | **ATP 兼容示例 producer + Engineering KG episode 链** | ✅ | `examples/atp-minimal-producer/`（atp-ir/1.2 + memory-*）；`report_outcome` / insight document-semantic 接线 episode↔Requirement/Concept `derived_from` |

### 既有 backlog

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | **飞轮自动闭环**：hook 式 outcome 自动捕获 + 历史 backfill | ✅ | auto-capture；Claude Code hooks API + **install/doctor 接线**；`npm run backfill:episodes`；v1.9.8 diagnose 暴露 flywheel 健康。Dogfood 非零 skill 靠真实使用积累 |
| **P1** | **独立 benchmark 公开复现** | ✅ | [docs/flywheel-reproduction.md](docs/flywheel-reproduction.md) + `npm run proof:flywheel`（检索 / 飞轮 A/B / 记忆 A/B）；方法学见 [benchmarks/README.md](benchmarks/README.md) |
| **P1** | **图噪声治理**：Trie 引用预过滤、子图 PageRank 缓存 | ✅ | v1.9.8 落地；Bloom 非必要（Trie 已覆盖预过滤） |
| **P1** | **团队共享记忆安全门控**：provenance + canary + anti-pattern 隔离 | ✅ | `canary-gate.ts`；见 [docs/team-memory-security.md](docs/team-memory-security.md) |
| **P1** | **第三方基准复现邀请** | ✅ | README「Proof, not promises」指向 `npm run proof:flywheel`；issue 标题 `[benchmark] Independent reproduction — <commit>` |
| **P1（融合）** | **Skill-conditioned DAG + SkillOpt-lite** | ✅ | plan 节点 `skillRefs`/`avoidPatterns`；outcome 有界编辑 guidance |
| **P2** | **协议层占位**：ATP/IR v1.2、MCP resources | ✅ | MCP resources 已落地；ATP/IR v1.2 Stable（§8 memory-* + outcome eng-link 字段）；最小 producer / 一致性测试 |
| **P2** | **代码域检索评测公开数据集** | ✅ | [`benchmarks/datasets/retrieval-golden-v1.json`](benchmarks/datasets/retrieval-golden-v1.json)（+ JSONL）；`npm run dataset:retrieval` 从 TS 真源再生；`npm run bench:retrieval` |
| **P2** | **社区化基建** | ✅ | CONTRIBUTING / ROADMAP / Issue 模板 |
| **P3** | **MCP 2.0 无状态规范适配** | ✅ | SDK 1.30；JSON Schema 2020-12；draft discovery；stdio handshake 兼容 |

## 进化方向（2026-08 深度调研版）

> 来源：CLI dogfood 实证 + 41k LOC 内部代码调研 + 4 主题行业趋势调研（详见会话调研报告）。核心判断：**"记得住"已有 99% 压缩背书，"学得会"还是空的（Skill=0、episode 全 pending）——进化主线 = 把学习飞轮做成真实证据链，再用 MCP 2.0 + SKILL.md 互操作成为标准记忆层，最后用概念层让记忆变成知识。**

### R5 · Conversation Graph 2.0（对话过程节点图谱，2026-08-23 落地）

> 定位：把对话过程从「仅显示的脉络树」升级为一等图资产——时间语义、上下文引擎接入、多 Agent 轨迹、回放分叉、面板与导出全链路。三层价值：飞轮学习信号从 episode 粒度升到 turn 粒度（W1b decisionTurn + W2 修正链）；历史问答成为可检索上下文（"这个问题上周讨论过，结论 X 被修正为 Y"）；多 Agent 轨迹成为审计与回放基础（W3）。

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | **W1 时间语义与类型化边** | ✅ | `supersedes`/`same_topic` 边 + `validAt`/`invalidAt`（Graphiti 式时间有效性）；`detectSupersession` 离线修正启发式（更正标记 + 主题重叠 ≥ 0.25 + pending 不可被取代）；跨 session `same_topic` 连边；`effectiveTurns` 当前真值过滤。turn-distillation 增加可选 LLM 蒸馏路径（`distillTurnWithLlm`，无 Key/失败回退启发式；`isDecisionTurn` 决策轮标记喂飞轮证据链） |
| **P0** | **W2 对话图进入上下文引擎** | ✅ | `context-slicer` L3 打包命中有效对话轮（≤3，含修正链标注行），同 token 预算与 L3 quota，绝不豁免；`graph-search` 新增 `searchDialogueTurns`（默认隐藏被取代轮，`includeSuperseded` 可选回看历史），对话命中纯增量、永不挤掉代码锚点；已接入生产链路——preview 附加 `dialogueHits`（MCP `graphflow_context` 同步）+ CLI `dialogue search` |
| **P0** | **W3 多 Agent 轨迹 + fork/回放** | ✅ | dsh glue 监听 `subagent/start|end` 写 `agent-trace` Decision 节点（`GRAPHFLOW_CAPTURE_TRACE` 开关、身份去重、绝不抛入 harness 循环）；`forkDialogueSession` 显式分叉（跨 session next_section 主干 + same_topic 溯源边）；`walkDialoguePath` 回放路径（fork 边界标注）；CLI `dialogue fork --from` / `list --path` / `traces` |
| **P1** | **W4 面板与导出** | ✅ | `/gf` RPC 数据通道扩展返回 traces；web 面板对话轮显示「修正过结论/fork/跳转」徽章 + Agent 轨迹区块；`artifact export-memory` 新增 `dialogues.md`（会话分组、修正链标注、轨迹列表，含 superseded 历史标记） |

### R0 · 让飞轮真的转起来（P0，决定项目本质）

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | 真实证据链替代规则堆叠 | ✅ | `proven` 改为 `successCount>=阈值`（默认 2，env 可覆盖），按 episodeId 去重并持久化 `successCount/successEpisodeIds`；旧数据自动迁移，已 proven 不降级 |
| **P0** | 删除硬编码准入闭集 | ✅ | `FALLBACK_GOLDEN_TOKENS` 已删除；golden 词集动态生成（retrieval golden 数据集 + 运行时 pass episode/symbol 证据叠加）；golden-overlap 降为辅助条件 |
| **P0** | 本地闭环验证 | ✅ | evidence backfill 可用 commit/diff/test command/result 关闭 pending episode；`governance release-gate` 强制 proven skill、fidelity sample 和 pending ratio 门禁；本仓 v1.13 dogfood 已产生非零样本 |
| **P0** | 对话记录噪声治理 | ✅ | `isUserOriginatedMessage` 按 `source.kind` 过滤 harness 系统注入（job/子代理/Cordis 通知不再入图） |

### R1 · 性能与存储收敛（P0，规模化前提）

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | 消灭 file 后端全量读写放大 | ✅ | `graphify-file-client` 进程内缓存（绝对路径 key、mtime+size 校验、写穿透、倒排索引懒重建、跨实例共享）；`transport: auto` 已是默认（sqlite 优先、file 回退，回退路径已测） |
| **P0** | 技能读路径改 O(1) id 查找 | ✅ | `readSkillState` / `loadCompositeSkill` 已优先 `getNodesByIds`，仅在旧后端缺失或未命中时回退 keyword 查询 |
| **P1** | fidelity 指标落地 | ✅ | 独立 `context-fidelity.json` 记录 anchor recall@k、missing anchors 与 normalized LCS body coverage；`FlywheelReport.fidelity` 输出样本聚合 |

### R2 · 对齐行业标准（P1，防被覆盖）

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P1** | MCP 2.0 无状态规范迁移 | ✅ | SDK 已升 1.30；`server/discover`、JSON Schema 2020-12、全量 `structuredContent`、stdio 握手兼容、Streamable HTTP stateless/stateful 均已落地并有端到端矩阵 |
| **P1** | Skill 节点对齐 SKILL.md 事实标准 | ✅ | `skill markdown export|import` 双向互操作；导入保守标记 import/correctable，不继承本地成功或 canary 证据 |
| **P2** | 自适应遗忘机制 | ✅ | 陈旧度 × 失败压力 × 成功保持 × proven 保护的有界衰减曲线；只软衰减，不删除证据节点 |

### R3 · 从"记录"到"知识"（P1，产品差异化）

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P1** | Concept/Requirement 层落地 | ✅ | 确定性中英文抽取器已接线 CLI/MCP；本仓 dogfood 写入 20 Requirement + 224 Concept 和 503 条 provenance 边 |
| **P2** | 团队共享记忆补位 | ✅ | MVP 已产品化：`graphflow team serve`（tenant 隔离 + viewer/contributor/admin RBAC）、`team issue-token`、mcp-http 客户端 JWT/bearer + 401/403 不降级、`skill sync push/pull`、diagnose/doctor 报告 team 连通与 RBAC。artifact 三方合并/签名/加密/quarantine 仍在。企业 wishlist：OIDC IdP UI、审批流界面、托管多活 |

### R4 · 工程治理（P2，持续维护前提）

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P2** | 配置 split-brain 收敛 | ✅ | 新增 canonical embedding model 模块；defaults 与 transformers loader 统一使用 `Xenova/bge-base-zh-v1.5` |
| **P2** | context-slicer / orchestrator 重复合并 | ⬜ | `buildLayeredContextPackage`/`buildEnhancedContextPackage` ~60% 重复；`runOrchestration` 358 行 |
| **P2** | 集成层模块化 | 🟡 | `HostAdapter` 能力模型已落地；DSH / Cursor / Claude Code 的 install / uninstall / doctor 已迁到 `installViaHostAdapter`。其余宿主（Trae、VS Code、Windsurf、Codex、Gemini、Antigravity、Copilot、Cline、Roo、Kilo、Qoder、Opencode 等）仍走 `agent-mcp-installer` / `skill-installer` 遗留路径 |
| **P2** | 测试隔离修复 | 🟡 | Trae project-install 真实 home 并行竞态已改为只断言临时 workspace 项目项；m74/m75 仍需继续隔离 |
| **P2** | web 知识节点栏产品化 | ✅ | 静态 `dsh.client` bundle 落地：`dsh/client.js` factory 双 slot + glue `/gf` Connection RPC 数据通道 + `dsh.client`/`exports["./client"]` 声明，重启自动加载。已知缺口（上游）：client-modules 扫描器只从 dsh 安装树解析条目名（loader 是安装树→profile 两锚点），out-of-tree 包需可从安装树解析（如 `~/node_modules` 符号链接）否则被静默跳过 |
| **P2** | 集成健壮性：unsafe-cwd 下 rootDir 生效 | ✅ | dsh dogfood 实证：`resolveConfig()` 先于工具级 rootDir 绑定并抛 unsafe-cwd 错，MCP 工具全灭；已改为 `resolveConfig(configPath, { rootDir })` 贯穿 runtime 调用点，安全检查不放宽 |

### 建议版本节奏

- **v1.10**：R0 全部（真证据链 + 本地闭环 + 噪声治理）——"学习引擎"成为真能力的版本
- ~~v1.10–v1.13~~：v1.13.0 已发布——真实证据链、fidelity 指标、O(1) 技能读路径、SKILL.md 互操作、自适应遗忘、Engineering KG 概念层、MCP Streamable HTTP 和治理/release-gate 平面。
- **v1.14+**：团队共享记忆 HTTP RBAC + `graphflow team serve` MVP 已落地。Cursor / Claude Code 已迁到 HostAdapter；其余 IDE 安装器仍待迁移。
- **长期**：R4 工程债随版本消化

## 如何参与

- 独立复现飞轮 / 记忆 / 检索自测：`npm run proof:flywheel`（[docs/flywheel-reproduction.md](docs/flywheel-reproduction.md)）
- 认领 ⬜ / 🟡 事项、修 bug、补测试与文档：见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 想法与新功能：先在 [Discussions](https://github.com/Roarpeng/GraphFlow/discussions) 讨论
- 节奏说明：单作者维护；版本节奏随社区参与度调整
