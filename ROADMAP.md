# GraphFlow 路线图（ROADMAP）

> 最后更新：2026-08-02（随 v1.9.5）
>
> GraphFlow 是**单人维护**项目（bus factor = 1）。本路线图既是对外承诺，也是社区贡献的入口——欢迎按 [CONTRIBUTING.md](CONTRIBUTING.md) 认领任意 ⬜ / 🟡 事项，直接降低单点风险。

## 状态图例

- ✅ 已完成
- 🟡 进行中 / 部分完成
- ⬜ 未开始（欢迎认领）

## 已完成里程碑（v1.0 → v1.9.5）

| 版本 | 日期 | 里程碑 | 关键交付 | 状态 |
| --- | --- | --- | --- | --- |
| v1.0.0 | 2026-06-19 | **建图与分发** | 12 语言 AST 索引（TS/JS/Python/Rust/Go/C/C++/Java/Ruby/Kotlin/Swift/Dart）；CLI + MCP 骨架（22 工具时代）；首个稳定版（280+ 测试） | ✅ |
| v1.3–v1.4 | 2026-07 | **压缩与存储收敛** | L0–L3 分层锚点压缩；file / memory / sqlite（FTS5）存储后端抽象 | ✅ |
| v1.7.0–v1.7.15 | 2026-07-11 → 07-28 | **工具面收敛与基础协议** | MCP 工具 22→10；Bridge 委托与 agent-delegated 模式；词干匹配召回；PageRank LRU 缓存；HNSW 向量索引持久化；`transport: auto`；检索 golden set；skill sync 团队共享；飞轮报告；[ATP/IR 公开规范 v1.0](docs/atp-ir-spec-v1.md)；15+ Agent 自动安装 | ✅ |
| v1.8.0 | 2026-07-28 | **Goal 对齐** | Goal 锚点节点化（意图五元组固化为一等公民）；低置信度澄清门（<0.6 不出 plan）；alignment-check 执行期回检；deviation 偏离分类；Goal 版本链 + 变更 diff；ATP/IR 规范 v1.1 | ✅ |
| v1.9.0–v1.9.4 | 2026-08-01 | **证据与团队化** | 检索 golden set 26→132；skill A/B 基准（飞轮开 100% vs 关 61.5%）与记忆 ROI 基准（ON 100% vs OFF 56.5%，含归因链）；技能四分类（proven / correctable / anti-pattern / noise）；CI 版本一致性门禁；skill sync 双向 MERGE；Graphify mcp-http 团队后端试点；MCP 官方 SDK 化（协议 2025-11-25、logging/progress）；`graphflow://diagnose` resource；VS Code 扩展改名与飞轮贡献面板 | ✅ |
| v1.9.5 | 2026-08-01 | **索引卫生** | 索引排除 Agent 工具目录（`.agent` / `.claude` / `.cursor` 等，消除 worktrees 76% 节点污染）；批量剪枝 `GraphClient.deleteNodes`（全量读写挂起 305s → 单次快照 + 批量删除）；测试 95 文件 / 656 | ✅ |

## 下一阶段

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | **飞轮自动闭环**：hook 式 outcome 自动捕获（任务完成 / 会话压缩时自动记录）+ 历史运行 backfill 脚本 | ⬜ | 现状：本仓库 600+ 次 context 运行 **0 次 outcome 回填、技能库 0 skill**——飞轮在自己的 dogfood 环境里从未闭环。竞品（claude-mem / Engram）用 hook 自动捕获会话记忆，主动调 `graphflow_report_outcome` 是结构性劣势。目标：让 `graphflow_diagnose` 出现真实 skill / episode |
| **P1** | **独立 benchmark 公开复现**：token 节省 98.7%、skill A/B（100% vs 61.5%）、记忆 ROI（100% vs 56.5%）的方法学文档 + JSON 落盘，邀请第三方复现 | 🟡 | 基准基建已完备（`npm run benchmark` / `benchmark:skills` / `benchmark:memory`，golden set 已入 CI），但结论目前全部为自测；赛道硬通货是独立第三方数据（CodeGraph / grepai 均有独立实测） |
| **P1** | **图噪声治理**：符号哈希冲突处理、引用边质量（Trie / 布隆过滤）、子图级 PageRank 缓存 | 🟡 | v1.9.5 已修复 worktrees 污染与剪枝读写放大；但黑帽分析指出「噪声图比无图更糟」——大仓库下边缺失 / 伪边 / 重构后过期仍会误导 agent，是头号质量风险 |
| **P2** | **协议层占位**：ATP/IR 公开规范 v1.2 增量演进、MCP resources 完善（`graphflow://diagnose` 已上）、协议适配文档 | 🟡 | 对冲平台内置化（Claude Code Auto Memory 等）；resources 与路线图（本文档）已落地，ATP/IR v1.2 待办 |
| **P2** | **社区化基建**：贡献指南（CONTRIBUTING）、公开路线图（本文档）、Issue 模板（bug / feature） | ✅ | 本文档与配套文件落地后即完成；后续价值取决于社区参与度——从修 bug、补测试、认领 ⬜ / 🟡 事项开始 |
| **P3（前瞻）** | **MCP 2026-07-28 无状态规范适配（MCP 2.0）** | ⬜ | 业界称史上最大改版：移除 initialize 握手、新增 `server/discover`、每请求 `_meta` 携带协议信息、工具 schema 升级 JSON Schema 2020-12（`oneOf` 可用于 `graphflow_insight` 的条件必填）、`ping` / `logging` 移除但保留 12 个月兼容窗口。传输层已 SDK 化（v1.9.2+），升级 `@modelcontextprotocol/sdk` 即自动获得兼容；需复核 ping 依赖 |

## 如何参与

- 认领 ⬜ / 🟡 事项、修 bug、补测试与文档：见 [CONTRIBUTING.md](CONTRIBUTING.md)（开发环境、代码规范、PR 检查清单、测试要求）
- 想法与新功能：先在 [Discussions](https://github.com/Roarpeng/GraphFlow/discussions) 讨论，再用 feature 模板提 issue
- 节奏说明：单作者维护，7 周 39 个 npm 版本、250+ commits；版本节奏会随社区参与度动态调整，评审可能较慢，请耐心
