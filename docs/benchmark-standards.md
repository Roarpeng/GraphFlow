# GraphFlow Benchmark Standards（基准方法学公开标准）

> 适用版本：@roarpeng/graphflow v1.9.5+　|　标准版本：v1
> 范围：把项目内置的三套自测基准（token 节省 / Skill A/B / Memory A/B）的方法学固化为**第三方可复现的公开标准**：环境要求、运行命令、输入数据、判定标准、输出位置、复现清单与结果解读。

> **诚实声明（self-test vs independent）**：本文件中引用的所有具体数字（如 98.7%、100%、56.5%）均为**项目自测结果**——由作者在作者机器上运行、未经过独立第三方复核。第三方复现时应以本文档为准重新跑出**自己的数字**，再与本文数字对比；任何"官方宣称"均应以独立复现为准。

> English abstract: This document standardizes the methodology of GraphFlow's three built-in self-test benchmarks (token-savings, Skill A/B, Memory A/B) so that third parties can reproduce them independently. All numbers cited here are self-test results; the reproduction checklist in section 7 lets anyone regenerate them. No API keys, no network, Node >= 20 required.

## 0. 总览

| 基准 | 脚本 | 命令 | 人类可读输出 | 机器可读输出 | 自测关键数字 |
| --- | --- | --- | --- | --- | --- |
| Token 节省 | `benchmarks/run-token-benchmark.ts` | `npm run benchmark` | `benchmarks/RESULTS.md`（本基准区块） | `benchmarks/.cache/token-bench-results.json` | 98.7%（2026-07-28 自测）；98.9%（2026-08-02 复跑，见 §2.7 漂移说明） |
| Skill A/B（注入/召回/开销） | `benchmarks/run-skill-ab-benchmark.ts` | `npm run benchmark:skills` | `benchmarks/SKILL-AB-RESULTS.md` | — | 注入 100% / 召回 100% / 25.6 tok/任务 |
| Skill A/B 端到端（P1-2） | `benchmarks/run-skill-ab.ts` | `npm run benchmark:ab` | `benchmarks/RESULTS.md`（P1-2 区块） | `benchmarks/.cache/skill-ab-results.json` | ON 100% vs OFF 61.5%（26 任务） |
| Memory A/B 端到端（P3） | `benchmarks/run-memory-ab.ts` | `npm run benchmark:memory` | `benchmarks/RESULTS.md`（P3 区块） | `benchmarks/.cache/memory-ab-results.json` | ON 100% vs OFF 56.5%（62 任务） |

四个脚本归属三套基准：Token 节省一套；Skill A/B 两档（P1-2 的"注入率/召回率/开销"与"端到端成功代理"）；Memory A/B（P3）在 Skill A/B 端到端框架上扩展了 HARD 任务集与归因链。

## 1. 通用环境要求

- **Node ≥ 20**（`package.json` 声明 `engines.node = ">=20"`、`npm >= 10`），已验证 Node v22（win32 x64 与 linux x64）。
- **OS**：Linux / macOS / Windows 均可。脚本只依赖 Node 标准库与本仓库依赖，无平台特定调用；token 基准的 commit hash 采集需要 `git` 在 PATH 中（缺失时自动降级，见 §2.6）。
- **离线**：三套基准**均不联网、不需要任何 API key**。LLM/网络 embedding 步骤被显式禁用（token 基准）或用确定性哈希/内存图替代（A/B 基准）。
- **依赖**：`npm install`（`tsx`、`gpt-tokenizer` 已是 devDependencies，无需额外安装）。
- **磁盘/内存**：无特殊要求（benchmark 图缓存约数 MB，见 §6）。
- **git 状态**：A/B 基准使用内存图，不受工作树影响；token 基准的语料是**工作树中的 `src/`**，未提交改动会改变结果（见 §2.6 与 §5）。

## 2. 基准一：Token 节省（`npm run benchmark`）

### 2.1 目的
测量 GraphFlow 压缩上下文（summary + anchors）相对"传统 coding agent 先 grep 再把整文件塞进 prompt"的 LLM **input token** 节省比例。

### 2.2 输入数据（固定）
- **查询集**：8 条 golden 查询，硬编码于 `benchmarks/run-token-benchmark.ts` 的 `QUERIES` 常量：`orchestrator`、`context compression`、`model routing`、`graph index`、`token savings`、`semantic enrichment`、`preview context`、`skill flywheel`。固定输入，不可配置。
- **被测语料**：仓库自身的 `src/` 树（baseline 扫描范围；忽略 `node_modules`、`dist`、`.git`、`graphflow-out`、`graphify-out`、`.cache`、`tests`、`__tests__`）。
- **Baseline 参数**：每查询最多整读命中分数最高的 10 个文件（`BASELINE_MAX_FILES_PER_QUERY = 10`），扩展名 `.ts`/`.tsx`。

### 2.3 运行命令
```bash
npm run benchmark        # 等价于 tsx benchmarks/run-token-benchmark.ts
```

### 2.4 判定标准
- **运行成功** = 进程退出码 0，且两个输出文件均已生成（§2.5）。
- **主指标** = 总节省率 `savings % = (Σ baseline − Σ graphflow) / Σ baseline × 100`。
- **可复现性**：同一 commit + 同一 Node 版本下数字确定性一致（离线 AST 索引、固定查询集、`gpt-tokenizer`（gpt-4o 编码）对两侧同口径计数）。跨 commit 或跨工作树状态不可比，对比前先核对结果 JSON 的 `commit` 字段。

### 2.5 输出位置
| 文件 | 内容 |
| --- | --- |
| `benchmarks/RESULTS.md` | 人类可读报告（本基准区块；文件顶部含"如何复现"小节。P1-2/P3 区块由其他脚本维护，各脚本只替换自己的 `<!-- BEGIN/END -->` 标记区块，互不覆盖） |
| `benchmarks/.cache/token-bench-results.json` | 机器可读结果：`schemaVersion` / `generatedAt` / `commit` / `environment` / `inputs`（查询集与 baseline 参数原样记录）/ `totals` / `results`（逐查询明细，`savingsPercent` 保留 1 位小数与报告一致） |
| `benchmarks/.cache/benchmark.config.json`、`benchmark-graph.json` | 本次运行的隔离配置与索引图（中间产物，gitignored） |

### 2.6 commit 采集
结果 JSON 的 `commit` 字段由 `git rev-parse HEAD`（`node:child_process`）获取；失败时降级为 `env.GITHUB_SHA`，再失败为 `"unknown"`（如非 git 检出）。降级不影响其余测量。

### 2.7 结果解读与边界（诚实标注）
- 自测口径：**98.7%**（baseline 230,069 → graphflow 2,893，2026-07-28，win32，Node v22.17）。GraphFlow 侧是**独立重算**的 summary+anchors 文本 token 数（保守口径）；报告中的"self-estimate"列是引擎自报数（通常更低），两者同时公开以便对账。
- **语料漂移实证**：2026-08-02 在同一仓库（commit `2e120a5`）复跑（linux x64，Node v22.20），结果为 **98.9%**（baseline 262,926 → graphflow 2,843）：07-28 之后 src/ 有 10+ 个功能提交（memory attribution、MCP SDK 迁移、PLC、Graphify pilot 等），语料增长（索引 327 → 335 文件、图节点 3,270 → 3,480）导致 baseline 上移。这印证了"语料 = 仓库自身"的漂移特性——**跨 commit 对比必须使用 JSON 的 `commit` 字段锚定**。
- **Baseline 是模拟，不是抓拍**：它模拟"grep + 整读 top-10 文件"，真实 agent 读取文件数各异；上限取 10 是**保守**选择（上限越高节省越大）。
- 语义压缩与网络 embedding 已**禁用**（离线确定性优先）；启用通常只会进一步提高节省。

## 3. 基准二：Skill A/B——注入/召回/开销（`npm run benchmark:skills`）

### 3.1 目的
学习飞轮（skill hints + 情景召回）是否为新任务注入**相关**历史经验，以及注入的 prompt token 开销。

### 3.2 输入数据（固定，硬编码 fixtures）
- **Phase 1（历史）**：8 条历史任务（`HISTORY`，含 pass/fail 与 lessons），经真实学习路径 `applySkillLearning` + `recordEpisode` 灌入隔离的内存图。
- **Phase 2（评估）**：8 条相关但不同的新任务（`EVAL_TASKS`）。
- 无 mocks、无网络、无 API key。

### 3.3 运行命令
```bash
npm run benchmark:skills   # 等价于 tsx benchmarks/run-skill-ab-benchmark.ts
```

### 3.4 判定标准
- 指标：`hintInjectionRate`（收到 ≥1 条 hint 的任务占比）、`episodeRecallRate`（召回 ≥1 条 episode 的占比）、Jaccard 相关性代理、`meanTokenOverheadPerTask`（gpt-tokenizer 计数）。
- 可复现性：确定性离线；同一 commit 下数字一致。

### 3.5 输出位置
- `benchmarks/SKILL-AB-RESULTS.md`（唯一输出，整文件重写）。

### 3.6 结果解读与边界
- 自测口径：注入 100% / 召回 100% / 平均 25.6 tok/任务（总开销 205 tok，8 任务）。
- **Jaccard 是机械代理**：证明飞轮为词表相关任务注入词表相关经验，**不证明任务成功率提升**。端到端成功率需在真实 agent 上以 `skillPolicy.enableSkillFlywheel` 开关做 A/B（需 LLM，刻意排除在本离线基准之外）。

## 4. 基准三：Memory A/B——端到端成功代理（P1-2 + P3）

### 4.1 目的
记忆层（技能提示 + 情景摘要注入）能否提升"找到预期 golden 目标"的**成功代理**，并量化代价、污染与归因。P1-2（`npm run benchmark:ab`）为 skill-flywheel 版本；P3（`npm run benchmark:memory`）为 episodic-memory 扩展版（HARD 任务集 + 归因链）。

### 4.2 输入数据
- **任务集（黄金查询）**：26 条 retrieval-golden 查询，**复制自** `tests/retrieval-golden.test.ts` 的 `GOLDEN_SET`——该文件是回归测试真源，归另一 agent 所有、不可修改；两个基准脚本以注释注明并**手工同步**此列表。其中 10 条为 `indirect`（golden 模块名与查询词形态不同，纯检索无法命中）。
- **HARD 任务集（仅 P3）**：36 条 = 12 cross-module + 12 disambiguation + 12 indirect。构造上 golden 节点与查询**零 token 重叠**（节点 id 不参与可搜索文本），纯检索必然无法排名——情景记忆是唯一桥梁。
- **历史模拟（仅 Arm A）**：P1-2 为 27 条历史任务（含 1 条 decoy）；P3 为 63 条（26 golden + 36 hard + 1 decoy）。
- **每任务种子图**：golden 文件节点 + 2 个 token 重叠干扰节点 + 1 个 module 节点 + 1 个全局 decoy 节点；哈希用项目 DJB2a（FNV 类，确定性）。
- 参数：`TOP_K = 5`、包 token 预算 800、`MAX_HINTS = 3`、`MAX_EPISODES = 3`。

### 4.3 运行命令
```bash
npm run benchmark:ab       # P1-2：等价于 tsx benchmarks/run-skill-ab.ts
npm run benchmark:memory   # P3：  等价于 tsx benchmarks/run-memory-ab.ts
```

### 4.4 判定标准
- **成功代理**：Arm A 成功 = 包 Top-5 命中 golden 节点 id **或**注入文本命中（hints/episodes 按模块名引用，`expectAny` 子串检查）；Arm B = 仅包 Top-5。包专用命中率单列，供同口径对比。
- 指标：`successRateA/B`、`rescued`（B miss → A hit）、`hurt`（B hit → A miss）、`hintInjectionRate`、`episodeRecallRate`、`meanTokenOverheadPerTask`、decoy 污染（Top-5 与注入）、wall-clock；P3 另有归因链（每个 rescued 任务的载体通道 + 相似度最高的 episode + 注入文本样本）。
- 可复现性：确定性离线；episode id 内嵌 `Date.now()` 跨运行不同，但**排名只依赖 token/分数，不依赖 id**。

### 4.5 输出位置
- `benchmarks/RESULTS.md`：P1-2 与 P3 各自 `<!-- BEGIN/END -->` 标记区块（各脚本只替换自己的区块；token 基准同样只替换自己的区块，三者互不覆盖）。
- `benchmarks/.cache/skill-ab-results.json`（P1-2）、`benchmarks/.cache/memory-ab-results.json`（P3）：结构化汇总 + 逐任务明细。

### 4.6 结果解读与边界
- 自测口径：P3 **ON 100% vs OFF 56.5%**（62 任务，rescued 27、hurt 0）；P1-2 **ON 100% vs OFF 61.5%**（26 任务，rescued 10、hurt 0）。注入侧开销 P3 平均 70.9 tok/任务、P1-2 33.2 tok/任务。
- **成功代理 ≠ LLM 完成率**：它机械地验证"golden 目标是否出现在 Top-5 或注入文本"，不是真实任务成功率；真实收益需在 agent 上端到端 A/B。
- Arm B 的失败是**刻意设计**（indirect/HARD 任务与 golden 零 token 重叠），用于隔离记忆层的边际价值；报告同时公开包专用命中率，避免夸大。

## 5. 自测 vs 独立测试：边界与对账

| 维度 | 可由本基准独立验证 | 不可由本基准验证 |
| --- | --- | --- |
| Token 计数 | ✅ `gpt-tokenizer`（gpt-4o）独立重算，与引擎内部口径解耦 | — |
| 离线确定性 | ✅ 无 API key、无网络、固定输入 | — |
| 结果锚定 | ✅ JSON 的 `commit` + `generatedAt` | — |
| LLM 端到端成功率提升 | — | ❌ 需要真实 agent + LLM 的 A/B |
| 真实 agent 的上下文成本 | — | ❌ baseline 是模拟（top-10 整读） |
| 跨仓库泛化 | — | ❌ 语料 = 本仓库 `src/` |

**对账指南（独立测试出现偏差时）**：
1. 核对结果 JSON 的 `commit` 是否一致——token 基准的语料是工作树 `src/`，**未提交改动会改变结果**；
2. 核对 Node 版本（≥20）与是否离线环境；
3. 核对 npm 依赖版本（`tsx`、`gpt-tokenizer`）；
4. 若以上一致而数字仍不同，请在报告中记录并作为发现的差异提交（这正是独立基准的意义）。

## 6. 输出与中间产物汇总（gitignore 说明）

- `benchmarks/.cache/` 已在 `.gitignore` 中，包含：`token-bench-results.json`、`skill-ab-results.json`、`memory-ab-results.json`（结果，建议 CI 归档）、`benchmark.config.json`、`benchmark-graph.json`（中间产物）。
- `benchmarks/RESULTS.md` 与 `benchmarks/SKILL-AB-RESULTS.md` 为跟踪文件：前者是三个脚本共享的"汇总页"（各占自己的标记区块），后者仅由 Skill A/B（P1-2）脚本维护。

## 7. 第三方复现清单（checklist）

1. `git clone <repo> && cd <repo>` 并 `git checkout` 一个固定 tag/commit（如 `v1.9.5`）。
2. `npm ci`（或 `npm install`）。
3. 按序运行四命令（均离线、无需 API key）：
   ```bash
   npm run benchmark        # → RESULTS.md 顶部区块 + .cache/token-bench-results.json
   npm run benchmark:skills # → SKILL-AB-RESULTS.md
   npm run benchmark:ab     # → RESULTS.md P1-2 区块 + .cache/skill-ab-results.json
   npm run benchmark:memory # → RESULTS.md P3 区块 + .cache/memory-ab-results.json
   ```
4. **校验**：每个命令退出码 0；JSON 文件均生成且含 `commit`/`generatedAt`；token 基准的 `totals.savingsPercent` 与 RESULTS.md 摘要一致。
5. **对比**：将你的 `totals`/`successRate` 与本文件 §0 自测数字对比，记录差异（预期：同一 commit 下数字一致；跨 commit 以 JSON `commit` 字段为准）。
6. （可选交叉验证）用任意 gpt-4o tokenizer 实现，对 `token-bench-results.json` 的 `inputs.queries` 与 baseline 命中文件重算一次 token 计数，验证两侧计数口径。

## 8. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1 | 2026-08-02 | 初版：方法学固化（随 v1.9.5）；token 基准新增机器可读 JSON 落盘（commit hash + 运行日期）。 |
