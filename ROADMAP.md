# GraphFlow 路线图（ROADMAP）

> 最后更新：2026-08-12（Experience 层已合入；install/doctor 接入 Claude Code hooks）
>
> GraphFlow 是**单人维护**项目（bus factor = 1）。本路线图既是对外承诺，也是社区贡献的入口——欢迎按 [CONTRIBUTING.md](CONTRIBUTING.md) 认领任意 ⬜ / 🟡 事项，直接降低单点风险。

## 状态图例

- ✅ 已完成
- 🟡 进行中 / 部分完成
- ⬜ 未开始（欢迎认领）

## 已完成里程碑（v1.0 → v1.9.11）

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

## 下一阶段

### Experience 层（已合入 main）

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | **飞轮 Experience 指标 + QM 式 skill 巩固** | ✅ | `skill consolidate` dry-run + `--apply`/`--execute`；`getFlywheelReport` / diagnose / skill report 暴露 `experience`（含 consolidation 动作计数与 hint） |
| **P1** | **Context 合同产品化 + Agent Plugin 主路径 + memory pack** | ✅ | [docs/context-contract.md](docs/context-contract.md)；[docs/experience-memory.md](docs/experience-memory.md)；Plugin 为首选安装，`install` 为 Rules/多 Agent 回退；`artifact export-memory` Markdown 包 |
| **P2** | **ATP 兼容示例 producer + Engineering KG episode 链** | 🟡 | `examples/atp-minimal-producer/`；episode↔Requirement/Concept 边 |

### 既有 backlog

| 优先级 | 事项 | 状态 | 说明与依据 |
| --- | --- | --- | --- |
| **P0** | **飞轮自动闭环**：hook 式 outcome 自动捕获 + 历史 backfill | ✅ | auto-capture；Claude Code hooks API + **install/doctor 接线**；`npm run backfill:episodes`；v1.9.8 diagnose 暴露 flywheel 健康。Dogfood 非零 skill 靠真实使用积累 |
| **P1** | **独立 benchmark 公开复现** | ✅ | [benchmarks/README.md](benchmarks/README.md) + commit 锚定 JSON；欢迎第三方复现 |
| **P1** | **图噪声治理**：Trie 引用预过滤、子图 PageRank 缓存 | ✅ | v1.9.8 落地；Bloom 非必要（Trie 已覆盖预过滤） |
| **P1** | **团队共享记忆安全门控**：provenance + canary + anti-pattern 隔离 | ✅ | `canary-gate.ts`；见 [docs/team-memory-security.md](docs/team-memory-security.md) |
| **P1** | **第三方基准复现邀请** | ✅ | 与独立 benchmark 同源；README「Proof, not promises」 |
| **P1（融合）** | **Skill-conditioned DAG + SkillOpt-lite** | ✅ | plan 节点 `skillRefs`/`avoidPatterns`；outcome 有界编辑 guidance |
| **P2** | **协议层占位**：ATP/IR v1.2、MCP resources | 🟡 | resources 已落地；ATP/IR v1.2 待办 |
| **P2** | **代码域检索评测公开数据集** | ⬜ | golden set 已入 CI，开放成本低 |
| **P2** | **社区化基建** | ✅ | CONTRIBUTING / ROADMAP / Issue 模板 |
| **P3** | **MCP 2.0 无状态规范适配** | ⬜ | 升级 SDK 后复核 ping / schema |

## 如何参与

- 认领 ⬜ / 🟡 事项、修 bug、补测试与文档：见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 想法与新功能：先在 [Discussions](https://github.com/Roarpeng/GraphFlow/discussions) 讨论
- 节奏说明：单作者维护；版本节奏随社区参与度调整
