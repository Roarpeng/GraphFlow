# GraphFlow

[English](./README.md) | **简体中文**

[![npm](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![CI](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-roarpeng.graphflow-blue)](https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow)

> **面向 AI 编程 Agent 的省 Token 外科手术级代码引擎（v3.7.0）**
> 只暴露 4 个外科手术工具的 MCP 服务器 —— `gf_read`、`gf_edit`、`gf_exec`、`gf_macro` —— 对**全部 6 种语言家族提供真 AST 解析**：TypeScript/JavaScript 用 `@babel/parser`，Python、Go、Rust、C/C++、C# 用可选 tree-sitter 语法包（缺省回退结构化分析器）。**自研语义索引**为爆炸半径/重命名解析调用目标（不新增运行时依赖），**精度调优的文档↔代码链接**（BM25/IDF + PMI + 上限 + 置信度）让知识图谱更可信。**六语言能力平价已纳入回归测试**（51 项矩阵），双语检索在「孤立 30 对 + packed 30 对」语料上达到 **EN 1.000 / ZH 1.000**，**本地任务反射**可通过显式记录或自动收割外部指令日志，在无 LLM/网络下重放已记录的 shell 指令。知识图谱现在**按文件增量重建**（只重算 dirty 文件，输出与全量重建完全一致），解析后的 AST 索引落盘缓存，因此 274 文件仓库上的热 `gf_read` 从 4.4 s 降到 1.4 s。运行时依赖：`@babel/parser`、`@modelcontextprotocol/sdk` 与 `tree-sitter`；语法包为可选依赖。

---

## GraphFlow 3.0 — 大刀阔斧的重写

3.0 版本**整体替换了 2.x 架构**：10 工具的知识图谱 / 上下文压缩 MCP 面（`graphflow_context`、`graphflow_plan`、`graphflow_run`、`graphflow_index`、`graphflow_insight`、`graphflow_skill_*`、`graphflow_diagnose`、`graphflow_artifact`）、情景技能飞轮、VS Code 图记忆扩展、LLM 路由 —— **全部移除**。取而代之的是跑在 AST/结构化流水线上的 4 个确定性手术工具。MCP schema 开销下降 **92.2%**（每轮 5897 → 458 tokens）。

| 2.x（已移除） | 3.x 替代方案 |
| :--- | :--- |
| `graphflow_context(...)` | `gf_read({ targets, q, skeleton: true })` |
| `graphflow_plan` / `graphflow_run` | 移除 —— 确定性流水线，无 LLM 路由 |
| `graphflow_index` | 移除 —— 符号索引按需构建 |
| `graphflow_insight` / `graphflow_skill_*` | `gf_macro({ action: "mine" \| "mine-git" })` |
| `graphflow_diagnose` | `graphflow status`（CLI） |
| `graphflow_artifact` | `gf_macro({ action: "visualize" })` → `.graphflow/knowledge-graph.html` |
| `GRAPHFLOW_MCP_PROFILE` 环境变量 | 移除 —— 4 个 `gf_*` 工具是唯一入口 |
| VS Code 图记忆扩展 | 轻量预编译启动器（见 [VSIX-INSTALL.md](./VSIX-INSTALL.md)） |
| 对话 / 工作台记忆功能 | 随飞轮一并移除；跨会话交接由 `gf_read({ targets: ["@brief"] })` 承担 |

**2.x 用户必须把工具调用从 `graphflow_*` 迁移到 `gf_*`。** 没有兼容层。

| 版本 | 说明 |
| :--- | :--- |
| 2.3.0 | 最后一个旧架构版本（10 工具知识图谱 MCP） |
| 3.0.0 | 大刀阔斧的重写 —— 破坏性变更，4 个手术工具 |
| 3.1.0 | 21-Agent 安装器、三振熔断、git 共变挖掘、结构体字段契约守卫 |
| 3.1.1 | 轻量预编译 VS Code 扩展、GitHub Releases 提供 VSIX |
| 3.2.0 | 文档图谱（跨 Agent 交接简报、文档↔代码链接、HTML 知识图）+ 中英双语分词器 |
| 3.2.1 | 修复包：affected-tests 感知 `package.json` `scripts.test`、`gf_exec` `run:true` 执行/预览门控、简报 hub 入度匹配带扩展名 import |
| **3.3.0** | **VSIX 激活自动注册（每版本一次，`graphflow.autoInstall` 可关）+ `install` 自动清理旧注册（别名键、陈旧 launcher、已卸载 Agent 残留；`--no-prune` 跳过）** |
| **3.3.1** | **方法级爆炸半径与重命名（覆盖成员调用点，存在未解析调用方则中止）· 真正可用的 DSH Cordis patch 安装（`cwd` + `GRAPHFLOW_WORKSPACE_ROOT`）· 可安全限范围的 `uninstall`（`--agents` / `--all`）· Python 启发式语法守卫 · `exec` 参数解析 · `Error:` + 栈帧后的失败源码窗口 · Go/Rust `struct` 类型** |
| **3.3.2** | **真实知识图谱边（defines/imports/calls/doc-links-code/co-edit，方法节点 id 带类名，最多 5000 条边）· 接收者类型推断感知的爆炸半径与重命名（同名方法 A/B 消歧、`REJECTED [ambiguous-symbol]`）· tsconfig/jsconfig 别名 + 动态 import 感知的受影响测试路由** |
| **3.3.3** | **类型感知的知识图谱 calls（按接收者匹配目标、外部接收者丢弃、别名解析 imports）· 继承/`super`/`base` 接收者推断（子类→基类分派、最后赋值优先、泛型/数组/可空解包）· tsconfig/jsconfig `extends` 链、嵌套配置与 project references 感知的受影响测试路由 · `npm run bench` 基准脚本** |
| **3.3.4** | **`install` 安全合并宿主钩子（保留用户 `PreToolUse`/`PostToolUse` 钩子；重复安装幂等）· `uninstall` 只移除 GraphFlow 钩子 · `graphflow status` 按 Agent 显示注册状态（`[MCP ✓] [Skill ✓] [Rule -] [Hook ✓]`），支持 `--agents` / `--all` · MCP stdio 端到端测试（initialize → tools/list 4 工具 → gf_read/gf_exec → 未知工具优雅报错）** |
| **3.4.0** | **Python/Go/Rust/C/C++/C# 默认真 AST：可选 tree-sitter 语法包（`engine: "tree-sitter"`），缺少原生绑定时回退结构化分析器，`GRAPHFLOW_TREE_SITTER=0` 强制结构化 · C/C++ 头文件/原型处理与 Python `super` 接收者 · 依赖变化：必需 `tree-sitter` 核心 + 可选语法包 · 基准数据刷新** |
| **3.5.0** | **文档↔代码链接精度（自研 BM25/IDF + PMI + 互惠剪枝 + 上限，`GRAPHFLOW_DOC_LINKS_MAX`；仓库 728 → 约 150 条边，−80%）· `graphflow doctor parsers` + `npm run verify:parsers` + 增量 CI 解析器矩阵 · 自研 L0 语义索引（置信度 ≥0.75）与可选 TypeScript/LSP 提供者 · DSH 配置包 `@roarpeng/graphflow-dsh` · 发布预检（`npm run preflight` / `preflight:release`）· 基准数据刷新** |
| **3.6.0** | **48 项六语言平价矩阵与修复（语言家族作用域的 `resolveMethod`/重命名、Go 嵌入/分组参数、C typedef 字段、Rust `&dyn`/`impl` 解包、C/C++ 头文件原型↔定义重命名）· 30 对双语召回 1.000 EN / 1.000 ZH（拼音/混合/同义词 1.000；基线 ZH@1 0.967、拼音 0.769）· 本地任务反射（`graphflow task`/`reflect`、`gf_macro` task-list/run/record）· Windows CRLF 测试修复；CI（6 job）+ 解析器矩阵（7 job）全绿 · 458 wire tokens · 24 个测试文件** |
| **3.6.1** | **六语言平价 51 项：Rust trait 分派闭环（trait 方法带 `parentClass`=trait；`dyn Trait`/`impl Trait` 接收者解析到 trait 方法，具体接收者解析到 impl）、C# `record`/`record struct` kind + 位置参数字段 + namespace 映射闭环（Go 同包 imports 仍为诚实缺口）· packed 文件双语语料：packed EN 1.000 / ZH 1.000 @1/@3/@5（ZH@1 原为 0.900；修复 ±7 行 own-doc 串扰）· 任务自动收割（`.graphflow/instruction-log.jsonl`、`task log`/`task harvest`、`gf_macro` `task-harvest`；需要外部写入者）· 458 wire tokens · 24 个测试文件** |
| **3.7.0** | **词表外的中文检索英文标识符：L1 注释/提交 PMI 映射、L2 自编口语词表（可选本地 ECDICT）、L3 翻译钩子默认关闭 · `gf_read` 自适应搜索预算 · 真正的按文件增量建图（每文件贡献 + 分片清单）· AST 索引落盘缓存 · 重命名不再改坏 import 路径 · 80 条留出查询 P@1 0.000 → 0.813 · `ts-zh-search` 3198 → 1077 tokens · wire **459** tokens · 40 个测试文件** |
| **3.6.2** | **评测修复包：类限定名重命名（`OrderService.cancel`）并沿覆写层级更新 `super` · Rust 宏内 `impl Trait` 爆炸半径 · 文档↔代码常量 / 泛词 / 测试符号上限 · `gf_read` 源码体积预算（`GRAPHFLOW_READ_BUDGET_RATIO`）· PostToolUse 钩子与 `gf_exec` `run:true` 自动写指令日志 · MISS Jaccard + task-run 结构化 `exitCode` · wire **459** tokens · 25 个测试文件** |

## 四个外科手术工具

| 工具 | 用途 | 关键参数 |
| :--- | :--- | :--- |
| `gf_read` | 精准符号切片（自动跨文件类型闭合）+ 接收者类型感知的 `[Blast Radius]` 调用点（先查语义索引，再回退继承/`super` 启发式）、骨架折叠、双语检索（1.000 EN/ZH 平价召回）、`@brief` 跨 Agent 交接 | `targets`、`q`、`topK`、`skeleton`、`dedup` |
| `gf_edit` | 原地 / 批量原子编辑、零 LLM 跨仓重命名（先做语义目标判定，再回退接收者/继承启发式；语言家族作用域 staging，拒绝歧义/外部接收者文件；仍有未解析调用方则中止）、结构体字段契约守卫 | `file`、`symbol`、`newCode`、`edits`、`renameTo` |
| `gf_exec` | 变更到测试路由（感知 `package.json` `scripts.test`；解析 tsconfig/jsconfig 别名、`extends` 链、嵌套配置与动态 import）+ 输出脱水器：通过的测试套件只回 1 行 `PASS`；失败时内联最多 5 行源码上下文；`run: true` 才执行，缺省仅预览 | `cmd`、`changedFiles`、`handle`、`run` |
| `gf_macro` | 习惯宏、git 共变挖掘、知识图谱 HTML 导出（类型感知 `calls`、别名解析 `imports`、BM25/IDF 受限的 `doc-links-code`，以及 `defines` / `co-edit` 边），以及**本地任务反射**（`task-list` / `task-run` / `task-record` / `task-harvest`） | `action: "list" \| "run" \| "save" \| "mine" \| "mine-git" \| "visualize" \| "brief" \| "task-list" \| "task-run" \| "task-record" \| "task-harvest"` |

会话级读去重跳过未变更文件；连续 3 次编辑-测试失败触发确定性急救包（爆炸半径契约 + 最近 git diff）。语法守卫在有真 AST 后端时使用它们 —— TS/JS 用 `@babel/parser`，其余 5 种用 tree-sitter 的 ERROR/MISSING 诊断 —— 结构化分析器的启发式检查（花括号/声明级、Python 缺冒号/括号诊断）作为回退，设置 `GRAPHFLOW_TREE_SITTER=0` 时同样适用。

## 3.7.0 新特性

- **词表没覆盖的中文也能找到英文标识符** —— L0 的拼音、同义词和工程词表不动，因此已经饱和的 30+30 平价集仍是 **1.000**。L1 在建索引时把注释和 `git log` 标题里的中文 n-gram 与附近标识符子词配对，按 PMI 保留（英文词若还出现在别的中文窗口里，单次共现会被丢掉），并缓存到 `.graphflow/zh-identifier-map.json`。热查询大约 **0.005 ms**。L2 是随仓库发布的原创编程口语表（Apache-2.0，不是 CC-CEDICT 或 ECDICT 的拷贝），再滤成「这个仓库的标识符里真的出现过的英文词」，缓存远小于 1 MB。本地 ECDICT TSV（MIT；`GRAPHFLOW_ECDICT` 或 `.graphflow/ecdict.csv`）可选，不打进发布包。L3 是 `registerZhEnModel`，只有 `GRAPHFLOW_ZH_EN_MODEL=1` 才调用。不新增模型依赖。`GRAPHFLOW_ZH_RECALL=0` / `GRAPHFLOW_ZH_L1=0` / `GRAPHFLOW_ZH_L2=0` 可逐层关闭。
- **80 条不在 L0 词表里的留出说法** —— 仅 L0：**P@1 0.000 / MRR 0.000 / R@3 0.000**。**+L1：0.375 / 0.375 / 0.375**（30 条由提交教会的查询从 0 到 **1.000**）。**+L1+L2：0.813 / 0.813 / 0.813**（35 条口语查询从 0 到 **1.000**）。另外 **15** 条仍然是 **0**：注释、提交和词表里都没有。L3 没有当作神经网络模型来打分；注册钩子后，其中一条未命中可以被补上。更短的 L1 n-gram 会抢答（`搞定发货` 会先撞上只教过 `发货` 的提交），直到更长的 L2 短语把它压过去。
- **自适应搜索预算** —— 不传 `topK` 时，前两名分差至少 **0.45** 就只返回 **1** 条切片；分差更小则保留最多 3 条接近结果（因此 `订单超时` 仍会同时返回处理函数和 `OrderService.timeout`）。这些默认切片不再附类型闭合和爆炸半径。显式传入 `topK` 仍是原来的完整切片。80 条留出查询的 token 合计从 **22157 降到 4849**，自适应 P@1 仍是 **0.813**。CLI 上的 `ts-zh-search`（三次查询，`ceil(字符数/4)`）从 **3198 降到 1077**，三份源文件基线是 1245；要求命中的符号还在。
- **真正的按文件增量建图** —— 图谱不再是「一次全量重算」，而是各文件贡献之和。每条边都有唯一归属文件（`defines` / `imports` / `calls` 归声明 / 导入 / 调用方，`doc-links-code` 归代码文件），因此 `buildKnowledgeGraphData` 被拆成 `planKgRebuild` + `executeKgRebuild`，只重算 dirty 文件。失效判定三层，由便宜到贵：**(1) 指纹** `size:mtimeMs`；**(2) 名字级反向依赖** —— 每个文件记录自己查询过的符号名 `queriedNames`，与改动文件的 `deltaNames` 求交集即可定位真正受影响的文件，比「拉整张 import 扇入闭包」精确一个量级；**(3) 结构级** —— 继承关系变化把涉及的类名并入 `deltaNames`，文件增删只影响 `unresolvedImports` 非空的文件。分片清单 `.graphflow/graph-shards.json` 还存了每个文件的符号表，未变的文件连 AST 都不加载。清单缺失或损坏时降级为全量重建。
- **AST 索引落盘 + 修掉真正的热点** —— 切片器的解析结果持久化到 `.graphflow/ast-cache/<sha1>.json`，键是内容哈希**加后端签名**，因此切换 `GRAPHFLOW_TREE_SITTER` 会正确失效。`GRAPHFLOW_AST_CACHE=0` 可关闭。`--cpu-prof` 同时推翻了原本的直觉：解析不是瓶颈（274 文件约 950 ms），真正的热点是 `tokenizeEnglish`（约 46%）和 `normalizeWorkspaceRelPath`（约 43%）。两者改为有界记忆化，词典模糊匹配按首字母分桶。axios（274 文件）实测：热 `gf_read` **4.4 s → 1.4 s**，冷 `graph` **16.1 s → 5.6 s**。
- **文档↔代码缓存合并** —— 274 个按文件小分片合并成三个单文件 store（`.graphflow/doc-links/symbols.json`、`concepts.json`、`sections.json`）：Windows 上符号数据加载 **1000 ms → 121 ms**，文档扫描 **920 ms → 49 ms**。候选缓存改用文件内序号（`so`）而非扁平下标作键，因此在文件前部插入符号不会让后面所有缓存条目失效。reciprocal top-K 剪枝仍然每次全局执行，结果与全量重建逐条一致。
- **修复包（正确性）** —— `gf_edit` 重命名不再改坏 **import 路径**：先对注释与字符串/模板串做等长遮蔽，因此重命名符号不会再把 `./combineURLs.js` 改成 `./joinURLs.js` 而触发 `ERR_MODULE_NOT_FOUND`。读取预算的收缩顺序改为优先 `digestSymbolBlocks`，小函数不再被误折叠。受影响测试路由识别 `tests/` / `__tests__/` / `spec/` 目录，并跳过 `conftest.py` 之类的伪测试。MCP 对未知工具的 `tools/call` 返回 `isError: true`，`gf_exec` 通过 `findCommandMacro()` 暴露已编译的本地工具 id。CLI 退出码正确透传，`install` / `uninstall` 会渲染错误而不是吞掉，卸载只删除 GraphFlow 自己写入的 hook 与 MCP 配置。
- **版本/状态** —— 3.7.0；MCP 面仍是 **4 个工具**。wire schema 未改，仍是 **459 tokens**（1834 字符，`ceil(chars/4)`）。测试套件 **39 个文件**（新增 10 个 `tests/fix-*.test.ts`）。CI（6 job）+ 解析器矩阵（7 job）未改。

## 3.6.2 新特性

- **限定名重命名会跟着覆写走** —— `gf_edit` / `graphflow edit --symbol OrderService.cancel --rename cancelOrder` 接受与 `gf_read` 的 `file#Class.method` 相同的类限定符号。子类覆写（`VipOrderService.cancel`、`PartialRefundPolicy.refund`）不再被当成 `ambiguous-symbol` 拒绝：覆写声明保持原名，只改写基类调用（`super.cancel`、`super().refund`）。外部接收者（`RefundService.cancel`、`settle_partial`）、import 模块路径（`from billing.refund`）和块注释里的提及都不改。`new VipOrderService().cancel()` 会解析到构造出的类，因此覆写调用不会被改写。同一文件里的同名重复声明、以及无关的同名类，仍然拒绝。
- **宏里面的 Rust `impl Trait` 调用** —— 爆炸半径会扫描 `macro_invocation` 里的 `receiver.method()`（例如 `describe(d: impl Device) { format!(..., d.read()) }`）。直接的 `&dyn Trait` 调用行为不变。trait+impl 的原子重命名仍安全拒绝。
- **文档↔代码链接** —— 反引号标识符不再拆碎，因此 `` `OrderService.timeout` `` 不会挤掉 `TIMEOUT_WINDOW_MS` 的名额。显式标识符链接不再受每符号 3 条上限约束（每节上限 3 和全局上限仍然生效），所以 EVAL/README 里对同一符号的提及不会挤掉真正定义它们的章节。泛词 `买家` / `卖家` / `会员` / `客服`（及其拼音）进入停用表，同一词的拼音回声只计一次，概念链接跳过测试符号（`setUp`、`tests/`、`test_*.py`）。
- **读取预算** —— 当 `gf_read` 的响应会大于它所切片或检索的主文件源码体积时（爆炸半径/类型闭合的邻居文件不计入预算），切片器就地压缩，不做硬截断。它会缩短爆炸半径片段和符号/闭合函数体，丢掉重复闭合以及已经作为符号展示过的闭合，丢掉不是 `super`/`base` 的编号调用行，丢掉 `EVAL.md` / `README` / `results/` 的引用，并最多保留三条 `// ->` 箭头（出现 `in Hold()` / `in Available()` / `in Reservation()` 时一定保留）加上 `super`/`base` 调用行。`GRAPHFLOW_READ_BUDGET_RATIO` 默认 `1`，设为 `0` 关闭。未超预算时，链接文档行和骨架标记保留。
- **自动指令日志** —— `graphflow install` 注册的 PostToolUse 钩子，以及 `run: true` 的 `gf_exec`，会追加 `.graphflow/instruction-log.jsonl` 并立即收割，因此第二次相同命令就能提升为本地任务，不再需要外部写入者。`GRAPHFLOW_AUTO_LOG=0` 关闭。噪音命令（`echo`、`git status` 等）会跳过。`MISS` 文本带 `(jaccard=…)`，MCP `task-run` 在 `structuredContent.exitCode` 里返回退出码（tools/list schema 未改）。
- **版本/状态** —— 3.6.2；MCP 面仍是 **4 个工具**。实测 wire schema 为 **459 tokens**（1834 字符，`ceil(chars/4)`；schema 未变，仍低于 460 上限；3.6.1 文档写的是 458）。测试套件 **25 个文件**（`tests/eval-regressions.test.ts`）。CI（6 job）+ 解析器矩阵（7 job）未改。

## 3.6.1 新特性

- **平价矩阵 48 → 51 项** —— `tests/language-parity.test.ts` 闭环两个已记录的缺口：**Rust trait 分派**（trait 方法以 `parentClass`=trait 名输出，`dyn Trait`/`impl Trait` 接收者解析到 trait 方法，具体接收者解析到 impl；含跨文件 trait/impl 断言与结构化回退的 trait 作用域）与 **C# record 类型**（`record`→class、`record struct`→struct、位置 record 参数暴露为字段）。自研语义索引新增 C# `namespace → files` 映射，用于 `using`/import、符号与方法候选解析（带文件主干回退）。**Go 同包 imports 仍是诚实缺口**：同包兄弟文件没有文件级 `imports` 边（不虚构边；包作用域的 calls/边可解析）。其余残余：trait+impl 的原子重命名会安全拒绝、`impl Trait for Type` 不视为继承、doc-graph KG 的歧义 `calls` 现改为经语义索引的 `namespace → files` 映射解析（置信度 ≥0.75）—— 例如 `using Demo.Two; g.Cancel()` 会确定性地指向 `two/Gadget.cs#Gadget.Cancel` 而不是 `one/Gadget.cs`；此处仅剩首次遇到歧义工作区时的一次性冷启动语义索引构建（约 +120 ms，之后缓存）与 `GRAPHFLOW_KG_SEMANTIC=0` 逃生开关；C 为函数级、Go 只建模第一个嵌入类型、重命名保持保守、C++ 原型定位为尽力而为。
- **Packed 文件双语语料** —— 双语平价套件在孤立 30 对语料之外新增 packed 文件语料（每文件 6 个符号、仅中文 docstring）。packed **EN 1.000 / ZH 1.000 @1/@3/@5**（修复前 packed ZH@1 为 0.900）；own-doc 注释提取不再使用会串到相邻符号的固定 ±7 行窗口，并加入词项上限/归一化。孤立单符号、拼音、混合、同义词查询仍为 **1.000**。残余不变：泛用英文在 @1 上仍无法区分拼音命名符号；词表为人工维护。
- **任务自动收割（仍无 LLM/网络）** —— 反射现在可由外部指令日志驱动：用 `graphflow task log "<instruction>" --step "<cmd>"` 追加到 `.graphflow/instruction-log.jsonl`（仅追加；`--log <path>` 可覆盖路径），再用 `graphflow task harvest [--log <path>]` 把重复的归一化指令提升为同一套 `.graphflow/tasks.json` + 编译后的 `.graphflow/tasks/<id>.mjs` runner。MCP 等价动作：`gf_macro({ action: "task-harvest", instruction, steps })`，或裸 `task-harvest` 收割日志。收割通过字节偏移状态文件（`.graphflow/task-harvest.json`）增量进行；显式 `graphflow task record` 路径不变，`graphflow reflect` 无匹配时仍返回 `MISS`。限制：**仍需外部写入者**（shell wrapper / DSH skill 向日志追加 —— 没有宿主钩子或守护进程）、步骤以记录者权限本地执行、`{{argN}}` 需手工参数化、并发记录最后写入者胜出。
- **版本/状态** —— 3.6.1；MCP wire 仍为 **458 tokens**，测试套件 **24 个文件**，CI（6 job）+ 解析器矩阵（7 job）保持全绿，基准数字沿用 3.6.0 最终运行（未变）。

## 3.6.0 新特性

- **六语言平价矩阵与修复** —— 新增 `tests/language-parity.test.ts`（48 项测试），对 TS/JS、Python、Go、Rust、C/C++、C# 断言符号/跨度/字段平价，覆盖切片 + 类型闭合、接收者感知爆炸半径、跨文件重命名，以及知识图谱 `defines`/`imports`/`calls`。修复：语言家族作用域的 `resolveMethod`/重命名 staging（杜绝跨语言串扰）、Go 结构体嵌入 + 分组参数 + 嵌入字段、C `typedef struct` 字段、Rust `&dyn`/`impl` 接收者解包、C/C++ 头文件原型↔定义重命名簇。如实记录的残余：Go 同包兄弟文件没有文件级 `imports` 边；Rust trait 声明不作为方法符号（trait 分派返回 0，不会给错目标）；C# `record` 映射为 `interface` kind；C 为函数级（无继承）；深层/多重 Go 嵌入不链式展开；结构化回退不在平价矩阵内。（3.6.1 将矩阵提升到 51 项并闭环 Rust trait 分派与 C# record 缺口；Go 同包 imports 仍为诚实缺口 —— 见上文。）
- **双语召回 1.000 / 1.000** —— 新增 `tests/bilingual-parity.test.ts` 测量 30 对 EN/ZH 查询：EN 与 ZH 在 @1/@3/@5 均为 **1.000**，拼音/混合/同义词家族也是 **1.000**（基线 ZH@1 0.967、拼音 0.769）。分词器修复：词形还原救援不对称、同义词前向扩展污染、缺失的 zh/拼音词表 + EN→ZH 拼音桥、过宽映射。残余：切片文档窗口/名称权重仍可能影响紧密排列的文件；泛用英文在 @1 上无法区分拼音命名符号；词表为人工维护。（3.6.1 新增 packed 文件语料，并通过 own-doc 注释提取修复把 packed ZH@1 从 0.900 提升到 1.000。）
- **本地任务反射（无 LLM、无网络）** —— 重复的 shell 指令可记录到 `.graphflow/tasks.json` 并编译为 `.graphflow/tasks/<id>.mjs`：`graphflow task list|show|record|run`（`--step` / `--steps` / `--args` / `--json` / `--root`）与 `graphflow reflect "<instruction>"`（未知时返回 `MISS`），或 MCP `gf_macro` 动作 `task-list` / `task-run` / `task-record` + `instruction`。第二次记录会提升任务，之后相同/近似匹配（token-Jaccard 0.86）的指令会在本地重放。MCP 表面仍恰好 4 个工具、**458 wire tokens**。限制：仅显式记录（暂无自动采集）、shell 步骤以记录者权限在本地执行、手工 `{{argN}}` 参数化、并发跨进程记录为最后写入者胜出。（3.6.1 新增外部日志自动收割：`graphflow task log` / `graphflow task harvest`。）
- **CI 与发布** —— Windows CI 的 `dsh-bundle` CRLF 失败已在测试中修复（篡改检测兼容 CRLF；校验器不变）；**CI（6 job）**与**解析器矩阵（7 job）**在 ubuntu/windows/macos × Node 20/22（另加严格 ubuntu job）上全绿。现有发布工作流不变；`npm run preflight` / `preflight:release` 与 `npm run task` / `npm run reflect` 可用，测试套件现为 **24 个文件**。
- **实测数据** —— wire schema 为 **458 tokens**；骨架折叠 27,926 → 7,840（71.9%），符号切片 27,926 → 1,165（95.8%），PASS 脱水 5,946 → 30（99.5%，24 文件套件），知识图谱约 1,277 节点 / 约 2,750 条边 / 约 2.08 s（165 条 doc links），受影响测试路由 26 ms（16 项测试），爆炸半径 7 ms。见[基准数据](#基准数据)。

## 3.5.0 新特性

- **文档↔代码链接精度** —— 文档图链接器现在是一条自研检索流水线：对字段加权的文档小节词项做 BM25/IDF（标题与显式标识符加权），叠加 PMI 风格的稀有词对奖励，在「小节侧」和「符号侧」双向取互惠 Top-K，做边际剪枝与贪心最大权匹配，再施加每小节/每符号上限（≤3）、全局上限 `GRAPHFLOW_DOC_LINKS_MAX`（默认 400）与逐链接置信度标签。本仓库文档↔代码边从 **728 降到约 150（−80%）**；显式引用链接占主导，但同样受上限约束（在上限内优先保留），纯概念链接需要分数边际/置信度达标。`.md` / `.html` / `.xml` / `.docx` / `.pdf` 仍受支持，`.graphflow/doc-link-feedback.json` 作为只读的接受/拒绝调参输入。
- **解析器矩阵与 doctor** —— `graphflow doctor parsers`（别名 `graphflow parsers`，支持 `--strict`）打印 tree-sitter 核心/语法包版本与生效的默认引擎；`npm run verify:parsers` 运行 `scripts/verify-parsers.mjs`，对 6 个 fixture 分别在真 AST 模式与 `GRAPHFLOW_TREE_SITTER=0` 结构化模式下验证（支持 `--json`、`--strict`、`--check-install`）。新增增量工作流 `.github/workflows/ci-parser-matrix.yml`，覆盖 ubuntu/windows/macos × Node 20/22 另加一个严格 ubuntu job；现有 ci/publish 工作流不变。
- **自研 L0 语义索引** —— `src/semantic-index.ts`（不新增依赖）构建模块图（根 tsconfig/jsconfig 别名、barrel/re-export）、工作区符号表、逐文件类型环境（标注、`new`、参数、字段、赋值，分支冲突视为未知，泛型/可空/数组解包，继承/`super`），以及带置信度的调用目标解析。爆炸半径与重命名优先查询它（置信度 ≥0.75），否则回退到语言启发式。残余限制：仅根配置（不支持 `extends`/project references）、default/namespace import 限制、不做流敏感收窄与泛型替换。
- **可选语义加速** —— `src/ts-semantic.ts` 通过既有 devDependency 惰性包装 TypeScript Compiler API（缺省时返回 `undefined`；提供 `resolveCallTarget` / `getReferences` / `getTypeAt`）；`src/lsp-bridge.ts` 是自研 JSON-RPC stdio LSP 客户端，内置 pyright/pylsp、gopls、rust-analyzer、clangd、OmniSharp/csharp-ls 与 typescript-language-server 预设（超时、惰性重启、dispose）。两者均为**可选**：不新增必需依赖、不捆绑语言服务器 —— 可用性取决于用户环境。
- **DSH 配置包** —— 新包 `@roarpeng/graphflow-dsh`（版本与 CLI 同步）是纯配置的 Cordis bundle：`dsh.bundle.patch` 插入同一条 `mcp-graphflow` stdio 行（cwd 取 `GRAPHFLOW_WORKSPACE_ROOT`，否则回退 DSH 默认工作目录）并随包携带 Skill。通过 `plugin_manager install_bundle` 安装（或 `node scripts/install-dsh-bundle.mjs --print|--stage|--check`）。DSH 能力矩阵如实标注：**MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌**。配置包 **或** `graphflow install --agents deepseek-harness` 二选一（两者注册同一 row id/serverName，同时使用会重复）；CLI 安装器仍会把 Skill 复制到 `DSH_HOME/skills`。
- **发布预检** —— `npm run preflight` 是只读门禁：校验版本一致性（package / lock / 扩展 / README tagline）、必需文件、`mcp.json`、现有工作流的关键内容契约、Skill frontmatter 与包元数据；`npm run preflight:release` 额外运行 `npm test`、`npm pack --dry-run` 与本地 `vsce package` 试打包（未安装 vsce 时跳过）。现有 ci/publish-npm/publish-marketplace 工作流保持不变并通过校验；解析器矩阵为增量新增。审计注意事项：tag 与版本一致性守卫不在 CI 中，VSIX 工作流打包的是已提交的扩展构建产物。
- **基准数据刷新（3.5.0 运行 —— 历史值；当前 3.6.0 数字见上文）** —— MCP wire 459 tokens；骨架折叠 27,507 → 7,694 tokens（72.0%，范围 68–86%）；单符号切片 95.8%（约 96%）；PASS 脱水 4,282 → 30 tokens（99.3%）；知识图谱约 1,156 节点 / 约 2,436 条边，构建约 1.15 s（约 145–150 条 doc links）；受影响测试路由 22 ms；爆炸半径 6 ms。见[基准数据](#基准数据)。

## 3.4.0 新特性

- **默认启用 6 语言真 AST** —— 只要安装了可选的 tree-sitter 原生绑定，`analyzeSourceFile` 就会用 tree-sitter 解析 Python、Go、Rust、C/C++、C#（`engine: "tree-sitter"`）；缺少语法包时回退到内置结构化分析器，设置 `GRAPHFLOW_TREE_SITTER=0` 可强制走结构化路径。TypeScript/JavaScript 继续使用 `@babel/parser` 真 AST。tree-sitter 后端提取符号（kind/span/signature/params/`parentClass`/fields/referencedTypes）、imports、calls（callee/receiver/member/argsCount/caller/`isDeclaration`）以及 ERROR/MISSING 语法诊断；C/C++ 原型保留为 `isDeclaration` 调用点并与定义去重，`.h` 头文件先尝试 C++ 语法再回退到 C。
- **Python `super` 接收者** —— 接收者推断能从 tree-sitter CST 识别 `super()` / `super(A, self)` 调用，与爆炸半径/重命名中已有的 `super`/`base` 处理一致。
- **依赖变化** —— 必需运行时依赖现在是 `@babel/parser`、`@modelcontextprotocol/sdk` 与 `tree-sitter`；6 个语法包（`tree-sitter-python`/`-go`/`-rust`/`-c`/`-cpp`/`-c-sharp`）以 optionalDependencies 安装。安装时 npm 可能打印原生语法包的 peer 范围警告 —— 这是预期现象；缺少某个语法包时该语言自动回退到结构化分析器。除这些以外没有其他运行时依赖。
- **基准数据刷新** —— 真 AST 切换后重跑基准脚本：MCP wire schema 仍为 459 tokens；骨架折叠 25,994 → 7,178 tokens（72.4%，仓库文件范围 68–86%）；单符号切片约 95–96%（随运行略有波动）；通过测试套件脱水 2,966 → 30 tokens（99.0%）；知识图谱约 750 节点 / 约 2.2k 条边，构建约 1 s；受影响测试路由 31 ms。见[基准数据](#基准数据)。

## 3.3.4 新特性

- **安全合并宿主机钩子与卸载** —— `graphflow install` 现在把 GraphFlow 的 `PreToolUse` / `PostToolUse` 钩子**合并**进各宿主机现有钩子配置（Cursor、Claude Code、Codex、Gemini CLI），而不是覆盖：同阶段的用户钩子及其他阶段/键全部保留，Claude/Codex/Gemini 的嵌套 hooks 条目逐个过滤，重复执行 install 只刷新 GraphFlow 自己的条目（幂等）。`graphflow uninstall` 只移除 GraphFlow 所有的钩子条目，不动用户钩子，并保持钩子文件为合法 JSON。
- **按 Agent 的注册状态** —— `graphflow status` 现在每个 Agent 输出一行，明确显示注册了什么，例如 `[MCP ✓] [Skill ✓] [Rule -] [Hook ✓] Cursor (cursor)`，并支持 `--agents <id1,id2>` / `--all` 限定范围（`graphflow doctor` 为别名）。
- **MCP stdio 端到端测试** —— 新增 e2e 测试驱动真实 stdio 服务器：`initialize` → `notifications/initialized` → `tools/list`（恰好 4 个 `gf_*` 工具，wire 负载 459 tokens）→ `gf_read`（符号切片 + `[Blast Radius]`）→ `gf_exec`（`affected-tests` 回执）→ 未知工具（优雅报错、不崩溃）→ 再次 `tools/list`。该测试随 `npm test` 运行。

## 3.3.3 新特性

- **类型感知的知识图谱 calls** —— `graphflow graph` 现在复用爆炸半径的接收者类型推断：调用接收者能解析到某个类时，目标只能是该类声明的方法，外部接收者会被丢弃而不是错误归属（同一文件里的 `a.cancel()` / `b.cancel()` 分别指向 `A.cancel` / `B.cancel`）。接收者未知时仍沿用「同文件 → 显式 import → 窄包作用域」启发式。文件 → 文件 `imports` 边除相对路径外，现在也解析本地 `tsconfig.json` / `jsconfig.json` 的 `compilerOptions.baseUrl` + `paths` 别名（仅工作区根配置）。注意：calls 仍是尽力而为的启发式，**不是类型检查**；5000 条边上限与 Go/C# 的文件名主干/目录 import 回退依旧生效。
- **继承与 `super` 感知的接收者推断** —— 接收者推断现在解析类继承关系：TS/JS `extends` + `super.method()`、Python `class B(A)` + `super()`、C# `class B : A` + `base.Method()`、C++ `class B : public A` + `A::method()`。`super`/`base` 解析到父类；当中间类没有覆写时，子类接收者会为继承来的基类方法计数。推断是流不敏感的「最后赋值优先」（不同分支的冲突赋值视为未知），并会解包泛型/数组/可空包装（`Box<Order>`、`Order | null`、`Order[]`、`&Order`）；C++ `auto x = new Type()` / `Type{}` 也能处理。残余限制：多级覆写链要求中间类可解析；Rust trait 与 Go 嵌入有意不做继承；歧义联合类型/工厂返回仍为未知。依然不是类型检查器。
- **受影响测试路由：`extends` / 嵌套配置 / project references** —— `gf_exec({ cmd: "affected-tests" })` 现在会合并 `tsconfig.json` / `jsconfig.json` 的 `extends` 链（相对路径与 node_modules 包，支持 `package.json` 的 `tsconfig` 字段、数组、防环，子配置覆盖父配置），从导入文件所在目录向上取最近的配置，`jsconfig.json` 同样支持继承，并把根配置 `references[].path` 指向的项目配置作为额外别名来源。限制：不做项目到项目的嵌套 reference 遍历、不支持 Node `exports` map、node_modules 的 `extends` 止于工作区根、配置在进程生命周期内缓存。
- **本地基准脚本** —— 先 `npm run build`，再 `npm run bench` 运行 `scripts/benchmark.mjs`，写出 `benchmarks/latest.md` + `benchmarks/latest.json`；见[基准数据](#基准数据)。

## 3.3.2 新特性

- **真实知识图谱边** —— `graphflow graph` 不再只是平铺清单，而是导出尽力而为的依赖图：`defines`（文件 → 符号）、`imports`（文件 → 文件，由各文件 import 解析）、`calls`（符号 → 符号；能定位调用方符号时以其为源，否则用文件节点）、`doc-links-code`、`co-edit`。方法节点 id 带类名（`sym:file#Class.method`），同名方法不再冲突；单文件 HTML 的图例/颜色/检查器可渲染全部 5 种边。注意：`calls` 边是尽力而为的启发式，**不是类型检查**（3.3.3 加入接收者类型匹配）；大型仓库最多 5000 条边；Go、C# 的 `imports` 边因包路径/命名空间不是文件路径，会回退到文件名主干/目录匹配。
- **接收者类型推断感知的爆炸半径** —— 对方法目标，`gf_read` 会从局部声明、类型标注、`new Type()`、参数、类字段、`var x Type` / `x := Type{}`（Go）、`let x: Type`（Rust）、`Type x`（C++/C#）、方法接收者、`this`/`self`/`cls`/`Self`、`Class.method`/`Class::method` 推断每个调用的接收者类型，只有接收者匹配声明类时才计入。已知不匹配的排除、已知匹配的接受；声明文件内接收者未知则忽略（因此同一文件里的 `A.cancel` 与 `B.cancel` 可消歧），其他文件中接收者未知时仍按 importer 启发式计入。这仍是静态启发式 —— 不做流敏感分析：工厂返回、动态/鸭子类型接收者仍无法解析（3.3.3 加入继承/`super` 与最后赋值处理，见上文）。
- **更安全的重命名** —— `gf_edit({ renameTo })` 复用同一套接收者解析：只有外部接收者命中的文件会被跳过，同时混有目标与外部接收者的文件会以 `REJECTED [ambiguous-symbol]` 拒绝，同名兄弟声明会在写入前拒绝。重命名后「仍有未解析调用方则回滚」的保护依旧生效；重命名不是类型检查器级别的安全。
- **别名感知的受影响测试路由** —— `gf_exec({ cmd: "affected-tests" })` 现在读取 `tsconfig.json` / `jsconfig.json`（JSONC：允许注释与尾逗号）的 `compilerOptions.baseUrl` + `paths` 别名并解析到工作区文件；会跟踪动态 `import("./x")` 与 `require("./x")`；并识别更多测试约定（`__tests__/`、`spec/`、`.test.mts`/`.cts`、`*_test.go`、`test_*.py`、`*Tests.cs`）以及 `.mts`/`.cts` 文件。runner 感知的命令不变（优先 `scripts.test`，检测到 vitest 用 vitest，自定义 runner 用 `npm test`）。仍是启发式（3.3.3 已加入 `extends` 链、嵌套配置与 project references，见上文）。

## 3.3.1 新特性

- **方法级爆炸半径** —— 调用点现在携带接收者/成员信息：在 import 了所属类的文件里，`service.cancelOrder(...)`、`this.cancelOrder(...)`、`Type.cancelOrder(...)`、`Type::cancelOrder(...)` 都会被统计（3.3.2 起改为按接收者类型推断，见上文）。声明不再被当作调用，通配 import（`#include`、`import *`）不再代表某个具体符号，不同语言家族也不再互相匹配。
- **重命名安全** —— `gf_edit({ renameTo })` 同样更新成员调用点；编辑后会重新分析工作区，若旧名字仍作为调用或标识符出现，则回滚并返回带文件列表的 `REJECTED`，不会悄悄弄坏调用方。
- **真正可用的 DSH 注册** —— `graphflow install` 会写入托管块到 `~/.dsh/cordis.patch.yml`（插入 `@deepseek-ai/dsh-mcp-client`），`cwd` 指向工作区，env 带 `GRAPHFLOW_WORKSPACE_ROOT`。DSH **不读取** `~/.dsh/mcp.json`，该文件现在仅作为遗留产物写入。详见下文「DeepSeek Harness（DSH）」一节。
- **安全卸载** —— `graphflow uninstall` 缺省只移除**检测到的 Agent**；`--agents <ids>` 指定子集，`--all` 清理所有已知配置。
- **Python 启发式语法守卫** —— `gf_edit` 会拒绝 `def`/`class`/复合语句缺冒号（括号深度 0 处）、括号不配对、`def`/`class` 缺名，且不会误报多行签名。
- **失败源码窗口** —— `gf_exec` 脱水后的失败现在会在 `Error:` 行紧跟栈帧时附带源码上下文，Python traceback 同样支持。
- **解析器/CLI 准确性** —— Go、Rust 结构体报告 `kind: "struct"`；`graphflow exec --root <dir>` 不再把目录值追加进命令。

## 3.2.0 新特性

### 文档图谱（`src/doc-graph.ts`）

- **跨 Agent 入职简报** —— 持久化于 `.graphflow/cross-agent-brief.json`，以约 300 tokens 的 `@brief` 目标提供：
  - 新会话里的 `gf_read({})` 自动附带架构枢纽、上一位 Agent 改过的符号及其测试状态。
  - `gf_read({ targets: ["@brief"] })` 返回完整交接简报：枢纽 + 改动符号 + 测试状态 + 关联设计文档 + 已编译宏。
- **多格式文档↔代码双向链接** —— `.md`、`.html`、`.xml`、`.docx`、`.pdf`，零依赖原生 zlib 解析：
  - `.docx` 通过原生 ZIP Central Directory + 对 `word/document.xml` 执行 `zlib.inflateRawSync` 解析 —— 把 Word 设计规格小节链接到它提到的符号。
  - `.pdf` 通过对 `/FlateDecode` 流执行 `zlib.inflateSync` + `BT..ET` 文本提取 —— 把 PDF 接口协议链接到实现函数。
  - PLCopen / 配置 XML 小节链接到它们描述的解析器符号。
- **交互式知识图** —— `graphflow graph` 导出 `.graphflow/knowledge-graph.html`，单文件力导向 Canvas 拓扑，带搜索、节点过滤与点击检查器（文件、符号、文档、宏）。自 3.3.2 起承载真实的 `defines` / `imports` / `calls` / `doc-links-code` / `co-edit` 边（见「3.3.2 新特性」）。

### 中英双语分词器（`src/tokenizer.ts`）

一套查询引擎同时覆盖中文与英文：

- **拼音双向索引** —— `gf_read({ q: "dingdan chaoshi" })` 解析为 `订单超时`；`q: "订单支付"` 反向产出 `dingdan`/`zhifu`，能匹配 `handleDingDanZhiFu` 这类拼音命名的遗留标识符。
- **中文同义词簇** —— `q: "取消订单"` 同时命中 `作废/撤单/撤销`；`支付 ↔ 付款/收款/结账`、`用户 ↔ 客户/买家/会员/账号`、`校验 ↔ 验证/验签/核对/检查`。
- **同音字纠错** —— 输入法错别字自动纠正：`定单钞时取销 → 订单超时取消`、`回掉验千 → 回调验签`、`事物回滚 → 事务回滚`、`登陆帐号 → 登录账号`。
- **英文模糊匹配** —— 驼峰/下划线拆分（`resolveEfficiencyPolicy → resolve/efficiency/policy`）、词干还原、编辑距离 1 容错（`cancle → cancel`、`expried → expired`）。

## 独立评测（graphflow-eval）

以下数字来自夹具仓库 [graphflow-eval](https://github.com/Roarpeng/graphflow-eval)，不是生产流量。下面的[基准数据](#基准数据)是另一件事：在本仓库上跑 `npm run bench`。

**方法。** token = `ceil(字符数/4)`。主套件里，基线 token 是该任务基线文件的整文件体积；GraphFlow token 是代理会读到的工具 stdout 的 `ceil(字符数/4)`，含链接进来的规格附录。题面在 `fixtures/tasks/*.json`。计分脚本是 `scripts/score.mjs`。

**3.6.1 主套件**是已入库的 `results/run-3.6.1.md`（2026-10-19T00:42:20Z，二进制 `@roarpeng/graphflow@3.6.1`）：得分失败，安全闸失败，**6/10** 通过，平均 token 节省 **−0.368**（十条比率的未舍入平均是 −0.3678）。

**3.6.2 主套件**是用 3.6.2 树的 `dist/cli.js` 在本地重跑、再用同一 `scripts/score.mjs` 计分（2026-10-19T01:52:23Z）：得分失败，安全闸失败，**9/10** 通过，平均 token 节省 **+0.281**（未舍入 +0.2806）。`scripts/run-tasks.mjs` 不填写 `edited_files` 和 `callers`，所以这次重跑用了放在两个仓库之外的转录器：它记录 stdout、爆炸半径行、被改文件，以及从 `.graphflow/tasks.json` 读回的收割步骤。`PATH` 上的 `python` 是指向 `python3` 的符号链接。有两条基线比已发布的 3.6.1 跑少数字节，因为本地运行器重新数了文件字节：`py-super-blast` 218→222，`ts-rename-safe` 938→939。

| 任务 | 3.6.1 结果 | 3.6.1 tokens | 3.6.2 结果 | 3.6.2 tokens |
| :--- | :--- | :--- | :--- | :--- |
| ts-read-symbol-slice | 通过 | 938→552（+0.4115） | 通过 | 938→559（+0.4041） |
| ts-blast-disambiguate | 通过 | 1573→552（+0.6491） | 通过 | 1573→559（+0.6446） |
| ts-rename-safe | 失败 | 938→158（+0.8316） | **失败** | 939→66（+0.9297） |
| ts-zh-search | 通过 | 1245→5872（−3.7165） | 通过 | 1245→3198（−1.5687） |
| ts-affected-tests | 通过 | 304→33（+0.8914） | 通过 | 304→33（+0.8914） |
| py-super-blast | 失败 | 218→674（−2.0917） | 通过 | 222→243（−0.0946） |
| py-task-harvest-doc | 通过 | 117→166（−0.4188） | 通过 | 117→122（−0.0427） |
| go-embed-read | 通过 | 415→931（−1.2434） | 通过 | 415→354（+0.1470） |
| rs-trait-dispatch | 失败 | 523→450（+0.1396） | 通过 | 523→191（+0.6348） |
| cross-doc-link | 失败 | 237→31（+0.8692） | 通过 | 237→33（+0.8608） |

负比率表示工具 stdout 比原始文件更大。3.6.2 上仍然如此的是 `ts-zh-search`（−1.5687）、`py-super-blast`（−0.0946）和 `py-task-harvest-doc`（−0.0427）。

**`ts-rename-safe` 为什么还是失败。** 题面的 `must_edit_files` 包含 `packages/order-ts/__tests__/checkout.test.ts`。这个文件 13 行，里面没有裸标识符 `cancel`。附近的写法是动词 “cancels”、状态字符串 `"cancelled"`，以及字段 `cancelReason`：

```ts
it("cancels through OrderService", () => {
  const next = buyerCancels(new OrderService(), pendingOrder());
  expect(next.status).toBe("cancelled");
  expect(next.cancelReason).toBe("buyer-request");
});
```

按词边界把 `cancel` 改成 `cancelOrder`，这个文件里没有可改的位置。若去改 `cancelReason` 或 “cancels”，改的是另一个标识符或一段字符串，`npm test --prefix packages/order-ts` 会失败。3.6.2 实际改了 `order-service.ts`、`vip-order-service.ts`（只改 `super.cancel` 调用，`VipOrderService.cancel` 声明保留）、`checkout.ts` 和 `order-service.test.ts`。`renamed_to` 为 `cancelOrder`，`tests_green` 为 true。安全闸失败，只因为这道安全题没有通过那一条 `must_edit_files`。这是夹具题面的错误：题面要求改动的文件里并没有这个符号。3.6.1 上同一题更早、也以另一种方式失败（限定名找不到，然后 `ambiguous-symbol`，没有文件被改）。

**反射套件。** `results/run-3.6.1-reflex.md`，对 3.6.2 构建重跑结果相同：**5/5** 通过，安全闸通过，平均节省 **+0.664**。token 题把已编译的 runner 重放 **N=3** 次。基线（指令 + 两条命令 + 完整 stdout/stderr）**750** tokens。反射（一次 `gf_macro` `task-run` 加上脱水文本）**252** tokens，少 66%。Jaccard 阈值 0.86：近命中 0.875，丢掉一个词的未命中 0.8571428571428571，无关 0。

**中文留出集，80 条**（3.7.0 的 `tests/zh-recall.test.ts`）。这些说法都不在 L0 词表里。下表排序使用显式 `topK` 5。

| 层 | n | P@1 | MRR | R@3 |
| :--- | ---: | :--- | :--- | :--- |
| 仅 L0 | 80 | 0.000 | 0.000 | 0.000 |
| +L1 | 80 | 0.375 | 0.375 | 0.375 |
| +L1+L2 | 80 | 0.813 | 0.813 | 0.813 |

只由提交标题教会的 30 条，打开 L1 后 P@1 从 0.000 到 1.000。35 条口语在打开 L2 后从 0.000 到 1.000。另外 **15/80** 对不上任何注释、提交标题或收录的口语条目，P@1 保持 **0.000**。L3 没有当作神经网络模型来打分。

**真实代码上的中文 —— 160 条注释**（`tests/zh-real-corpus.test.ts`）。夹具里是从五个 MIT 仓库原样摘录的（注释，声明）对，都是「中文注释紧挨英文标识符」的写法：`akfamily/akshare`（153 条 Python docstring）、`mouday/domain-admin`、`go-admin-team/go-admin`（Go 行注释）、`HalseySpicy/Geeker-Admin` 与 `vbenjs/vue-vben-admin`（TS 块注释）。凡是注释里出现符号名或它任意驼峰片段的，摘录时就丢弃，所以查询不会泄漏答案。测试按原路径重建文件，再把每条注释当查询问回去。

| 设置 | n | P@1 | MRR | R@3 |
| :--- | ---: | :--- | :--- | :--- |
| 词表（L0），注释原文 | 160 | 0.825 | 0.849 | 0.875 |
| + 挖掘层（L1），注释原文 | 160 | 0.819 | 0.845 | 0.875 |
| 词表（L0），只取第一分句 | 141 | 0.816 | 0.837 | 0.858 |
| + 挖掘层（L1），只取第一分句 | 141 | 0.801 | 0.827 | 0.851 |

分语言：Go 0.857（n=7），Python 0.817（n=153）。诚实的结论是：**真实注释主要靠 L0 撑住**（维护者用的工程词本来就在词表里），挖掘层在这里从「有害」变成「中性」——在下面这些修复之前，同一批 160 条上它是 **0.775** 对词表的 **0.825**。而在 L0 完全读不出来的合成留出集上，L1 仍是唯一的桥（30 条提交教授的查询 0.000 → 1.000）。

这个夹具有效地暴露了四处问题，都已在 `src/zh-recall.ts` 与 `src/slicer.ts` 修掉：

- **共现窗口原本只向前看 8 行**，一条注释会和隔壁声明的标识符配对。现在改为前后 ±2/+3 行，并遮蔽 URL —— docstring 里常见的 `vip.stock.finance.sina.com.cn` 曾被挖成「finance/vip/sina」。
- **语料级填充词被当成翻译**。`pass`、包名、以及出现在两成窗口里的 `数据`/`中心`，靠支持度取胜却什么也不说明。语料够大时按文档频率丢弃（英文侧 8%，中文键 12%）。
- **排序只看声明上方的注释**。所有 Python docstring 风格的函数只能靠正文文字得分。现在 doc 窗口也包含紧跟声明的字符串字面量。
- **挖掘出的 token 压过了词表**。现在它们只是弱证据（名字命中 8 分对 15 分，签名不计分），且只有当词表完全读不懂查询时才启用。

**自适应 topK**：这 80 条查询的搜索输出按 `ceil(字符数/4)` 求和，显式 `topK` 3 为 **22157** tokens，不传 `topK` 为 **4849**。自适应 P@1 仍是 **0.813**。

**夹具上的 `ts-zh-search` CLI。** 对 graphflow-eval 树做三次 `graphflow read -q`：3.6.2 合计 **3198** tokens，3.7.0 合计 **1077**（`订单超时` 369，`dingdan zhifu` 191，`支付订单` 517）。同三次查询的整文件基线是 1245。要求命中的符号还在。接近分的结果仍会带上 `TIMEOUT_WINDOW_MS` 和 `OrderService` 类切片。

### 这些数字说明不了的事

- 小文件仍可能比直接读原文更贵。表里的负比率就是这种情况。自适应搜索压低了 `ts-zh-search`，并没有让每一次读取都比文件本身更便宜。
- 自动任务学习只有在 `graphflow install`（PostToolUse 钩子）或 `run: true` 的 `gf_exec` 之后，才会追加 `.graphflow/instruction-log.jsonl`。`GRAPHFLOW_AUTO_LOG=0` 关闭。没有守护进程。已发布的 3.6.1 反射跑自己调用了 `graphflow task log`。
- L3 是 `registerZhEnModel` 钩子。除非 `GRAPHFLOW_ZH_EN_MODEL=1` 且注册了翻译函数，否则它不运行。发布包不带翻译模型，0.813 这个数字也不包含模型。
- Go 同包 imports 仍是缺口：同一 package 的兄弟文件没有文件级 `imports` 边。
- 反射命中要求 Jaccard 至少 0.86。丢掉一个词的探针得分 0.857，算未命中。`{{argN}}` 占位符要手写。并发记录是最后写入者胜出，反射跑没有覆盖这个竞争。
- 本节全部数字来自夹具（graphflow-eval，或那 80 条单元夹具），不是生产轨迹。
- 真实语料夹具只重建带注释的声明，候选池是 160 个符号而不是五个完整仓库。它衡量的是「注释→标识符」这条桥，不是在上千个兄弟符号里排序。部分「未命中」是标注问题：`东方财富网-上海板块-行业板块` 期望拿到资金流抓取函数，而 `stock_board_industry_cons_em` 同样说得通。

## 基准数据

**在本仓库上自测**，用 `npm run bench` 对着 GraphFlow 自己的源码。这不是上面的 [graphflow-eval 独立评测](#独立评测graphflow-eval)。表中的 wire 数字是 3.6.0 那次运行（458 tokens）。3.6.2 与 3.7.0 在未改 schema 上测得 **459** tokens（1834 字符，`ceil(chars/4)`）。

| 指标 | 基线 | GraphFlow 3.6.0 | 节省 |
| :--- | :--- | :--- | :--- |
| 每轮 MCP 工具 schema 开销 | 5897 tokens（2.x，10 工具） | wire 负载 458 tokens（4 工具，约 460） | **−92.2%** |
| 大文件读取 —— 骨架折叠 | 整文件原文 | `ast-engine.ts` 27,926 → 7,840 tokens（缩小 71.9%；仓库文件范围 68–86%） | **−68% … −86%** |
| 单符号读取 —— 切片 | 整文件原文 | `ast-engine.ts` 缩小 95.8%（27,926 → 1,165 tokens，约 96%） | **~−96%** |
| 通过的测试套件输出 | 完整日志 | 1 行 `PASS` 回执（24 文件套件 5,946 → 30 tokens） | **−99.5%** |
| 知识图谱构建（仓库） | — | 约 1,277 节点 / 约 2,750 条边，约 2.08 s（165 条 doc links） | — |
| 受影响测试路由 | — | 单个变更文件 26 ms（16 项受影响测试） | — |
| 爆炸半径（仓库符号） | — | 7 ms | — |

**Schema 开销说明：** `tools/list` 的 wire 负载为 458 tokens —— 冗余的 `$schema` / `title` / `annotations` / `_meta` 已从 wire 剥离；程序化 `getV3ToolDefinitions()` 仍保留这些字段供治理 API 使用，因此 API 视图大于 wire 视图。

**本地基准脚本（自测）：** 先 `npm run build`，再 `npm run bench`（`scripts/benchmark.mjs`）会测量 MCP schema 开销、骨架/切片压缩、PASS/失败脱水、知识图谱构建、受影响测试与爆炸半径耗时，并写出 `benchmarks/latest.md` 与 `benchmarks/latest.json`。上表是本仓库 3.6.0 最终基准运行的数字（3.6.1 未变；耗时和计数为约数，随运行略有波动）。重跑可以复现这组自测数字。夹具得分在[独立评测（graphflow-eval）](#独立评测graphflow-eval)。

## 缓存与增量重建

GraphFlow 把派生状态放在 `.graphflow/`（已在 .gitignore 中），因此下一个进程 —— 或另一个 Agent —— 可以复用上一个进程的工作，而不必重付一遍代价。

| 产物 | 内容 | 失效条件 |
| :--- | :--- | :--- |
| `.graphflow/graph-shards.json` | 每文件分片清单：指纹（`size:mtimeMs`）、符号表 `syms`、`declaredNames`、`queriedNames`、`parents`、`hasReceiverCalls`、`unresolvedImports` | 指纹或结构变化；不可读/损坏 → 降级为全量重建 |
| `.graphflow/ast-cache/<sha1>.json` | 单文件的 AST 索引 | 内容哈希**加后端签名**（切换 `GRAPHFLOW_TREE_SITTER` 会正确失效） |
| `.graphflow/doc-links/{symbols,concepts,sections}.json` | 文档↔代码的符号、候选与 section store | 文件指纹；`.graphflow/doc-link-feedback.json` 参与指纹计算，因此「你拒绝过的链接」不会被陈旧缓存掩盖 |
| `.graphflow/zh-identifier-map.json` | L1 中文→英文标识符映射 | 索引重建 |

环境变量开关：`GRAPHFLOW_AST_CACHE=0` 关闭 AST 持久化，`GRAPHFLOW_GRAPH_DEBUG=1` 打印建图各阶段耗时（`kgStage`）。

axios（274 文件 → 2819 节点 / 2418 条边）实测，两侧各自在独立副本中预热：

| 场景 | 全量重建 | 增量重建 |
| :--- | :--- | :--- |
| 改一个叶子文件（dirty = 1） | 4571 ms | **2666 ms**（贡献计算 **13 ms** vs 2300 ms） |
| 改一个枢纽文件（dirty = 25，真实扇出 32） | 4455 ms | 4421 ms |
| 冷启动（无缓存） | — | 6356 ms |

增量结果与全量重建**逐节点、逐边完全一致**。两个诚实的限制：端到端时间里约 **2.6 s** 是固定开销（进程启动、缓存反序列化、HTML 导出），重建算法本身已不是瓶颈；改枢纽文件会真实地弄脏它的全部扇出，此时增量优势消失 —— 依赖方确实必须重算。

## 支持语言

| 语言 | 提取后端 |
| :--- | :--- |
| TypeScript / JavaScript | **真 AST**（`@babel/parser`） |
| Python | **真 AST**，可选 `tree-sitter-python`（缺省回退结构化分析器） |
| Go | **真 AST**，可选 `tree-sitter-go`（缺省回退结构化分析器） |
| Rust | **真 AST**，可选 `tree-sitter-rust`（缺省回退结构化分析器） |
| C / C++ | **真 AST**，可选 `tree-sitter-c` / `tree-sitter-cpp`（缺省回退结构化分析器） |
| C# | **真 AST**，可选 `tree-sitter-c-sharp`（缺省回退结构化分析器） |

tree-sitter 语法包是可选依赖：安装后 Python/Go/Rust/C/C++/C# 默认使用真语法树；缺少语法包（或设置 `GRAPHFLOW_TREE_SITTER=0`）时，该语言改用内置结构化分析器。tree-sitter 只做**语法**解析 —— 不做语义类型解析，因此跨文件接收者/类型推断仍为启发式，并有已记录的限制（Python import 别名/嵌套函数、Go 分组参数/嵌入字段、Rust 宏/trait-宏边界、C/C++ 宏/命名空间、C# 属性即字段/非 record 构造函数）。

运行时依赖：`@babel/parser`、`@modelcontextprotocol/sdk` 与 `tree-sitter`（必需），外加可选语法包 `tree-sitter-python` / `-go` / `-rust` / `-c` / `-cpp` / `-c-sharp`。除此之外没有其他运行时依赖。

## 快速开始

```bash
# 1) 全局安装（Node 18+）
npm install -g @roarpeng/graphflow@3.7.0

# 2) 一键注册到检测到的 Agent（MCP + Skill + Rules + Hooks）
graphflow install            # 等价写法：npx @roarpeng/graphflow install

# 3) 查看按 Agent 的注册状态
graphflow status

# 4) 启动 MCP 服务器（stdio）
graphflow-mcp
```

通过 [skills.sh](https://skills.sh) 生态的轻量入口（只装 Agent Skill，内置引导：再用 `npx @roarpeng/graphflow@latest install` 注册 MCP 服务器）：

```bash
npx skills add Roarpeng/GraphFlow
```

读取 `mcpServers` JSON 块的 Agent 可手动注册 MCP（DSH 请改用下文的 Cordis patch）：

```json
{ "mcpServers": { "graphflow": { "command": "graphflow-mcp" } } }
```

从源码跑测试：

```bash
git clone https://github.com/Roarpeng/GraphFlow && cd GraphFlow
npm install && npm test      # tsx tests/run-all.ts（40 个测试文件，含 MCP stdio e2e）
npm run build && npm run bench  # 可选：本地基准脚本 → benchmarks/latest.md
npm run verify:parsers       # 可选：真 AST 与强制结构化解析器矩阵
npm run preflight            # 可选：静态发布预检
```

## VS Code 扩展

轻量预编译启动器（`roarpeng.graphflow`），提供三条命令：**Install MCP, Skills & Hooks to Agents**、**Mine Git Co-Change History**、**Show Detected Agents Status**。

- Marketplace：搜索 "GraphFlow" —— https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow
- Open VSX：https://open-vsx.org/extension/roarpeng/graphflow
- 手动 VSIX：从 https://github.com/Roarpeng/GraphFlow/releases 下载 `graphflow-<version>.vsix` → `code --install-extension graphflow-<version>.vsix`

完整步骤见 [VSIX-INSTALL.md](./VSIX-INSTALL.md)。

## 22-Agent 自动安装器

`graphflow install` 自动探测已安装的 Agent，注册 MCP + Skill + Rules + Hooks。宿主钩子会合并进现有 `PreToolUse`/`PostToolUse` 配置（保留用户钩子；重复安装幂等）；`graphflow uninstall` 干净移除 MCP、Skill、Rules 与 Hooks —— 只删除 GraphFlow 所有的条目，保留用户钩子与其他阶段 —— 缺省仅针对**检测到的 Agent**；可用 `--agents <id1,id2>` 限定子集，或用 `--all` 清理所有已知配置。

| 分组 | Agent |
| :--- | :--- |
| IDE / 编辑器 | Cursor、VS Code（GitHub Copilot）、Windsurf、Trae / Trae CN、Zed |
| 终端 Agent | Claude Code、OpenAI Codex、Gemini CLI、Antigravity、Kimi Code、DeepSeek Harness（DSH）、OpenCode、ZCode |
| 插件宿主 | Cline、Roo Code、Kilo Code、Continue、PearAI、Qoder / Qoder CN |
| 桌面 / 云端 | Claude Desktop、Amazon Q、WorkBuddy |

限定安装范围：`graphflow install --agents cursor,claude-code --workspace`。

## DeepSeek Harness（DSH）

DSH **不读取** `~/.dsh/mcp.json`。它的 MCP 服务器是 `~/.dsh/cordis.patch.yml` 中的 Cordis 插件 insert。`graphflow install` 现在会在该文件写入托管块（以 `# GRAPHFLOW-DSH-BEGIN` / `# GRAPHFLOW-DSH-END` 界定），并把 Agent Skill 复制到 `~/.dsh/skills/graphflow/SKILL.md`：

```yaml
# GRAPHFLOW-DSH-BEGIN
- insert:
    - id: mcp-graphflow
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: graphflow
        transport: stdio
        command: npx
        args: ['-y', '--package=@roarpeng/graphflow', 'graphflow-mcp']
        cwd: "C:/path/to/your/workspace"
        env: { GRAPHFLOW_WORKSPACE_ROOT: "C:/path/to/your/workspace", GRAPHFLOW_MCP_STDIO: '1', GRAPHFLOW_LOG_JSON: '1' }
        failOnStartupError: false
# GRAPHFLOW-DSH-END
```

`cwd` 很关键：没有它，MCP 子进程会在 DSH 配置目录启动，`gf_*` 调用就必须显式传 `rootDir`。在工作区里执行 `graphflow install` 后，`cwd` 与 `GRAPHFLOW_WORKSPACE_ROOT` 都指向该工作区，`src/app.ts#main` 这类相对目标即可正常解析。重复执行 `install` 会原地替换托管块（包括使用 `cwd: !!js process.cwd()` 的旧块）；`graphflow uninstall --agents deepseek-harness` 会移除它。

`~/.dsh/mcp.json` 仍会作为遗留产物写入，供其他工具使用，但 DSH 本身忽略它。

**配置包替代方案。** `@roarpeng/graphflow-dsh` 是纯配置的 DSH Cordis bundle（版本与 CLI 同步）：其 `dsh.bundle.patch` 插入同一条 `mcp-graphflow` stdio 行，`cwd` 取 `GRAPHFLOW_WORKSPACE_ROOT`（否则回退 DSH 默认工作目录），并随包携带 Skill。通过 DSH 的 `plugin_manager install_bundle` 安装（或 `node scripts/install-dsh-bundle.mjs --print|--stage|--check`），再把 bundle/暂存目录中的 Skill 复制到 `DSH_HOME/skills`。DSH 能力矩阵：**MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌**（DSH 没有 rules 文件或宿主钩子 API）。配置包 **或** `graphflow install --agents deepseek-harness` 二选一 —— 两者都注册同一条 `mcp-graphflow` row，同时使用会重复。

## CLI 参考

| 命令 | 用途 |
| :--- | :--- |
| `graphflow install [--workspace] [--agents <id1,id2>]` | 向检测到的 Agent 注册 MCP + Skill + Rules + Hooks（合并宿主钩子，保留用户钩子） |
| `graphflow uninstall [--agents <id1,id2>] [--all]` | 干净移除 MCP、Skill、Rules 与 Hooks（仅 GraphFlow 所有的钩子条目）；缺省仅检测到的 Agent，`--all` 清理所有配置 |
| `graphflow status [--agents <id1,id2>] [--all]` | 列出检测到的 Agent 及按 Agent 的注册状态（`[MCP ✓] [Skill ✓] [Rule -] [Hook ✓]`） |
| `graphflow doctor parsers [--strict]` / `graphflow parsers` | 打印 tree-sitter 核心/语法包版本、生效的默认引擎与 `GRAPHFLOW_TREE_SITTER`；`--strict` 在真 AST 不可用时以非零码退出 |
| `graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]` | 终端侧手术式读取 |
| `graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <name>]` | 手术式编辑 / 重命名 |
| `graphflow exec [cmd] [--run] [--root <dir>]` | 运行 `affected-tests` 或任意命令（带脱水；`--run` 才执行，缺省仅预览）；`--root` 按参数解析，绝不追加进命令 |
| `graphflow macro <list\|run\|save\|mine\|mine-git> [id] [args...]` | 宏与 git 共变挖掘 |
| `graphflow task <list\|show\|record\|run\|log\|harvest> [--step <cmd>] [--log <path>] [--args <a>] [--json] [--root <dir>]` | 本地任务反射：显式 `record`，或用 `task log` 追加到 `.graphflow/instruction-log.jsonl` 再以增量 `task harvest` 提升重复指令；离线重放 |
| `graphflow reflect "<instruction>" [args...] [--json] [--root <dir>]` | 在本地运行该指令对应（或近似匹配）的已记录任务（未知时返回 MISS） |
| `graphflow graph` | 导出 `.graphflow/knowledge-graph.html` |
| `graphflow brief` | 打印跨 Agent 交接简报 |
| `graphflow hook <pre-tool\|post-tool>` | 宿主钩子拦截入口（内部使用） |
| `graphflow version \| help` | 版本 / 用法 |

## 文档

- [README.md](./README.md) —— 英文文档
- [VSIX-INSTALL.md](./VSIX-INSTALL.md) —— VS Code 扩展安装指南（EN + 中文）
- [skills/graphflow/SKILL.md](./skills/graphflow/SKILL.md) —— 面向 Agent 的 Skill 定义
- [Releases](https://github.com/Roarpeng/GraphFlow/releases) · [Issues](https://github.com/Roarpeng/GraphFlow/issues) · [许可证：Apache-2.0](./LICENSE)
